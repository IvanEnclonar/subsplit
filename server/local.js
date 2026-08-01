'use strict';

/**
 * SubSplit sync server — self-hosted, plain node:http + a JSON file.
 *
 * Deploy target #2. Speaks the exact same HTTP contract as server/worker.js
 * (both delegate to ./core.js); the only difference is where rows live.
 *
 * Run it:
 *
 *   SUBSPLIT_ADMIN_TOKEN=$(openssl rand -hex 24) \
 *   SUBSPLIT_DATA_FILE=./subsplit-data.json \
 *   node server/local.js
 *
 * Environment:
 *   SUBSPLIT_ADMIN_TOKEN  secret guarding POST /v1/groups (required to create groups)
 *   SUBSPLIT_DATA_FILE    path to the JSON store       (default ./subsplit-data.json)
 *   SUBSPLIT_PORT / PORT  listen port                  (default 8787)
 *   SUBSPLIT_HOST / HOST  bind address                 (default 127.0.0.1)
 *
 * Binding to 127.0.0.1 by default is deliberate: the join token and everyone's
 * usage numbers travel in cleartext over plain HTTP, so exposing this directly
 * to the internet is a bad idea. Put it behind a TLS-terminating reverse proxy
 * (or a tunnel) and set SUBSPLIT_HOST=0.0.0.0 only then.
 *
 * Zero dependencies, CommonJS, Node 22 compatible (no node:sqlite).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DATA_FILE = 'subsplit-data.json';

/** Anything past this is a client that is not going to be talked to politely. */
const HARD_BODY_LIMIT = 1024 * 1024;

// ---------------------------------------------------------------------------
// JSON-file store
// ---------------------------------------------------------------------------

/**
 * Composite key standing in for D1's PRIMARY KEY (group_id, member_id, device_id).
 * `|` is a safe separator: group ids are hex, member ids are slugs, and device
 * ids are filtered to [A-Za-z0-9._:-], so none of them can contain one.
 */
function deviceKey(groupId, memberId, deviceId) {
  return `${groupId}|${memberId}|${deviceId}`;
}

/**
 * In-memory state with debounced, atomic (tmp + rename) persistence.
 *
 * Every mutation happens synchronously before any await, so concurrent requests
 * on the event loop can never interleave a read-modify-write.
 *
 * @param {string|null} dataFile path to the JSON file, or null for memory-only
 */
