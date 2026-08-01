'use strict';

// SubSplit — Electron main process.
//
// Bootstrap order matters: AppUserModelId first (it is what notification icons
// and setLoginItemSettings' registry name derive from), then the single-instance
// lock synchronously, before anything else happens.

const { app, Menu, ipcMain, Notification } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setAppUserModelId('app.subsplit');

const gotTheLock = app.requestSingleInstanceLock();

const settingsStore = require('./settings');
const trayModule = require('./tray');
const { createScanner } = require('./parser');
const { computeWindows } = require('./windows');
const { createSync, toErrorInfo } = require('./sync');
const { computeCapacity } = require('./capacity');
const { evaluateAlerts } = require('./notify');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const WATCH_DEBOUNCE_MS = 300;
const WATCH_BACKOFF_MIN_MS = 1000;
const WATCH_BACKOFF_MAX_MS = 60000;
const SAFETY_RESCAN_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;
const MIN_PUSH_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_PUSH_MS = 10 * 60 * 1000;
const WINDOW_KEYS = ['5h', 'weekly'];
const WINDOW_MINUTES = { '5h': 300, weekly: 10080 };
const IPC_CHANNELS = {
  stateGet: 'state:get',
  settingsSave: 'settings:save',
  groupJoin: 'group:join',
  syncRefresh: 'sync:refresh',
  appQuit: 'app:quit',
};
const STATE_CHANGED = 'state:changed';

// ---------------------------------------------------------------------------
// mutable app state
// ---------------------------------------------------------------------------

const state = {
  settings: settingsStore.defaultSettings(),
  windows: { '5h': null, weekly: null },
  rateSnapshot: null,
  lastScanAt: null,
  scanStats: emptyStats(),
  group: null,
  etag: null,
  lastSyncAt: null,
  syncError: null,
  clockSkewMs: null,
  lastPushAt: 0,
  lastPushedKey: null,
  pushTimer: null,
  pushInFlight: false,
  pollInFlight: false,
  skipNextPoll: false,
  pollIntervalMs: POLL_INTERVAL_MS,
  loginItemEnabled: false,
};

let scanner = null;
let sync = null;
let tray = null;
let popover = null;
let watchSupervisor = null;
let pollTimer = null;
let safetyTimer = null;
let rescanTimer = null;
let dockHidden = false;
let isQuitting = false;

function noop() {}

// ---------------------------------------------------------------------------
// codex roots
// ---------------------------------------------------------------------------

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function codexRoots() {
  const env = process.env.CODEX_HOME;
  if (typeof env === 'string' && env.trim()) {
    // Several homes may be listed, separated by the platform path delimiter
    // (':' / ';') — the one character that cannot appear inside a path segment.
    // A comma can, and does: "~/Dropbox (Acme, Inc)/.codex".
    const roots = env
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(expandHome(entry)));
    if (roots.length) return roots;
  }
  return [path.join(os.homedir(), '.codex')];
}

// ---------------------------------------------------------------------------
// filesystem watch supervisor
// ---------------------------------------------------------------------------

/**
 * Watches each Codex home recursively (the parent of sessions/ and
 * archived_sessions/, so deleting and recreating those directories survives).
 * fs.watch follows the inode, gives coalesced rename/change events and a
 * frequently-null filename, so: never trust `filename`, debounce into one
 * rescan, and re-arm on error/ENOENT with backoff.
 */
