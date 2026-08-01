'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computePace, MAX_PROJECTED_PCT } = require('../src/main/pace.js');

const NOW = 1_700_000_000_000;
const FIVE_H = 300 * 60 * 1000;
const WEEK = 10080 * 60 * 1000;

/** groupState carrying only what pace reads: the account rate snapshot. */
function groupWith(windows) {
  return {
    server_time: NOW,
    members: [],
    account_rate_limit: { ts: NOW, planType: 'plus', credits: null, windows },
  };
}

/** A window `elapsed` into its span, at `usedPercent`. */
function window(windowMinutes, usedPercent, elapsedMs) {
  const span = windowMinutes * 60 * 1000;
  return { windowMinutes, usedPercent, resetsAt: NOW - elapsedMs + span };
}

test('a window half gone at 30% is on pace for 60%, and never hits the limit', () => {
  const pace = computePace(groupWith([window(300, 30, FIVE_H / 2)]), NOW);

  assert.ok(Math.abs(pace['5h'].elapsedFraction - 0.5) < 1e-9);
  assert.ok(Math.abs(pace['5h'].projectedPct - 60) < 1e-9);
  assert.strictEqual(pace['5h'].hitsAtMs, null, 'under 100% projected: no hit time');
  assert.strictEqual(pace.weekly, null, 'no weekly snapshot, no weekly pace');
});

test('a window projected past 100% carries the moment it gets there', () => {
  // A quarter gone, 50% used -> 200% projected, 100% reached at the halfway mark.
  const pace = computePace(groupWith([window(300, 50, FIVE_H / 4)]), NOW);

  assert.ok(Math.abs(pace['5h'].projectedPct - 200) < 1e-9);
  const windowStart = NOW - FIVE_H / 4;
  assert.ok(Math.abs(pace['5h'].hitsAtMs - (windowStart + FIVE_H / 2)) < 1e-6);
  assert.ok(pace['5h'].hitsAtMs > NOW, 'it has not happened yet');
});

test('already at or past 100% hits the limit now, not in the past', () => {
  for (const used of [100, 137]) {
    const pace = computePace(groupWith([window(300, used, FIVE_H / 2)]), NOW);
    assert.strictEqual(pace['5h'].hitsAtMs, NOW, `used_percent ${used}`);
  }
});

test('a stale (rolled-over) snapshot projects nothing', () => {
  const rolledOver = { windowMinutes: 300, usedPercent: 80, resetsAt: NOW - 1 };
  const exactlyNow = { windowMinutes: 10080, usedPercent: 80, resetsAt: NOW };

  const pace = computePace(groupWith([rolledOver, exactlyNow]), NOW);
  assert.strictEqual(pace['5h'], null);
  assert.strictEqual(pace.weekly, null);
});

test('an early window is too noisy to project', () => {
  const tooEarly = computePace(groupWith([window(300, 4, FIVE_H * 0.09)]), NOW);
  assert.strictEqual(tooEarly['5h'], null);

  // The 10% mark is where it starts reporting.
  const justEnough = computePace(groupWith([window(300, 4, FIVE_H * 0.1)]), NOW);
  assert.ok(justEnough['5h']);
  assert.ok(Math.abs(justEnough['5h'].projectedPct - 40) < 1e-6);
});

test('nothing used yet projects nothing', () => {
  for (const used of [0, -3]) {
    const pace = computePace(groupWith([window(300, used, FIVE_H / 2)]), NOW);
    assert.strictEqual(pace['5h'], null, `used_percent ${used}`);
  }
});

test('a missing or non-numeric used_percent projects nothing', () => {
  const cases = [
    { windowMinutes: 300, usedPercent: null, resetsAt: NOW + FIVE_H },
    { windowMinutes: 300, resetsAt: NOW + FIVE_H },
    { windowMinutes: 300, usedPercent: '40', resetsAt: NOW + FIVE_H },
    { windowMinutes: 300, usedPercent: 40, resetsAt: null },
  ];
  for (const win of cases) {
    assert.strictEqual(computePace(groupWith([win]), NOW)['5h'], null, JSON.stringify(win));
  }
});

test('the projection is capped for display sanity', () => {
  // 10% of the window gone, 99% of the quota burned -> 990%… then 9900%.
  const sane = computePace(groupWith([window(300, 99, FIVE_H * 0.1)]), NOW);
  assert.ok(Math.abs(sane['5h'].projectedPct - 990) < 1e-6);

  const absurd = computePace(groupWith([window(300, 990, FIVE_H * 0.1)]), NOW);
  assert.strictEqual(absurd['5h'].projectedPct, MAX_PROJECTED_PCT);
  assert.strictEqual(absurd['5h'].hitsAtMs, NOW, 'well past the limit already');
});

test('the projection the renderer prints is the one it thresholds on', () => {
  // 25% used a quarter of the way in, but a hair short: 99.6% projected. The
  // renderer prints Math.round(projectedPct), so an unrounded value here reads
  // "on pace for ~100%" with no warn tint and no hit time — three signals
  // disagreeing at the only boundary that matters.
  const elapsed = FIVE_H * 0.251;
  const pace = computePace(groupWith([window(300, 25, elapsed)]), NOW)['5h'];

  assert.strictEqual(pace.projectedPct, Math.round(pace.projectedPct), 'a whole number');
  assert.strictEqual(pace.projectedPct, 100);
  assert.ok(pace.hitsAtMs != null, 'what says 100% must carry the moment it gets there');

  // And just below it, everything agrees the other way.
  const under = computePace(groupWith([window(300, 24, elapsed)]), NOW)['5h'];
  assert.strictEqual(under.projectedPct, 96);
  assert.strictEqual(under.hitsAtMs, null);
});

test('the two windows are projected independently', () => {
  const pace = computePace(
    groupWith([window(300, 60, FIVE_H * 0.25), window(10080, 20, WEEK * 0.8)]),
    NOW
  );

  assert.ok(Math.abs(pace['5h'].projectedPct - 240) < 1e-9);
  assert.ok(pace['5h'].hitsAtMs > NOW);
  assert.ok(Math.abs(pace.weekly.projectedPct - 25) < 1e-9);
  assert.strictEqual(pace.weekly.hitsAtMs, null);
});

test('malformed input is null, never an exception', () => {
  const empty = { '5h': null, weekly: null };
  assert.deepStrictEqual(computePace(null, NOW), empty);
  assert.deepStrictEqual(computePace({}, NOW), empty);
  assert.deepStrictEqual(computePace({ account_rate_limit: {} }, NOW), empty);
  assert.deepStrictEqual(computePace({ account_rate_limit: { windows: 'no' } }, NOW), empty);
  assert.deepStrictEqual(computePace(groupWith([null, 7, {}]), NOW), empty);
  // Windows are matched by window_minutes, never by slot position.
  assert.deepStrictEqual(computePace(groupWith([window(60, 50, 30 * 60e3)]), NOW), empty);
});
