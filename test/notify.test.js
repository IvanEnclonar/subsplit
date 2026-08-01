'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { computeCapacity } = require('../src/main/capacity.js');
const { evaluateAlerts, humanizeDuration } = require('../src/main/notify.js');
const settingsStore = require('../src/main/settings.js');

const NOW = 1_700_000_000_000;
const WEEKLY_RESET = NOW + 2 * 24 * 3600e3 + 4 * 3600e3;
const FIVE_RESET = NOW + 3 * 3600e3 + 42 * 60e3;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A group where `me` holds `mineShare` of the total and the account gauges read
 * `weeklyPct` / `fivePct`. Capacity comes from the real module, so these tests
 * exercise the same numbers the app shows.
 */
function scenario(options) {
  const opts = options || {};
  const others = opts.others === undefined ? 3 : opts.others;
  const mine = opts.mine === undefined ? 400 : opts.mine;
  const each = opts.each === undefined ? 200 : opts.each;

  const members = [
    {
      member_id: 'me',
      member_name: 'Me',
      windows: { weekly: { total: mine }, '5h': { total: mine } },
    },
  ];
  for (let i = 0; i < others; i += 1) {
    members.push({
      member_id: `other-${i}`,
      member_name: `Other ${i}`,
      windows: { weekly: { total: each }, '5h': { total: each } },
    });
  }

  const windows = [];
  if (opts.weeklyPct !== null) {
    windows.push({
      windowMinutes: 10080,
      usedPercent: opts.weeklyPct === undefined ? 80 : opts.weeklyPct,
      resetsAt: opts.weeklyReset === undefined ? WEEKLY_RESET : opts.weeklyReset,
    });
  }
  if (opts.fivePct !== null && opts.fivePct !== undefined) {
    windows.push({ windowMinutes: 300, usedPercent: opts.fivePct, resetsAt: FIVE_RESET });
  }

  return {
    server_time: NOW,
    etag: 'W/"1"',
    members,
    account_rate_limit: { ts: NOW, planType: 'plus', credits: null, windows },
  };
}

function evaluate(groupState, settings, extra) {
  return evaluateAlerts(
    Object.assign(
      {
        capacity: computeCapacity(groupState),
        groupState,
        settings: settings || {},
        memberId: 'me',
        nowMs: NOW,
      },
      extra || {}
    )
  );
}

// ---------------------------------------------------------------------------
// firing
// ---------------------------------------------------------------------------

test('an alert fires when my capacity share reaches the explicit threshold', () => {
  // 4 members, mine 400 of 1000 → 80% × 0.4 = 32% of the weekly limit.
  const result = evaluate(scenario(), { notifyPct: { weekly: 32, '5h': null } });

  assert.strictEqual(result.alerts.length, 1);
  const alert = result.alerts[0];
  assert.strictEqual(alert.windowKey, 'weekly');
  assert.strictEqual(alert.effectivePct, 32);
  assert.ok(Math.abs(alert.capacityPct - 32) < 1e-9);
  assert.ok(alert.title.length > 0);
  assert.strictEqual(
    alert.body,
    "You've used ~32% of the account's weekly limit (alert at 32%). Resets in 2d 4h."
  );
  assert.ok(!/ss_/.test(alert.body + alert.title), 'no token material ever reaches a toast');
});

test('nothing fires below the threshold', () => {
  const result = evaluate(scenario(), { notifyPct: { weekly: 33, '5h': null } });
  assert.deepStrictEqual(result.alerts, []);
  assert.deepStrictEqual(result.prunedLatch, {});
});

