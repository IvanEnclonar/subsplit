'use strict';

/**
 * SubSplit sync server — shared core.
 *
 * This file holds every piece of behaviour that must be identical between the
 * two deploy targets:
 *
 *   server/worker.js   Cloudflare Worker + D1   (module-format ESM, imports this file)
 *   server/local.js    plain node:http + JSON file persistence
 *
 * Neither the routing nor the aggregation logic knows anything about D1 or
 * node:http — both are handed a tiny async `store` adapter (see StoreAdapter
 * below) and return plain `{ status, body, headers }` results that the HTTP
 * layer serialises.
 *
 * CommonJS (per the project-wide rule). worker.js pulls it in with a default
 * import, which wrangler/esbuild resolves to `module.exports`.
 *
 * Zero dependencies. Everything used here (TextEncoder, crypto.getRandomValues,
 * crypto.randomUUID, btoa, URL) is a global in both Node 22+ and Workers.
 */

// ---------------------------------------------------------------------------
// Limits & constants
// ---------------------------------------------------------------------------

/** Hard cap on a request body. Anything larger is rejected with 413. */
const MAX_BODY_BYTES = 4096;
/** Distinct member_ids allowed per group. Past this, join/push return 409. */
const MAX_MEMBERS = 16;
/** Device rows allowed per group (a member may run several devices). */
const MAX_DEVICES = 32;
/** Poll cadence advertised to clients on join. */
const POLL_INTERVAL_S = 60;
/**
 * Reported by the unauthenticated GET /v1/health so "Test connection" in the
 * app can say *which* server answered. Both deploy targets route through this
 * file, so worker.js and local.js always agree on it.
 */
const SERVER_VERSION = '1';

/**
 * How far ahead of the server clock a client-supplied `seq` may be. The client
 * counter is small and the server's own fallback is `now`, so anything beyond
 * this is broken or hostile — and storing it would freeze that device row.
 */
const MAX_SEQ_AHEAD_MS = 24 * 60 * 60 * 1000;
/**
 * How far ahead of the server clock a snapshot's own `ts` may be and still be
 * trusted for ordering. Past this the row is ordered by server write time.
 */
const MAX_RATE_TS_AHEAD_MS = 5 * 60 * 1000;

const MAX_NAME_LEN = 64;
const MAX_DEVICE_ID_LEN = 64;
const MAX_MEMBER_ID_LEN = 32;
const MAX_RATE_WINDOWS = 8;

/** The two windows SubSplit tracks. Order is the serialisation order. */
const WINDOW_KEYS = ['5h', 'weekly'];

/** Length of one full window, in ms. Used for stale-device exclusion. */
const WINDOW_MS = {
  '5h': 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * A device unseen for longer than the *shortest* window can no longer be
 * contributing to that window, so it is flagged `stale` in GroupState.
 * Per-window exclusion from the sums uses WINDOW_MS[key] instead.
 */
const STALE_MS = WINDOW_MS['5h'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

/** UTF-8 byte length of a string (works in Workers and Node alike). */
function byteLength(str) {
  return TEXT_ENCODER.encode(String(str == null ? '' : str)).length;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Non-negative integer, defaulting to 0 — token counters can never go below 0. */
function toCount(value) {
  const n = toInt(value, 0);
  return n > 0 ? n : 0;
}

/**
 * A percentage gauge from a client: null when absent or not a real number, and
 * clamped into [0, 100] so a buggy client cannot make every member's UI render
 * something like "-4201%".
 */
function toPercent(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Constant-time string comparison. Length is still observable (unavoidable for
 * a variable-length secret), but the byte comparison never exits early.
 */
function timingSafeEqualString(a, b) {
  const A = TEXT_ENCODER.encode(String(a == null ? '' : a));
  const B = TEXT_ENCODER.encode(String(b == null ? '' : b));
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

/**
 * Deterministic member id from a display name. Join is idempotent because two
 * devices typing the same name land on the same slug.
 */
function slugify(name) {
  let s = String(name == null ? '' : name);
  try {
    // NFKD splits accented letters into base + combining mark; dropping the
    // marks means "Céline" slugs to "celine", not "ce-line".
    s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  } catch (_) {
    /* normalize is always present in Node 22 / Workers; be defensive anyway */
  }
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_MEMBER_ID_LEN)
    .replace(/-+$/g, '');
}

function sanitizeName(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN)
    .trim();
}

function sanitizeDeviceId(value) {
  return String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._:-]/g, '')
    .slice(0, MAX_DEVICE_ID_LEN);
}

/** `Authorization: Bearer ss_<group_id>_<secret>` → { group_id, secret } | null */
function parseBearer(header) {
  const m = /^Bearer\s+ss_([a-z0-9]{4,32})_([A-Za-z0-9_-]{16,128})$/.exec(
    String(header == null ? '' : header).trim()
  );
  return m ? { group_id: m[1], secret: m[2] } : null;
}

function base64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** 10 lowercase hex chars — short enough to eyeball, long enough not to collide. */
function randomGroupId() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

/** 24 random bytes, base64url — 32 chars. */
function randomSecret() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return base64url(b);
}

