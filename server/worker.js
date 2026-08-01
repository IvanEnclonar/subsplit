/**
 * SubSplit sync server — Cloudflare Worker + D1.
 *
 * Deploy target #1. All routing and aggregation live in ./core.js, which
 * server/local.js uses too — this file is only the D1 store adapter plus the
 * Request/Response plumbing.
 *
 * Bindings (see wrangler.toml):
 *   env.DB           D1 database, schema in ./schema.sql
 *   env.ADMIN_TOKEN  secret guarding POST /v1/groups  (`wrangler secret put ADMIN_TOKEN`)
 *
 * NOTE ON MODULE FORMAT: the rest of SubSplit is CommonJS, but a D1 binding
 * requires the Workers *module* format (`export default { fetch(req, env) }`),
 * so this one file is ESM. Wrangler's bundler resolves the CommonJS `core.js`
 * through the default import below.
 */

import core from './core.js';

const { MAX_BODY_BYTES, byteLength, createRouter } = core;

// ---------------------------------------------------------------------------
// D1 store adapter
// ---------------------------------------------------------------------------

const DEVICE_COLUMNS =
  'member_id, member_name, device_id, payload, client_updated_at, server_updated_at, seq';

function createD1Store(db) {
  return {
    async getGroup(groupId) {
      return await db
        .prepare('SELECT group_id, secret, created_at FROM groups WHERE group_id = ?')
        .bind(groupId)
        .first();
    },

    async createGroup(row) {
      await db
        .prepare('INSERT INTO groups (group_id, secret, created_at) VALUES (?, ?, ?)')
        .bind(row.group_id, row.secret, row.created_at)
        .run();
    },

    async listDevices(groupId) {
      // Deterministic order keeps the aggregation output byte-stable; the
      // aggregation itself is order-independent by construction.
      const res = await db
        .prepare(
          `SELECT ${DEVICE_COLUMNS} FROM devices WHERE group_id = ? ORDER BY member_id, device_id`
        )
        .bind(groupId)
        .all();
      return res.results || [];
    },

    async stats(groupId) {
      // One cheap probe row backs both the 16-member/32-device caps and the ETag.
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS device_count,
                  COUNT(DISTINCT member_id) AS member_count,
                  COALESCE(MAX(server_updated_at), 0) AS max_updated
             FROM devices WHERE group_id = ?`
        )
        .bind(groupId)
        .first();
      return {
        deviceCount: (row && row.device_count) || 0,
        memberCount: (row && row.member_count) || 0,
        maxServerUpdatedAt: (row && row.max_updated) || 0,
      };
    },

    async hasMember(groupId, memberId) {
      const row = await db
        .prepare('SELECT 1 AS hit FROM devices WHERE group_id = ? AND member_id = ? LIMIT 1')
        .bind(groupId, memberId)
        .first();
      return !!row;
    },

    async hasDevice(groupId, memberId, deviceId) {
      const row = await db
        .prepare(
          'SELECT 1 AS hit FROM devices WHERE group_id = ? AND member_id = ? AND device_id = ? LIMIT 1'
        )
        .bind(groupId, memberId, deviceId)
        .first();
      return !!row;
    },

    async upsertDevice(row) {
      // Atomic upsert with the seq guard: a replayed or out-of-order push whose
      // seq is not strictly newer changes nothing and reports accepted:false.
      const res = await db
        .prepare(
          `INSERT INTO devices
             (group_id, member_id, device_id, member_name, payload,
              client_updated_at, server_updated_at, seq)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(group_id, member_id, device_id) DO UPDATE SET
             member_name = ?4,
             payload = ?5,
             client_updated_at = ?6,
             server_updated_at = ?7,
             seq = ?8
           WHERE excluded.seq > devices.seq`
        )
        .bind(
          row.group_id,
          row.member_id,
          row.device_id,
          row.member_name,
          row.payload,
          row.client_updated_at,
          row.server_updated_at,
          row.seq
        )
        .run();
      return !!(res && res.meta && res.meta.changes > 0);
    },

    async deleteDevice(groupId, memberId, deviceId) {
      const res = await db
        .prepare('DELETE FROM devices WHERE group_id = ? AND member_id = ? AND device_id = ?')
        .bind(groupId, memberId, deviceId)
        .run();
      return (res && res.meta && res.meta.changes) || 0;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const BASE_HEADERS = { 'cache-control': 'no-store' };

function toResponse(result) {
  const headers = { ...BASE_HEADERS, ...(result.headers || {}) };
  if (result.body == null) {
    return new Response(null, { status: result.status, headers });
  }
  headers['content-type'] = 'application/json; charset=utf-8';
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}

function errorResponse(status, code, message) {
  return toResponse({ status, body: { error: code, code, message }, headers: {} });
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export default {
  async fetch(request, env) {
    try {
      if (!env || !env.DB) {
        return errorResponse(503, 'not_configured', 'no D1 binding named DB is attached');
      }

      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      const headers = {};
      for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;

      const query = {};
      for (const [key, value] of url.searchParams) {
        if (!(key in query)) query[key] = value;
      }

      let rawBody = '';
      let bodyTooLarge = false;
      if (BODY_METHODS.has(method)) {
        rawBody = await request.text();
        if (byteLength(rawBody) > MAX_BODY_BYTES) {
          bodyTooLarge = true;
          rawBody = '';
        }
      }

      const router = createRouter({
        store: createD1Store(env.DB),
        adminToken: env.ADMIN_TOKEN || '',
      });

      const result = await router.handle({
        method,
        path: url.pathname,
        query,
        headers,
        rawBody,
        bodyTooLarge,
      });

      // HEAD must not carry a body.
      if (method === 'HEAD') result.body = null;
      return toResponse(result);
    } catch (err) {
      // Never leak internals (or the group secret) to the caller.
      console.error('subsplit worker error', err && err.stack ? err.stack : err);
      return errorResponse(500, 'internal_error', 'internal server error');
    }
  },
};
