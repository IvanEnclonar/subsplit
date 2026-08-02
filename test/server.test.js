'use strict';

/**
 * Sync server contract tests.
 *
 * These run against server/local.js on an ephemeral port, so they exercise the
 * real HTTP surface — routing, auth, status codes, ETags — not just the pure
 * functions. Because local.js and worker.js both delegate to server/core.js,
 * everything asserted here is equally true of the Cloudflare deploy; only the
 * store adapter differs.
 *
 * A handful of aggregation rules (row ordering, stale-device exclusion) are
 * additionally checked by calling core.aggregate directly, where the row order
 * can be pinned exactly.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { start } = require('../server/local.js');
const core = require('../server/core.js');

const ADMIN_TOKEN = 'test-admin-token-4f2b9c1d';

let tempDir = null;
let server = null;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsplit-server-test-'));
  server = await start({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tempDir, 'data.json'),
    adminToken: ADMIN_TOKEN,
  });
});

after(async () => {
  if (server) await server.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function request(method, urlPath, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.adminToken) headers['x-admin-token'] = options.adminToken;

  let body;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(server.url + urlPath, { method, headers, body });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, body: json, text };
}

/** Bootstrap a fresh group so each test is isolated from every other. */
async function createGroup() {
  const res = await request('POST', '/v1/groups', { adminToken: ADMIN_TOKEN });
  assert.equal(res.status, 201, `group creation failed: ${res.text}`);
  assert.match(res.body.join_token, /^ss_[a-z0-9]{10}_[A-Za-z0-9_-]{32}$/);
  return res.body;
}

/** The secret half of a join token. NOT `split('_')[2]` — base64url contains `_`. */
function secretOf(group) {
  return group.join_token.slice(`ss_${group.group_id}_`.length);
}

/** A WindowTotals object with sensible defaults. */
function totals(overrides = {}) {
  return Object.assign(
    {
      window_start: 1_700_000_000_000,
      resets_at: null,
      used_percent: null,
      input: 0,
      cached_input: 0,
      output: 0,
      total: 0,
    },
    overrides
  );
}

/** A RateSnapshot object with sensible defaults. */
function snapshot(overrides = {}) {
  return Object.assign(
    {
      ts: 1_700_000_000_000,
      windows: [{ windowMinutes: 300, usedPercent: 12, resetsAt: 1_700_018_000_000 }],
      planType: 'plus',
      credits: null,
    },
    overrides
  );
}

let seqCounter = 0;
function push(token, overrides) {
  const body = Object.assign(
    {
      member_name: 'Alice',
      device_id: 'device-a',
      seq: ++seqCounter,
      updated_at: Date.now(),
      window_totals: {},
      rate_limit: null,
    },
    overrides
  );
  return request('PUT', '/v1/state', { token, body });
}

function memberOf(state, memberId) {
  const found = state.members.find((m) => m.member_id === memberId);
  assert.ok(found, `member ${memberId} missing from ${JSON.stringify(state.members.map((m) => m.member_id))}`);
  return found;
}

