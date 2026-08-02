/* SubSplit popover renderer.
 *
 * Talks to the main process exclusively through the `window.subsplit` bridge
 * exposed by src/preload/preload.js:
 *
 *   getState()      -> Promise<UiState>
 *   saveSettings(p) -> Promise<UiState>
 *   joinGroup(o)    -> Promise<UiState>
 *   refreshNow()    -> Promise<UiState>
 *   copyInvite()    -> Promise<{ ok } | { ok: false, error }>
 *   pasteInvite()   -> Promise<{ ok, serverUrl, tokenMasked } | { ok: false, error }>
 *   openFolder(t)   -> Promise<{ ok } | { ok: false, error }>   t = root index | 'app-data'
 *   testConnection(u)-> Promise<{ ok, latencyMs, version, error, checkedAt }>  u = Server URL field
 *   quit()          -> void
 *   onState(cb)     -> unsubscribe()
 *
 * When that bridge is absent (plain browser dev) — or when the URL carries
 * `?mock=1` — an in-page mock with the same shape is installed instead.
 */
'use strict';

(function () {
  /* ─────────────────────────── constants ─────────────────────────── */

  var WINDOW_KEYS = ['weekly', '5h'];
  var WINDOW_MINUTES = { weekly: 10080, '5h': 300 };
  var WINDOW_LABEL = { weekly: 'Weekly', '5h': '5h' };
  var EN_DASH = '–';
  var HOT_PERCENT = 85;

  /* ───────────────────────── dom utilities ───────────────────────── */

  function role(name, root) {
    return (root || document).querySelector('[data-role="' + name + '"]');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  var dom = {
    app: document.getElementById('app'),
    viewLoading: document.querySelector('[data-view="loading"]'),
    viewForm: document.querySelector('[data-view="form"]'),
    viewDash: document.querySelector('[data-view="dash"]'),

    loadingText: role('loading-text'),
    reloadBtn: document.querySelector('[data-action="reload"]'),

    formTitle: role('form-title'),
    formLede: role('form-lede'),
    form: role('form'),
    fServer: role('f-server'),
    fToken: role('f-token'),
    fTokenHint: role('f-token-hint'),
    fName: role('f-name'),
    pasteInviteBtn: document.querySelector('[data-action="paste-invite"]'),
    copyInviteBtn: document.querySelector('[data-action="copy-invite"]'),
    inviteNote: role('invite-note'),
    alerts: role('alerts'),
    fNotify: role('f-notify'),
    fNotifyWeekly: role('f-notify-weekly'),
    fNotify5h: role('f-notify-5h'),
    fNotifyHint: role('f-notify-hint'),
    diag: role('diag'),
    diagRoots: role('diag-roots'),
    diagAppData: role('diag-appdata'),
    diagStats: role('diag-stats'),
    diagLogin: role('diag-login'),
    diagHealth: role('diag-health'),
    openAppDataBtn: document.querySelector('[data-action="open-appdata"]'),
    testConnectionBtn: document.querySelector('[data-action="test-connection"]'),
    formError: role('form-error'),
    formSubmit: role('form-submit'),
    formBack: document.querySelector('[data-action="form-back"]'),

    seg: role('seg'),
    banner: role('banner'),
    bannerText: role('banner-text'),
    account: role('account'),
    listHead: role('list-head'),
    fairHint: role('fair-hint'),
    members: role('members'),
    synced: role('synced'),
    refreshBtn: document.querySelector('[data-action="refresh"]'),
    settingsBtn: document.querySelector('[data-action="settings"]'),
    quitBtn: document.querySelector('[data-action="quit"]'),
    retryBtn: document.querySelector('[data-action="retry"]')
  };

  /* ───────────────────────── formatting ───────────────────────── */

  function num(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  // Codex `resets_at` is unix seconds upstream; everything here is ms.
  // Be forgiving if a value slips through in seconds.
  function toMs(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return null;
    return n < 1e11 ? n * 1000 : n;
  }

  function fmtTokens(value) {
    var n = Math.max(0, Math.round(num(value)));
    if (n < 1000) return String(n);
    var units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (var i = 0; i < units.length; i++) {
      if (n >= units[i][0]) {
        var v = n / units[i][0];
        var s = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
        return s + units[i][1];
      }
    }
    return String(n);
  }

  function fmtPercent(value) {
    if (value == null || !isFinite(Number(value))) return null;
    var p = Number(value);
    if (p > 0 && p < 1) return '<1%';
    return Math.round(p) + '%';
  }

  function clampPercent(value) {
    var p = Number(value);
    if (!isFinite(p) || p < 0) return 0;
    return p > 100 ? 100 : p;
  }

  function fmtCountdown(msLeft) {
    if (msLeft == null) return null;
    if (msLeft <= 0) return 'any moment';
    var s = Math.floor(msLeft / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  // Local weekday + hour, e.g. "Thu ~2pm". No Intl formats beyond the weekday.
  function fmtWhen(ms) {
    var d = new Date(ms);
    if (!isFinite(d.getTime())) return '';
    var day;
    try {
      day = d.toLocaleDateString(undefined, { weekday: 'short' });
    } catch (e) {
      day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    }
    var h = d.getHours();
    return day + ' ~' + (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'am' : 'pm');
  }

  function fmtAgo(msAgo) {
    var s = Math.max(0, Math.round(msAgo / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function hueOf(id) {
    var s = String(id == null ? '' : id);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h % 360) + 360) % 360;
  }

  function initialsOf(name, id) {
    var src = String(name || id || '').trim();
    if (!src) return '?';
    var parts = src.split(/[\s._\-]+/).filter(Boolean);
    if (!parts.length) return '?';
    var first = Array.from(parts[0]);
    if (parts.length === 1) return first.slice(0, 2).join('').toUpperCase();
    return (first[0] + Array.from(parts[1])[0]).toUpperCase();
  }

  function slug(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function errMessage(err) {
    if (!err) return 'Something went wrong.';
    if (typeof err === 'string') return err;
    var msg = err.message || err.code || '';
    msg = String(msg).replace(/^Error invoking remote method '[^']*':\s*/, '');
    msg = msg.replace(/^Error:\s*/, '');
    return msg || 'Something went wrong.';
  }

  /* ───────────────────────── state helpers ───────────────────────── */

  function normalize(state) {
    var s = state && typeof state === 'object' ? state : {};
    var settings = s.settings && typeof s.settings === 'object' ? s.settings : {};
    var local = s.local && typeof s.local === 'object' ? s.local : {};
    var sync = s.sync && typeof s.sync === 'object' ? s.sync : {};
    var pct = settings.notifyPct && typeof settings.notifyPct === 'object' ? settings.notifyPct : {};
    return {
      configured: !!s.configured,
      settings: {
        memberName: settings.memberName || '',
        // The id is what isYou() matches on — names are not unique.
        memberId: settings.memberId || null,
        serverUrl: settings.serverUrl || '',
        primaryWindow: settings.primaryWindow === '5h' ? '5h' : 'weekly',
        notifyEnabled: settings.notifyEnabled !== false,
        notifyPct: { weekly: pctOrNull(pct.weekly), '5h': pctOrNull(pct['5h']) }
      },
      local: {
        windows: local.windows && typeof local.windows === 'object' ? local.windows : {},
        lastScanAt: local.lastScanAt == null ? null : Number(local.lastScanAt),
        stats: local.stats && typeof local.stats === 'object' ? local.stats : null,
        // Diagnostics. Roots arrive as paths to print; what goes back the other
        // way is only ever their index (see doOpenFolder).
        roots: Array.isArray(local.roots) ? local.roots.filter(function (r) { return r && typeof r === 'object'; }) : [],
        appDataPath: typeof local.appDataPath === 'string' ? local.appDataPath : '',
        loginItemEnabled: !!local.loginItemEnabled
      },
      group: s.group && typeof s.group === 'object' ? s.group : null,
      // Computed in the main process (src/main/capacity.js) — never here.
      capacity: s.capacity && typeof s.capacity === 'object' ? s.capacity : {},
      // Likewise src/main/pace.js.
      pace: s.pace && typeof s.pace === 'object' ? s.pace : {},
      sync: {
        lastSyncAt: sync.lastSyncAt == null ? null : Number(sync.lastSyncAt),
        error: sync.error && typeof sync.error === 'object' ? sync.error : null,
        clockSkewMs: sync.clockSkewMs == null ? null : Number(sync.clockSkewMs),
        // Latest "Test connection" result, or null. Never carries a token: the
        // probe behind it is unauthenticated.
        health: sync.health && typeof sync.health === 'object' ? sync.health : null
      }
    };
  }

  function pctOrNull(value) {
    var n = Number(value);
    return isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : null;
  }

  // { accountPct, members: { id: pct } } for a window, or null when the main
  // process could not compute one (no account gauge, or nothing used yet).
  function capacityFor(state, key) {
    var cap = state.capacity ? state.capacity[key] : null;
    if (!cap || typeof cap !== 'object' || !cap.members || typeof cap.members !== 'object') return null;
    var accountPct = Number(cap.accountPct);
    if (!isFinite(accountPct)) return null;
    return { accountPct: accountPct, members: cap.members };
  }

  // { projectedPct, hitsAtMs } for a window, or null when the main process
  // could not project one (no gauge, stale snapshot, or too early to tell).
  function paceFor(state, key) {
    var p = state.pace ? state.pace[key] : null;
    if (!p || typeof p !== 'object') return null;
    var projected = Number(p.projectedPct);
    if (!isFinite(projected)) return null;
    return {
      projectedPct: projected,
      hitsAtMs: p.hitsAtMs == null ? null : toMs(p.hitsAtMs)
    };
  }

  function memberCapacity(cap, member) {
    if (!cap) return null;
    var value = cap.members[member.member_id];
    return value == null || !isFinite(Number(value)) ? null : Number(value);
  }

  function membersOf(state) {
    var list = state.group && Array.isArray(state.group.members) ? state.group.members : [];
    return list.filter(function (m) { return m && typeof m === 'object'; });
  }

  // Account-wide rate-limit snapshot window (freshest across the group's
  // devices), falling back to whatever this machine parsed locally.
  function accountWindow(state, key) {
    var snap = state.group && state.group.account_rate_limit;
    var minutes = WINDOW_MINUTES[key];
    if (snap && Array.isArray(snap.windows)) {
      for (var i = 0; i < snap.windows.length; i++) {
        var w = snap.windows[i];
        if (w && Number(w.windowMinutes) === minutes) {
          return { usedPercent: w.usedPercent == null ? null : Number(w.usedPercent), resetsAt: toMs(w.resetsAt) };
        }
      }
    }
    var localWin = state.local.windows[key];
    if (localWin) {
      return {
        usedPercent: localWin.used_percent == null ? null : Number(localWin.used_percent),
        resetsAt: toMs(localWin.resets_at)
      };
    }
    return { usedPercent: null, resetsAt: null };
  }

  function memberWindow(member, key) {
    var w = member && member.windows && member.windows[key];
    return w && typeof w === 'object' ? w : null;
  }

  function groupTotal(state, key) {
    var list = membersOf(state);
    if (!list.length) {
      var localWin = state.local.windows[key];
      return localWin ? num(localWin.total) : 0;
    }
    var sum = 0;
    for (var i = 0; i < list.length; i++) {
      var w = memberWindow(list[i], key);
      if (w) sum += num(w.total);
    }
    return sum;
  }

  function windowExists(state, key) {
    if (state.local.windows[key]) return true;
    var acct = accountWindow(state, key);
    if (acct.usedPercent != null || acct.resetsAt != null) return true;
    return membersOf(state).some(function (m) { return !!memberWindow(m, key); });
  }

  function availableWindows(state) {
    return WINDOW_KEYS.filter(function (key) { return windowExists(state, key); });
  }

  function primaryWindowOf(state, available) {
    var want = state.settings.primaryWindow;
    if (available.indexOf(want) !== -1) return want;
    return available.length ? available[0] : 'weekly';
  }

  function isYou(member, state) {
    if (state.settings.memberId) return member.member_id === state.settings.memberId;
    var mine = state.settings.memberName;
    if (!mine) return false;
    if (member.member_name && member.member_name === mine) return true;
    var mineSlug = slug(mine);
    if (!mineSlug) return false;
    return member.member_id === mineSlug || slug(member.member_name) === mineSlug;
  }

  function allDevicesStale(member) {
    var devices = Array.isArray(member.devices) ? member.devices : [];
    if (!devices.length) return false;
    return devices.every(function (d) { return d && d.stale; });
  }

  function hasLocalData(state) {
    var stats = state.local.stats;
    if (stats && Number(stats.files) > 0) return true;
    return WINDOW_KEYS.some(function (key) {
      var w = state.local.windows[key];
      return w && num(w.total) > 0;
    });
  }

  /* ───────────────────────── view mode ───────────────────────── */

  var api = null;
  var current = null;      // normalized UiState
  var mode = 'loading';    // 'loading' | 'onboard' | 'dash' | 'settings'
  var formMode = 'onboard';// which flavour the shared form is showing
  var busy = { form: false, refresh: false, health: false };
  var ticking = [];        // [{ node, resetAt }]
  // True once a pasted invite is loaded: the token itself stayed in the main
  // process, so the form submits an empty token and main fills it back in.
  var fromInvite = false;
  var inviteServer = '';   // the URL that invite is good for, as main sees it
  var noteTimer = null;
  var healthTimer = null;  // the health note is transient — it ages out

  // Main matches a pending invite to the submitted URL canonically, and treats a
  // trailing slash as the same server (src/main/invite.js). Mirror that here so
  // the "from invite" state never claims a token main would refuse to use.
  function sameServer(a, b) {
    return String(a).trim().replace(/\/+$/, '') === String(b).trim().replace(/\/+$/, '');
  }

  function setMode(next) {
    mode = next;
    show(dom.viewLoading, next === 'loading');
    show(dom.viewForm, next === 'onboard' || next === 'settings');
    show(dom.viewDash, next === 'dash');
  }

  function apply(state) {
    current = normalize(state);
    if (!current.configured) {
      if (mode !== 'onboard') fillForm('onboard');
      setMode('onboard');
    } else {
      if (mode === 'onboard' || mode === 'loading') setMode('dash');
      else setMode(mode);
    }
    if (mode === 'dash') renderDash();
    // Diagnostics hold no user input, so a state push may refresh them in place
    // without disturbing whatever is half-typed in the fields above.
    if (mode === 'settings') renderDiagnostics();
    return current;
  }

  /* ───────────────────────── form view ───────────────────────── */

  function fillForm(which) {
    var settings = current ? current.settings : { memberName: '', serverUrl: '' };
    var onboarding = which === 'onboard';
    formMode = which;

    dom.formTitle.textContent = onboarding ? 'Join your group' : 'Settings';
    dom.formLede.textContent = onboarding
      ? 'Point SubSplit at your group’s server and paste the join token you were given.'
      : 'Change how you appear to the group, or move to a different server.';
    dom.formSubmit.textContent = onboarding ? 'Join group' : 'Save';
    show(dom.formBack, !onboarding);
    show(dom.fTokenHint, !onboarding);

    dom.fServer.value = settings.serverUrl || '';
    dom.fName.value = settings.memberName || '';
    dom.fToken.value = '';
    clearInvite();

    // Paste an invite when joining; hand one out once you are in a group.
    show(dom.pasteInviteBtn, onboarding);
    show(dom.copyInviteBtn, !onboarding);
    setInviteNote('');

    // Alerts are about your own share of a group you are already in, and
    // diagnostics are about a setup that already exists.
    show(dom.alerts, !onboarding);
    if (!onboarding) fillAlerts();
    show(dom.diag, !onboarding);
    if (!onboarding) renderDiagnostics();

    setFormError(null);
    setFormBusy(false);
  }

  function fillAlerts() {
    var settings = current ? current.settings : { notifyEnabled: true, notifyPct: {} };
    var pct = settings.notifyPct || {};

    dom.fNotify.checked = settings.notifyEnabled !== false;
    dom.fNotifyWeekly.value = pct.weekly == null ? '' : String(pct.weekly);
    dom.fNotify5h.value = pct['5h'] == null ? '' : String(pct['5h']);

    var count = current ? membersOf(current).length : 0;
    var auto = count > 0 ? Math.round(100 / count) : null;
    dom.fNotifyHint.textContent = auto == null
      ? 'Leave a box empty for auto — your fair share of the account limit.'
      : 'Leave a box empty for auto, which is ' + auto + '% right now (' + count +
        (count === 1 ? ' member).' : ' members).');
  }

  function readAlertInput(input) {
    var raw = input.value.trim();
    if (!raw) return null;
    var n = Math.round(Number(raw));
    return isFinite(n) && n >= 1 && n <= 100 ? n : null;
  }

  /* ───────────────────────── diagnostics ───────────────────────── */

  function fmtBytes(value) {
    var n = Math.max(0, Math.round(num(value)));
    if (n < 1024) return n + ' B';
    var units = [[1 << 30, 'GB'], [1 << 20, 'MB'], [1024, 'KB']];
    for (var i = 0; i < units.length; i++) {
      if (n >= units[i][0]) {
        var v = n / units[i][0];
        return (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))) + ' ' + units[i][1];
      }
    }
    return n + ' B';
  }

  function statRow(label, value, warn) {
    dom.diagStats.appendChild(el('span', 'diag-stat-label', label));
    dom.diagStats.appendChild(el('span', 'diag-stat-value' + (warn ? ' is-warn' : ''), value));
  }

  // One Codex home. The Open button carries the root's INDEX and nothing else —
  // main resolves the path from its own list, so this window never gets to name
  // a folder for the OS to open.
  function rootRow(root, index) {
    var row = el('div', 'diag-root');

    var pathEl = el('span', 'diag-path', root.path || '(unknown)');
    pathEl.title = root.path || '';
    row.appendChild(pathEl);

    var exists = !!root.exists;
    var tag = el('span', 'diag-tag' + (exists ? '' : ' is-missing'), exists ? 'found' : 'missing');
    tag.title = exists ? 'This folder exists on disk' : 'No such folder — SubSplit has nothing to read here';
    row.appendChild(tag);

    var open = el('button', 'btn btn-ghost btn-sm', 'Open');
    open.type = 'button';
    open.dataset.rootIndex = String(index);
    row.appendChild(open);

    return row;
  }

  function renderDiagnostics() {
    if (!current) return;
    var local = current.local;

    dom.diagRoots.textContent = '';
    if (!local.roots.length) {
      dom.diagRoots.appendChild(el('p', 'diag-value', 'No Codex home resolved.'));
    } else {
      local.roots.forEach(function (root, index) {
        dom.diagRoots.appendChild(rootRow(root, index));
      });
    }

    dom.diagAppData.textContent = local.appDataPath || '';
    dom.diagAppData.title = local.appDataPath || '';

    var stats = local.stats || {};
    dom.diagStats.textContent = '';
    statRow('Files', String(Math.round(num(stats.files))));
    statRow('New bytes', fmtBytes(stats.newBytes));
    // Per-scan, like everything else in this block: an incremental scan reads
    // almost no new bytes, so this is normally 0 even when a cold scan skipped
    // lines. Say so in the label rather than letting it read as a running total.
    statRow('Bad lines (this scan)', String(Math.round(num(stats.badLines))), num(stats.badLines) > 0);
    statRow('Fork baselines', String(Math.round(num(stats.forkBaselines))));
    statRow('Scanned', local.lastScanAt == null ? 'never' : fmtAgo(Date.now() - local.lastScanAt));

    dom.diagLogin.textContent = local.loginItemEnabled ? 'Enabled' : 'Not enabled';
  }

  function setHealthNote(message, ok) {
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    dom.diagHealth.textContent = message || '';
    dom.diagHealth.classList.toggle('is-ok', !!message && ok === true);
    dom.diagHealth.classList.toggle('is-bad', !!message && ok === false);
    if (message && ok !== null) {
      healthTimer = setTimeout(function () {
        healthTimer = null;
        setHealthNote('', null);
      }, 8000);
    }
  }

  function healthSummary(result) {
    var latency = result.latencyMs == null ? null : Math.round(Number(result.latencyMs));
    if (result.ok) {
      var text = 'Reachable';
      if (latency != null && isFinite(latency)) text += ' · ' + latency + ' ms';
      if (result.version) text += ' · server v' + result.version;
      return text;
    }
    var why = result.error && result.error.message ? result.error.message : 'No answer from the server.';
    return 'Unreachable — ' + why;
  }

  function doTestConnection() {
    if (busy.health) return;
    busy.health = true;
    dom.testConnectionBtn.disabled = true;
    setHealthNote('Testing…', null);
    // The field as it stands, not the saved setting: the button exists for
    // exactly the case where the two differ. Main validates it — blank falls
    // back to the stored URL, malformed is reported as malformed.
    var typedUrl = dom.fServer ? String(dom.fServer.value || '').trim() : '';
    Promise.resolve(api.testConnection(typedUrl)).then(function (result) {
      busy.health = false;
      dom.testConnectionBtn.disabled = false;
      var res = result && typeof result === 'object' ? result : { ok: false, error: null };
      setHealthNote(healthSummary(res), !!res.ok);
    }, function (err) {
      busy.health = false;
      dom.testConnectionBtn.disabled = false;
      setHealthNote('Unreachable — ' + errMessage(err), false);
    });
  }

  // `target` is a root index or the 'app-data' enum — never a path.
  function doOpenFolder(target) {
    Promise.resolve(api.openFolder(target)).then(function (result) {
      var res = result || {};
      if (!res.ok) setFormError(res.error || 'That folder could not be opened.');
      else setFormError(null);
    }, function (err) {
      setFormError(errMessage(err));
    });
  }

  /* ───────────────────────── invites ───────────────────────── */

  function setInviteNote(message) {
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
    dom.inviteNote.textContent = message || '';
    if (message) {
      noteTimer = setTimeout(function () {
        noteTimer = null;
        dom.inviteNote.textContent = '';
      }, 2200);
    }
  }

  function clearInvite() {
    fromInvite = false;
    inviteServer = '';
    dom.fToken.classList.remove('is-invite');
    dom.fToken.placeholder = formMode === 'onboard' ? 'ss_…' : 'unchanged';
  }

  function doPasteInvite() {
    if (busy.form) return;
    Promise.resolve(api.pasteInvite()).then(function (result) {
      var res = result || {};
      if (!res.ok) return setFormError(res.error || 'Could not read an invite from the clipboard.');
      setFormError(null);
      dom.fServer.value = res.serverUrl || '';
      dom.fToken.value = '';
      dom.fToken.placeholder = res.tokenMasked || 'from invite';
      dom.fToken.classList.add('is-invite');
      fromInvite = true;
      inviteServer = res.serverUrl || '';
      setInviteNote('Invite loaded');
      dom.fName.focus();
    }, function (err) {
      setFormError(errMessage(err));
    });
  }

  function doCopyInvite() {
    Promise.resolve(api.copyInvite()).then(function (result) {
      var res = result || {};
      if (!res.ok) return setFormError(res.error || 'Could not copy the invite.');
      setFormError(null);
      setInviteNote('Copied!');
    }, function (err) {
      setFormError(errMessage(err));
    });
  }

  function setFormError(message) {
    if (!message) {
      dom.formError.textContent = '';
      show(dom.formError, false);
      return;
    }
    dom.formError.textContent = message;
    show(dom.formError, true);
  }

  function setFormBusy(value) {
    busy.form = value;
    dom.formSubmit.disabled = value;
    var onboarding = formMode === 'onboard';
    dom.formSubmit.textContent = value
      ? (onboarding ? 'Joining…' : 'Saving…')
      : (onboarding ? 'Join group' : 'Save');
  }

  function submitForm(event) {
    if (event) event.preventDefault();
    if (busy.form) return;

    var serverUrl = dom.fServer.value.trim();
    var token = dom.fToken.value.trim();
    var memberName = dom.fName.value.trim();
    var onboarding = formMode === 'onboard';

    if (!serverUrl) return setFormError('Enter the server URL your group is using.');
    if (!/^https?:\/\//i.test(serverUrl)) return setFormError('The server URL should start with http:// or https://.');
    if (onboarding && !token && !fromInvite) return setFormError('Paste the join token you were given (it starts with ss_), or use Paste invite.');
    if (!memberName) return setFormError('Add a name so the rest of the group knows who you are.');

    setFormError(null);
    setFormBusy(true);

    var promise = onboarding
      ? api.joinGroup({ serverUrl: serverUrl, joinToken: token, memberName: memberName })
      : api.saveSettings(buildSettingsPatch(serverUrl, memberName, token));

    Promise.resolve(promise).then(function (state) {
      setFormBusy(false);
      if (!onboarding) {
        current = normalize(state);
        setMode('dash');
        renderDash();
      } else {
        apply(state);
      }
    }, function (err) {
      setFormBusy(false);
      setFormError(errMessage(err));
    });
  }

  // saveSettings takes a partial: omitting joinToken keeps the stored token.
  function buildSettingsPatch(serverUrl, memberName, token) {
    var patch = {
      serverUrl: serverUrl,
      memberName: memberName,
      notifyEnabled: !!dom.fNotify.checked,
      // Both windows every time: main replaces the pair wholesale.
      notifyPct: {
        weekly: readAlertInput(dom.fNotifyWeekly),
        '5h': readAlertInput(dom.fNotify5h)
      }
    };
    if (token) patch.joinToken = token;
    return patch;
  }

  /* ───────────────────────── dashboard ───────────────────────── */

  function renderDash() {
    var state = current;
    var available = availableWindows(state);
    var primary = primaryWindowOf(state, available);
    var offline = !!state.sync.error;

    dom.viewDash.classList.toggle('is-offline', offline);

    renderSeg(available, primary);
    renderBanner(state);
    renderAccount(state, available, primary);
    renderMembers(state, primary);
    renderFooter(state);
    tick();
  }

  function renderSeg(available, primary) {
    var both = available.length > 1;
    show(dom.seg, both);
    if (!both) return;
    var buttons = dom.seg.querySelectorAll('.seg-btn');
    for (var i = 0; i < buttons.length; i++) {
      var key = buttons[i].getAttribute('data-window');
      buttons[i].setAttribute('aria-pressed', key === primary ? 'true' : 'false');
    }
  }

  function renderBanner(state) {
    var err = state.sync.error;
    if (!err) {
      show(dom.banner, false);
      return;
    }
    dom.bannerText.textContent = errMessage(err);
    show(dom.banner, true);
  }

  function renderAccount(state, available, primary) {
    dom.account.textContent = '';
    ticking = [];

    if (!available.length) {
      var empty = el('div', 'acct-row');
      var top = el('div', 'acct-top');
      top.appendChild(el('span', 'acct-label', 'No usage yet'));
      top.appendChild(el('span', 'acct-value', EN_DASH));
      empty.appendChild(top);
      var sub = el('div', 'acct-sub');
      sub.appendChild(el('span', 'acct-note', 'Waiting for the first scan of your Codex sessions'));
      empty.appendChild(sub);
      dom.account.appendChild(empty);
      return;
    }

    // Primary window leads — it is the number the tray title shows.
    var ordered = available.slice().sort(function (a, b) {
      return (a === primary ? 0 : 1) - (b === primary ? 0 : 1);
    });
    ordered.forEach(function (key) {
      dom.account.appendChild(accountRow(state, key, key !== primary));
    });
  }

  function accountRow(state, key, secondary) {
    var acct = accountWindow(state, key);
    var total = groupTotal(state, key);
    var pct = acct.usedPercent;
    var known = pct != null && isFinite(pct);

    var row = el('div', 'acct-row' + (secondary ? ' is-secondary' : ''));
    if (known && pct >= HOT_PERCENT) row.classList.add('is-hot');

    var top = el('div', 'acct-top');
    top.appendChild(el('span', 'acct-label', WINDOW_LABEL[key]));
    top.appendChild(el('span', 'acct-value', known ? fmtPercent(pct) : fmtTokens(total)));
    row.appendChild(top);

    if (known) {
      var meter = el('div', 'meter');
      var fill = el('div', 'meter-fill');
      fill.style.width = clampPercent(pct) + '%';
      meter.appendChild(fill);
      row.appendChild(meter);
    }

    var sub = el('div', 'acct-sub');
    var reset = el('span', 'acct-reset');
    if (acct.resetsAt) {
      ticking.push({ node: reset, resetAt: acct.resetsAt });
    } else {
      reset.textContent = 'resets in ' + EN_DASH;
    }
    sub.appendChild(reset);
    sub.appendChild(el('span', 'acct-note', known ? fmtTokens(total) + ' tokens' : 'group total'));
    row.appendChild(sub);

    var pace = paceFor(state, key);
    if (pace) row.appendChild(paceLine(pace));

    return row;
  }

  // "on pace for ~118% — hits 100% Thu ~2pm", or just the projection when the
  // window is not heading for the limit.
  function paceLine(pace) {
    var over = pace.projectedPct >= 100;
    var line = el('div', 'acct-pace' + (over ? ' is-warn' : ''));
    var text = 'on pace for ~' + Math.round(pace.projectedPct) + '%';
    if (pace.hitsAtMs != null) text += ' ' + EN_DASH + ' hits 100% ' + fmtWhen(pace.hitsAtMs);
    line.textContent = text;
    return line;
  }

  function renderMembers(state, primary) {
    var scrollTop = dom.members.scrollTop;
    dom.members.textContent = '';

    var list = membersOf(state).slice();
    list.sort(function (a, b) {
      var wa = memberWindow(a, primary);
      var wb = memberWindow(b, primary);
      var diff = num(wb && wb.total) - num(wa && wa.total);
      if (diff !== 0) return diff;
      return String(a.member_name || a.member_id || '').localeCompare(String(b.member_name || b.member_id || ''));
    });

    dom.listHead.textContent = list.length ? 'Members · ' + list.length : 'Members';
    var fair = list.length ? 100 / list.length : 0;
    dom.fairHint.textContent = list.length > 1 ? 'fair share ' + Math.round(fair) + '%' : '';

    // Only claim there is nothing to find once a scan has actually run.
    if (state.local.lastScanAt != null && !hasLocalData(state)) {
      dom.members.appendChild(card(
        'No local Codex data found',
        'SubSplit reads token counts from your Codex session logs. Run Codex once, or set CODEX_HOME if it lives somewhere unusual.',
        true
      ));
    }

    if (!state.group) {
      dom.members.appendChild(card(
        'Not synced yet',
        'Waiting for the first exchange with the group server. Your own usage is already being tracked locally.',
        true
      ));
      dom.members.scrollTop = scrollTop;
      return;
    }

    var cap = capacityFor(state, primary);
    list.forEach(function (member) {
      dom.members.appendChild(memberRow(member, state, primary, fair, cap));
    });

    if (!list.length) {
      dom.members.appendChild(card(
        'Nobody here yet',
        'Once someone joins with the group’s token, they show up here automatically.',
        true
      ));
    } else if (list.length === 1) {
      dom.members.appendChild(card(
        'You’re the only one here',
        'Share the join token with the rest of your group — their usage appears here as soon as they join.',
        false
      ));
    }

    dom.members.scrollTop = scrollTop;
  }

  function memberRow(member, state, primary, fair, cap) {
    var win = memberWindow(member, primary);
    var total = num(win && win.total);
    var share = win && win.share_pct != null ? Number(win.share_pct) : 0;
    var you = isYou(member, state);
    var stale = allDevicesStale(member);
    var over = fair > 0 && share > fair + 0.5;

    var row = el('div', 'member');
    if (you) row.classList.add('is-you');
    if (over) row.classList.add('is-over');
    if (stale) row.classList.add('is-stale');

    var name = member.member_name || member.member_id || 'Unknown';

    var avatar = el('div', 'avatar', initialsOf(member.member_name, member.member_id));
    avatar.style.setProperty('--hue', String(hueOf(member.member_id || name)));
    avatar.setAttribute('aria-hidden', 'true');
    row.appendChild(avatar);

    var main = el('div', 'm-main');

    var top = el('div', 'm-top');
    var nameEl = el('span', 'm-name', name);
    nameEl.title = name;
    top.appendChild(nameEl);
    if (you) top.appendChild(el('span', 'badge', 'you'));
    if (stale) {
      var dot = el('span', 'dot-stale');
      dot.title = 'All of this member’s devices are stale';
      top.appendChild(dot);
    }
    var tokens = el('span', 'm-tokens', fmtTokens(total));
    tokens.title = Math.round(total).toLocaleString() + ' tokens';
    top.appendChild(tokens);
    main.appendChild(top);

    var bottom = el('div', 'm-bottom');
    var bar = el('div', 'm-bar');
    var fill = el('div', 'm-bar-fill');
    fill.style.width = clampPercent(share) + '%';
    bar.appendChild(fill);
    if (fair > 0 && fair < 100) {
      var guide = el('div', 'm-bar-guide');
      guide.style.left = fair + '%';
      guide.title = 'fair share ' + Math.round(fair) + '%';
      bar.appendChild(guide);
    }
    bottom.appendChild(bar);
    var shareEl = el('span', 'm-share', fmtPercent(share) || '0%');
    if (over) shareEl.title = 'Over the fair share of ' + Math.round(fair) + '%';
    bottom.appendChild(shareEl);
    main.appendChild(bottom);

    // Capacity: this member's slice of the account limit. Shown only when the
    // main process could compute one — no gauge, no row.
    var capPct = memberCapacity(cap, member);
    if (capPct != null) {
      main.appendChild(capacityLine(capPct, primary, fair, you));
    }

    row.appendChild(main);
    return row;
  }

  // The fair-share marker here is 100/N of the whole account limit — the same
  // number the AUTO alert threshold uses.
  function capacityLine(capPct, primary, fair, you) {
    var line = el('div', 'm-cap');
    if (fair > 0 && capPct > fair + 0.5) line.classList.add('is-over');

    var track = el('div', 'm-cap-track');
    var fill = el('div', 'm-cap-fill');
    fill.style.width = clampPercent(capPct) + '%';
    track.appendChild(fill);
    if (fair > 0 && fair < 100) {
      var guide = el('div', 'm-cap-guide');
      guide.style.left = fair + '%';
      guide.title = 'fair share ' + Math.round(fair) + '% of the limit';
      track.appendChild(guide);
    }
    line.appendChild(track);

    var text = el('span', 'm-cap-text', '~' + (fmtPercent(capPct) || '0%') + ' of ' + WINDOW_LABEL[primary].toLowerCase() + ' limit');
    text.title = (you ? 'You have' : 'This member has') + ' used about ' +
      (fmtPercent(capPct) || '0%') + ' of the account’s ' + WINDOW_LABEL[primary].toLowerCase() + ' limit';
    line.appendChild(text);

    return line;
  }

  function card(title, text, quiet) {
    var node = el('div', 'card' + (quiet ? ' is-quiet' : ''));
    node.appendChild(el('p', 'card-title', title));
    node.appendChild(el('p', 'card-text', text));
    return node;
  }

  function renderFooter(state) {
    var last = state && state.sync ? state.sync.lastSyncAt : null;
    dom.synced.dataset.since = last == null ? '' : String(last);
    dom.refreshBtn.classList.toggle('is-busy', busy.refresh);
    dom.refreshBtn.disabled = busy.refresh;
  }

  /* ───────────────────────── one-second tick ───────────────────────── */

  function tick() {
    var now = Date.now();

    for (var i = 0; i < ticking.length; i++) {
      var entry = ticking[i];
      var left = fmtCountdown(entry.resetAt - now);
      entry.node.textContent = left === 'any moment' ? 'resetting any moment' : 'resets in ' + left;
    }

    if (mode === 'dash' && current) {
      var since = dom.synced.dataset.since;
      if (busy.refresh) dom.synced.textContent = 'syncing…';
      else if (!since) dom.synced.textContent = current.sync.error ? 'not synced' : 'not synced yet';
      else dom.synced.textContent = 'synced ' + fmtAgo(now - Number(since));
    }
  }

  /* ───────────────────────── actions ───────────────────────── */

  function doRefresh() {
    if (busy.refresh) return;
    busy.refresh = true;
    renderFooter(current);
    tick();
    Promise.resolve(api.refreshNow()).then(function (state) {
      busy.refresh = false;
      apply(state);
    }, function (err) {
      busy.refresh = false;
      if (current) {
        current.sync.error = { code: 'refresh_failed', message: errMessage(err) };
        renderDash();
      }
    });
  }

  function doSetPrimary(key) {
    if (!current || current.settings.primaryWindow === key) return;
    current.settings.primaryWindow = key;
    renderDash();
    Promise.resolve(api.saveSettings({ primaryWindow: key })).then(apply, function () { /* keep optimistic view */ });
  }

  function bind() {
    dom.form.addEventListener('submit', submitForm);

    dom.pasteInviteBtn.addEventListener('click', doPasteInvite);
    dom.copyInviteBtn.addEventListener('click', doCopyInvite);
    // Typing a token by hand takes precedence over a pasted invite.
    dom.fToken.addEventListener('input', function () {
      if (fromInvite) clearInvite();
    });
    // An invite is only good for the server it came from. Pointing the form at a
    // different one drops it, so the field stops advertising a token that main
    // would decline to use; tidying the same URL up keeps it.
    dom.fServer.addEventListener('input', function () {
      if (fromInvite && !sameServer(dom.fServer.value, inviteServer)) clearInvite();
    });
    // Delegated: each Open button carries its root's index, not its path.
    dom.diagRoots.addEventListener('click', function (event) {
      var btn = event.target.closest ? event.target.closest('button[data-root-index]') : null;
      if (!btn) return;
      var index = Number(btn.dataset.rootIndex);
      if (isFinite(index)) doOpenFolder(index);
    });
    dom.openAppDataBtn.addEventListener('click', function () { doOpenFolder('app-data'); });
    dom.testConnectionBtn.addEventListener('click', doTestConnection);

    dom.formBack.addEventListener('click', function () {
      if (!current || !current.configured) return;
      setMode('dash');
      renderDash();
    });

    dom.settingsBtn.addEventListener('click', function () {
      fillForm('settings');
      setMode('settings');
      setFormBusy(false);
      dom.fName.focus();
    });

    dom.refreshBtn.addEventListener('click', doRefresh);
    dom.retryBtn.addEventListener('click', doRefresh);
    dom.quitBtn.addEventListener('click', function () { api.quit(); });

    dom.seg.addEventListener('click', function (event) {
      var btn = event.target.closest ? event.target.closest('.seg-btn') : null;
      if (btn) doSetPrimary(btn.getAttribute('data-window'));
    });

    dom.reloadBtn.addEventListener('click', function () { boot(); });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && mode === 'settings' && current && current.configured) {
        setMode('dash');
        renderDash();
      }
    });

    // The popover has no browser chrome — nothing here should ever navigate.
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });
  }

  function fatal(message) {
    setMode('loading');
    dom.loadingText.textContent = message;
    show(dom.reloadBtn, true);
  }

  /* ───────────────────────── boot ───────────────────────── */

  var unsubscribe = null;

  function boot() {
    dom.loadingText.textContent = 'Loading…';
    show(dom.reloadBtn, false);
    setMode('loading');

    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch (e) { /* ignore */ }
      unsubscribe = null;
    }

    Promise.resolve(api.getState()).then(function (state) {
      apply(state);
      if (typeof api.onState === 'function') {
        var off = api.onState(function (next) {
          if (busy.form) return;   // don't yank the form out from under a submit
          apply(next);
        });
        if (typeof off === 'function') unsubscribe = off;
      }
    }, function (err) {
      fatal(errMessage(err));
    });
  }

  function start() {
    api = resolveApi();
    bind();
    boot();
    setInterval(tick, 1000);
  }

  function resolveApi() {
    var wantMock = /[?&]mock=1\b/.test(window.location.search);
    if (!wantMock && window.subsplit && typeof window.subsplit.getState === 'function') {
      return window.subsplit;
    }
    return installMock();
  }

  /* ─────────────────────────────────────────────────────────────────
   * Dev mock — only used when window.subsplit is missing (plain browser)
   * or when ?mock=1 forces it. Same surface, same shapes.
   * Scenarios: ?mock=1&scenario=onboard|solo|error|nodata|unsynced
   * ───────────────────────────────────────────────────────────────── */

  function installMock() {
    var params = new URLSearchParams(window.location.search);
    var scenario = params.get('scenario') || 'default';
    var listeners = [];
    var state = mockState(scenario);

    function emit() {
      var snapshot = clone(state);
      listeners.slice().forEach(function (fn) {
        try { fn(snapshot); } catch (e) { /* ignore */ }
      });
    }

    var mock = {
      getState: function () { return delay(120).then(function () { return clone(state); }); },
      saveSettings: function (partial) {
        return delay(180).then(function () {
          var p = partial || {};
          if (p.memberName) state.settings.memberName = p.memberName;
          if (p.serverUrl) state.settings.serverUrl = p.serverUrl;
          if (p.primaryWindow) state.settings.primaryWindow = p.primaryWindow;
          if (typeof p.notifyEnabled === 'boolean') state.settings.notifyEnabled = p.notifyEnabled;
          if (p.notifyPct) state.settings.notifyPct = p.notifyPct;
          emit();
          return clone(state);
        });
      },
      joinGroup: function (opts) {
        return delay(700).then(function () {
          var o = opts || {};
          if (!/^ss_/.test(String(o.joinToken || ''))) {
            throw { code: 'bad_token', message: 'That join token wasn’t accepted — check it starts with ss_ and was copied in full.' };
          }
          state = mockState('default');
          state.settings.memberName = o.memberName || state.settings.memberName;
          state.settings.serverUrl = o.serverUrl || state.settings.serverUrl;
          emit();
          return clone(state);
        });
      },
      refreshNow: function () {
        return delay(650).then(function () {
          state.sync.lastSyncAt = Date.now();
          state.sync.error = null;
          state.local.lastScanAt = Date.now();
          jitter(state);
          emit();
          return clone(state);
        });
      },
      copyInvite: function () {
        return delay(150).then(function () { return { ok: true }; });
      },
      pasteInvite: function () {
        return delay(150).then(function () {
          return {
            ok: true,
            serverUrl: 'https://subsplit.example.workers.dev',
            tokenMasked: 'ss_a1b2…(hidden)'
          };
        });
      },
      openFolder: function (target) {
        return delay(120).then(function () {
          console.info('[mock] openFolder(' + JSON.stringify(target) + ')');
          if (target !== 'app-data' && !(state.local.roots || [])[target]) {
            return { ok: false, error: 'There is no folder to open there.' };
          }
          return { ok: true };
        });
      },
      testConnection: function (serverUrl) {
        return delay(500).then(function () {
          console.info('[mock] testConnection(' + JSON.stringify(serverUrl || '') + ')');
          // Both outcomes are reachable from the mock: healthy by default, and
          // a failure in the scenarios where the server is the suspect.
          var broken = scenario === 'error' || scenario === 'nodata';
          state.sync.health = broken
            ? {
                ok: false,
                latencyMs: 5000,
                version: null,
                error: { code: 'timeout', message: 'The server did not answer within 5s.' },
                checkedAt: Date.now()
              }
            : { ok: true, latencyMs: 128, version: '1', error: null, checkedAt: Date.now() };
          emit();
          return clone(state.sync.health);
        });
      },
      quit: function () { console.info('[mock] quit()'); },
      onState: function (cb) {
        listeners.push(cb);
        return function () {
          var i = listeners.indexOf(cb);
          if (i !== -1) listeners.splice(i, 1);
        };
      }
    };

    window.subsplit = mock;
    console.info('[subsplit] using in-page mock (scenario: ' + scenario + ')');
    return mock;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function mockState(scenario) {
    var now = Date.now();
    var weeklyReset = now + (2 * 24 + 4) * 3600e3 + 15 * 60e3;
    var fiveReset = now + 3 * 3600e3 + 42 * 60e3;

    function totals(key, total, share) {
      var span = key === 'weekly' ? 10080 * 60e3 : 300 * 60e3;
      var reset = key === 'weekly' ? weeklyReset : fiveReset;
      return {
        window_start: reset - span,
        resets_at: reset,
        used_percent: null,
        input: Math.round(total * 0.62),
        cached_input: Math.round(total * 0.41),
        output: Math.round(total * 0.38),
        total: total,
        share_pct: share
      };
    }

    function member(id, name, weekly, five, devices) {
      var wTotal = 3160000;
      var fTotal = 347000;
      return {
        member_id: id,
        member_name: name,
        devices: devices,
        windows: {
          weekly: totals('weekly', weekly, Math.round((weekly / wTotal) * 1000) / 10),
          '5h': totals('5h', five, Math.round((five / fTotal) * 1000) / 10)
        }
      };
    }

    var members = [
      member('marcus', 'Marcus', 1320000, 210000, [{ device_id: 'd-mac', seen_ms_ago: 21000, stale: false }]),
      member('alex-rivera', 'Alex Rivera', 780000, 96000, [
        { device_id: 'd-mbp', seen_ms_ago: 14000, stale: false },
        { device_id: 'd-desk', seen_ms_ago: 9 * 3600e3, stale: true }
      ]),
      member('priya', 'Priya N', 620000, 41000, [{ device_id: 'd-win', seen_ms_ago: 96000, stale: false }]),
      member('bo', 'Bo', 440000, 0, [{ device_id: 'd-old', seen_ms_ago: 31 * 3600e3, stale: true }])
    ];

    var state = {
      configured: true,
      settings: {
        memberName: 'Alex Rivera',
        memberId: 'alex-rivera',
        serverUrl: 'https://subsplit.example.workers.dev',
        primaryWindow: 'weekly',
        notifyEnabled: true,
        notifyPct: { weekly: null, '5h': null }
      },
      local: {
        windows: {
          weekly: {
            window_start: weeklyReset - 10080 * 60e3,
            resets_at: weeklyReset,
            used_percent: 62,
            input: 483600, cached_input: 319800, output: 296400, total: 780000
          },
          '5h': {
            window_start: fiveReset - 300 * 60e3,
            resets_at: fiveReset,
            used_percent: 31,
            input: 59520, cached_input: 39360, output: 36480, total: 96000
          }
        },
        lastScanAt: now - 24000,
        stats: { files: 138, newBytes: 41233, badLines: 0, forkBaselines: 3 },
        roots: [{ path: '/Users/alex/.codex', exists: true }],
        appDataPath: '/Users/alex/Library/Application Support/SubSplit',
        loginItemEnabled: true
      },
      group: {
        server_time: now,
        etag: 'W/"mock-1"',
        members: members,
        account_rate_limit: {
          ts: now - 24000,
          planType: 'plus',
          credits: { hasCredits: false, unlimited: false, balance: null },
          windows: [
            { windowMinutes: 10080, usedPercent: 62, resetsAt: weeklyReset },
            { windowMinutes: 300, usedPercent: 31, resetsAt: fiveReset }
          ]
        }
      },
      // Main computes this (src/main/capacity.js); the mock carries literals so
      // the formula is not restated in renderer code. Four members => a fair
      // share of 25% of the account limit, which Marcus is over.
      capacity: {
        weekly: {
          accountPct: 62,
          members: { marcus: 25.9, 'alex-rivera': 15.3, priya: 12.2, bo: 8.6 }
        },
        '5h': {
          accountPct: 31,
          members: { marcus: 18.8, 'alex-rivera': 8.6, priya: 3.7, bo: 0 }
        }
      },
      // Also main's (src/main/pace.js), and likewise literals — but literals of
      // what computePace returns for the snapshot above, or the harness stops
      // being a reference. Weekly: 62% with 0.689 of the window gone -> 90%, no
      // hit time. 5h: 31% with 0.26 gone -> 119%, reaching 100% at
      // windowStart + elapsed x (100/31), i.e. ~174 min out.
      pace: {
        weekly: { projectedPct: 90, hitsAtMs: null, elapsedFraction: 0.69 },
        '5h': { projectedPct: 119, hitsAtMs: now + 174 * 60e3, elapsedFraction: 0.26 }
      },
      sync: { lastSyncAt: now - 42000, error: null, clockSkewMs: 180, health: null }
    };

    if (scenario === 'onboard') {
      state.configured = false;
      state.settings.memberName = '';
      state.settings.memberId = null;
      state.settings.serverUrl = '';
      state.group = null;
      state.capacity = { weekly: null, '5h': null };
      state.pace = { weekly: null, '5h': null };
      state.sync.lastSyncAt = null;
    } else if (scenario === 'solo') {
      state.group.members = [members[1]];
      state.group.members[0].windows.weekly.share_pct = 100;
      state.group.members[0].windows['5h'].share_pct = 100;
      // Sole member: the whole account gauge is theirs.
      state.capacity = {
        weekly: { accountPct: 62, members: { 'alex-rivera': 62 } },
        '5h': { accountPct: 31, members: { 'alex-rivera': 31 } }
      };
      // The hidden half of the feature: the 5h window is restarted 24 minutes
      // ago, so at 0.08 elapsed it is below the 10% floor and computePace
      // returns null — meter, no pace line. Weekly still projects, under 100%.
      var soloFiveReset = now + 300 * 60e3 - 24 * 60e3;
      state.group.account_rate_limit.windows.forEach(function (w) {
        if (w.windowMinutes === 300) w.resetsAt = soloFiveReset;
      });
      state.local.windows['5h'].window_start = soloFiveReset - 300 * 60e3;
      state.local.windows['5h'].resets_at = soloFiveReset;
      state.pace = {
        weekly: { projectedPct: 90, hitsAtMs: null, elapsedFraction: 0.69 },
        '5h': null
      };
    } else if (scenario === 'error') {
      state.sync.error = { code: 'network_error', message: 'Can’t reach the group server (ETIMEDOUT). Showing the last data received.' };
      state.sync.lastSyncAt = now - 11 * 60e3;
    } else if (scenario === 'nodata') {
      state.local.windows = {};
      state.local.stats = { files: 0, newBytes: 0, badLines: 0, forkBaselines: 0 };
      // The usual reason for a row of zeroes, and what Diagnostics is for: a
      // CODEX_HOME listing two homes, one of which is not there.
      state.local.roots = [
        { path: '/Users/alex/.codex', exists: true },
        { path: '/Users/alex/Dropbox (Acme, Inc)/.codex', exists: false }
      ];
      state.local.loginItemEnabled = false;
      state.group.account_rate_limit = null;
      // No account gauge — no capacity and no pace, so neither is rendered.
      state.capacity = { weekly: null, '5h': null };
      state.pace = { weekly: null, '5h': null };
      state.group.members.forEach(function (m) {
        m.windows.weekly.used_percent = null;
        m.windows['5h'].used_percent = null;
      });
    } else if (scenario === 'unsynced') {
      state.group = null;
      state.capacity = { weekly: null, '5h': null };
      state.pace = { weekly: null, '5h': null };
      state.sync.lastSyncAt = null;
    }

    return state;
  }

  function jitter(state) {
    if (!state.group) return;
    state.group.members.forEach(function (m) {
      WINDOW_KEYS.forEach(function (key) {
        var w = m.windows[key];
        if (w) w.total = Math.round(w.total * (1 + Math.random() * 0.02));
      });
    });
    WINDOW_KEYS.forEach(function (key) {
      var totalAll = state.group.members.reduce(function (sum, m) {
        return sum + (m.windows[key] ? m.windows[key].total : 0);
      }, 0);
      state.group.members.forEach(function (m) {
        var w = m.windows[key];
        if (w) w.share_pct = totalAll ? Math.round((w.total / totalAll) * 1000) / 10 : 0;
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