test('AUTO uses the fair share, 100/N, recomputed as the group grows', () => {
  // 3 members → fair share 33.3%, mine is 80 × 400/800 = 40% → fires.
  const small = evaluate(scenario({ others: 2 }), {});
  assert.strictEqual(small.alerts.length, 1);
  assert.ok(Math.abs(small.alerts[0].effectivePct - 100 / 3) < 1e-9);
  assert.strictEqual(
    small.alerts[0].body,
    "You've used ~40% of the account's weekly limit (alert at 33%). Resets in 2d 4h."
  );

  // 9 members later, the same person is at 80 × 400/2000 = 16% against a fair
  // share of 11.1% → still over.
  const grown = evaluate(scenario({ others: 8 }), {});
  assert.strictEqual(grown.alerts.length, 1);
  assert.ok(Math.abs(grown.alerts[0].effectivePct - 100 / 9) < 1e-9);

  // …but at an even split nobody is over their fair share.
  const even = evaluate(scenario({ mine: 200 }), {});
  assert.deepStrictEqual(even.alerts, []);
});

test('the two windows carry independent thresholds', () => {
  const groupState = scenario({ weeklyPct: 80, fivePct: 50 });
  // weekly capacity 32%, 5h capacity 20%.
  const result = evaluate(groupState, { notifyPct: { weekly: 90, '5h': 20 } });

  assert.strictEqual(result.alerts.length, 1);
  assert.strictEqual(result.alerts[0].windowKey, '5h');
  assert.strictEqual(result.alerts[0].effectivePct, 20);
  assert.match(result.alerts[0].body, /the account's 5h limit \(alert at 20%\)/);

  const both = evaluate(groupState, { notifyPct: { weekly: 30, '5h': 20 } });
  assert.deepStrictEqual(both.alerts.map((a) => a.windowKey), ['5h', 'weekly']);
});

// ---------------------------------------------------------------------------
// the latch
// ---------------------------------------------------------------------------

test('the latch stops the same alert firing twice for one window instance', () => {
  const groupState = scenario();
  const first = evaluate(groupState, { notifyPct: { weekly: 32, '5h': null } });
  assert.strictEqual(first.alerts.length, 1);
  assert.strictEqual(first.prunedLatch[first.alerts[0].latchKey], WEEKLY_RESET);

  const second = evaluate(groupState, {
    notifyPct: { weekly: 32, '5h': null },
    notifyLatch: first.prunedLatch,
  });
  assert.deepStrictEqual(second.alerts, []);
  assert.deepStrictEqual(second.prunedLatch, first.prunedLatch);
});

test('a new window instance (a later resets_at) re-arms the alert', () => {
  const first = evaluate(scenario(), { notifyPct: { weekly: 32, '5h': null } });

  const nextReset = WEEKLY_RESET + 7 * 24 * 3600e3;
  const second = evaluate(scenario({ weeklyReset: nextReset }), {
    notifyPct: { weekly: 32, '5h': null },
    notifyLatch: first.prunedLatch,
  });

  assert.strictEqual(second.alerts.length, 1);
  assert.notStrictEqual(second.alerts[0].latchKey, first.alerts[0].latchKey);
  assert.strictEqual(second.prunedLatch[second.alerts[0].latchKey], nextReset);
});

test('changing the threshold re-arms the alert', () => {
  const groupState = scenario();
  const first = evaluate(groupState, { notifyPct: { weekly: 32, '5h': null } });
  const second = evaluate(groupState, {
    notifyPct: { weekly: 25, '5h': null },
    notifyLatch: first.prunedLatch,
  });

  assert.strictEqual(second.alerts.length, 1);
  assert.strictEqual(second.alerts[0].effectivePct, 25);
});

test('a stale snapshot whose window already reset still only alerts once', () => {
  // The weekly window rolled over 90 minutes ago and nobody has run Codex
  // since, so no fresher snapshot exists. Latching on that past resets_at would
  // expire the record immediately and the toast would repeat on every rescan.
  const groupState = scenario({ weeklyReset: NOW - 90 * 60e3 });
  const options = { notifyPct: { weekly: 32, '5h': null } };

  const first = evaluate(groupState, options);
  assert.strictEqual(first.alerts.length, 1);
  assert.ok(first.prunedLatch[first.alerts[0].latchKey] > NOW, 'the latch must outlive this pass');

  let latch = first.prunedLatch;
  let fired = 0;
  for (let pass = 1; pass <= 5; pass += 1) {
    const later = evaluateAlerts({
      capacity: computeCapacity(groupState),
      groupState,
      settings: Object.assign({}, options, { notifyLatch: latch }),
      memberId: 'me',
      nowMs: NOW + pass * 5 * 60e3, // the 5-minute safety rescan
      syncError: null,
    });
    fired += later.alerts.length;
    latch = later.prunedLatch;
  }
  assert.strictEqual(fired, 0, 'a stale gauge must not re-fire every rescan');
});

test('a resets_at that drifts inside one window does not re-arm the alert', () => {
  // Legacy Codex builds report `resets_in_seconds`, which parser.js turns into
  // eventTs + seconds × 1000 — so the same 5h window is reported a few hundred
  // milliseconds apart on every turn.
  const first = evaluate(scenario({ weeklyPct: null, fivePct: 50 }), {
    notifyPct: { weekly: null, '5h': 20 },
  });
  assert.strictEqual(first.alerts.length, 1);

  const drifted = {
    server_time: NOW,
    etag: 'W/"2"',
    members: scenario().members,
    account_rate_limit: {
      ts: NOW,
      planType: 'plus',
      credits: null,
      windows: [{ windowMinutes: 300, usedPercent: 50, resetsAt: FIVE_RESET + 432 }],
    },
  };
  const second = evaluate(drifted, {
    notifyPct: { weekly: null, '5h': 20 },
    notifyLatch: first.prunedLatch,
  });

  assert.deepStrictEqual(second.alerts, []);
  assert.strictEqual(Object.keys(second.prunedLatch).length, 1, 'one record per window instance');
});

test('latch records for windows that have already reset are pruned every evaluation', () => {
  const stale = { 'weekly|1|25': NOW - 1000, 'weekly|2|25': NOW, '5h|3|50': NOW + 5000 };
  const result = evaluate(scenario({ weeklyPct: 1 }), {
    notifyPct: { weekly: 100, '5h': null },
    notifyLatch: stale,
  });

  assert.deepStrictEqual(result.prunedLatch, { '5h|3|50': NOW + 5000 });
});

// ---------------------------------------------------------------------------
// suppression
// ---------------------------------------------------------------------------

test('nothing fires when alerts are disabled', () => {
  const result = evaluate(scenario(), {
    notifyEnabled: false,
    notifyPct: { weekly: 1, '5h': 1 },
  });
  assert.deepStrictEqual(result.alerts, []);
});

test('nothing fires while sync is failing — the numbers may be stale', () => {
  const result = evaluate(
    scenario(),
    { notifyPct: { weekly: 32, '5h': null } },
    { syncError: { code: 'network', message: 'Cannot reach the group server' } }
  );
  assert.deepStrictEqual(result.alerts, []);
  // …and the alert is still waiting once sync recovers.
  const recovered = evaluate(scenario(), {
    notifyPct: { weekly: 32, '5h': null },
    notifyLatch: result.prunedLatch,
  });
  assert.strictEqual(recovered.alerts.length, 1);
});

test('a window with no capacity, and an unknown member, produce nothing', () => {
  const noGauge = evaluate(scenario({ weeklyPct: null }), { notifyPct: { weekly: 1, '5h': null } });
  assert.deepStrictEqual(noGauge.alerts, []);

  const stranger = evaluate(scenario(), { notifyPct: { weekly: 1, '5h': null } }, { memberId: 'nobody' });
  assert.deepStrictEqual(stranger.alerts, []);

  const anonymous = evaluate(scenario(), { notifyPct: { weekly: 1, '5h': null } }, { memberId: '' });
  assert.deepStrictEqual(anonymous.alerts, []);

  assert.deepStrictEqual(evaluateAlerts(null), { alerts: [], prunedLatch: {} });
});

// ---------------------------------------------------------------------------
// wording
// ---------------------------------------------------------------------------

test('humanizeDuration reads like the popover countdown', () => {
  assert.strictEqual(humanizeDuration(2 * 86400e3 + 4 * 3600e3), '2d 4h');
  assert.strictEqual(humanizeDuration(3 * 3600e3 + 42 * 60e3), '3h 42m');
  assert.strictEqual(humanizeDuration(9 * 60e3 + 30e3), '9m');
  assert.strictEqual(humanizeDuration(40e3), '40s');
  assert.strictEqual(humanizeDuration(0), 'a moment');
  assert.strictEqual(humanizeDuration(null), 'a moment');
});

// ---------------------------------------------------------------------------
// settings persistence of the new keys
// ---------------------------------------------------------------------------

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsplit-notify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the alert settings default to enabled with AUTO thresholds', () => {
  const defaults = settingsStore.defaultSettings();
  assert.strictEqual(defaults.notifyEnabled, true);
  assert.deepStrictEqual(defaults.notifyPct, { '5h': null, weekly: null });
  assert.deepStrictEqual(defaults.notifyLatch, {});
});