function createFileStore(dataFile) {
  /** @type {{groups: Object, devices: Object}} */
  const state = { groups: Object.create(null), devices: Object.create(null) };
  let writing = false;
  let dirty = false;
  let pending = null;

  function load() {
    if (!dataFile) return;
    let raw;
    try {
      raw = fs.readFileSync(dataFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[subsplit] could not read ${dataFile}: ${err.message}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Refuse to silently start empty and then overwrite the damaged file.
      const backup = `${dataFile}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(dataFile, backup);
        console.error(`[subsplit] ${dataFile} is not valid JSON; moved it to ${backup}`);
      } catch (renameErr) {
        console.error(`[subsplit] ${dataFile} is not valid JSON and could not be moved aside: ${renameErr.message}`);
      }
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const group of Object.values(parsed.groups || {})) {
      if (group && typeof group === 'object' && group.group_id) {
        state.groups[group.group_id] = group;
      }
    }
    for (const device of Object.values(parsed.devices || {})) {
      if (device && typeof device === 'object' && device.group_id && device.member_id && device.device_id) {
        state.devices[deviceKey(device.group_id, device.member_id, device.device_id)] = device;
      }
    }
  }

  async function writeOnce() {
    const dir = path.dirname(dataFile);
    if (dir && dir !== '.') await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${dataFile}.tmp-${process.pid}`;
    const serialized = JSON.stringify({
      version: 1,
      groups: state.groups,
      devices: state.devices,
    });
    await fs.promises.writeFile(tmp, serialized, 'utf8');
    await fs.promises.rename(tmp, dataFile);
  }

  /** Coalesce bursts of writes into one file rewrite at a time. */
  function persist() {
    if (!dataFile) return Promise.resolve();
    dirty = true;
    if (writing) return pending;
    writing = true;
    pending = (async () => {
      try {
        while (dirty) {
          dirty = false;
          await writeOnce();
        }
      } catch (err) {
        console.error(`[subsplit] could not persist to ${dataFile}: ${err.message}`);
      } finally {
        writing = false;
      }
    })();
    return pending;
  }

  function devicesOf(groupId) {
    const out = [];
    for (const device of Object.values(state.devices)) {
      if (device.group_id === groupId) out.push(device);
    }
    return out;
  }

  load();

  return {
    async getGroup(groupId) {
      return state.groups[groupId] || null;
    },

    async createGroup(row) {
      state.groups[row.group_id] = {
        group_id: row.group_id,
        secret: row.secret,
        created_at: row.created_at,
      };
      persist();
    },

    async listDevices(groupId) {
      // Same ordering the D1 adapter uses, so both targets serialise identically.
      return devicesOf(groupId).sort((a, b) => {
        if (a.member_id !== b.member_id) return a.member_id < b.member_id ? -1 : 1;
        return a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0;
      });
    },

    async stats(groupId) {
      let deviceCount = 0;
      let maxServerUpdatedAt = 0;
      const members = new Set();
      for (const device of Object.values(state.devices)) {
        if (device.group_id !== groupId) continue;
        deviceCount += 1;
        members.add(device.member_id);
        if (device.server_updated_at > maxServerUpdatedAt) {
          maxServerUpdatedAt = device.server_updated_at;
        }
      }
      return { deviceCount, memberCount: members.size, maxServerUpdatedAt };
    },

    async hasMember(groupId, memberId) {
      for (const device of Object.values(state.devices)) {
        if (device.group_id === groupId && device.member_id === memberId) return true;
      }
      return false;
    },

    async hasDevice(groupId, memberId, deviceId) {
      return Object.prototype.hasOwnProperty.call(state.devices, deviceKey(groupId, memberId, deviceId));
    },

    async upsertDevice(row) {
      const key = deviceKey(row.group_id, row.member_id, row.device_id);
      const previous = state.devices[key];
      // Mirrors D1's `WHERE excluded.seq > devices.seq`.
      if (previous && !(row.seq > previous.seq)) return false;
      state.devices[key] = {
        group_id: row.group_id,
        member_id: row.member_id,
        device_id: row.device_id,
        member_name: row.member_name,
        payload: row.payload,
        client_updated_at: row.client_updated_at,
        server_updated_at: row.server_updated_at,
        seq: row.seq,
      };
      persist();
      return true;
    },

    async deleteDevice(groupId, memberId, deviceId) {
      const key = deviceKey(groupId, memberId, deviceId);
      if (!Object.prototype.hasOwnProperty.call(state.devices, key)) return 0;
      delete state.devices[key];
      persist();
      return 1;
    },

    /** Wait for any in-flight write to land. Used on shutdown and in tests. */
    async flush() {
      if (pending) await pending;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Read a request body, capping it at `limit` bytes.
 * Oversized bodies are drained (not parsed) so the router can answer 413 on a
 * clean connection instead of the client seeing a reset.
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        // Past the cap the body is worthless — drop what we buffered and keep
        // draining so the 413 goes back over a healthy connection.
        tooLarge = true;
        chunks.length = 0;
        if (bytes > HARD_BODY_LIMIT) {
          finish({ raw: '', tooLarge: true, aborted: true });
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ raw: tooLarge ? '' : Buffer.concat(chunks).toString('utf8'), tooLarge }));
    req.on('aborted', () => finish({ raw: '', tooLarge, aborted: true }));
    req.on('error', () => finish({ raw: '', tooLarge, aborted: true }));
  });
}

function sendResult(res, result, headOnly) {
  if (res.destroyed || res.writableEnded) return;
  const headers = Object.assign({ 'cache-control': 'no-store' }, result.headers || {});
  try {
    if (result.body == null) {
      res.writeHead(result.status, headers);
      res.end();
      return;
    }
    const payload = JSON.stringify(result.body);
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = Buffer.byteLength(payload);
    res.writeHead(result.status, headers);
    res.end(headOnly ? undefined : payload);
  } catch (err) {
    console.error('[subsplit] could not write response:', err.message);
  }
}

