'use strict';

// Preload: the entire renderer-facing surface.
//
// Runs in a sandboxed, context-isolated renderer, so it may only require
// `electron`, `events`, `timers` and `url`. `ipcRenderer` itself is never
// exposed — only a hand-written allow-list of channels.

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_STATE_GET = 'state:get';
const CHANNEL_SETTINGS_SAVE = 'settings:save';
const CHANNEL_GROUP_JOIN = 'group:join';
const CHANNEL_SYNC_REFRESH = 'sync:refresh';
const CHANNEL_INVITE_COPY = 'invite:copy';
const CHANNEL_INVITE_PASTE = 'invite:paste';
const CHANNEL_DIAG_OPEN = 'diag:open';
const CHANNEL_DIAG_HEALTH = 'diag:health';
const CHANNEL_APP_QUIT = 'app:quit';

/** The one non-index folder the diagnostics panel may ask main to open. */
const TARGET_APP_DATA = 'app-data';
const CHANNEL_STATE_CHANGED = 'state:changed';

function asString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Only renderer-editable fields cross the bridge. `joinToken` travels one way
 * only — the renderer may submit a new one from the settings form (main treats
 * that as a re-join), but it is never handed back in a UiState.
 */
function pickSettings(partial) {
  const out = {};
  if (!partial || typeof partial !== 'object') return out;
  if (typeof partial.memberName === 'string') out.memberName = partial.memberName;
  if (typeof partial.serverUrl === 'string') out.serverUrl = partial.serverUrl;
  if (typeof partial.joinToken === 'string' && partial.joinToken) {
    out.joinToken = partial.joinToken;
  }
  if (partial.primaryWindow === '5h' || partial.primaryWindow === 'weekly') {
    out.primaryWindow = partial.primaryWindow;
  }
  if (typeof partial.notifyEnabled === 'boolean') out.notifyEnabled = partial.notifyEnabled;
  // Per-window alert thresholds. null (or anything unusable) means AUTO; main
  // normalizes. The internal `notifyLatch` is deliberately not crossable.
  if (partial.notifyPct && typeof partial.notifyPct === 'object') {
    out.notifyPct = {
      '5h': asPct(partial.notifyPct['5h']),
      weekly: asPct(partial.notifyPct.weekly),
    };
  }
  return out;
}

function asPct(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const api = {
  /** getState(): Promise<UiState> */
  getState() {
    return ipcRenderer.invoke(CHANNEL_STATE_GET);
  },

  /** saveSettings(partial): Promise<UiState> */
  saveSettings(partial) {
    return ipcRenderer.invoke(CHANNEL_SETTINGS_SAVE, pickSettings(partial));
  },

  /** joinGroup({ serverUrl, joinToken, memberName }): Promise<UiState> */
  joinGroup(options) {
    const input = options && typeof options === 'object' ? options : {};
    return ipcRenderer.invoke(CHANNEL_GROUP_JOIN, {
      serverUrl: asString(input.serverUrl),
      joinToken: asString(input.joinToken),
      memberName: asString(input.memberName),
    });
  },

  /** refreshNow(): Promise<UiState> */
  refreshNow() {
    return ipcRenderer.invoke(CHANNEL_SYNC_REFRESH);
  },

  /**
   * copyInvite(): Promise<{ ok: true } | { ok: false, error }>
   * Main builds the invite from its own settings and writes it to the
   * clipboard: no argument goes in, and no token comes back.
   */
  copyInvite() {
    return ipcRenderer.invoke(CHANNEL_INVITE_COPY);
  },

  /**
   * pasteInvite(): Promise<{ ok: true, serverUrl, tokenMasked } |
   *                        { ok: false, error }>
   * Main reads and parses the clipboard, keeps the token, and answers with a
   * masked stand-in for it.
   */
  pasteInvite() {
    return ipcRenderer.invoke(CHANNEL_INVITE_PASTE);
  },

  /**
   * openFolder(target): Promise<{ ok: true } | { ok: false, error }>
   * `target` is an INDEX into UiState.local.roots, or the 'app-data' enum.
   * A path string is not accepted here and is not accepted by main either —
   * main resolves the folder itself, so this never becomes a way for the
   * renderer to open an arbitrary file.
   */
  openFolder(target) {
    const safe =
      target === TARGET_APP_DATA
        ? TARGET_APP_DATA
        : Number.isInteger(target) && target >= 0
          ? target
          : null;
    if (safe === null) {
      return Promise.resolve({ ok: false, error: 'There is no folder to open there.' });
    }
    return ipcRenderer.invoke(CHANNEL_DIAG_OPEN, safe);
  },

  /**
   * testConnection(serverUrl?): Promise<{ ok, latencyMs, version, error, checkedAt }>
   * `serverUrl` is the Server URL field as it currently stands, so the button
   * tests what the user is looking at and not what was last saved. Main treats
   * it as untrusted: it validates it, falls back to the stored URL only when it
   * is blank, and reports a malformed one as malformed. Main performs an
   * unauthenticated GET /v1/health — the join token is not involved, so nothing
   * about it can be inferred from the answer.
   */
  testConnection(serverUrl) {
    return ipcRenderer.invoke(CHANNEL_DIAG_HEALTH, asString(serverUrl));
  },

  /** quit(): void */
  quit() {
    ipcRenderer.invoke(CHANNEL_APP_QUIT).catch(() => {});
  },

  /** onState(cb): unsubscribe */
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, uiState) => {
      try {
        callback(uiState);
      } catch (err) {
        console.error('[subsplit] onState listener threw:', err);
      }
    };
    ipcRenderer.on(CHANNEL_STATE_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(CHANNEL_STATE_CHANGED, handler);
    };
  },
};

contextBridge.exposeInMainWorld('subsplit', api);