function createWatchSupervisor(roots, onChange) {
  const watchers = new Map();
  let debounceTimer = null;
  let stopped = false;

  function fire() {
    if (stopped || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        onChange();
      } catch (err) {
        console.error('[subsplit] rescan failed:', (err && err.message) || err);
      }
    }, WATCH_DEBOUNCE_MS);
  }

  function stateFor(root) {
    let entry = watchers.get(root);
    if (!entry) {
      entry = { watcher: null, retry: null, backoff: WATCH_BACKOFF_MIN_MS, ino: null };
      watchers.set(root, entry);
    }
    return entry;
  }

  function scheduleRetry(root) {
    if (stopped) return;
    const entry = stateFor(root);
    if (entry.retry) return;
    const delay = entry.backoff;
    entry.backoff = Math.min(entry.backoff * 2, WATCH_BACKOFF_MAX_MS);
    entry.retry = setTimeout(() => {
      entry.retry = null;
      arm(root);
    }, delay);
  }

  function closeWatcher(root) {
    const entry = stateFor(root);
    if (entry.watcher) {
      try {
        entry.watcher.close();
      } catch (_err) {
        /* ignore */
      }
      entry.watcher = null;
    }
  }

  function arm(root) {
    if (stopped) return;
    const entry = stateFor(root);
    if (entry.watcher) return;
    let watcher;
    try {
      watcher = fs.watch(root, { recursive: true, persistent: true });
    } catch (_err) {
      // ENOENT is the common case: Codex is not installed (yet).
      scheduleRetry(root);
      return;
    }
    entry.watcher = watcher;
    entry.backoff = WATCH_BACKOFF_MIN_MS;
    try {
      entry.ino = fs.statSync(root).ino;
    } catch (_err) {
      entry.ino = null;
    }
    watcher.on('change', () => fire());
    watcher.on('error', () => {
      closeWatcher(root);
      scheduleRetry(root);
    });
    watcher.on('close', () => {
      if (entry.watcher === watcher) entry.watcher = null;
    });
    // Something may have changed while we were not watching.
    fire();
  }

  /** Re-arm anything that died, and detect a delete+recreate of a root. */
  function ensureArmed() {
    if (stopped) return;
    for (const root of roots) {
      const entry = stateFor(root);
      if (!entry.watcher) {
        entry.backoff = WATCH_BACKOFF_MIN_MS;
        arm(root);
        continue;
      }
      let ino = null;
      try {
        ino = fs.statSync(root).ino;
      } catch (_err) {
        ino = null;
      }
      if (ino === null || (entry.ino !== null && ino !== entry.ino)) {
        closeWatcher(root);
        entry.backoff = WATCH_BACKOFF_MIN_MS;
        arm(root);
      }
    }
  }

  function start() {
    for (const root of roots) arm(root);
  }

  function stop() {
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    for (const root of watchers.keys()) {
      const entry = watchers.get(root);
      if (entry.retry) {
        clearTimeout(entry.retry);
        entry.retry = null;
      }
      closeWatcher(root);
    }
  }

  return { start, stop, ensureArmed };
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

function emptyStats() {
  return { files: 0, newBytes: 0, badLines: 0, forkBaselines: 0 };
}

function rescan() {
  if (!scanner) return;
  let result;
  try {
    result = scanner.scan();
  } catch (err) {
    console.error('[subsplit] scan failed:', (err && err.message) || err);
    state.lastScanAt = Date.now();
    state.scanStats = Object.assign(emptyStats(), {
      error: (err && err.message) || String(err),
    });
    broadcast();
    return;
  }

  state.lastScanAt = Date.now();
  state.scanStats = result && result.stats ? result.stats : emptyStats();
  if (result && result.rateSnapshot) state.rateSnapshot = result.rateSnapshot;

  let allDeltas = [];
  try {
    allDeltas = scanner.getAllDeltas() || [];
  } catch (_err) {
    allDeltas = [];
  }

  try {
    const computed = computeWindows(allDeltas, state.rateSnapshot, Date.now());
    state.windows = {
      '5h': (computed && computed['5h']) || null,
      weekly: (computed && computed.weekly) || null,
    };
  } catch (err) {
    console.error('[subsplit] window computation failed:', (err && err.message) || err);
  }

  try {
    settingsStore.scheduleSaveCache(scanner.getCache());
  } catch (err) {
    console.error('[subsplit] could not persist the scanner cache:', (err && err.message) || err);
  }

  evaluateAndNotify();
  broadcast();
  maybePush(false);
}

function scheduleRescan(delay) {
  if (rescanTimer) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    rescan();
  }, Math.max(0, delay || 0));
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

function isConfigured() {
  const s = state.settings;
  return Boolean(s && s.serverUrl && s.joinToken && s.memberId);
}

// Bumped every time the sync target changes (join, or a new server/token). A
// request that was already in flight belongs to the previous epoch and its
// answer says nothing about the group we are in now, so it is dropped whole.
let syncEpoch = 0;

