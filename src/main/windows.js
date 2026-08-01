'use strict';

/**
 * Window bucketing: turn a flat list of parser Deltas plus the freshest
 * RateSnapshot into 5-hour and weekly totals.
 *
 * Window bounds come from the rate-limit snapshot when it is still fresh
 * (`resetsAt > now`), because Codex windows are ROLLING/anchored to the first
 * request in the window, not fixed calendar buckets. When the snapshot is stale
 * or the window is unknown we fall back to a rolling `[now - w, now]` window
 * (with `now` quantised to a grid, so two devices scanning seconds apart still
 * report the same bound) and report `resets_at: null` / `used_percent: null`
 * rather than inventing bounds.
 *
 * @module windows
 */

/** Window key -> `window_minutes` as reported by Codex. */
const WINDOW_MINUTES = {
  '5h': 300,
  weekly: 10080,
};

const WINDOW_KEYS = ['5h', 'weekly'];

/** Coarsest quantisation grid for a rolling window bound. */
const MAX_GRID_MS = 15 * 60 * 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Find the snapshot window whose `windowMinutes` matches, never by slot position. */
function findWindow(rateSnapshot, windowMinutes) {
  if (!isPlainObject(rateSnapshot) || !Array.isArray(rateSnapshot.windows)) return null;
  for (const win of rateSnapshot.windows) {
    if (isPlainObject(win) && win.windowMinutes === windowMinutes) return win;
  }
  return null;
}

/**
 * Rolling-window lower bound, quantised so that two devices of the same member
 * agree on it. A raw `now - windowMs` moves with every scan, and the server
 * treats a materially newer window_start as a NEW window that resets the
 * member's accumulator — so unquantised bounds make a member's devices drop
 * each other, and make every rescan look like changed totals.
 * `now` is floored to a grid of a twentieth of the window, capped at 15 minutes
 * so the bound never reaches materially outside the window it stands for. (The
 * server additionally accepts window_starts within a quarter window of each
 * other as the same window, which covers devices landing either side of a grid
 * boundary.)
 */
function rollingWindowStart(now, windowMs) {
  const grid = Math.min(Math.max(60_000, Math.floor(windowMs / 20)), MAX_GRID_MS);
  return Math.floor(now / grid) * grid - windowMs;
}

function emptyTotals(windowStart, resetsAt, usedPercent) {
  return {
    window_start: windowStart,
    resets_at: resetsAt,
    used_percent: usedPercent,
    input: 0,
    cached_input: 0,
    output: 0,
    total: 0,
  };
}

/**
 * @param {Array<object>} allDeltas  every known Delta (see parser.js)
 * @param {object|null} rateSnapshot freshest RateSnapshot, or null
 * @param {number} [nowMs]           evaluation instant, defaults to Date.now()
 * @param {{ fallback?: boolean }} [options]
 *        `fallback: false` returns null for a window whose bounds are unknown
 *        instead of using a rolling window.
 * @returns {{ '5h': object|null, weekly: object|null }}
 */
function computeWindows(allDeltas, rateSnapshot, nowMs, options) {
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  const opts = isPlainObject(options) ? options : {};
  const fallback = opts.fallback !== false;
  const deltas = Array.isArray(allDeltas) ? allDeltas : [];

  const result = {};

  for (const key of WINDOW_KEYS) {
    const windowMinutes = WINDOW_MINUTES[key];
    const windowMs = windowMinutes * 60 * 1000;
    const snapWindow = findWindow(rateSnapshot, windowMinutes);

    let windowStart;
    let resetsAt;
    let usedPercent;

    if (
      snapWindow &&
      typeof snapWindow.resetsAt === 'number' &&
      Number.isFinite(snapWindow.resetsAt) &&
      snapWindow.resetsAt > now
    ) {
      resetsAt = snapWindow.resetsAt;
      windowStart = resetsAt - windowMs;
      usedPercent =
        typeof snapWindow.usedPercent === 'number' && Number.isFinite(snapWindow.usedPercent)
          ? snapWindow.usedPercent
          : null;
    } else if (fallback) {
      // Stale or unknown: rolling window, no server-reported percentage. The
      // bound is quantised so concurrent devices report the same window_start.
      windowStart = rollingWindowStart(now, windowMs);
      resetsAt = null;
      usedPercent = null;
    } else {
      result[key] = null;
      continue;
    }

    const totals = emptyTotals(windowStart, resetsAt, usedPercent);
    for (const delta of deltas) {
      if (!isPlainObject(delta)) continue;
      const ts = delta.ts;
      if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
      if (ts < windowStart || ts > now) continue;
      // `cachedInput` is a SUBSET of `input`, not additive — summed separately.
      totals.input += finiteNumber(delta.input);
      totals.cached_input += finiteNumber(delta.cachedInput);
      totals.output += finiteNumber(delta.output);
      totals.total += finiteNumber(delta.total);
    }
    result[key] = totals;
  }

  return result;
}

module.exports = {
  computeWindows,
  WINDOW_MINUTES,
};