test('invalid thresholds normalize back to AUTO', (t) => {
  const dir = tempDir(t);
  const saved = settingsStore.saveSettings(
    { notifyPct: { weekly: 0, '5h': 101 } },
    dir
  );
  assert.deepStrictEqual(saved.notifyPct, { '5h': null, weekly: null });

  const junk = settingsStore.saveSettings(
    { notifyPct: { weekly: 12.5, '5h': 'soon' } },
    dir
  );
  assert.deepStrictEqual(junk.notifyPct, { '5h': null, weekly: null });

  // Coerced like `seq` is, so a hand-edited settings.json still works.
  assert.deepStrictEqual(
    settingsStore.saveSettings({ notifyPct: { weekly: '80', '5h': null } }, dir).notifyPct,
    { '5h': null, weekly: 80 }
  );

  const good = settingsStore.saveSettings({ notifyPct: { weekly: 40, '5h': 1 } }, dir);
  assert.deepStrictEqual(good.notifyPct, { '5h': 1, weekly: 40 });

  const gone = settingsStore.saveSettings({ notifyPct: 'nope' }, dir);
  assert.deepStrictEqual(gone.notifyPct, { '5h': null, weekly: null });
});

test('unknown keys — including unknown notifyPct windows — are dropped', (t) => {
  const dir = tempDir(t);
  const saved = settingsStore.saveSettings(
    {
      notifyEnabled: false,
      notifyPct: { weekly: 40, '5h': 20, monthly: 10, __proto__: 'x' },
      notifySound: 'ping',
      evil: true,
    },
    dir
  );

  assert.strictEqual(saved.notifyEnabled, false);
  assert.deepStrictEqual(Object.keys(saved.notifyPct).sort(), ['5h', 'weekly']);
  assert.deepStrictEqual(Object.keys(saved).sort(), Object.keys(settingsStore.defaultSettings()).sort());
  assert.strictEqual(saved.notifySound, undefined);
  assert.strictEqual(saved.evil, undefined);

  // A non-boolean toggle falls back to the default rather than being coerced.
  assert.strictEqual(settingsStore.saveSettings({ notifyEnabled: 'yes' }, dir).notifyEnabled, true);
});

test('the latch survives a round trip and drops unusable records', (t) => {
  const dir = tempDir(t);
  const saved = settingsStore.saveSettings(
    { notifyLatch: { 'weekly|123|25': 123, bad: 'soon', worse: -1, nope: null } },
    dir
  );
  assert.deepStrictEqual(saved.notifyLatch, { 'weekly|123|25': 123 });
  assert.deepStrictEqual(settingsStore.loadSettings(dir).notifyLatch, { 'weekly|123|25': 123 });
});