function rebuildSyncClient() {
  const s = state.settings;
  syncEpoch += 1;
  sync =
    s && s.serverUrl && s.joinToken
      ? createSync({ serverUrl: s.serverUrl, token: s.joinToken })
      : null;
}

function totalsKey() {
  const parts = [];
  for (const key of WINDOW_KEYS) {
    const totals = state.windows[key];
    if (!totals) {
      parts.push(`${key}:-`);
      continue;
    }
    parts.push(
      [
        key,
        totals.window_start,
        totals.resets_at,
        totals.used_percent,
        totals.total,
        totals.input,
        totals.cached_input,
        totals.output,
      ].join('|')
    );
  }
  return parts.join(';');
}

function applyGroupState(groupState) {
  if (!groupState || typeof groupState !== 'object') return;
  state.group = groupState;
  if (typeof groupState.etag === 'string' && groupState.etag) state.etag = groupState.etag;
  evaluateAndNotify();
}

// ---------------------------------------------------------------------------
// usage alerts
// ---------------------------------------------------------------------------

/**
 * Decide (notify.js) and fire. Local to this machine: every member's app
 * evaluates its own share, so nobody is told about anybody else's usage. The
 * latch is persisted so a restart cannot replay an alert.
 */
function evaluateAndNotify() {
  let result;
  try {
    result = evaluateAlerts({
      capacity: computeCapacity(state.group),
      groupState: state.group,
      settings: state.settings,
      memberId: state.settings.memberId,
      nowMs: Date.now(),
      syncError: state.syncError,
    });
  } catch (err) {
    console.error('[subsplit] alert evaluation failed:', (err && err.message) || err);
    return;
  }

  for (const alert of result.alerts) {
    try {
      if (Notification && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
        new Notification({ title: alert.title, body: alert.body }).show();
      }
    } catch (err) {
      console.error('[subsplit] could not show a notification:', (err && err.message) || err);
    }
  }

  try {
    const before = JSON.stringify(state.settings.notifyLatch || {});
    if (JSON.stringify(result.prunedLatch) !== before) {
      state.settings = settingsStore.saveSettings({ notifyLatch: result.prunedLatch });
    }
  } catch (err) {
    console.error('[subsplit] could not persist the alert latch:', (err && err.message) || err);
  }
}

function schedulePush(delay) {
  if (state.pushTimer) return;
  state.pushTimer = setTimeout(() => {
    state.pushTimer = null;
    maybePush(false);
  }, Math.max(0, delay));
}

async function maybePush(force) {
  if (!isConfigured() || !sync) return;
  if (state.pushInFlight) return;

  const key = totalsKey();
  const now = Date.now();
  const stale = now - state.lastPushAt >= HEARTBEAT_PUSH_MS;

  if (!force && !stale && key === state.lastPushedKey) return;
  if (!force) {
    const since = now - state.lastPushAt;
    if (since < MIN_PUSH_INTERVAL_MS) {
      schedulePush(MIN_PUSH_INTERVAL_MS - since);
      return;
    }
  }

  state.pushInFlight = true;
  const epoch = syncEpoch;
  try {
    // seq must be persisted BEFORE the request goes out, so a crash mid-push can
    // never re-use a sequence number the server has already accepted.
    const nextSeq = (Number(state.settings.seq) || 0) + 1;
    state.settings = settingsStore.saveSettings({ seq: nextSeq });

    const payload = {
      member_id: state.settings.memberId,
      member_name: state.settings.memberName,
      device_id: state.settings.deviceId,
      seq: state.settings.seq,
      updated_at: Date.now(),
      window_totals: {
        '5h': state.windows['5h'] || null,
        weekly: state.windows.weekly || null,
      },
      rate_limit: state.rateSnapshot || null,
    };

    state.lastPushAt = Date.now();
    const result = await sync.push(payload);
    // We may have left for another group while this was outstanding.
    if (epoch !== syncEpoch) return;
    state.lastSyncAt = Date.now();
    state.clockSkewMs = typeof result.clock_skew_ms === 'number' ? result.clock_skew_ms : null;
    if (result.accepted === false) {
      // The seq guard rejected the row: the server kept its own copy and stored
      // nothing. These totals still need pushing, and the user needs to know.
      state.syncError = {
        code: 'not_accepted',
        message:
          'The server did not accept this update — its copy of this device is newer. Your numbers are not reaching the group.',
      };
    } else {
      state.lastPushedKey = key;
      state.syncError = null;
    }
    // The returned state is authoritative and fresh either way.
    if (result.state) {
      applyGroupState(result.state);
      state.skipNextPoll = true;
    }
  } catch (err) {
    if (epoch !== syncEpoch) return;
    state.syncError = toErrorInfo(err);
  } finally {
    state.pushInFlight = false;
    broadcast();
  }
}

