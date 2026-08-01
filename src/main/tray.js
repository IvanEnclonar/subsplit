'use strict';

// Tray creation + popover window creation/positioning.
//
// Everything here is main-process only. The genuinely non-obvious bits (lifted
// from `menubar` + Electron docs):
//   - position from the `click` event's bounds, not tray.getBounds()
//   - cache the last non-zero tray bounds; Windows reports x=0 when the icon
//     lives in the taskbar-corner overflow flyout -> fall back to the work
//     area's bottom-right corner
//   - clamp into the work area and Math.round: setPosition crashes on floats
//   - macOS: type 'panel' + setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
//   - hide-on-blur needs a ~100ms grace so a tray click reads as a toggle
//   - never setContextMenu() (it eats mouse events on macOS): popUpContextMenu()

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');

const { Tray, BrowserWindow, nativeImage } = electron;

const POPOVER_SIZE = { width: 360, height: 520 };
const EDGE_GAP = 4;
// NOTIFYICONDATA.szTip is 128 chars including the NUL terminator.
const TOOLTIP_MAX = 127;

const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const ICON_PATHS = {
  // nativeImage.createFromPath picks up the sibling @2x automatically, and the
  // "Template" suffix is what makes macOS auto-invert for dark mode.
  darwin: path.join(ASSETS_DIR, 'iconTemplate.png'),
  win32: path.join(ASSETS_DIR, 'tray-win.png'),
  linux: path.join(ASSETS_DIR, 'tray-win.png'),
};

function trayIconPath(platform) {
  const key = platform || process.platform;
  return ICON_PATHS[key] || ICON_PATHS.linux;
}

/**
 * Load the tray image, falling back to an empty image when the generated assets
 * are not present yet so `npm start` never hard-crashes during development.
 */
function resolveTrayImage(platform) {
  const plat = platform || process.platform;
  const file = trayIconPath(plat);
  try {
    if (fs.existsSync(file)) {
      const image = nativeImage.createFromPath(file);
      if (image && !image.isEmpty()) {
        if (plat === 'darwin' && typeof image.setTemplateImage === 'function') {
          image.setTemplateImage(true);
        }
        return image;
      }
    }
  } catch (_err) {
    /* fall through to the empty image */
  }
  return nativeImage.createEmpty();
}

// ---------------------------------------------------------------------------
// tray bounds cache
// ---------------------------------------------------------------------------

let lastGoodBounds = null;

function isUsableBounds(bounds, platform) {
  const plat = platform || process.platform;
  if (!bounds || typeof bounds !== 'object') return false;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  if (!Number.isFinite(bounds.width) || bounds.width <= 0) return false;
  if (!Number.isFinite(bounds.height) || bounds.height <= 0) return false;
  // Windows overflow flyout reports x === 0.
  if (plat === 'win32' && bounds.x === 0) return false;
  return true;
}

/** Remember the last non-zero tray bounds we saw. Returns the cached value. */
function rememberTrayBounds(bounds, platform) {
  if (isUsableBounds(bounds, platform)) {
    lastGoodBounds = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  }
  return lastGoodBounds;
}

/** Best anchor we have: the fresh bounds, else the cached ones, else null. */
function getAnchorBounds(bounds, platform) {
  if (isUsableBounds(bounds, platform)) return bounds;
  return lastGoodBounds;
}

function resetTrayBoundsCache() {
  lastGoodBounds = null;
}

// ---------------------------------------------------------------------------
// positioning
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Pure positioning maths, so it can be reasoned about (and tested) without a
 * running Electron.
 *
 * computePopoverPosition({ bounds, workArea, size, platform }) -> { x, y }
 */
function computePopoverPosition(options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const size = opts.size || POPOVER_SIZE;
  const width = Number(size.width) || POPOVER_SIZE.width;
  const height = Number(size.height) || POPOVER_SIZE.height;
  const wa = opts.workArea || { x: 0, y: 0, width: width, height: height };
  const anchor = isUsableBounds(opts.bounds, platform) ? opts.bounds : null;

  let x;
  let y;

  if (anchor && platform === 'darwin') {
    // Centred under the menu bar icon; workArea.y already excludes the menu bar.
    x = anchor.x + anchor.width / 2 - width / 2;
    y = wa.y;
  } else if (anchor) {
    // Windows/Linux: right-aligned with the icon, above the taskbar.
    x = anchor.x + anchor.width - width;
    y = wa.y + wa.height - height - EDGE_GAP;
    if (anchor.y + anchor.height / 2 <= wa.y) {
      // Taskbar is at the top of this display — drop below it instead.
      y = wa.y + EDGE_GAP;
    }
  } else {
    // No usable tray bounds (Win11 overflow flyout, Linux, menu item click):
    // bottom-right of the work area.
    x = wa.x + wa.width - width - EDGE_GAP;
    y = wa.y + wa.height - height - EDGE_GAP;
  }

  x = clamp(x, wa.x, wa.x + wa.width - width);
  y = clamp(y, wa.y, wa.y + wa.height - height);

  return { x: Math.round(x), y: Math.round(y) };
}

