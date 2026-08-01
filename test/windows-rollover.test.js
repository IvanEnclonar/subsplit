'use strict';

/**
 * Rolling-fallback window bounds (src/main/windows.js).
 *
 * When the rate-limit snapshot carries no fresh window for a key, computeWindows
 * bounds that window against the wall clock. Two devices of one member never scan
 * at the same instant, and the server treats a newer `window_start` as a NEW
 * window that resets the member's accumulator — so an unquantised bound makes a
 * member's own devices drop each other from the group sums. These tests pin the
 * quantisation that keeps independent devices in agreement.
 *
 * The snapshot-anchored path is covered by test/parser.test.js; only the fallback
 * is exercised here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeWindows } = require('../src/main/windows');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Quantisation grid: a twentieth of the 5h window, and the cap for weekly. */
const GRID = 15 * MINUTE;

const WINDOW_MS = {
  '5h': 5 * HOUR,
  weekly: 7 * DAY,
};

/** A deliberately un-round instant, well inside a grid cell. */
const BASE = Date.parse('2026-07-15T12:07:23.412Z');

function delta(ts, total) {
  return {
    threadId: 't',
    ts,
    model: 'gpt-5.5',
    input: total,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 0,
    reasoningOutput: 0,
    total,
  };
}

test('two devices scanning 90s apart report the same fallback window_start', () => {
  const laptop = computeWindows([], null, BASE);
  const desktop = computeWindows([], null, BASE + 90 * 1000);

  for (const key of ['5h', 'weekly']) {
    assert.equal(
      laptop[key].window_start,
      desktop[key].window_start,
      `${key}: devices scanning seconds apart must agree, or the server drops one of them`
    );
  }

  // A third scan later in the same grid cell agrees too, and the value is stable
  // across rescans (which also keeps the push change-detection key stable).
  const again = computeWindows([], null, BASE + 4 * MINUTE);
  assert.equal(again['5h'].window_start, laptop['5h'].window_start);
  assert.equal(again.weekly.window_start, laptop.weekly.window_start);
});

test('the fallback window_start is floored to the grid, never later than now - w', () => {
  for (const key of ['5h', 'weekly']) {
    const windowMs = WINDOW_MS[key];
    const out = computeWindows([], null, BASE);
    const expected = Math.floor(BASE / GRID) * GRID - windowMs;

    assert.equal(out[key].window_start, expected, `${key}: window_start must be quantised`);
    assert.ok(
      out[key].window_start <= BASE - windowMs,
      `${key}: the bound must not cut into the window it stands for`
    );
    assert.ok(
      BASE - windowMs - out[key].window_start < GRID,
      `${key}: the bound must not reach more than one grid step outside the window`
    );
    assert.equal((out[key].window_start + windowMs) % GRID, 0, `${key}: window_start is off-grid`);
    assert.equal(out[key].resets_at, null);
    assert.equal(out[key].used_percent, null);
  }
});

test('the window_start advances by exactly one grid step across a boundary', () => {
  const cellStart = Math.floor(BASE / GRID) * GRID;
  const before = computeWindows([], null, cellStart + GRID - 1);
  const after = computeWindows([], null, cellStart + GRID);

  for (const key of ['5h', 'weekly']) {
    assert.equal(after[key].window_start - before[key].window_start, GRID);
  }
});

test('quantising the bound never drops usage from the window', () => {
  const now = BASE;
  const deltas = [
    delta(now - 5 * HOUR + 1, 100), // just inside the true 5h window
    delta(now - 30 * MINUTE, 200),
    delta(now - 6 * HOUR, 400), // outside 5h, inside weekly
    delta(now + MINUTE, 800), // in the future: excluded from both
  ];

  const out = computeWindows(deltas, null, now);
  assert.equal(out['5h'].total, 300);
  assert.equal(out.weekly.total, 700);
});

test('a fresh snapshot window is still anchored to resets_at, not quantised', () => {
  const now = BASE;
  const snapshot = {
    ts: now - MINUTE,
    windows: [{ windowMinutes: 300, usedPercent: 38, resetsAt: now + 77 * 1000 }],
    planType: 'plus',
    credits: null,
  };

  const out = computeWindows([], snapshot, now);
  assert.equal(out['5h'].window_start, now + 77 * 1000 - 5 * HOUR);
  assert.equal(out['5h'].resets_at, now + 77 * 1000);
  assert.equal(out['5h'].used_percent, 38);

  // …while the weekly window, absent from the snapshot, takes the quantised bound.
  assert.equal(out.weekly.window_start, Math.floor(now / GRID) * GRID - 7 * DAY);
});

test('a snapshot whose window has already reset falls back to the quantised bound', () => {
  const now = BASE;
  const stale = {
    ts: now - DAY,
    windows: [{ windowMinutes: 300, usedPercent: 90, resetsAt: now - HOUR }],
    planType: 'plus',
    credits: null,
  };

  const first = computeWindows([], stale, now);
  const second = computeWindows([], stale, now + 90 * 1000);
  assert.equal(first['5h'].window_start, Math.floor(now / GRID) * GRID - 5 * HOUR);
  assert.equal(first['5h'].window_start, second['5h'].window_start);
  assert.equal(first['5h'].used_percent, null, 'a reset window reports no percentage');
});
