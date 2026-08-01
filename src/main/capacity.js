'use strict';

// Capacity share — a member's estimated slice of the ACCOUNT limit.
//
//   capacity(member, window) = account used_percent(window)
//                            × (member window total / group window total)
//
// This is the single source of truth for that formula: it is computed here, in
// the main process, and shipped to the renderer inside UiState. Nothing else
// may recompute it.
//
// Pure — no Electron, no I/O.

const WINDOW_KEYS = ['5h', 'weekly'];
const WINDOW_MINUTES = { '5h': 300, weekly: 10080 };

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Strict on purpose: `Number(null)` is 0, and a null used_percent means "no
// gauge", not "0% used".
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Account-wide used% for a window, identified by window_minutes — never by slot. */
function accountPercentFor(groupState, windowMinutes) {
  const snapshot = isPlainObject(groupState) ? groupState.account_rate_limit : null;
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.windows)) return null;
  for (const win of snapshot.windows) {
    if (isPlainObject(win) && win.windowMinutes === windowMinutes) {
      return finite(win.usedPercent);
    }
  }
  return null;
}

function memberTotal(member, key) {
  const win = isPlainObject(member) && isPlainObject(member.windows) ? member.windows[key] : null;
  if (!isPlainObject(win)) return 0;
  const total = finite(win.total);
  return total != null && total > 0 ? total : 0;
}

function membersOf(groupState) {
  if (!isPlainObject(groupState) || !Array.isArray(groupState.members)) return [];
  return groupState.members.filter((m) => isPlainObject(m) && m.member_id);
}

/**
 * computeCapacity(groupState) ->
 *   { "5h": CapacityWindow|null, "weekly": CapacityWindow|null }
 *   CapacityWindow = { accountPct: number, members: { [member_id]: pct } }
 *
 * A window is null when the account snapshot has nothing for it, its
 * used_percent is null, or the group total for that window is 0 — the last one
 * is what keeps the division safe.
 */
function computeCapacity(groupState) {
  const out = { '5h': null, weekly: null };

  for (const key of WINDOW_KEYS) {
    const raw = accountPercentFor(groupState, WINDOW_MINUTES[key]);
    if (raw == null) continue;
    const accountPct = Math.max(0, raw);

    const list = membersOf(groupState);
    let groupTotal = 0;
    for (const member of list) groupTotal += memberTotal(member, key);
    if (groupTotal <= 0) continue;

    const members = {};
    for (const member of list) {
      const pct = accountPct * (memberTotal(member, key) / groupTotal);
      members[member.member_id] = Math.min(accountPct, Math.max(0, pct));
    }
    out[key] = { accountPct, members };
  }

  return out;
}

module.exports = { WINDOW_KEYS, WINDOW_MINUTES, computeCapacity };
