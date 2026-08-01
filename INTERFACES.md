# SubSplit — module contracts (build-time reference)

SubSplit is a cross-platform (macOS menu bar + Windows system tray) Electron app for
people **sharing one OpenAI Codex subscription**. Each member's app parses their local
Codex CLI session logs, pushes aggregate token counters to a tiny shared server
(Cloudflare Worker + D1), and shows everyone's consumption + the account-wide rate-limit
windows so the group can split usage fairly.

## Global rules (all modules)

- Plain **CommonJS** everywhere (`require`/`module.exports`). No TypeScript. No bundler.
- **Zero runtime npm dependencies.** Only Node/Electron built-ins. (`electron` + `electron-builder` are devDeps.)
- Never read `~/.codex/auth.json`, `~/.codex/history.jsonl`, or conversation content.
  Only `token_count` / `session_meta` / `turn_context` lines from rollout files, and skip
  `session_meta.payload.base_instructions` / `.dynamic_tools`.
- Never make authenticated requests to OpenAI. All account data comes from local files.
- Errors: modules must never throw on malformed input lines — skip bad lines, count them
  (`stats.badLines`), keep going. Network/sync errors surface as state, not exceptions.
- Timestamps: milliseconds since epoch (`ts`) internally. `resets_at` from Codex data is
  unix **seconds** — convert at the parse boundary.

## Repo layout

```
src/main/index.js      app bootstrap: single-instance, tray, popover, scan/sync loops, IPC
src/main/tray.js       tray creation + popover positioning (exported helpers)
src/main/parser.js     Codex rollout parser (incremental)  ← crown jewel
src/main/windows.js    window bucketing (5h / weekly totals from deltas + rate snapshot)
src/main/capacity.js   capacity share (a member's slice of the ACCOUNT limit) — pure
src/main/notify.js     usage-alert rules + latch (decides, never fires) — pure
src/main/sync.js       server client (join / push / poll)
src/main/settings.js   settings + cache persistence in app.getPath('userData')
src/preload/preload.js contextBridge surface
src/renderer/index.html, style.css, app.js   popover UI (no framework)
server/worker.js       Cloudflare Worker (D1)
server/schema.sql      D1 DDL
server/wrangler.toml   deploy config
server/local.js        same API self-hosted on plain node:http (JSON-file persistence)
scripts/gen-icons.js   generates assets/*.png (pure-JS PNG encoder, zlib built-in)
test/*.test.js         node:test suites (run with `node --test test/`)
```

## parser.js

```js
const { createScanner } = require('./parser');
const scanner = createScanner({
  roots: [string],        // Codex homes, e.g. [path.join(os.homedir(), '.codex')]; honors CODEX_HOME upstream (caller resolves)
  cache: object | null,   // previously persisted scanner cache (opaque to callers), or null
});
const result = scanner.scan();  // synchronous full/incremental pass
// result = {
//   newDeltas: [Delta],          // deltas discovered THIS scan (appended since last scan)
//   rateSnapshot: RateSnapshot | null,  // freshest across ALL files ever seen
//   stats: { files, newBytes, badLines, forkBaselines },
// }
scanner.getAllDeltas();          // [Delta] — every delta known (cache + new)
scanner.getCache();              // JSON-serializable cache to persist (file memos incl. byte offsets, deltas, snapshot)
```

- `Delta = { threadId, ts, model: string|null, input, cachedInput, cacheWriteInput, output, reasoningOutput, total }`
  One row per **positive advance** of `total_token_usage`, attributed to that event's own
  timestamp, per the parsing spec (see research: monotonic cumulative counter; never sum
  `last_token_usage`; fork-replay baseline subtraction; model = last-seen `turn_context.payload.model`).
- Scans `<root>/sessions/**/rollout-*.jsonl` and `<root>/archived_sessions/**/rollout-*.jsonl`
  (both date-nested and flat). Thread key = filename UUID; on collision prefer `sessions/`.
- Incremental: per-file memo `(size, mtimeMs, byteOffset, parserState)`; rollout files are
  append-only — resume from the stored byte offset; if size shrank or mtime went backwards, re-parse that file from 0 (drop its previous deltas).