// ---------------------------------------------------------------------------
// Payload normalisation
//
// Everything a client sends is untrusted and is rewritten into a known shape
// before it is stored. This bounds row size, keeps the aggregation arithmetic
// on real numbers, and means a malformed push degrades instead of throwing.
// ---------------------------------------------------------------------------

/** WindowTotals as pushed by the client (see INTERFACES.md § windows.js). */
function normalizeWindowTotals(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  return {
    window_start: toCount(t.window_start),
    resets_at: t.resets_at == null ? null : toInt(t.resets_at, null),
    used_percent: toPercent(t.used_percent),
    input: toCount(t.input),
    cached_input: toCount(t.cached_input),
    output: toCount(t.output),
    total: toCount(t.total),
  };
}

/** RateSnapshot as pushed by the client (see INTERFACES.md § parser.js). */
function normalizeRateSnapshot(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const windows = [];
  if (Array.isArray(r.windows)) {
    for (const w of r.windows.slice(0, MAX_RATE_WINDOWS)) {
      if (!w || typeof w !== 'object') continue;
      const windowMinutes = toInt(w.windowMinutes, null);
      if (windowMinutes === null) continue;
      windows.push({
        windowMinutes,
        usedPercent: toPercent(w.usedPercent),
        resetsAt: w.resetsAt == null ? null : toInt(w.resetsAt, null),
      });
    }
  }
  let credits = null;
  if (r.credits && typeof r.credits === 'object' && !Array.isArray(r.credits)) {
    credits = {
      hasCredits: !!r.credits.hasCredits,
      unlimited: !!r.credits.unlimited,
      balance: r.credits.balance == null ? null : String(r.credits.balance).slice(0, 32),
    };
  }
  return {
    ts: toCount(r.ts),
    windows,
    planType: r.planType == null ? null : String(r.planType).slice(0, 32),
    credits,
  };
}

/**
 * Normalise a PUT /v1/state body.
 * @param {object} body   parsed request body
 * @param {number} [nowMs] server clock, used to bound `seq`
 * @returns {{ok:true,value:object}|{ok:false,code:string,message:string}}
 */
