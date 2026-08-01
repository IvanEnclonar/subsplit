'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeCapacity } = require('../src/main/capacity.js');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function snapshot(windows) {
  return {
    ts: NOW,
    planType: 'plus',
    credits: null,
    windows: windows.map((w) => ({
      windowMinutes: w.minutes,
      usedPercent: w.used,
      resetsAt: w.resetsAt === undefined ? NOW + 3600e3 : w.resetsAt,
    })),
  };
}

/** members: { id: { weekly, '5h' } } — totals only, which is all capacity reads. */
function group(members, rateLimit) {
  return {
    server_time: NOW,
    etag: 'W/"1"',
    account_rate_limit: rateLimit === undefined ? null : rateLimit,
    members: Object.keys(members).map((id) => ({
      member_id: id,
      member_name: id,
      devices: [{ device_id: `${id}-1`, seen_ms_ago: 1000, stale: false }],
      windows: {
        weekly: { total: members[id].weekly, share_pct: 0 },
        '5h': { total: members[id]['5h'], share_pct: 0 },
      },
    })),
  };
}

function close(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message || 'value'}: expected ${expected}, got ${actual}`
  );
}

// ---------------------------------------------------------------------------
// the formula
// ---------------------------------------------------------------------------

test('capacity is the account gauge split by each member’s share of the group total', () => {
  const state = group(
    { ada: { weekly: 600, '5h': 30 }, bob: { weekly: 300, '5h': 10 }, cy: { weekly: 100, '5h': 0 } },
    snapshot([{ minutes: 10080, used: 60 }, { minutes: 300, used: 20 }])
  );

  const capacity = computeCapacity(state);

  assert.strictEqual(capacity.weekly.accountPct, 60);
  close(capacity.weekly.members.ada, 36, 'ada weekly');   // 60 × 600/1000
  close(capacity.weekly.members.bob, 18, 'bob weekly');
  close(capacity.weekly.members.cy, 6, 'cy weekly');

  assert.strictEqual(capacity['5h'].accountPct, 20);
  close(capacity['5h'].members.ada, 15, 'ada 5h');        // 20 × 30/40
  close(capacity['5h'].members.bob, 5, 'bob 5h');
  close(capacity['5h'].members.cy, 0, 'cy 5h');
});

test('member capacities add up to the account percentage', () => {
  const state = group(
    { ada: { weekly: 7, '5h': 1 }, bob: { weekly: 11, '5h': 2 }, cy: { weekly: 13, '5h': 3 } },
    snapshot([{ minutes: 10080, used: 41.5 }])
  );

  const members = computeCapacity(state).weekly.members;
  const sum = Object.keys(members).reduce((acc, id) => acc + members[id], 0);
  close(sum, 41.5, 'sum of capacities');
});

test('a sole member’s capacity is the account gauge itself', () => {
  const state = group(
    { ada: { weekly: 4200, '5h': 90 } },
    snapshot([{ minutes: 10080, used: 73 }, { minutes: 300, used: 12.5 }])
  );

  const capacity = computeCapacity(state);
  assert.strictEqual(capacity.weekly.members.ada, 73);
  assert.strictEqual(capacity['5h'].members.ada, 12.5);
});

// ---------------------------------------------------------------------------
// the null cases — never divide by zero, never invent a number
// ---------------------------------------------------------------------------

test('a zero group total yields null, not a division by zero', () => {
  const state = group(
    { ada: { weekly: 0, '5h': 0 }, bob: { weekly: 0, '5h': 0 } },
    snapshot([{ minutes: 10080, used: 60 }, { minutes: 300, used: 20 }])
  );

  assert.deepStrictEqual(computeCapacity(state), { '5h': null, weekly: null });
});

test('a window with a null used_percent yields null', () => {
  const state = group(
    { ada: { weekly: 100, '5h': 10 } },
    snapshot([{ minutes: 10080, used: null }, { minutes: 300, used: 20 }])
  );

  const capacity = computeCapacity(state);
  assert.strictEqual(capacity.weekly, null);
  assert.strictEqual(capacity['5h'].accountPct, 20);
});

test('a missing window in the snapshot yields null for that window only', () => {
  const state = group(
    { ada: { weekly: 100, '5h': 10 } },
    snapshot([{ minutes: 300, used: 20 }])
  );

  const capacity = computeCapacity(state);
  assert.strictEqual(capacity.weekly, null);
  assert.ok(capacity['5h']);
});

test('no account snapshot, no group, and junk input all yield both windows null', () => {
  const empty = { '5h': null, weekly: null };
  assert.deepStrictEqual(computeCapacity(group({ ada: { weekly: 5, '5h': 5 } }, null)), empty);
  assert.deepStrictEqual(computeCapacity(null), empty);
  assert.deepStrictEqual(computeCapacity(undefined), empty);
  assert.deepStrictEqual(computeCapacity({ members: 'nope', account_rate_limit: 7 }), empty);
});

test('windows are identified by window_minutes, never by position', () => {
  const state = group(
    { ada: { weekly: 100, '5h': 100 } },
    snapshot([{ minutes: 300, used: 20 }, { minutes: 10080, used: 60 }])
  );

  const capacity = computeCapacity(state);
  assert.strictEqual(capacity.weekly.accountPct, 60);
  assert.strictEqual(capacity['5h'].accountPct, 20);
});

// ---------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------

test('members without totals count as zero and never exceed the account gauge', () => {
  const state = {
    server_time: NOW,
    account_rate_limit: snapshot([{ minutes: 10080, used: 50 }]),
    members: [
      { member_id: 'ada', windows: { weekly: { total: 100 } } },
      { member_id: 'bob', windows: {} },
      { member_id: 'cy' },
      { member_id: 'dot', windows: { weekly: { total: -900 } } },
      null,
      { member_name: 'no id' },
    ],
  };

  const weekly = computeCapacity(state).weekly;
  assert.deepStrictEqual(Object.keys(weekly.members).sort(), ['ada', 'bob', 'cy', 'dot']);
  assert.strictEqual(weekly.members.ada, 50);
  assert.strictEqual(weekly.members.bob, 0);
  assert.strictEqual(weekly.members.dot, 0);
  for (const id of Object.keys(weekly.members)) {
    assert.ok(weekly.members[id] >= 0 && weekly.members[id] <= weekly.accountPct);
  }
});