- `RateSnapshot = { ts, windows: [{ windowMinutes, usedPercent, resetsAt }], planType: string|null, credits: {hasCredits,unlimited,balance:string|null}|null }`
  Built from the token_count event with the max timestamp globally. Identify windows by
  `window_minutes` value, NEVER by primary/secondary slot. Drop windows whose `resets_at`
  was already in the past at event time. Legacy `resets_in_seconds` → `resets_at = eventTs/1000 + resets_in_seconds`.

## windows.js

```js
const { computeWindows } = require('./windows');
computeWindows(allDeltas, rateSnapshot, nowMs) // ->
// {
//   "5h":     WindowTotals | null,   // null when no 5h window is known AND no fallback wanted
//   "weekly": WindowTotals | null,
// }
// WindowTotals = { window_start (ms), resets_at (ms|null), used_percent (number|null),
//                  input, cached_input, output, total }
```

- Window bounds: from `rateSnapshot.windows` matching `windowMinutes` (300 → "5h",
  10080 → "weekly"). If snapshot fresh (`resetsAt > now`): bounds `[resetsAt - w, resetsAt]`.
  If stale or missing: **rolling** window `[start, now]` with `start` quantized to a stable
  grid (`min(max(60s, w/20), 15min)`) so independent devices agree; `resets_at: null`,
  `used_percent: null`.
- Totals = sum of deltas with `window_start <= ts <= now`. `cached_input` summed from
  `cachedInput`; `input` is full input tokens (cached is a subset, not additive).

## capacity.js

```js
const { computeCapacity } = require('./capacity');
computeCapacity(groupState) // ->
// { "5h": CapacityWindow | null, "weekly": CapacityWindow | null }
// CapacityWindow = { accountPct: number, members: { [member_id]: pct } }
```

- **Capacity share** = a member's estimated slice of the ACCOUNT limit for a window:
  `account used_percent(window) × (member window total / group window total)`.
- This is the **only** place the formula lives. It runs in the main process and reaches the
  renderer through `UiState.capacity`; the renderer must never recompute it.
- A window is `null` when the account snapshot has no entry for it, its `used_percent` is
  `null`, or the group total for that window is 0 (never divide by zero). Member percentages
  are clamped to `[0, accountPct]`, so they always sum to `accountPct`.
- Pure: no Electron, no I/O, never throws on malformed input.

## notify.js

```js
const { evaluateAlerts } = require('./notify');
evaluateAlerts({ capacity, groupState, settings, memberId, nowMs, syncError }) // ->
// { alerts: [ { windowKey, effectivePct, capacityPct, latchKey, title, body } ],
//   prunedLatch }
```

- Decides which usage alerts should fire; **firing is index.js's job** (`new Notification`).
  Alerts are local to the machine that raises them and are only ever about *your own* share.
- Nothing fires when `notifyEnabled` is false, when `syncError` is truthy, when
  `capacity[windowKey]` is `null`, when your capacity pct is below the effective threshold,
  or when `latchKey` is already latched.
- Effective threshold = `settings.notifyPct[windowKey]` (integer 1..100) or, when that is
  `null` (AUTO), the fair share `100 / N` with `N` = members in the group **at evaluation
  time**, so the bar moves as people join.
- `latchKey = windowKey + "|" + resets_at + "|" + threshold` (`resets_at` from the account
  rate snapshot for that window) — one alert per window instance per threshold. A later
  `resets_at` (a new window) or a changed threshold re-arms it.
- Each latch record stores **when it stops applying**: the window's `resets_at`, or a full
  window from now when that `resets_at` has already passed (a stale snapshot nobody has
  refreshed — latching on a past timestamp would expire the record instantly and the toast
  would repeat on every scan). A record also matches a *drifting* `resets_at`: same window
  key and threshold within a quarter window of the stored expiry is the same window instance,
  because legacy `resets_in_seconds` builds re-derive `resets_at` from every event's own
  millisecond timestamp.
- `prunedLatch` is the latch to persist: records whose expiry is in the past are dropped
  on every evaluation, and the keys of the returned alerts are added.
- Body copy: `You've used ~<X>% of the account's <weekly|5h> limit (alert at <Y>%). Resets in
  <humanized>.` The join token, the server URL and other members never appear in alert text.
- Pure: no Electron, no I/O.

## sync.js