async function pollNow(force) {
  if (!isConfigured() || !sync) return;
  if (state.pollInFlight) return;
  if (!force && state.skipNextPoll) {
    state.skipNextPoll = false;
    return;
  }
  state.skipNextPoll = false;

  state.pollInFlight = true;
  const epoch = syncEpoch;
  try {
    const result = await sync.poll(state.etag);
    // An answer from the group we just left must not touch the current one.
    if (epoch !== syncEpoch) return;
    // Cleared before the state is applied: alerts must not be suppressed by the
    // error this very poll just resolved.
    state.lastSyncAt = Date.now();
    state.syncError = null;
    if (!result.notModified) {
      applyGroupState(result.state);
      if (result.etag) state.etag = result.etag;
    }
  } catch (err) {
    if (epoch !== syncEpoch) return;
    state.syncError = toErrorInfo(err);
  } finally {
    state.pollInFlight = false;
    broadcast();
  }
}

function onPollTick() {
  if (!isConfigured()) return;
  // Heartbeat so the server does not mark this device stale while it is idle.
  const heartbeatDue = Date.now() - state.lastPushAt >= HEARTBEAT_PUSH_MS;
  // maybePush() is a no-op unless totals changed (or a previous push failed), so
  // this doubles as the retry path. A push returns the full group state, and
  // pollNow() then skips itself for one tick.
  maybePush(heartbeatDue)
    .then(() => pollNow(false))
    .catch(noop);
}

async function refreshNow() {
  rescan();
  await maybePush(true);
  await pollNow(true);
  return buildUiState();
}

/**
 * Join (or re-join) a group. Rejects with a friendly Error when the join itself
 * fails so the onboarding form can print it; failures of the follow-up push/poll
 * are only state, because the join already succeeded.
 */