/** Build a device row the way the store does, for direct aggregate() tests. */
function row(overrides) {
  return Object.assign(
    {
      member_id: 'alice',
      member_name: 'Alice',
      device_id: 'device-a',
      server_updated_at: 1_700_000_000_000,
      payload: JSON.stringify({ window_totals: {}, rate_limit: null }),
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// health + group bootstrap
// ---------------------------------------------------------------------------

test('GET /v1/health needs no auth and reports the server clock', async () => {
  const res = await request('GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Number.isFinite(res.body.server_time));
  assert.ok(Math.abs(res.body.server_time - Date.now()) < 60_000);
});

test('GET /v1/health reports SERVER_VERSION, on both deploy targets', async () => {
  assert.equal(typeof core.SERVER_VERSION, 'string');
  assert.ok(core.SERVER_VERSION.length > 0);

  const res = await request('GET', '/v1/health');
  assert.equal(res.body.server_version, core.SERVER_VERSION);

  // The version comes out of the shared router, not out of local.js — so the
  // Worker deploy, which has no health route of its own either, reports the
  // same string from the same constant.
  const viaCore = await core
    .createRouter({ store: {}, adminToken: '', now: () => 1_700_000_000_000 })
    .handle({ method: 'GET', path: '/v1/health', headers: {}, query: {}, rawBody: '' });
  assert.equal(viaCore.status, 200);
  assert.deepEqual(viaCore.body, {
    ok: true,
    server_time: 1_700_000_000_000,
    server_version: core.SERVER_VERSION,
  });
});

test('GET /v1/health answers even with a bad token, and never echoes one', async () => {
  const res = await request('GET', '/v1/health', { token: 'ss_nope_notarealsecret' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(!res.text.includes('notarealsecret'));
});

test('POST /v1/groups requires the admin token', async () => {
  const missing = await request('POST', '/v1/groups');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, 'unauthorized');

  const wrong = await request('POST', '/v1/groups', { adminToken: 'not-the-admin-token' });
  assert.equal(wrong.status, 401);

  const ok = await request('POST', '/v1/groups', { adminToken: ADMIN_TOKEN });
  assert.equal(ok.status, 201);
  assert.match(ok.body.group_id, /^[0-9a-f]{10}$/);
  assert.ok(ok.body.join_token.startsWith(`ss_${ok.body.group_id}_`));
  assert.equal(secretOf(ok.body).length, 32);

  // Two groups never collide.
  const other = await request('POST', '/v1/groups', { adminToken: ADMIN_TOKEN });
  assert.notEqual(other.body.group_id, ok.body.group_id);
});

test('a group secret is never echoed back on error', async () => {
  const group = await createGroup();
  const secret = secretOf(group);
  const res = await request('GET', '/v1/state', { token: `ss_${group.group_id}_${secret}x` });
  assert.equal(res.status, 401);
  assert.ok(!res.text.includes(secret), 'error body leaked the group secret');
});

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

test('four members join, and re-joining under the same name is idempotent', async () => {
  const group = await createGroup();
  const token = group.join_token;
  const names = ['Alice', 'Bob Jones', 'Céline', 'dave'];
  const ids = [];

  for (const member_name of names) {
    const res = await request('POST', '/v1/join', { token, body: { member_name } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.group_id, group.group_id);
    assert.equal(res.body.member_name, member_name);
    assert.equal(res.body.poll_interval_s, 60);
    assert.ok(Number.isFinite(res.body.server_time));
    ids.push(res.body.member_id);
  }

  assert.deepEqual(ids, ['alice', 'bob-jones', 'celine', 'dave']);
  assert.equal(new Set(ids).size, 4, 'member ids must be distinct');

  // Second device for the same human → same member_id, which is how two
  // machines bind to one member.
  for (let i = 0; i < names.length; i++) {
    const again = await request('POST', '/v1/join', { token, body: { member_name: names[i] } });
    assert.equal(again.status, 200);
    assert.equal(again.body.member_id, ids[i]);
  }
});

test('join rejects an empty or unslugifiable member_name', async () => {
  const group = await createGroup();
  for (const member_name of ['', '   ', '!!!']) {
    const res = await request('POST', '/v1/join', { token: group.join_token, body: { member_name } });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(member_name)}`);
    assert.equal(res.body.code, 'bad_request');
  }
});

// ---------------------------------------------------------------------------
// push + aggregation
// ---------------------------------------------------------------------------

test('two devices of one member sum, and the response carries the full group state', async () => {
  const group = await createGroup();
  const token = group.join_token;

  const first = await push(token, {
    member_name: 'Alice',
    device_id: 'laptop',
    window_totals: { weekly: totals({ input: 240, cached_input: 100, output: 60, total: 300 }) },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.accepted, true);
  assert.ok(Number.isFinite(first.body.clock_skew_ms));
  assert.ok(first.body.state, 'push response must nest GroupState under `state`');

  const second = await push(token, {
    member_name: 'Alice',
    device_id: 'desktop',
    window_totals: { weekly: totals({ input: 160, cached_input: 40, output: 40, total: 200 }) },
  });
  assert.equal(second.status, 200);

  const alice = memberOf(second.body.state, 'alice');
  assert.equal(alice.member_name, 'Alice');
  assert.equal(alice.windows.weekly.total, 500);
  assert.equal(alice.windows.weekly.input, 400);
  assert.equal(alice.windows.weekly.cached_input, 140);
  assert.equal(alice.windows.weekly.output, 100);
  assert.equal(alice.windows['5h'], null, 'a window with no data is null, not a phantom zero row');

  assert.equal(alice.devices.length, 2);
  assert.deepEqual(
    alice.devices.map((d) => d.device_id).sort(),
    ['desktop', 'laptop']
  );
  for (const device of alice.devices) {
    assert.ok(device.seen_ms_ago >= 0 && device.seen_ms_ago < 60_000);
    assert.equal(device.stale, false);
  }
});

test('the freshest rate_limit snapshot wins regardless of push order', async () => {
  const older = snapshot({ ts: 1_700_000_000_000, planType: 'plus' });
  const newer = snapshot({ ts: 1_700_000_060_000, planType: 'pro' });

  // newest pushed first, then an older snapshot arrives late
  const groupA = await createGroup();
  await push(groupA.join_token, { member_name: 'Alice', device_id: 'laptop', rate_limit: newer });
  const afterA = await push(groupA.join_token, { member_name: 'Bob', device_id: 'desktop', rate_limit: older });
  assert.equal(afterA.body.state.account_rate_limit.ts, newer.ts);
  assert.equal(afterA.body.state.account_rate_limit.planType, 'pro');

  // reverse push order, same winner
  const groupB = await createGroup();
  await push(groupB.join_token, { member_name: 'Alice', device_id: 'laptop', rate_limit: older });
  const afterB = await push(groupB.join_token, { member_name: 'Bob', device_id: 'desktop', rate_limit: newer });
  assert.equal(afterB.body.state.account_rate_limit.ts, newer.ts);
  assert.equal(afterB.body.state.account_rate_limit.planType, 'pro');

  // and it is a snapshot, never a sum
  assert.equal(afterB.body.state.account_rate_limit.windows.length, 1);
  assert.equal(afterB.body.state.account_rate_limit.windows[0].usedPercent, 12);
});

test('a snapshot timestamped far in the future cannot pin account_rate_limit', async () => {
  const group = await createGroup();
  const token = group.join_token;
  const now = Date.now();

  // A machine whose clock is hours ahead (or a client that simply lies) would
  // otherwise own this group-wide gauge until real time caught up.
  const skewed = snapshot({
    ts: now + 6 * 60 * 60 * 1000,
    planType: 'skewed',
    windows: [{ windowMinutes: 300, usedPercent: 1, resetsAt: now + 60 * 60 * 1000 }],
  });
  await push(token, { member_name: 'Mallory', device_id: 'laptop', rate_limit: skewed });

  // An untrusted ts is ordered by server write time instead, so a later honest
  // push takes the gauge back.
  const honest = snapshot({
    ts: Date.now(),
    planType: 'plus',
    windows: [{ windowMinutes: 300, usedPercent: 97, resetsAt: now + 60 * 60 * 1000 }],
  });
  const after = await push(token, { member_name: 'Alice', device_id: 'laptop', rate_limit: honest });
  assert.equal(after.body.state.account_rate_limit.planType, 'plus');
  assert.equal(after.body.state.account_rate_limit.windows[0].usedPercent, 97);

  // A snapshot only slightly ahead of the server clock is still trusted — client
  // clocks are never exactly in step.
  const nearby = snapshot({
    ts: Date.now() + 60_000,
    planType: 'pro',
    windows: [{ windowMinutes: 300, usedPercent: 45, resetsAt: now + 60 * 60 * 1000 }],
  });
  const nudged = await push(token, { member_name: 'Bob', device_id: 'laptop', rate_limit: nearby });
  assert.equal(nudged.body.state.account_rate_limit.planType, 'pro');
});

test('aggregate() only falls back to a stale device for account_rate_limit', () => {
  const now = 2_000_000_000_000;
  // Mallory last pushed 6h ago (past the staleness horizon) carrying a snapshot
  // that is still newer than the one on Alice's fresh but idle-in-Codex machine.
  const stale = row({
    member_id: 'mallory',
    member_name: 'Mallory',
    device_id: 'm-laptop',
    server_updated_at: now - 6 * 60 * 60 * 1000,
    payload: JSON.stringify({
      window_totals: {},
      rate_limit: snapshot({
        ts: now - 6 * 60 * 60 * 1000,
        planType: 'stale',
        windows: [{ windowMinutes: 300, usedPercent: 3, resetsAt: now + 1000 }],
      }),
    }),
  });
  const fresh = row({
    device_id: 'a-laptop',
    server_updated_at: now - 60_000,
    payload: JSON.stringify({
      window_totals: {},
      rate_limit: snapshot({
        ts: now - 8 * 60 * 60 * 1000,
        planType: 'plus',
        windows: [{ windowMinutes: 300, usedPercent: 64, resetsAt: now + 1000 }],
      }),
    }),
  });

  for (const state of [core.aggregate([fresh, stale], now), core.aggregate([stale, fresh], now)]) {
    assert.equal(state.account_rate_limit.planType, 'plus', 'a stale device must not own the gauge');
    assert.equal(state.account_rate_limit.windows[0].usedPercent, 64);
  }

  // …but a group where every device is stale still gets its last known reading.
  const only = core.aggregate([stale], now);
  assert.equal(only.account_rate_limit.planType, 'stale');
});

test('an out-of-range used_percent is clamped into [0, 100]', async () => {
  const group = await createGroup();
  const token = group.join_token;

  const res = await push(token, {
    member_name: 'Alice',
    device_id: 'laptop',
    window_totals: {
      weekly: totals({ total: 10, used_percent: -4201 }),
      '5h': totals({ total: 5, used_percent: 420.5 }),
    },
    rate_limit: snapshot({
      windows: [
        { windowMinutes: 300, usedPercent: -12, resetsAt: null },
        { windowMinutes: 10080, usedPercent: 250, resetsAt: null },
      ],
    }),
  });

  const alice = memberOf(res.body.state, 'alice');
  assert.equal(alice.windows.weekly.used_percent, 0);
  assert.equal(alice.windows['5h'].used_percent, 100);
  assert.equal(res.body.state.account_rate_limit.windows[0].usedPercent, 0);
  assert.equal(res.body.state.account_rate_limit.windows[1].usedPercent, 100);

  // A percentage that is not a number at all is dropped, not stored as junk.
  const junk = await push(token, {
    member_name: 'Bob',
    device_id: 'laptop',
    window_totals: { weekly: totals({ total: 1, used_percent: 'nope' }) },
  });
  assert.equal(memberOf(junk.body.state, 'bob').windows.weekly.used_percent, null);
});

// ---------------------------------------------------------------------------
// window rollover
// ---------------------------------------------------------------------------

const OLD_WINDOW = 1_700_000_000_000;
const NEW_WINDOW = OLD_WINDOW + 5 * 60 * 60 * 1000;

test('window rollover: equal window_start adds', async () => {
  const group = await createGroup();
  await push(group.join_token, {
    member_name: 'Alice',
    device_id: 'a-one',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 50 }) },
  });
  const res = await push(group.join_token, {
    member_name: 'Alice',
    device_id: 'b-two',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 70 }) },
  });
  const alice = memberOf(res.body.state, 'alice');
  assert.equal(alice.windows['5h'].window_start, OLD_WINDOW);
  assert.equal(alice.windows['5h'].total, 120);
});

test('window rollover: a newer window_start resets and an older one is skipped — both row orders', async () => {
  // Rows are aggregated in (member_id, device_id) order, so the device names
  // below pin which row the folder sees first.

  // order 1: stale-window row first, rolled-over row second
  const groupA = await createGroup();
  await push(groupA.join_token, {
    member_name: 'Alice',
    device_id: 'a-desktop',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 900 }) },
  });
  const resA = await push(groupA.join_token, {
    member_name: 'Alice',
    device_id: 'b-laptop',
    window_totals: { '5h': totals({ window_start: NEW_WINDOW, total: 50 }) },
  });
  const aliceA = memberOf(resA.body.state, 'alice');
  assert.equal(aliceA.windows['5h'].window_start, NEW_WINDOW);
  assert.equal(aliceA.windows['5h'].total, 50);

  // order 2: rolled-over row first, stale-window row second
  const groupB = await createGroup();
  await push(groupB.join_token, {
    member_name: 'Alice',
    device_id: 'a-laptop',
    window_totals: { '5h': totals({ window_start: NEW_WINDOW, total: 50 }) },
  });
  const resB = await push(groupB.join_token, {
    member_name: 'Alice',
    device_id: 'b-desktop',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 900 }) },
  });
  const aliceB = memberOf(resB.body.state, 'alice');
  assert.equal(aliceB.windows['5h'].window_start, NEW_WINDOW);
  assert.equal(aliceB.windows['5h'].total, 50);
});

test('aggregate() is row-order independent for window rollover', () => {
  const now = OLD_WINDOW + 60_000;
  const stale = row({
    device_id: 'desktop',
    server_updated_at: now - 1000,
    payload: JSON.stringify({
      window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 900 }) },
      rate_limit: null,
    }),
  });
  const rolled = row({
    device_id: 'laptop',
    server_updated_at: now - 500,
    payload: JSON.stringify({
      window_totals: { '5h': totals({ window_start: NEW_WINDOW, total: 50 }) },
      rate_limit: null,
    }),
  });

  const forward = core.aggregate([stale, rolled], now);
  const reverse = core.aggregate([rolled, stale], now);

  for (const state of [forward, reverse]) {
    const alice = state.members[0];
    assert.equal(alice.windows['5h'].window_start, NEW_WINDOW);
    assert.equal(alice.windows['5h'].total, 50);
    assert.equal(alice.windows['5h'].share_pct, 100);
  }
  assert.deepEqual(forward.members, reverse.members);
});

// Devices that fall back to a rolling window anchor it to their own scan clock,
// so two devices of one member report near-but-unequal window_starts. Anything
// within a quarter window is the SAME window; a real rollover jumps by a whole
// window and still resets.
const TOLERANCE_5H = (5 * 60 * 60 * 1000) / 4;

test('window rollover: window_starts a scan apart are one window and sum', async () => {
  const group = await createGroup();
  const token = group.join_token;

  await push(group.join_token, {
    member_name: 'Alice',
    device_id: 'a-laptop',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 40_000 }) },
  });
  const res = await push(token, {
    member_name: 'Alice',
    device_id: 'b-desktop',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW + 90_000, total: 60_000 }) },
  });

  const alice = memberOf(res.body.state, 'alice');
  assert.equal(alice.windows['5h'].total, 100_000, 'both devices of a member must count');
  assert.equal(
    alice.windows['5h'].window_start,
    OLD_WINDOW + 90_000,
    'the newest window_start of the merged window is reported'
  );
  assert.equal(alice.windows['5h'].share_pct, 100);
});

test('window rollover: an idle second device cannot zero a member', async () => {
  // The idle machine still heartbeats: same window, newest window_start, no usage.
  const group = await createGroup();
  const token = group.join_token;

  await push(token, {
    member_name: 'Alice',
    device_id: 'a-laptop',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 100_000 }) },
  });
  const res = await push(token, {
    member_name: 'Alice',
    device_id: 'b-idle',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW + 30_000, total: 0 }) },
  });

  assert.equal(memberOf(res.body.state, 'alice').windows['5h'].total, 100_000);
});

test('window rollover: a window_start past the tolerance still resets', async () => {
  const group = await createGroup();
  const token = group.join_token;

  await push(token, {
    member_name: 'Alice',
    device_id: 'a-desktop',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 900 }) },
  });
  const res = await push(token, {
    member_name: 'Alice',
    device_id: 'b-laptop',
    window_totals: { '5h': totals({ window_start: OLD_WINDOW + TOLERANCE_5H + 60_000, total: 50 }) },
  });

  const alice = memberOf(res.body.state, 'alice');
  assert.equal(alice.windows['5h'].total, 50, 'the older window is a previous window, not a peer');
  assert.equal(alice.windows['5h'].window_start, OLD_WINDOW + TOLERANCE_5H + 60_000);
});

test('aggregate() treats the tolerance boundary the same in either row order', () => {
  const now = OLD_WINDOW + 6 * 60 * 60 * 1000;
  const build = (offset) => [
    row({
      device_id: 'a-desktop',
      server_updated_at: now - 1000,
      payload: JSON.stringify({
        window_totals: { '5h': totals({ window_start: OLD_WINDOW, total: 900 }) },
        rate_limit: null,
      }),
    }),
    row({
      device_id: 'b-laptop',
      server_updated_at: now - 500,
      payload: JSON.stringify({
        window_totals: { '5h': totals({ window_start: OLD_WINDOW + offset, total: 50 }) },
        rate_limit: null,
      }),
    }),
  ];

  // exactly at the tolerance: still the same window
  const [oldRow, edgeRow] = build(TOLERANCE_5H);
  for (const state of [core.aggregate([oldRow, edgeRow], now), core.aggregate([edgeRow, oldRow], now)]) {
    assert.equal(state.members[0].windows['5h'].total, 950);
    assert.equal(state.members[0].windows['5h'].window_start, OLD_WINDOW + TOLERANCE_5H);
  }

  // one millisecond past it: a genuine rollover
  const [staleRow, rolledRow] = build(TOLERANCE_5H + 1);
  const forward = core.aggregate([staleRow, rolledRow], now);
  const reverse = core.aggregate([rolledRow, staleRow], now);
  for (const state of [forward, reverse]) {
    assert.equal(state.members[0].windows['5h'].total, 50);
    assert.equal(state.members[0].windows['5h'].window_start, OLD_WINDOW + TOLERANCE_5H + 1);
  }
  assert.deepEqual(forward.members, reverse.members);
});

test('aggregate() drops devices unseen for longer than one full window', () => {
  const now = 2_000_000_000_000;
  const fresh = row({
    device_id: 'fresh',
    server_updated_at: now - 60_000,
    payload: JSON.stringify({
      window_totals: {
        '5h': totals({ window_start: now - 1000, total: 100 }),
        weekly: totals({ window_start: now - 1000, total: 100 }),
      },
      rate_limit: null,
    }),
  });
  // Last seen 2 days ago: outside the 5h window, still inside the weekly one.
  const twoDaysOld = row({
    device_id: 'dormant',
    server_updated_at: now - 2 * 24 * 60 * 60 * 1000,
    payload: JSON.stringify({
      window_totals: {
        '5h': totals({ window_start: now - 1000, total: 777 }),
        weekly: totals({ window_start: now - 1000, total: 400 }),
      },
      rate_limit: null,
    }),
  });

  const state = core.aggregate([fresh, twoDaysOld], now);
  const alice = state.members[0];
  assert.equal(alice.windows['5h'].total, 100, 'the dormant device must not count toward the 5h window');
  assert.equal(alice.windows.weekly.total, 500, 'it is still inside the weekly window');

  const dormant = alice.devices.find((d) => d.device_id === 'dormant');
  assert.equal(dormant.stale, true);
  assert.equal(alice.devices.find((d) => d.device_id === 'fresh').stale, false);
});

// ---------------------------------------------------------------------------
// seq guard
// ---------------------------------------------------------------------------

test('the seq guard rejects a replayed older seq without regressing state', async () => {
  const group = await createGroup();
  const token = group.join_token;
  const base = { member_name: 'Alice', device_id: 'laptop', updated_at: Date.now() };

  const fresh = await request('PUT', '/v1/state', {
    token,
    body: Object.assign({}, base, {
      seq: 5,
      window_totals: { weekly: totals({ total: 500 }) },
    }),
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.accepted, true);

  const replay = await request('PUT', '/v1/state', {
    token,
    body: Object.assign({}, base, {
      seq: 3,
      window_totals: { weekly: totals({ total: 1 }) },
    }),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.accepted, false, 'an older seq must not be applied');
  assert.equal(memberOf(replay.body.state, 'alice').windows.weekly.total, 500);

  // Re-sending the same seq is also a no-op (pushes are idempotent).
  const duplicate = await request('PUT', '/v1/state', {
    token,
    body: Object.assign({}, base, { seq: 5, window_totals: { weekly: totals({ total: 9 }) } }),
  });
  assert.equal(duplicate.body.accepted, false);
  assert.equal(memberOf(duplicate.body.state, 'alice').windows.weekly.total, 500);

  // A strictly newer seq goes through.
  const next = await request('PUT', '/v1/state', {
    token,
    body: Object.assign({}, base, { seq: 6, window_totals: { weekly: totals({ total: 650 }) } }),
  });
  assert.equal(next.body.accepted, true);
  assert.equal(memberOf(next.body.state, 'alice').windows.weekly.total, 650);
});

test('an out-of-range seq is refused with 400 instead of freezing the device row', async () => {
  const group = await createGroup();
  const token = group.join_token;
  const base = { member_name: 'Alice', device_id: 'laptop', updated_at: Date.now() };

  const honest = await request('PUT', '/v1/state', {
    token,
    body: Object.assign({}, base, { seq: 1, window_totals: { weekly: totals({ total: 4000 }) } }),
  });
  assert.equal(honest.body.accepted, true);

  // Every one of these would otherwise be stored and win the `excluded.seq >
  // devices.seq` comparison forever, silently freezing Alice's row.
  const rejected = [1e300, Number.MAX_SAFE_INTEGER, Date.now() + 48 * 60 * 60 * 1000, -1, 1.5, 'nope'];
  for (const seq of rejected) {
    const res = await request('PUT', '/v1/state', {
      token,
      body: Object.assign({}, base, { seq, window_totals: { weekly: totals({ total: 0 }) } }),
    });
    assert.equal(res.status, 400, `seq ${seq} was accepted`);
    assert.equal(res.body.code, 'invalid_seq');
    assert.match(res.body.message, /reset/i, 'the client is told how to recover');
  }

  // Alice's own counter still makes forward progress, with her numbers intact.
  const next = await request('PUT', '/v1/state', {
    token,
    body: Object.assign({}, base, { seq: 2, window_totals: { weekly: totals({ total: 4200 }) } }),
  });
  assert.equal(next.body.accepted, true);
  assert.equal(memberOf(next.body.state, 'alice').windows.weekly.total, 4200);
});

test('a push with no seq at all still lands (server-clock fallback)', async () => {
  const group = await createGroup();
  const token = group.join_token;

  const res = await request('PUT', '/v1/state', {
    token,
    body: {
      member_name: 'Alice',
      device_id: 'laptop',
      updated_at: Date.now(),
      window_totals: { weekly: totals({ total: 77 }) },
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.accepted, true);
  assert.equal(memberOf(res.body.state, 'alice').windows.weekly.total, 77);

  // seq: 0 means the same thing and is not an error either.
  const zero = await request('PUT', '/v1/state', {
    token,
    body: {
      member_name: 'Bob',
      device_id: 'laptop',
      seq: 0,
      updated_at: Date.now(),
      window_totals: { weekly: totals({ total: 5 }) },
    },
  });
  assert.equal(zero.status, 200, zero.text);
  assert.equal(zero.body.accepted, true);
});

// ---------------------------------------------------------------------------
// polling / ETag
// ---------------------------------------------------------------------------

test('GET /v1/state returns an ETag and honours If-None-Match with a 304', async () => {
  const group = await createGroup();
  const token = group.join_token;
  await push(token, {
    member_name: 'Alice',
    device_id: 'laptop',
    window_totals: { weekly: totals({ total: 100 }) },
  });

  const first = await request('GET', '/v1/state', { token });
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'GET /v1/state must send an ETag header');
  assert.equal(first.body.etag, etag, 'GroupState.etag must match the ETag header');
  // The poll body IS the GroupState — no envelope (see INTERFACES.md § sync.js).
  assert.ok(Array.isArray(first.body.members));
  assert.ok('account_rate_limit' in first.body);
  assert.ok(Number.isFinite(first.body.server_time));

  const cached = await request('GET', '/v1/state', {
    token,
    headers: { 'if-none-match': etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, '');
  assert.equal(cached.headers.get('etag'), etag);

  // A new push must invalidate the ETag.
  await push(token, {
    member_name: 'Bob',
    device_id: 'laptop',
    window_totals: { weekly: totals({ total: 100 }) },
  });
  const revalidated = await request('GET', '/v1/state', {
    token,
    headers: { 'if-none-match': etag },
  });
  assert.equal(revalidated.status, 200);
  assert.notEqual(revalidated.headers.get('etag'), etag);
});

// ---------------------------------------------------------------------------
// auth failures
// ---------------------------------------------------------------------------

test('a wrong, malformed, or foreign token is rejected with 401', async () => {
  const group = await createGroup();
  const other = await createGroup();
  const secret = secretOf(group);

  const cases = [
    { name: 'no header', token: undefined },
    { name: 'garbage', token: 'totally-not-a-token' },
    { name: 'right shape, wrong secret', token: `ss_${group.group_id}_${'A'.repeat(32)}` },
    { name: 'wrong group', token: `ss_${other.group_id}_${secret}` },
    { name: 'unknown group', token: `ss_deadbeef00_${secret}` },
  ];

  for (const testCase of cases) {
    for (const [method, urlPath] of [
      ['GET', '/v1/state'],
      ['POST', '/v1/join'],
      ['PUT', '/v1/state'],
      ['DELETE', '/v1/state?member_id=alice&device_id=laptop'],
    ]) {
      const res = await request(method, urlPath, {
        token: testCase.token,
        body: method === 'GET' || method === 'DELETE' ? undefined : { member_name: 'Alice', device_id: 'x' },
      });
      assert.equal(res.status, 401, `${testCase.name} ${method} ${urlPath} → ${res.status}`);
      assert.equal(res.body.code, 'unauthorized');
    }
  }
});

// ---------------------------------------------------------------------------
// payload cap
// ---------------------------------------------------------------------------

test('an oversized payload is rejected with 413', async () => {
  const group = await createGroup();
  const token = group.join_token;

  const oversized = JSON.stringify({
    member_name: 'Alice',
    device_id: 'laptop',
    seq: 1,
    updated_at: Date.now(),
    window_totals: { weekly: totals({ total: 1 }) },
    rate_limit: null,
    filler: 'x'.repeat(core.MAX_BODY_BYTES),
  });
  assert.ok(Buffer.byteLength(oversized) > core.MAX_BODY_BYTES);

  const res = await request('PUT', '/v1/state', { token, body: oversized });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'payload_too_large');

  // Nothing was stored.
  const state = await request('GET', '/v1/state', { token });
  assert.equal(state.body.members.length, 0);

  // A payload just under the cap still goes through.
  const fits = await push(token, {
    member_name: 'Alice',
    device_id: 'laptop',
    window_totals: { weekly: totals({ total: 1 }) },
  });
  assert.equal(fits.status, 200);
});

// ---------------------------------------------------------------------------
// share_pct
// ---------------------------------------------------------------------------

test('share_pct is proportional per window and sums to ~100', async () => {
  const group = await createGroup();
  const token = group.join_token;

  const plan = [
    { member_name: 'Alice', device_id: 'laptop', weekly: 1000, five: 300 },
    { member_name: 'Bob', device_id: 'laptop', weekly: 500, five: 100 },
    { member_name: 'Céline', device_id: 'laptop', weekly: 300, five: 0 },
    { member_name: 'dave', device_id: 'laptop', weekly: 200, five: 0 },
  ];

  let latest = null;
  for (const entry of plan) {
    latest = await push(token, {
      member_name: entry.member_name,
      device_id: entry.device_id,
      window_totals: {
        weekly: totals({ total: entry.weekly, input: entry.weekly }),
        '5h': totals({ total: entry.five, input: entry.five }),
      },
    });
    assert.equal(latest.status, 200, latest.text);
  }

  const state = latest.body.state;
  assert.equal(state.members.length, 4);

  assert.equal(memberOf(state, 'alice').windows.weekly.share_pct, 50);
  assert.equal(memberOf(state, 'bob').windows.weekly.share_pct, 25);
  assert.equal(memberOf(state, 'celine').windows.weekly.share_pct, 15);
  assert.equal(memberOf(state, 'dave').windows.weekly.share_pct, 10);

  for (const key of ['weekly', '5h']) {
    const sum = state.members.reduce((acc, m) => acc + (m.windows[key] ? m.windows[key].share_pct : 0), 0);
    assert.ok(Math.abs(sum - 100) < 0.5, `${key} share_pct summed to ${sum}`);
  }

  // 5h: only Alice and Bob consumed anything, but everyone reported the window.
  assert.equal(memberOf(state, 'alice').windows['5h'].share_pct, 75);
  assert.equal(memberOf(state, 'bob').windows['5h'].share_pct, 25);
  assert.equal(memberOf(state, 'celine').windows['5h'].share_pct, 0);
});

test('share_pct is 0 for every member when the group total is 0', async () => {
  const group = await createGroup();
  const token = group.join_token;
  await push(token, { member_name: 'Alice', device_id: 'laptop', window_totals: { weekly: totals() } });
  const res = await push(token, { member_name: 'Bob', device_id: 'laptop', window_totals: { weekly: totals() } });
  for (const member of res.body.state.members) {
    assert.equal(member.windows.weekly.share_pct, 0);
  }
});

// ---------------------------------------------------------------------------
// device retirement + misc routing
// ---------------------------------------------------------------------------

test('DELETE /v1/state retires one device and leaves the others alone', async () => {
  const group = await createGroup();
  const token = group.join_token;
  await push(token, {
    member_name: 'Alice',
    device_id: 'laptop',
    window_totals: { weekly: totals({ total: 300 }) },
  });
  await push(token, {
    member_name: 'Alice',
    device_id: 'old-desktop',
    window_totals: { weekly: totals({ total: 200 }) },
  });

  const before = await request('GET', '/v1/state', { token });
  assert.equal(memberOf(before.body, 'alice').windows.weekly.total, 500);

  const removed = await request('DELETE', '/v1/state?member_id=alice&device_id=old-desktop', { token });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, 1);

  const after = await request('GET', '/v1/state', { token });
  const alice = memberOf(after.body, 'alice');
  assert.equal(alice.devices.length, 1);
  assert.equal(alice.windows.weekly.total, 300);

  // Deleting again is a no-op, not an error.
  const again = await request('DELETE', '/v1/state?member_id=alice&device_id=old-desktop', { token });
  assert.equal(again.status, 200);
  assert.equal(again.body.deleted, 0);
});

test('unknown routes 404 and wrong methods 405', async () => {
  const group = await createGroup();
  const notFound = await request('GET', '/v1/nope', { token: group.join_token });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.code, 'not_found');

  const badMethod = await request('POST', '/v1/state', { token: group.join_token, body: {} });
  assert.equal(badMethod.status, 405);
  assert.equal(badMethod.headers.get('allow'), 'GET, PUT, DELETE');
});

test('malformed JSON and missing device_id are 400, not 500', async () => {
  const group = await createGroup();
  const token = group.join_token;

  const broken = await request('PUT', '/v1/state', { token, body: '{not json' });
  assert.equal(broken.status, 400);
  assert.equal(broken.body.code, 'bad_request');

  const noDevice = await request('PUT', '/v1/state', { token, body: { member_name: 'Alice' } });
  assert.equal(noDevice.status, 400);
  assert.match(noDevice.body.message, /device_id/);
});

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------

test('a 17th member is refused with 409 group_full', async () => {
  const group = await createGroup();
  const token = group.join_token;

  for (let i = 0; i < core.MAX_MEMBERS; i++) {
    const res = await push(token, {
      member_name: `Member ${i}`,
      device_id: `device-${i}`,
      window_totals: { weekly: totals({ total: 1 }) },
    });
    assert.equal(res.status, 200, `member ${i} rejected: ${res.text}`);
  }

  const joinRes = await request('POST', '/v1/join', { token, body: { member_name: 'One Too Many' } });
  assert.equal(joinRes.status, 409);
  assert.equal(joinRes.body.code, 'group_full');

  const pushRes = await push(token, {
    member_name: 'One Too Many',
    device_id: 'device-x',
    window_totals: { weekly: totals({ total: 1 }) },
  });
  assert.equal(pushRes.status, 409);
  assert.equal(pushRes.body.code, 'group_full');

  // An existing member can still push and re-join.
  const existing = await push(token, {
    member_name: 'Member 0',
    device_id: 'device-0',
    window_totals: { weekly: totals({ total: 2 }) },
  });
  assert.equal(existing.status, 200);
  const rejoin = await request('POST', '/v1/join', { token, body: { member_name: 'Member 0' } });
  assert.equal(rejoin.status, 200);
});

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test('state survives a server restart via the JSON data file', async () => {
  const dataFile = path.join(tempDir, 'restart.json');
  const first = await start({ port: 0, host: '127.0.0.1', dataFile, adminToken: ADMIN_TOKEN });
  let token;
  try {
    const created = await fetch(`${first.url}/v1/groups`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    }).then((r) => r.json());
    token = created.join_token;

    const res = await fetch(`${first.url}/v1/state`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        member_name: 'Alice',
        device_id: 'laptop',
        seq: 1,
        updated_at: Date.now(),
        window_totals: { weekly: totals({ total: 4242 }) },
        rate_limit: null,
      }),
    });
    assert.equal(res.status, 200);
  } finally {
    await first.close();
  }

  assert.ok(fs.existsSync(dataFile), 'data file was not written');

  const second = await start({ port: 0, host: '127.0.0.1', dataFile, adminToken: ADMIN_TOKEN });
  try {
    const state = await fetch(`${second.url}/v1/state`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.equal(state.members.length, 1);
    assert.equal(state.members[0].windows.weekly.total, 4242);
  } finally {
    await second.close();
  }
});