```js
const { createSync } = require('./sync');
const sync = createSync({ serverUrl, token, fetchImpl? });   // token = "ss_<group>_<secret>"
await sync.join(memberName)   // POST /v1/join → { group_id, member_id, member_name, server_time, poll_interval_s }
await sync.push(payload)      // PUT /v1/state → { accepted, clock_skew_ms, state: GroupState }
await sync.poll(etag|null)    // GET /v1/state → { notModified: true } | { etag, state: GroupState }
```

- `payload = { member_id, member_name, device_id, seq, updated_at, window_totals: { "5h": WindowTotals|null, "weekly": WindowTotals|null }, rate_limit: RateSnapshot|null }`
- `GroupState = { server_time, members: [ { member_id, member_name, devices: [{device_id, seen_ms_ago, stale}], windows: { "5h": {…totals, share_pct}, "weekly": {…} } } ], account_rate_limit: RateSnapshot|null, etag }`
- Auth header: `Authorization: Bearer ss_<group>_<secret>` on every call. 10s timeout,
  no retries inside sync.js (caller schedules). Reject non-2xx with `{code, message}` error objects.

## Server API (worker.js AND local.js — identical contract)

- `POST /v1/groups` — create group. Header `X-Admin-Token: <ADMIN_TOKEN env/secret>`. → 201 `{ group_id, join_token }`.
- `POST /v1/join` — Bearer auth. Body `{ member_name }`. Idempotent (member_id = slug(member_name)). 409 past 16 members.
- `PUT /v1/state` — Bearer auth. Push (shape above). Upsert keyed `(group_id, member_id, device_id)`,
  guarded `excluded.seq > devices.seq`. Returns full GroupState in same response.
- `GET /v1/state` — Bearer auth. Supports `If-None-Match` → 304.
- `DELETE /v1/state?member_id=&device_id=` — retire a device.
- `GET /v1/health` — unauthenticated `{ ok: true, server_time }`.
- Aggregation rules (server-side): SUM window_totals across a member's devices **per window,
  respecting window_start** (window_starts within w/4 of each other are the same window and
  are added, reporting the max; newer-beyond-tolerance resets the accumulator, older skipped);
  account_rate_limit = the single freshest snapshot across all devices, never summed
  (snapshot `ts` more than 5 min ahead of server time is distrusted → ordered by server
  write time; stale devices only win when no fresh device has a snapshot);
  devices unseen for > one full window are excluded from sums (and flagged `stale`).
  `share_pct` = member total / group total per window (0 when group total is 0).
- Payload cap 4KB → 413. Timing-safe secret comparison. Never echo the secret.

## settings.js

```js
const { loadSettings, saveSettings, loadCache, saveCache, paths } = require('./settings');
// settings.json in app.getPath('userData'):
// { memberName, serverUrl, joinToken, memberId, deviceId (uuid, generated once),
//   seq (monotonic int, incremented per push), primaryWindow: "weekly"|"5h",
//   notifyEnabled: boolean (default true),
//   notifyPct: { "5h": number|null, "weekly": number|null },  // null = AUTO (100/N)
//   notifyLatch: { [latchKey]: expires_at_ms } }              // internal, main-only
// cache.json: scanner cache (parser.getCache()) — saved debounced ≥5s apart.
```

`defaultSettings()`, `normalizeSettings()` and `pickSettings()` are a strict whitelist —
every key is declared in `defaultSettings()`, unknown keys are dropped, and each value is
normalized: `notifyPct` entries must be integers 1..100 (anything else becomes `null` =
AUTO), unknown `notifyPct` windows are dropped, a non-boolean `notifyEnabled` falls back to
`true`, and `notifyLatch` keeps only entries with a finite positive timestamp. `notifyPct`
is replaced whole, not merged per window. `notifyLatch` is written by the main process only
and is never renderer-writable.

`settings.js` must work when required from plain node tests too: accept an optional
`dir` override so tests don't need Electron (`loadSettings(dir?)` etc. or an injectable
`baseDir` via `init({ baseDir })`).

## IPC / preload contract

Preload exposes `window.subsplit`:

