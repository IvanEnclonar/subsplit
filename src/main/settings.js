'use strict';

// Settings + cache persistence.
//
// Lives in app.getPath('userData') inside Electron, but this module must also be
// requireable from plain `node` (tests, scripts) — so `electron` is only touched
// when we are demonstrably running inside Electron, and every entry point accepts
// an optional `dir` override (plus a process-wide `init({ baseDir })`).
//
// settings.json  { memberName, serverUrl, joinToken, memberId, deviceId, seq, primaryWindow,
//                  notifyEnabled, notifyPct, notifyLatch }
// cache.json     scanner cache from parser.getCache() — written debounced, never
//                more often than once per CACHE_MIN_INTERVAL_MS.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SETTINGS_FILE = 'settings.json';
const CACHE_FILE = 'cache.json';
const CACHE_MIN_INTERVAL_MS = 5000;

const PRIMARY_WINDOWS = ['weekly', '5h'];
const NOTIFY_WINDOWS = ['5h', 'weekly'];

let baseDirOverride = null;

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function electronUserData() {
  // `process.versions.electron` is only present in the Electron runtime; checking
  // it first means plain-node callers never even load the electron package.
  if (!process.versions || !process.versions.electron) return null;
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (_err) {
    /* not available — fall through */
  }
  return null;
}

function resolveBaseDir(dir) {
  if (dir) return String(dir);
  if (baseDirOverride) return baseDirOverride;
  if (process.env.SUBSPLIT_DATA_DIR) return process.env.SUBSPLIT_DATA_DIR;
  const userData = electronUserData();
  if (userData) return userData;
  return path.join(os.homedir(), '.subsplit');
}

/** Set a process-wide base directory override (used by tests). */
function init(options) {
  if (options && options.baseDir) baseDirOverride = String(options.baseDir);
  else if (options && options.baseDir === null) baseDirOverride = null;
  return paths();
}

/** paths(dir?) -> { baseDir, settingsFile, cacheFile } */
function paths(dir) {
  const baseDir = resolveBaseDir(dir);
  return {
    baseDir,
    settingsFile: path.join(baseDir, SETTINGS_FILE),
    cacheFile: path.join(baseDir, CACHE_FILE),
  };
}

// ---------------------------------------------------------------------------
// low-level json io (never throws)
// ---------------------------------------------------------------------------

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_err) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_e2) {
      /* ignore */
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function defaultSettings() {
  return {
    memberName: '',
    serverUrl: '',
    joinToken: '',
    memberId: '',
    deviceId: '',
    seq: 0,
    primaryWindow: 'weekly',
    // Usage alerts. `notifyPct[key] === null` means AUTO — the fair share,
    // 100/N, resolved at evaluation time because N changes as people join.
    notifyEnabled: true,
    notifyPct: { '5h': null, weekly: null },
    // Internal: which alerts have already fired. { latchKey: resetsAt(ms) }.
    notifyLatch: {},
  };
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

/** An alert threshold is an integer 1..100; anything else means AUTO (null). */
function notifyPct(raw) {
  const out = { '5h': null, weekly: null };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of NOTIFY_WINDOWS) {
    const value = Number(raw[key]);
    if (Number.isInteger(value) && value >= 1 && value <= 100) out[key] = value;
  }
  return out;
}

function notifyLatch(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    const resetsAt = Number(raw[key]);
    if (Number.isFinite(resetsAt) && resetsAt > 0) out[key] = resetsAt;
  }
  return out;
}

function normalizeSettings(raw) {
  const out = defaultSettings();
  if (!raw || typeof raw !== 'object') return out;
  out.memberName = str(raw.memberName).trim();
  out.serverUrl = str(raw.serverUrl).trim();
  out.joinToken = str(raw.joinToken).trim();
  out.memberId = str(raw.memberId).trim();
  out.deviceId = str(raw.deviceId).trim();
  const seq = Number(raw.seq);
  out.seq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
  out.primaryWindow = PRIMARY_WINDOWS.includes(raw.primaryWindow) ? raw.primaryWindow : 'weekly';
  out.notifyEnabled = typeof raw.notifyEnabled === 'boolean' ? raw.notifyEnabled : true;
  out.notifyPct = notifyPct(raw.notifyPct);
  out.notifyLatch = notifyLatch(raw.notifyLatch);
  return out;
}

function newDeviceId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

/**
 * loadSettings(dir?) -> settings object (always fully populated).
 * Generates + persists `deviceId` the first time it is missing.
 */
function loadSettings(dir) {
  const p = paths(dir);
  const settings = normalizeSettings(readJson(p.settingsFile));
  if (!settings.deviceId) {
    settings.deviceId = newDeviceId();
    writeJsonAtomic(p.settingsFile, settings);
  }
  return settings;
}

/**
 * saveSettings(partial, dir?) -> merged settings object.
 * Only known keys are merged; unknown keys are ignored.
 */
function saveSettings(partial, dir) {
  const p = paths(dir);
  const current = loadSettings(dir);
  const merged = normalizeSettings(Object.assign({}, current, pickSettings(partial)));
  if (!merged.deviceId) merged.deviceId = current.deviceId || newDeviceId();
  // seq must never go backwards
  if (merged.seq < current.seq) merged.seq = current.seq;
  writeJsonAtomic(p.settingsFile, merged);
  return merged;
}

function pickSettings(partial) {
  const out = {};
  if (!partial || typeof partial !== 'object') return out;
  for (const key of Object.keys(defaultSettings())) {
    if (Object.prototype.hasOwnProperty.call(partial, key) && partial[key] !== undefined) {
      out[key] = partial[key];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// scanner cache (debounced writes)
// ---------------------------------------------------------------------------

let pendingCache = null;
let pendingCacheDir;
let cacheTimer = null;
let lastCacheWriteAt = 0;

/** loadCache(dir?) -> cache object | null */
function loadCache(dir) {
  return readJson(paths(dir).cacheFile);
}

/** saveCache(cache, dir?) -> boolean. Writes immediately. */
function saveCache(cache, dir) {
  if (!cache || typeof cache !== 'object') return false;
  const ok = writeJsonAtomic(paths(dir).cacheFile, cache);
  lastCacheWriteAt = Date.now();
  return ok;
}

/**
 * scheduleSaveCache(cache, dir?) — coalesces rapid calls and guarantees writes
 * are at least CACHE_MIN_INTERVAL_MS (5s) apart.
 */
function scheduleSaveCache(cache, dir) {
  if (!cache || typeof cache !== 'object') return;
  pendingCache = cache;
  pendingCacheDir = dir;
  if (cacheTimer) return;
  const wait = Math.max(0, CACHE_MIN_INTERVAL_MS - (Date.now() - lastCacheWriteAt));
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    flushCache();
  }, wait);
  if (typeof cacheTimer.unref === 'function') cacheTimer.unref();
}

/** flushCache() — write any pending cache right now (call before quitting). */
function flushCache() {
  if (cacheTimer) {
    clearTimeout(cacheTimer);
    cacheTimer = null;
  }
  if (!pendingCache) return false;
  const cache = pendingCache;
  const dir = pendingCacheDir;
  pendingCache = null;
  pendingCacheDir = undefined;
  return saveCache(cache, dir);
}

module.exports = {
  CACHE_MIN_INTERVAL_MS,
  PRIMARY_WINDOWS,
  init,
  paths,
  defaultSettings,
  loadSettings,
  saveSettings,
  loadCache,
  saveCache,
  scheduleSaveCache,
  flushCache,
};