async function joinGroup(input) {
  const opts = input || {};
  const serverUrl = typeof opts.serverUrl === 'string' ? opts.serverUrl.trim() : '';
  const joinToken = typeof opts.joinToken === 'string' ? opts.joinToken.trim() : '';
  const memberName = typeof opts.memberName === 'string' ? opts.memberName.trim() : '';

  let result;
  try {
    const client = createSync({ serverUrl, token: joinToken });
    result = await client.join(memberName);
  } catch (err) {
    // Nothing is persisted on failure: a bad token cannot clobber a working setup.
    state.syncError = toErrorInfo(err);
    broadcast();
    const failure = new Error(state.syncError.message);
    failure.code = state.syncError.code;
    throw failure;
  }

  state.settings = settingsStore.saveSettings({
    serverUrl,
    joinToken,
    memberName:
      typeof result.member_name === 'string' && result.member_name
        ? result.member_name
        : memberName,
    memberId: result.member_id,
  });
  // New group: previous group state and etag are meaningless.
  state.group = null;
  state.etag = null;
  state.lastPushedKey = null;
  state.lastPushAt = 0;
  state.syncError = null;
  const interval = Number(result.poll_interval_s);
  state.pollIntervalMs =
    Number.isFinite(interval) && interval >= 15 ? interval * 1000 : POLL_INTERVAL_MS;
  rebuildSyncClient();
  restartPollTimer();

  rescan();
  await maybePush(true);
  await pollNow(true);

  broadcast();
  return buildUiState();
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

function buildUiState() {
  return {
    configured: isConfigured(),
    settings: {
      // The join token never leaves the main process.
      memberName: state.settings.memberName,
      memberId: state.settings.memberId || null,
      serverUrl: state.settings.serverUrl,
      primaryWindow: state.settings.primaryWindow,
      notifyEnabled: state.settings.notifyEnabled,
      notifyPct: {
        '5h': state.settings.notifyPct ? state.settings.notifyPct['5h'] : null,
        weekly: state.settings.notifyPct ? state.settings.notifyPct.weekly : null,
      },
    },
    local: {
      windows: state.windows,
      lastScanAt: state.lastScanAt,
      stats: state.scanStats,
    },
    group: state.group,
    // Computed here so the formula lives in exactly one place.
    capacity: computeCapacity(state.group),
    sync: {
      lastSyncAt: state.lastSyncAt,
      error: state.syncError,
      clockSkewMs: state.clockSkewMs,
    },
  };
}

function broadcast() {
  updateTray();
  if (!popover || popover.isDestroyed()) return;
  try {
    popover.webContents.send(STATE_CHANGED, buildUiState());
  } catch (_err) {
    /* renderer not ready yet */
  }
}

// ---------------------------------------------------------------------------
// tray presentation
// ---------------------------------------------------------------------------

function primaryWindowKey() {
  return state.settings.primaryWindow === '5h' ? '5h' : 'weekly';
}

function percentFromSnapshot(snapshot, minutes) {
  if (!snapshot || !Array.isArray(snapshot.windows)) return null;
  for (const w of snapshot.windows) {
    if (w && w.windowMinutes === minutes && typeof w.usedPercent === 'number') {
      return w.usedPercent;
    }
  }
  return null;
}

function findMe() {
  if (!state.group || !Array.isArray(state.group.members)) return null;
  return (
    state.group.members.find((m) => m && m.member_id === state.settings.memberId) || null
  );
}

function accountPercentFor(key) {
  const fromGroup = percentFromSnapshot(
    state.group && state.group.account_rate_limit,
    WINDOW_MINUTES[key]
  );
  if (fromGroup != null) return fromGroup;
  const local = state.windows[key];
  if (local && typeof local.used_percent === 'number') return local.used_percent;
  return null;
}

function formatCompact(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

function trayStatus() {
  const key = primaryWindowKey();
  const label = key === '5h' ? '5h' : 'Weekly';
  const accountPct = accountPercentFor(key);
  const me = findMe();
  const mine = me && me.windows ? me.windows[key] : null;
  const sharePct = mine && typeof mine.share_pct === 'number' ? mine.share_pct : null;
  const localTotals = state.windows[key];
  const myTotal =
    mine && typeof mine.total === 'number'
      ? mine.total
      : localTotals && typeof localTotals.total === 'number'
        ? localTotals.total
        : 0;

  let title = '';
  if (accountPct != null) title = ` ${Math.round(accountPct)}%`;
  else if (sharePct != null) title = ` ${Math.round(sharePct)}%`;
  else if (myTotal > 0) title = ` ${formatCompact(myTotal)}`;

  const parts = ['SubSplit'];
  if (!isConfigured()) {
    parts.push('not set up yet');
  } else if (accountPct != null) {
    parts.push(`${label} ${Math.round(accountPct)}% used`);
  } else {
    parts.push(`${label}: no account data yet`);
  }
  if (myTotal > 0) {
    parts.push(
      `you ${formatCompact(myTotal)}${sharePct != null ? ` (${Math.round(sharePct)}%)` : ''}`
    );
  }
  if (state.syncError) parts.push(`sync error: ${state.syncError.code}`);

  return { title, tooltip: parts.join(' · ') };
}

function updateTray() {
  if (!tray) return;
  trayModule.updateTrayStatus(tray, trayStatus());
}

// ---------------------------------------------------------------------------
// launch at login
// ---------------------------------------------------------------------------

function readLoginItemEnabled() {
  try {
    const settings = app.getLoginItemSettings();
    if (!settings) return false;
    // macOS 13+ reports a real status; unsigned builds often fail silently, so
    // trust `status` over `openAtLogin` when it is present.
    if (typeof settings.status === 'string') return settings.status === 'enabled';
    if (typeof settings.executableWillLaunchAtLogin === 'boolean') {
      return settings.executableWillLaunchAtLogin;
    }
    return Boolean(settings.openAtLogin);
  } catch (_err) {
    return false;
  }
}

function setLoginItem(enabled) {
  try {
    const options = { openAtLogin: Boolean(enabled) };
    if (process.platform === 'win32') {
      options.path = process.execPath;
      options.args = [];
    }
    app.setLoginItemSettings(options);
  } catch (err) {
    console.error('[subsplit] launch-at-login change failed:', (err && err.message) || err);
  }
  // Read back: on unsigned macOS builds this can silently not take effect.
  state.loginItemEnabled = readLoginItemEnabled();
  return state.loginItemEnabled;
}

// ---------------------------------------------------------------------------
// popover + tray wiring
// ---------------------------------------------------------------------------

function rendererIndexPath() {
  return path.join(__dirname, '..', 'renderer', 'index.html');
}

function createPopover() {
  const win = trayModule.createPopoverWindow({
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    devTools: !app.isPackaged,
  });

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    popover = null;
  });
  win.webContents.on('did-finish-load', () => {
    broadcast();
  });

  trayModule.attachAutoHide(win);

  const indexFile = rendererIndexPath();
  win.loadFile(indexFile).catch((err) => {
    console.error(
      `[subsplit] could not load ${indexFile}:`,
      (err && err.message) || err
    );
  });

  return win;
}

