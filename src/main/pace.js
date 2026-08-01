'use strict';

// Pace — "at this rate" for the ACCOUNT rate-limit windows.
//
//   projected used% = used_percent / elapsed fraction of the window
//
// Percent is projected from percent only: token counts are metered on a formula
// OpenAI does not publish, so mixing them into this would invent precision that
// is not there.
//
// Pure — no Electron, no I/O.

const WINDOW_KEYS = ['5h', 'weekly'];
const WINDOW_MINUTES = { '5h': 300, weekly: 10080 };

/** Below this the window is too young for the average to mean anything. */
const MIN_ELAPSED_FRACTION = 0.1;
/** Display sanity: a 1%-elapsed window can project absurd numbers. */
const MAX_PROJECTED_PCT = 999;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Snapshot window for `windowMinutes`, identified by value — never by slot. */
function findWindow(groupState, windowMinutes) {
  const snapshot = isPlainObject(groupState) ? groupState.account_rate_limit : null;
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.windows)) return null;
  for (const win of snapshot.windows) {
    if (isPlainObject(win) && win.windowMinutes === windowMinutes) return win;
  }
  return null;
}

/**
 * computePace(groupState, nowMs) ->
 *   { "5h": Pace|null, "weekly": Pace|null }
 *   Pace = { projectedPct, hitsAtMs: number|null, elapsedFraction }
 *
 * A window is null unless the account snapshot has a numeric used_percent for
 * it AND a `resets_at` still in the future — a stale snapshot describes a window
 * that has already rolled over, and projecting from it would be fiction.
 */
function computePace(groupState, nowMs) {
  const now = finite(nowMs) != null ? nowMs : Date.now();
  const out = { '5h': null, weekly: null };

  for (const key of WINDOW_KEYS) {
    const windowMs = WINDOW_MINUTES[key] * 60 * 1000;
    const win = findWindow(groupState, WINDOW_MINUTES[key]);
    if (!win) continue;

    const usedPct = finite(win.usedPercent);
    const resetsAt = finite(win.resetsAt);
    if (usedPct == null || resetsAt == null) continue;
    if (resetsAt <= now) continue;
    if (usedPct <= 0) continue;

    const windowStart = resetsAt - windowMs;
    const elapsed = now - windowStart;
    const elapsedFraction = Math.min(1, Math.max(0, elapsed / windowMs));
    if (elapsedFraction < MIN_ELAPSED_FRACTION) continue;

    // Rounded once, here. The renderer prints this number, tints on it and shows
    // the hit time from it, so anything left unrounded lets 99.6 print as "100%"
    // with no warning and no hit time — three signals contradicting each other
    // at the one boundary the whole feature turns on.
    const projectedPct = Math.min(MAX_PROJECTED_PCT, Math.round(usedPct / elapsedFraction));

    let hitsAtMs = null;
    if (projectedPct >= 100) {
      // Already there: it hits the limit now, not at some point in the past.
      hitsAtMs = usedPct >= 100 ? now : windowStart + elapsed * (100 / usedPct);
    }

    out[key] = { projectedPct, hitsAtMs, elapsedFraction };
  }

  return out;
}

module.exports = {
  WINDOW_KEYS,
  WINDOW_MINUTES,
  MIN_ELAPSED_FRACTION,
  MAX_PROJECTED_PCT,
  computePace,
};
