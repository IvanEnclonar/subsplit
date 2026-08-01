'use strict';

// Usage alerts — decides WHICH toasts should fire, never fires them.
//
// Pure (no Electron, no I/O) so the rules are unit-testable: index.js hands the
// result to `new Notification(...)` and persists the returned latch.
//
// The latch is what makes an alert fire once per window instance per threshold:
// it is keyed by windowKey + the window's resets_at + the effective threshold,
// so a new window (a later resets_at) or a changed threshold re-arms it, and a
// rescan five seconds later does not. Each record stores the moment it stops
// applying, which is the window's reset — or a full window from now when the
// snapshot has already rolled over and there is nothing fresher to read.
//
// Nothing that identifies the group — least of all the join token — is allowed
// anywhere near this text.

const { WINDOW_KEYS, WINDOW_MINUTES } = require('./capacity');

const WINDOW_LABEL = { '5h': '5h', weekly: 'weekly' };

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Strict: a null threshold means AUTO, not zero.
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Milliseconds → "2d 4h" / "3h 42m" / "12m" / "40s". Main has no formatter of
 *  its own; this mirrors the renderer's countdown wording. */
function humanizeDuration(ms) {
  const left = finite(ms);
  if (left == null || left <= 0) return 'a moment';
  const s = Math.floor(left / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function resetsAtFor(groupState, windowMinutes) {
  const snapshot = isPlainObject(groupState) ? groupState.account_rate_limit : null;
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.windows)) return null;
  for (const win of snapshot.windows) {
    if (isPlainObject(win) && win.windowMinutes === windowMinutes) return finite(win.resetsAt);
  }
  return null;
}

function memberCount(groupState) {
  if (!isPlainObject(groupState) || !Array.isArray(groupState.members)) return 0;
  return groupState.members.filter((m) => isPlainObject(m) && m.member_id).length;
}

/** An explicit per-window threshold, or AUTO = fair share = 100 / members. */
function effectiveThreshold(settings, key, groupState) {
  const configured = isPlainObject(settings) && isPlainObject(settings.notifyPct)
    ? finite(settings.notifyPct[key])
    : null;
  if (configured != null && Number.isInteger(configured) && configured >= 1 && configured <= 100) {
    return configured;
  }
  const n = memberCount(groupState);
  return 100 / (n > 0 ? n : 1);
}

/** Drop latch records whose window has already reset — they can never match again. */
function pruneLatch(latch, nowMs) {
  const out = {};
  if (!isPlainObject(latch)) return out;
  for (const key of Object.keys(latch)) {
    const resetsAt = finite(latch[key]);
    if (resetsAt != null && resetsAt > nowMs) out[key] = resetsAt;
  }
  return out;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Is this window instance already latched?
 *
 * The exact key covers the ordinary case. The tolerance sweep covers a window
 * that is reported with a slightly different `resets_at` each time: legacy Codex
 * builds send `resets_in_seconds`, which parser.js turns into
 * `eventTs + seconds × 1000`, so every turn inside one window yields a value a
 * few hundred milliseconds off the last. Two records are the same window
 * instance when their expiry is within a quarter window — the tolerance the
 * server already uses to merge `window_start`s — which is far below the gap
 * between consecutive windows.
 */
function isLatched(latch, latchKey, windowKey, threshold, expiresAt, windowMs) {
  if (Object.prototype.hasOwnProperty.call(latch, latchKey)) return true;
  const tolerance = windowMs / 4;
  const label = String(threshold);
  for (const key of Object.keys(latch)) {
    const parts = key.split('|');
    if (parts.length !== 3 || parts[0] !== windowKey || parts[2] !== label) continue;
    if (Math.abs(latch[key] - expiresAt) <= tolerance) return true;
  }
  return false;
}

/**
 * evaluateAlerts({ capacity, groupState, settings, memberId, nowMs, syncError })
 *   -> { alerts: [ { windowKey, effectivePct, capacityPct, latchKey, title, body } ],
 *        prunedLatch }
 *
 * `prunedLatch` is the latch to persist: expired records removed, the keys of
 * every alert in `alerts` added.
 */
function evaluateAlerts(input) {
  const opts = isPlainObject(input) ? input : {};
  const nowMs = finite(opts.nowMs) != null ? Number(opts.nowMs) : Date.now();
  const settings = isPlainObject(opts.settings) ? opts.settings : {};
  const capacity = isPlainObject(opts.capacity) ? opts.capacity : {};
  const groupState = isPlainObject(opts.groupState) ? opts.groupState : null;
  const memberId = typeof opts.memberId === 'string' ? opts.memberId : '';

  const latch = pruneLatch(settings.notifyLatch, nowMs);
  const alerts = [];

  const enabled = settings.notifyEnabled !== false;
  if (!enabled || opts.syncError || !memberId) return { alerts, prunedLatch: latch };

  for (const key of WINDOW_KEYS) {
    const win = isPlainObject(capacity[key]) ? capacity[key] : null;
    if (!win || !isPlainObject(win.members)) continue;

    const capacityPct = finite(win.members[memberId]);
    if (capacityPct == null) continue;

    const effectivePct = effectiveThreshold(settings, key, groupState);
    if (capacityPct < effectivePct) continue;

    const resetsAt = resetsAtFor(groupState, WINDOW_MINUTES[key]);
    const windowMs = WINDOW_MINUTES[key] * 60 * 1000;
    // A snapshot whose window has already rolled over carries no usable
    // countdown — nobody has run Codex since, so no fresher one exists. Latching
    // on that past timestamp would expire the record on the very next pass and
    // the toast would repeat every scan, so the latch runs a full window from
    // now instead.
    const expiresAt = resetsAt != null && resetsAt > nowMs ? resetsAt : nowMs + windowMs;
    const threshold = round(effectivePct);
    const latchKey = `${key}|${resetsAt == null ? 'none' : resetsAt}|${threshold}`;
    if (isLatched(latch, latchKey, key, threshold, expiresAt, windowMs)) continue;

    const label = WINDOW_LABEL[key];
    const used = Math.round(capacityPct);
    const at = Math.round(effectivePct);
    const body =
      `You've used ~${used}% of the account's ${label} limit (alert at ${at}%).` +
      (resetsAt == null ? '' : ` Resets in ${humanizeDuration(resetsAt - nowMs)}.`);

    alerts.push({
      windowKey: key,
      effectivePct,
      capacityPct,
      latchKey,
      title: `SubSplit — ${label} usage`,
      body,
    });
    // Latched even when the toast cannot be shown: one decision per window
    // instance, whatever the platform does with it.
    latch[latchKey] = expiresAt;
  }

  return { alerts, prunedLatch: latch };
}

module.exports = { evaluateAlerts, humanizeDuration, effectiveThreshold, pruneLatch };