function normalizePush(body, nowMs) {
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'bad_request', message: 'body must be a JSON object' };
  }
  const member_name = sanitizeName(body.member_name);
  const member_id = slugify(body.member_id || member_name);
  const device_id = sanitizeDeviceId(body.device_id);
  if (!member_id) {
    return { ok: false, code: 'bad_request', message: 'member_id or member_name is required' };
  }
  if (!device_id) {
    return { ok: false, code: 'bad_request', message: 'device_id is required' };
  }

  // seq is written into the row that the upsert guard (`excluded.seq > seq`)
  // compares against forever, so an absurd value freezes that device row for
  // good — every later honest push is rejected and the member's numbers stop
  // moving. A real counter is a small integer, and the router's own fallback is
  // the server clock, so anything more than a day ahead of it is broken or
  // hostile and is refused instead of stored.
  let seq = 0;
  if (body.seq != null) {
    seq = Number(body.seq);
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > now + MAX_SEQ_AHEAD_MS) {
      return {
        ok: false,
        code: 'invalid_seq',
        message:
          'seq must be a non-negative integer no further ahead than the server clock; ' +
          'reset this device (clear settings.json, or reinstall) and push again',
      };
    }
  }

  const window_totals = {};
  const raw = body.window_totals && typeof body.window_totals === 'object' ? body.window_totals : {};
  for (const key of WINDOW_KEYS) {
    const t = normalizeWindowTotals(raw[key]);
    if (t) window_totals[key] = t;
  }

  return {
    ok: true,
    value: {
      member_id,
      member_name: member_name || member_id,
      device_id,
      // seq is a client-persisted monotonic counter; a missing one falls back to
      // updated_at so old clients still make forward progress (see push guard).
      seq,
      updated_at: toCount(body.updated_at),
      payload: {
        window_totals,
        rate_limit: normalizeRateSnapshot(body.rate_limit),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation — device rows → GroupState
// ---------------------------------------------------------------------------

function parsePayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload !== 'string' || !payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** ETag string, quotes included, so it can be used verbatim as a header value. */
function makeEtag(maxServerUpdatedAt, deviceCount) {
  return `"${toCount(maxServerUpdatedAt)}-${toCount(deviceCount)}"`;
}

function normalizeEtag(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"|"$/g, '');
}

/** Does an `If-None-Match` header value match our current ETag? */
function etagMatches(header, etag) {
  if (!header) return false;
  const want = normalizeEtag(etag);
  for (const part of String(header).split(',')) {
    const got = normalizeEtag(part);
    if (got === '*' || (got !== '' && got === want)) return true;
  }
  return false;
}

/**
 * Fold device rows into a GroupState.
 *
 * Rules (INTERFACES.md § Server API):
 *  - window_totals are SUMMED across a member's devices, respecting window_start:
 *    a strictly-newer window_start resets that member's accumulator, a strictly
 *    older one is skipped, an equal one adds. "Newer"/"older" are judged with a
 *    quarter-window tolerance, because a device whose window bounds come from the
 *    rolling fallback anchors them to its own scan clock — two devices of one
 *    member are then near-but-not-equal and must still be summed, while a genuine
 *    rollover jumps by a whole window and still resets. The result is independent
 *    of row order: the member's newest window_start anchors the comparison.
 *  - `resets_at` / `used_percent` are gauges, not sums: within the winning
 *    window_start the freshest device's non-null value wins.
 *  - account_rate_limit is the single freshest snapshot across all devices,
 *    chosen by the snapshot's own `ts` (so push order cannot change the winner),
 *    and is NEVER summed. A `ts` implausibly far ahead of the server clock is not
 *    trusted for ordering, and a stale device only wins when no fresh device
 *    reported a snapshot at all.
 *  - a device unseen for more than one full window is excluded from that
 *    window's sums, and flagged `stale` once it passes the shortest window.
 *  - share_pct = member total / group total per window, 0 when the group total is 0.
 *
 * @param {Array<object>} rows device rows: {member_id, member_name, device_id, payload, server_updated_at}
 * @param {number} now server clock in ms
 * @returns {object} GroupState
 */
function aggregate(rows, now) {
  const list = Array.isArray(rows) ? rows : [];
  const byMember = new Map();
  let maxServerUpdatedAt = 0;
  const freshRate = { rate: null, ts: -Infinity, write: -Infinity };
  const staleRate = { rate: null, ts: -Infinity, write: -Infinity };

  for (const row of list) {
    if (!row) continue;
    const memberId = String(row.member_id == null ? '' : row.member_id);
    if (!memberId) continue;

    const serverUpdatedAt = toCount(row.server_updated_at);
    if (serverUpdatedAt > maxServerUpdatedAt) maxServerUpdatedAt = serverUpdatedAt;
    const seen = Math.max(0, now - serverUpdatedAt);
    const payload = parsePayload(row.payload);

    let member = byMember.get(memberId);
    if (!member) {
      member = {
        member_id: memberId,
        member_name: memberId,
        devices: [],
        windows: {},
        _totals: {},
        _nameAt: -Infinity,
      };
      byMember.set(memberId, member);
    }
    const name = sanitizeName(row.member_name);
    if (name && serverUpdatedAt >= member._nameAt) {
      member._nameAt = serverUpdatedAt;
      member.member_name = name;
    }

    member.devices.push({
      device_id: String(row.device_id == null ? '' : row.device_id),
      seen_ms_ago: seen,
      stale: seen > STALE_MS,
    });

    const totals = payload && payload.window_totals;
    if (totals && typeof totals === 'object') {
      for (const key of WINDOW_KEYS) {
        const t = normalizeWindowTotals(totals[key]);
        if (!t) continue;
        // A device that has not checked in for a whole window cannot still be
        // consuming inside it — drop it from the sum rather than double-count.
        if (seen > WINDOW_MS[key]) continue;

        // Which window_start wins can only be decided once every device of this
        // member has been seen, so collect here and fold in the pass below.
        let pending = member._totals[key];
        if (!pending) {
          pending = [];
          member._totals[key] = pending;
        }
        pending.push({ totals: t, server_updated_at: serverUpdatedAt });
      }
    }

    const rate = payload ? normalizeRateSnapshot(payload.rate_limit) : null;
    if (rate) {
      // Freshest snapshot wins by its own timestamp, so a late push carrying an
      // old snapshot cannot clobber a newer one. Server write time breaks ties.
      // A ts implausibly far ahead of the server clock (a machine with a badly
      // wrong clock, or a client that lies) would otherwise pin this group-wide
      // gauge for hours, so it is ordered by write time instead — exactly what
      // already happens for `ts <= 0`.
      const ts = rate.ts > 0 && rate.ts <= now + MAX_RATE_TS_AHEAD_MS ? rate.ts : serverUpdatedAt;
      // A device already dropped from the window sums must not still be serving
      // the account gauge; it is kept only as a last resort.
      const best = seen > STALE_MS ? staleRate : freshRate;
      if (ts > best.ts || (ts === best.ts && serverUpdatedAt > best.write)) {
        best.ts = ts;
        best.write = serverUpdatedAt;
        best.rate = rate;
      }
    }
  }

  const members = [...byMember.values()];
  for (const member of members) {
    member.devices.sort((a, b) => (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0));
    const windows = {};
    for (const key of WINDOW_KEYS) {
      const pending = member._totals[key];
      if (!pending || pending.length === 0) {
        windows[key] = null;
        continue;
      }
      // Devices anchored to the same window can still disagree on window_start
      // by a scan interval (rolling fallback bounds) — anything within a quarter
      // window of the newest one is the SAME window and adds; anything older is a
      // previous window and is skipped. A rollover jumps by a whole window.
      const tolerance = Math.floor(WINDOW_MS[key] / 4);
      let windowStart = -Infinity;
      for (const entry of pending) {
        if (entry.totals.window_start > windowStart) windowStart = entry.totals.window_start;
      }
      const acc = {
        window_start: windowStart,
        resets_at: null,
        used_percent: null,
        input: 0,
        cached_input: 0,
        output: 0,
        total: 0,
        share_pct: 0,
      };
      let gaugeAt = -Infinity;
      for (const entry of pending) {
        const t = entry.totals;
        if (windowStart - t.window_start > tolerance) continue;
        acc.input += t.input;
        acc.cached_input += t.cached_input;
        acc.output += t.output;
        acc.total += t.total;
        if (entry.server_updated_at >= gaugeAt) {
          gaugeAt = entry.server_updated_at;
          if (t.resets_at != null) acc.resets_at = t.resets_at;
          if (t.used_percent != null) acc.used_percent = t.used_percent;
        }
      }
      windows[key] = acc;
    }
    member.windows = windows;
    delete member._totals;
    delete member._nameAt;
  }

  for (const key of WINDOW_KEYS) {
    let groupTotal = 0;
    for (const member of members) {
      const w = member.windows[key];
      if (w) groupTotal += w.total;
    }
    for (const member of members) {
      const w = member.windows[key];
      if (!w) continue;
      w.share_pct = groupTotal > 0 ? Math.round((w.total / groupTotal) * 1000) / 10 : 0;
    }
  }

  members.sort((a, b) => (a.member_id < b.member_id ? -1 : a.member_id > b.member_id ? 1 : 0));

  return {
    server_time: now,
    members,
    account_rate_limit: freshRate.rate || staleRate.rate,
    etag: makeEtag(maxServerUpdatedAt, list.length),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * StoreAdapter (all methods async):
 *   getGroup(groupId)                       -> {group_id, secret, created_at} | null
 *   createGroup({group_id, secret, created_at}) -> void
 *   listDevices(groupId)                    -> [row]  (ordered by member_id, device_id)
 *   stats(groupId)                          -> {deviceCount, memberCount, maxServerUpdatedAt}
 *   hasMember(groupId, memberId)            -> boolean
 *   hasDevice(groupId, memberId, deviceId)  -> boolean
 *   upsertDevice(row)                       -> boolean  (false when the seq guard rejected it)
 *   deleteDevice(groupId, memberId, deviceId) -> number (rows removed)
 */

function jsonResult(status, body, headers) {
  return { status, body, headers: headers || {} };
}

/**
 * Error envelope. Both `error` and `code` carry the machine-readable code so a
 * client reading either field works; the secret is never echoed.
 */
function errorResult(status, code, message, headers) {
  return jsonResult(status, { error: code, code, message }, headers);
}

function methodNotAllowed(allow) {
  return errorResult(405, 'method_not_allowed', `allowed: ${allow}`, { allow });
}

function normalizePath(path) {
  let p = String(path == null ? '/' : path);
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function parseJsonBody(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * Build the request router.
 *
 * @param {object} options
 * @param {object} options.store        StoreAdapter (see above)
 * @param {string} options.adminToken   secret guarding POST /v1/groups
 * @param {() => number} [options.now]  clock override, for tests
 * @returns {{handle: (req: object) => Promise<{status:number, body:object|null, headers:object}>}}
 */
function createRouter(options) {
  const store = options.store;
  const adminToken = options.adminToken == null ? '' : String(options.adminToken);
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();

  async function handle(request) {
    const now = clock();
    const method = String(request.method || 'GET').toUpperCase();
    const path = normalizePath(request.path);
    const headers = request.headers || {};
    const query = request.query || {};
    const bodyTooLarge = !!request.bodyTooLarge;

    // --- unauthenticated reachability probe ---------------------------------
    if (path === '/v1/health') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET');
      return jsonResult(200, { ok: true, server_time: now, server_version: SERVER_VERSION });
    }

    // --- bootstrap a group (run once by whoever pays for Codex) -------------
    if (path === '/v1/groups') {
      if (method !== 'POST') return methodNotAllowed('POST');
      if (!adminToken) {
        return errorResult(
          503,
          'admin_disabled',
          'this server has no ADMIN_TOKEN configured, so groups cannot be created'
        );
      }
      const presented = headers['x-admin-token'] || '';
      if (!timingSafeEqualString(presented, adminToken)) {
        return errorResult(401, 'unauthorized', 'invalid admin token');
      }
      const group_id = randomGroupId();
      const secret = randomSecret();
      await store.createGroup({ group_id, secret, created_at: now });
      return jsonResult(201, { group_id, join_token: `ss_${group_id}_${secret}` });
    }

    // --- everything below is Bearer-authenticated ---------------------------
    const bearer = parseBearer(headers.authorization);
    let groupId = null;
    if (bearer) {
      const group = await store.getGroup(bearer.group_id);
      if (group && timingSafeEqualString(group.secret, bearer.secret)) groupId = group.group_id;
    }
    if (!groupId) {
      return errorResult(401, 'unauthorized', 'missing or invalid join token');
    }

    if (bodyTooLarge) {
      return errorResult(413, 'payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }

    // --- join: claim a stable member_id, idempotent on member_name ----------
    if (path === '/v1/join') {
      if (method !== 'POST') return methodNotAllowed('POST');
      const parsed = parseJsonBody(request.rawBody);
      if (!parsed.ok) return errorResult(400, 'bad_request', 'body is not valid JSON');
      const body = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
      const member_name = sanitizeName(body.member_name);
      const member_id = slugify(member_name);
      if (!member_name || !member_id) {
        return errorResult(400, 'bad_request', 'member_name must contain at least one letter or digit');
      }
      const known = await store.hasMember(groupId, member_id);
      if (!known) {
        const stats = await store.stats(groupId);
        if (stats.memberCount >= MAX_MEMBERS) {
          return errorResult(409, 'group_full', `this group already has ${MAX_MEMBERS} members`);
        }
      }
      return jsonResult(200, {
        group_id: groupId,
        member_id,
        member_name,
        server_time: now,
        poll_interval_s: POLL_INTERVAL_S,
      });
    }

    if (path === '/v1/state') {
      // --- push: upsert one device row, return the whole group in one trip --
      if (method === 'PUT') {
        const parsed = parseJsonBody(request.rawBody);
        if (!parsed.ok) return errorResult(400, 'bad_request', 'body is not valid JSON');
        const push = normalizePush(parsed.value, now);
        if (!push.ok) return errorResult(400, push.code, push.message);
        const value = push.value;

        const known = await store.hasDevice(groupId, value.member_id, value.device_id);
        if (!known) {
          const stats = await store.stats(groupId);
          if (stats.deviceCount >= MAX_DEVICES) {
            return errorResult(409, 'group_full', `this group already has ${MAX_DEVICES} devices`);
          }
          const knownMember = await store.hasMember(groupId, value.member_id);
          if (!knownMember && stats.memberCount >= MAX_MEMBERS) {
            return errorResult(409, 'group_full', `this group already has ${MAX_MEMBERS} members`);
          }
        }

        const serialized = JSON.stringify(value.payload);
        if (byteLength(serialized) > MAX_BODY_BYTES) {
          return errorResult(413, 'payload_too_large', `stored payload exceeds ${MAX_BODY_BYTES} bytes`);
        }

        const accepted = await store.upsertDevice({
          group_id: groupId,
          member_id: value.member_id,
          device_id: value.device_id,
          member_name: value.member_name,
          payload: serialized,
          client_updated_at: value.updated_at,
          server_updated_at: now,
          // seq falls back to the server clock so a client that never persisted
          // a counter still advances instead of being permanently rejected.
          seq: value.seq > 0 ? value.seq : now,
        });

        // Returning the whole group here means an active client never needs a
        // separate poll — roughly halves request volume during heavy use.
        const state = aggregate(await store.listDevices(groupId), now);
        return jsonResult(
          200,
          {
            accepted,
            clock_skew_ms: value.updated_at > 0 ? now - value.updated_at : null,
            state,
          },
          { etag: state.etag }
        );
      }

      // --- poll -------------------------------------------------------------
      if (method === 'GET' || method === 'HEAD') {
        const stats = await store.stats(groupId);
        const etag = makeEtag(stats.maxServerUpdatedAt, stats.deviceCount);
        if (etagMatches(headers['if-none-match'], etag)) {
          return { status: 304, body: null, headers: { etag, 'x-server-time': String(now) } };
        }
        // The body IS the GroupState (it carries `etag` too, so a client that
        // cannot read response headers can still drive If-None-Match).
        const state = aggregate(await store.listDevices(groupId), now);
        return jsonResult(200, state, { etag: state.etag });
      }

      // --- retire a device --------------------------------------------------
      if (method === 'DELETE') {
        const member_id = slugify(query.member_id);
        const device_id = sanitizeDeviceId(query.device_id);
        if (!member_id || !device_id) {
          return errorResult(400, 'bad_request', 'member_id and device_id query parameters are required');
        }
        const deleted = await store.deleteDevice(groupId, member_id, device_id);
        return jsonResult(200, { deleted, server_time: now });
      }

      return methodNotAllowed('GET, PUT, DELETE');
    }

    return errorResult(404, 'not_found', 'no such route');
  }

  return { handle };
}

module.exports = {
  // limits
  MAX_BODY_BYTES,
  MAX_MEMBERS,
  MAX_DEVICES,
  POLL_INTERVAL_S,
  SERVER_VERSION,
  WINDOW_KEYS,
  WINDOW_MS,
  STALE_MS,
  // helpers
  byteLength,
  slugify,
  sanitizeName,
  sanitizeDeviceId,
  timingSafeEqualString,
  parseBearer,
  randomGroupId,
  randomSecret,
  normalizeWindowTotals,
  normalizeRateSnapshot,
  normalizePush,
  makeEtag,
  etagMatches,
  aggregate,
  createRouter,
};