function rectForDisplayMatch(bounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

/** Position `win` next to the tray icon described by `bounds` (may be null). */
function positionWindow(win, bounds) {
  if (!win || win.isDestroyed()) return null;
  const anchor = getAnchorBounds(bounds);
  let workArea;
  try {
    const screen = electron.screen;
    const display = anchor
      ? screen.getDisplayMatching(rectForDisplayMatch(anchor))
      : screen.getPrimaryDisplay();
    workArea = display.workArea;
  } catch (_err) {
    workArea = null;
  }

  const size = win.getBounds();
  const position = computePopoverPosition({
    bounds: anchor,
    workArea: workArea || { x: 0, y: 0, width: size.width, height: size.height },
    size: { width: size.width, height: size.height },
  });

  try {
    win.setPosition(position.x, position.y, false);
  } catch (_err) {
    try {
      win.center();
    } catch (_e2) {
      /* give up quietly — an unpositioned popover still works */
    }
  }
  return position;
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

/**
 * createTray({ onLeftClick, onRightClick, tooltip }) -> Tray | null
 * Returns null (instead of throwing) when the platform refuses to create the
 * tray icon, so a missing asset can never take the whole app down.
 */
function createTray(options) {
  const opts = options || {};
  let tray;
  try {
    tray = new Tray(resolveTrayImage());
  } catch (err) {
    console.error('[subsplit] could not create the tray icon:', (err && err.message) || err);
    return null;
  }

  if (process.platform === 'darwin' && typeof tray.setIgnoreDoubleClickEvents === 'function') {
    tray.setIgnoreDoubleClickEvents(true);
  }
  if (typeof opts.tooltip === 'string') setTrayTooltip(tray, opts.tooltip);

  tray.on('click', (_event, bounds) => {
    rememberTrayBounds(bounds);
    if (typeof opts.onLeftClick === 'function') opts.onLeftClick(getAnchorBounds(bounds));
  });

  // NOTE: deliberately no setContextMenu() — it suppresses mouse events on macOS.
  tray.on('right-click', (_event, bounds) => {
    rememberTrayBounds(bounds);
    if (typeof opts.onRightClick === 'function') opts.onRightClick(getAnchorBounds(bounds));
  });

  return tray;
}

function truncateTooltip(text) {
  const oneLine = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= TOOLTIP_MAX) return oneLine;
  return `${oneLine.slice(0, TOOLTIP_MAX - 1)}…`;
}

function setTrayTooltip(tray, text) {
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return;
  try {
    tray.setToolTip(truncateTooltip(text));
  } catch (_err) {
    /* ignore */
  }
}

/**
 * updateTrayStatus(tray, { title, tooltip })
 * `title` is macOS-only (Windows has no setTitle equivalent).
 */
function updateTrayStatus(tray, status) {
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return;
  const next = status || {};
  if (process.platform === 'darwin' && typeof tray.setTitle === 'function') {
    try {
      tray.setTitle(typeof next.title === 'string' ? next.title : '', {
        fontType: 'monospacedDigit',
      });
    } catch (_err) {
      /* ignore */
    }
  }
  if (typeof next.tooltip === 'string') setTrayTooltip(tray, next.tooltip);
}

// ---------------------------------------------------------------------------
// popover window
// ---------------------------------------------------------------------------

function popoverBackground() {
  try {
    return electron.nativeTheme && electron.nativeTheme.shouldUseDarkColors
      ? '#1c1c1e'
      : '#ffffff';
  } catch (_err) {
    return '#ffffff';
  }
}

/**
 * createPopoverWindow({ preload, width, height, devTools }) -> BrowserWindow
 * Electron's secure defaults are kept (and restated explicitly as documentation).
 */
function createPopoverWindow(options) {
  const opts = options || {};
  const width = Number(opts.width) || POPOVER_SIZE.width;
  const height = Number(opts.height) || POPOVER_SIZE.height;

  const windowOptions = {
    width,
    height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    hasShadow: true,
    roundedCorners: true,
    acceptFirstMouse: true,
    backgroundColor: popoverBackground(),
    title: 'SubSplit',
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      devTools: Boolean(opts.devTools),
    },
  };

  if (process.platform === 'darwin') {
    // NSWindowStyleMaskNonactivatingPanel: floats above full-screened apps.
    windowOptions.type = 'panel';
    windowOptions.visualEffectState = 'active';
  }

  const win = new BrowserWindow(windowOptions);

  if (process.platform === 'darwin') {
    // skipTransformProcessType keeps the dock icon hidden (electron#37832).
    win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  return win;
}

/**
 * Hide on blur, with a 100ms grace period so that clicking the tray icon while
 * the popover is open reads as a toggle instead of blur-then-reopen.
 * Returns a disposer.
 */
function attachAutoHide(win) {
  let timer = null;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const onBlur = () => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (!win.isDestroyed() && !win.isFocused()) win.hide();
    }, 100);
  };
  win.on('blur', onBlur);
  win.on('show', cancel);
  win.on('hide', cancel);
  return () => {
    cancel();
    if (!win.isDestroyed()) win.removeListener('blur', onBlur);
  };
}

module.exports = {
  POPOVER_SIZE,
  TOOLTIP_MAX,
  ICON_PATHS,
  trayIconPath,
  resolveTrayImage,
  createTray,
  createPopoverWindow,
  attachAutoHide,
  computePopoverPosition,
  positionWindow,
  rememberTrayBounds,
  getAnchorBounds,
  resetTrayBoundsCache,
  isUsableBounds,
  updateTrayStatus,
  setTrayTooltip,
  truncateTooltip,
};