```js
{
  getState(): Promise<UiState>,
  saveSettings(partial): Promise<UiState>,
  joinGroup({ serverUrl, joinToken, memberName }): Promise<UiState>,  // join + persist + immediate push/poll
  refreshNow(): Promise<UiState>,     // rescan + push + poll
  quit(): void,
  onState(cb): unsubscribeFn,         // main → renderer push on every state change
}
// UiState = {
//   configured: boolean,
//   settings: { memberName, memberId, serverUrl, primaryWindow,
//               notifyEnabled, notifyPct: { "5h": number|null, "weekly": number|null } }
//             (never the token, never notifyLatch),
//   local: { windows: computeWindows() result, lastScanAt, stats },
//   group: GroupState | null,
//   capacity: computeCapacity(group) result,   // { "5h": CapacityWindow|null, "weekly": … }
//   sync: { lastSyncAt: ms|null, error: {code,message}|null, clockSkewMs: number|null },
// }
```

`saveSettings(partial)` also accepts `notifyEnabled` (boolean) and `notifyPct` (both windows,
`null` = AUTO); the preload allow-list passes nothing else through. UiState fields are not
filtered anywhere between `buildUiState()` and the renderer — whatever is added there arrives
whole, so the token must simply never be put in it.

Channels (ipcMain.handle): `state:get`, `settings:save`, `group:join`, `sync:refresh`, `app:quit`.
Event (webContents.send): `state:changed` with UiState.
Security: contextIsolation + sandbox stay at defaults, never expose ipcRenderer itself,
validate channel senders, CSP `script-src 'self'` meta in index.html,
`setWindowOpenHandler(() => ({action:'deny'}))`.

## Main-process loops (index.js)

- Scan: `fs.watch(<root>, { recursive: true })` on each Codex home **parent-guarded**
  (re-arm on error/ENOENT with backoff; debounce events 300ms into one `rescan()`), plus a
  5-minute safety-net rescan timer.
- Push: after any scan where current window totals changed; minimum 60s between pushes;
  push sends **absolute** totals for current windows (idempotent).
- Poll: every 60s with ETag (skip the poll if a push just returned state).
- Tray: macOS `tray.setTitle(' 38%', {fontType:'monospacedDigit'})` = primary window
  used% (account-wide when known, else own share); Windows: `setToolTip` (≤128 chars).
  Left-click → popover toggle; right-click → native menu (Open, Refresh now, Launch at login, Quit)
  via `popUpContextMenu` (do NOT `setContextMenu`).
- Popover: frameless, `show:false`, 360×520, `skipTaskbar`, `alwaysOnTop`,
  macOS `type:'panel'` + `setVisibleOnAllWorkspaces(true,{skipTransformProcessType:true})`,
  hide on blur (100ms grace). Position per platform from click-event bounds
  (`screen.getDisplayMatching(bounds).workArea`; cache last non-zero bounds; Windows x=0
  overflow fallback → bottom-right of work area; clamp + `Math.round`).
- Alerts: after every `applyGroupState()` and at the end of `rescan()`'s state update, run
  `evaluateAlerts()` and show each result with `new Notification({title, body})`, guarded by
  `Notification.isSupported()`; persist `prunedLatch` through `settings.js`. Never while
  `sync.error` is set. `app.setAppUserModelId` must stay the first line — Windows toasts
  need it.
- `app.dock?.hide()`, `requestSingleInstanceLock`, `app.setAppUserModelId('app.subsplit')` first line.

## Renderer views

1. **Onboarding** (when `!configured`): fields Server URL, Join token, Your name → Join
   button → `joinGroup`. Friendly error line under the form. In **settings** mode the same
   form also shows an "Usage alerts" block: enable toggle + a numeric input per window,
   placeholder "auto (fair share)", helper text naming what auto currently equals. An empty
   input means `null` (AUTO). Saved through `saveSettings`.
2. **Dashboard**: account header — one bar per available window ("Weekly", "5h") with
   account-wide used% + "resets in Xh Ym"; member list sorted by weekly total desc — name,
   token count (compact: 1.3M), share bar + share %, "you" badge, stale-device dot;
   footer — last synced, refresh button, gear (back to settings), quit.
   Fair-share guide line at 100/N % on share bars. Each row also shows its **capacity
   share** for the window the list is showing — a compact meter plus "~31% of weekly limit",
   read straight from `UiState.capacity`, with its own fair-share marker at 100/N of the
   account limit (the same number AUTO alerts use). When `capacity[window]` is `null` the
   capacity UI is not rendered at all. Dark-mode aware via `prefers-color-scheme`. No
   external fonts/assets. All dynamic styling goes through CSSOM/classList — the CSP is
   `script-src 'self'` **and** `style-src 'self'`.