/**
 * Build the HTTP server (not yet listening).
 *
 * @param {object} [options]
 * @param {string|null} [options.dataFile]  JSON store path; null = memory only
 * @param {string} [options.adminToken]     secret for POST /v1/groups
 * @param {() => number} [options.now]      clock override, for tests
 */
function createLocalServer(options = {}) {
  const dataFile =
    options.dataFile === null
      ? null
      : options.dataFile || process.env.SUBSPLIT_DATA_FILE || path.resolve(process.cwd(), DEFAULT_DATA_FILE);
  const adminToken =
    options.adminToken != null ? String(options.adminToken) : process.env.SUBSPLIT_ADMIN_TOKEN || '';

  const store = createFileStore(dataFile);
  const router = core.createRouter({ store, adminToken, now: options.now });

  const server = http.createServer((req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      sendResult(res, {
        status: 400,
        body: { error: 'bad_request', code: 'bad_request', message: 'malformed request URL' },
      });
      return;
    }

    const headers = Object.create(null);
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }

    const query = Object.create(null);
    for (const [key, value] of url.searchParams) {
      if (!(key in query)) query[key] = value;
    }

    readBody(req, core.MAX_BODY_BYTES)
      .then((body) =>
        router.handle({
          method,
          path: url.pathname,
          query,
          headers,
          rawBody: body.raw,
          bodyTooLarge: body.tooLarge,
        })
      )
      .then((result) => {
        if (method === 'HEAD') result.body = null;
        sendResult(res, result, method === 'HEAD');
      })
      .catch((err) => {
        console.error('[subsplit] request failed:', err && err.stack ? err.stack : err);
        if (res.headersSent) {
          res.end();
          return;
        }
        sendResult(res, {
          status: 500,
          body: { error: 'internal_error', code: 'internal_error', message: 'internal server error' },
        });
      });
  });

  return { server, store, dataFile, adminToken };
}

/**
 * Create and start the server.
 *
 * @returns {Promise<{server: import('node:http').Server, store: object, host: string,
 *                    port: number, url: string, close: () => Promise<void>}>}
 */
async function start(options = {}) {
  const created = createLocalServer(options);
  const host = options.host || process.env.SUBSPLIT_HOST || process.env.HOST || DEFAULT_HOST;
  const port =
    options.port != null
      ? Number(options.port)
      : Number(process.env.SUBSPLIT_PORT || process.env.PORT || DEFAULT_PORT);

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    created.server.once('error', onError);
    created.server.listen(port, host, () => {
      created.server.removeListener('error', onError);
      resolve();
    });
  });

  const address = created.server.address();
  const boundHost = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
  const displayHost = address.family === 'IPv6' && boundHost.includes(':') ? `[${boundHost}]` : boundHost;

  return {
    server: created.server,
    store: created.store,
    dataFile: created.dataFile,
    host: address.address,
    port: address.port,
    url: `http://${displayHost}:${address.port}`,
    async close() {
      // Kick keep-alive sockets loose, otherwise close() never fires.
      const closed = new Promise((resolve) => created.server.close(() => resolve()));
      created.server.closeAllConnections();
      await closed;
      await created.store.flush();
    },
  };
}

module.exports = { createFileStore, createLocalServer, start };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  start()
    .then((running) => {
      console.log(`[subsplit] sync server listening on ${running.url}`);
      console.log(`[subsplit] data file: ${running.dataFile}`);
      if (!process.env.SUBSPLIT_ADMIN_TOKEN) {
        console.warn(
          '[subsplit] SUBSPLIT_ADMIN_TOKEN is not set — POST /v1/groups will return 503 until it is.'
        );
      }
      const shutdown = (signal) => {
        console.log(`[subsplit] ${signal} received, shutting down`);
        running.close().then(
          () => process.exit(0),
          () => process.exit(1)
        );
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((err) => {
      console.error(`[subsplit] could not start: ${err.message}`);
      process.exitCode = 1;
    });
}