function showPopover(bounds) {
  if (!popover || popover.isDestroyed()) {
    popover = createPopover();
  }
  let anchor = bounds;
  if (!anchor && tray && typeof tray.getBounds === 'function') {
    try {
      anchor = tray.getBounds();
    } catch (_err) {
      anchor = null;
    }
  }
  trayModule.positionWindow(popover, anchor);
  popover.show();
  popover.focus();
  broadcast();
  scheduleRescan(0);
}

function togglePopover(bounds) {
  if (popover && !popover.isDestroyed() && popover.isVisible()) {
    popover.hide();
    return;
  }
  showPopover(bounds);
}

function buildTrayMenu() {
  const template = [
    { label: 'Open SubSplit', click: () => showPopover() },
    { label: 'Refresh now', click: () => refreshNow().catch(noop) },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: state.loginItemEnabled,
      click: (menuItem) => {
        const actual = setLoginItem(!state.loginItemEnabled);
        // Reflect what actually happened, not what was asked for.
        menuItem.checked = actual;
      },
    },
    { type: 'separator' },
    { label: 'Quit SubSplit', click: () => quitApp() },
  ];
  return Menu.buildFromTemplate(template);
}

function setupTray() {
  tray = trayModule.createTray({
    tooltip: 'SubSplit',
    onLeftClick: (bounds) => togglePopover(bounds),
    onRightClick: () => {
      state.loginItemEnabled = readLoginItemEnabled();
      try {
        tray.popUpContextMenu(buildTrayMenu());
      } catch (err) {
        console.error('[subsplit] could not open the tray menu:', (err && err.message) || err);
      }
    },
  });
  updateTray();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function fromPopover(event) {
  return Boolean(
    popover && !popover.isDestroyed() && event && event.sender === popover.webContents
  );
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromPopover(event)) {
      throw new Error(`Rejected ${channel} from an unexpected sender`);
    }
    return handler(...args);
  });
}

function registerIpc() {
  handle(IPC_CHANNELS.stateGet, () => buildUiState());

  handle(IPC_CHANNELS.settingsSave, (partial) => {
    const input = partial && typeof partial === 'object' ? partial : {};
    const next = {};
    if (typeof input.memberName === 'string') next.memberName = input.memberName.trim().slice(0, 64);
    if (typeof input.serverUrl === 'string') next.serverUrl = input.serverUrl.trim();
    if (input.primaryWindow === '5h' || input.primaryWindow === 'weekly') {
      next.primaryWindow = input.primaryWindow;
    }
    if (typeof input.notifyEnabled === 'boolean') next.notifyEnabled = input.notifyEnabled;
    // notifyPct is replaced whole — the form always submits both windows.
    // `notifyLatch` is main's own bookkeeping and is never renderer-writable.
    if (input.notifyPct && typeof input.notifyPct === 'object') {
      next.notifyPct = {
        '5h': input.notifyPct['5h'],
        weekly: input.notifyPct.weekly,
      };
    }

    // A token typed into the settings form is a re-join, not a settings write:
    // the member id has to come back from the server.
    const token = typeof input.joinToken === 'string' ? input.joinToken.trim() : '';
    const serverUrl = next.serverUrl !== undefined ? next.serverUrl : state.settings.serverUrl;
    if (token && (token !== state.settings.joinToken || serverUrl !== state.settings.serverUrl)) {
      // Preferences typed alongside the token must not be lost to the re-join.
      const carry = {};
      for (const key of ['primaryWindow', 'notifyEnabled', 'notifyPct']) {
        if (next[key] !== undefined) carry[key] = next[key];
      }
      if (Object.keys(carry).length) {
        state.settings = settingsStore.saveSettings(carry);
      }
      return joinGroup({
        serverUrl,
        joinToken: token,
        memberName: next.memberName !== undefined ? next.memberName : state.settings.memberName,
      });
    }

    if (Object.keys(next).length) {
      const serverChanged =
        next.serverUrl !== undefined && next.serverUrl !== state.settings.serverUrl;
      const nameChanged =
        next.memberName !== undefined && next.memberName !== state.settings.memberName;
      state.settings = settingsStore.saveSettings(next);
      if (serverChanged) {
        rebuildSyncClient();
        state.etag = null;
        state.lastPushedKey = null;
      }
      // The group should see a renamed member without waiting for the next scan.
      if (nameChanged && isConfigured()) maybePush(true).catch(noop);
    }
    broadcast();
    return buildUiState();
  });

  handle(IPC_CHANNELS.groupJoin, (payload) => joinGroup(payload));

  handle(IPC_CHANNELS.syncRefresh, () => refreshNow());

  handle(IPC_CHANNELS.appQuit, () => {
    quitApp();
    return null;
  });
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function restartPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(onPollTick, state.pollIntervalMs);
}

function quitApp() {
  if (isQuitting) return;
  isQuitting = true;
  try {
    settingsStore.flushCache();
  } catch (_err) {
    /* ignore */
  }
  app.quit();
}

function hideDockOnce() {
  if (dockHidden) return;
  dockHidden = true;
  // Packaged builds also set LSUIElement; this covers `npm start`.
  if (app.dock && typeof app.dock.hide === 'function') app.dock.hide();
}

function bootstrap() {
  app.on('second-instance', () => {
    showPopover();
  });

  // A tray app has no windows most of the time — never auto-quit.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    isQuitting = true;
    try {
      settingsStore.flushCache();
    } catch (_err) {
      /* ignore */
    }
    if (watchSupervisor) watchSupervisor.stop();
    if (pollTimer) clearInterval(pollTimer);
    if (safetyTimer) clearInterval(safetyTimer);
    if (state.pushTimer) clearTimeout(state.pushTimer);
    if (rescanTimer) clearTimeout(rescanTimer);
    if (tray && typeof tray.destroy === 'function') {
      try {
        tray.destroy();
      } catch (_err) {
        /* ignore */
      }
      tray = null;
    }
  });

  app.on('web-contents-created', (_event, contents) => {
    // Nothing in this app is allowed to open a window or navigate away.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
  });

  process.on('uncaughtException', (err) => {
    console.error('[subsplit] uncaught exception:', (err && err.stack) || err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[subsplit] unhandled rejection:', (err && err.stack) || err);
  });

  app.whenReady().then(() => {
    hideDockOnce();

    state.settings = settingsStore.loadSettings();
    state.loginItemEnabled = readLoginItemEnabled();
    rebuildSyncClient();

    const roots = codexRoots();
    scanner = createScanner({ roots, cache: settingsStore.loadCache() });

    popover = createPopover();
    registerIpc();
    setupTray();

    rescan();

    watchSupervisor = createWatchSupervisor(roots, rescan);
    watchSupervisor.start();

    safetyTimer = setInterval(() => {
      if (watchSupervisor) watchSupervisor.ensureArmed();
      rescan();
    }, SAFETY_RESCAN_MS);

    restartPollTimer();
    if (isConfigured()) pollNow(true).catch(noop);
  });
}

if (!gotTheLock) {
  app.quit();
} else {
  bootstrap();
}

// ---------------------------------------------------------------------------
// test seam
// ---------------------------------------------------------------------------

// Nothing in the app reads these: they exist so the parts that are not Electron
// (root parsing, the push/poll epoch guard) can be exercised under plain `node`.
module.exports = {
  __test: {
    state,
    codexRoots,
    buildUiState,
    rebuildSyncClient,
    maybePush,
    pollNow,
  },
};
