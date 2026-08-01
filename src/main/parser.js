'use strict';

/**
 * Codex rollout parser (incremental).
 *
 * Reads only three line types out of `<root>/sessions/**` and
 * `<root>/archived_sessions/**` rollout files:
 *
 *   - `session_meta`   (identity / fork lineage only: `id`, `forked_from_id`, `timestamp`)
 *   - `turn_context`   (model id only)
 *   - `event_msg` with `payload.type === "token_count"` (usage + rate limits)
 *
 * It never reads `auth.json`, `history.jsonl`, `session_index.jsonl`, conversation
 * content, or the `base_instructions` / `dynamic_tools` fields of `session_meta`.
 *
 * Aggregation rules (empirically verified against 282 real rollout files):
 *
 *   - `info.total_token_usage` is a CUMULATIVE, monotonic per-file counter. One Delta
 *     row is emitted per *positive advance*, attributed to that event's own timestamp.
 *   - `info.last_token_usage` is NEVER summed (duplicate re-emissions and phantom
 *     events inflate it by up to 10x).
 *   - Forked / subagent rollouts replay the entire ancestor token_count history as a
 *     prefix burst at file creation. Detected by
 *     `distinct session_meta.id > 1 && current session_meta.forked_from_id != null`,
 *     then bounded by a 2s epsilon from the first `session_meta`. Replayed advances
 *     are dropped entirely and their end total becomes the file baseline.
 *   - Model attribution is positional: last-seen `turn_context.payload.model`, else null.
 *   - Rate limits are a gauge: the single globally-freshest snapshot wins, windows are
 *     identified by `window_minutes` (never by primary/secondary slot), and windows
 *     whose `resets_at` was already past at event time are dropped. A snapshot with no
 *     usable windows (the credits-only `limit_id:"premium"` family) only refreshes
 *     plan/credits — it never evicts the last window-bearing snapshot. Rate limits read
 *     inside a replay burst are held until the burst is classified, and dropped with it.
 *
 * @module parser
 */

const fs = require('fs');
const path = require('path');

/** Cache schema version. Bumping this invalidates every persisted cache. */
const CACHE_VERSION = 1;

/** Replay-burst boundary: leading token_counts within this window may be replayed. */
const REPLAY_EPSILON_MS = 2000;

/**
 * Extra wall-clock slack before we are willing to declare the replay window closed
 * for a file that is still "young". Once `now > firstMetaTs + EPSILON + SLACK`, no
 * future appended line can fall inside the replay window, so the decision is final.
 */
const REPLAY_CLOSE_SLACK_MS = 1000;

/**
 * A file with an unterminated trailing line normally keeps its replay decision open
 * (more of the burst may still be on its way). If the file has not been touched for
 * this long the tail is never going to be completed, so decide anyway.
 */
const STALE_TAIL_MS = 60 * 1000;

/** Read granularity. Rollout files can reach hundreds of MB. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** Guard against a pathological unterminated line eating all memory. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

const NEWLINE = 0x0a;
const MAX_WALK_DEPTH = 16;

/** Sub-directories scanned per root, in preference order (lower priority wins). */
const SCAN_DIRS = [
  { name: 'sessions', priority: 0 },
  { name: 'archived_sessions', priority: 1 },
];

// Cheap substring prefilter applied to the raw bytes of each line, so conversation
// content is never decoded to a string, let alone JSON-parsed.
const NEEDLE_TOKEN_COUNT = Buffer.from('token_count');
const NEEDLE_SESSION_META = Buffer.from('session_meta');
const NEEDLE_TURN_CONTEXT = Buffer.from('turn_context');

const ROLLOUT_FILE_RE = /^rollout-.+\.jsonl$/;
const UUID_SUFFIX_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nonNegative(value) {
  return value > 0 ? value : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emptyUsage() {
  return {
    input: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 0,
    reasoningOutput: 0,
    total: 0,
  };
}

function readUsage(raw) {
  return {
    input: finiteNumber(raw.input_tokens),
    cachedInput: finiteNumber(raw.cached_input_tokens),
    cacheWriteInput: finiteNumber(raw.cache_write_input_tokens),
    output: finiteNumber(raw.output_tokens),
    reasoningOutput: finiteNumber(raw.reasoning_output_tokens),
    total: finiteNumber(raw.total_tokens),
  };
}

/** ISO-8601 (or epoch-ms number) -> ms since epoch, or null when unusable. */
function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Thread key = the UUID embedded in `rollout-<iso>-<uuid>.jsonl`. */
function threadIdForFileName(fileName) {
  const match = UUID_SUFFIX_RE.exec(fileName);
  if (match) return match[1].toLowerCase();
  return fileName;
}

// ---------------------------------------------------------------------------
// file discovery
// ---------------------------------------------------------------------------

function realPathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch (err) {
    return null;
  }
}

function walkRollouts(dir, priority, out, visited, depth) {
  if (depth > MAX_WALK_DEPTH) return;
  const real = realPathOrNull(dir);
  if (real === null || visited.has(real)) return;
  visited.add(real);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(full);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch (err) {
        continue;
      }
    }
    if (isDir) {
      walkRollouts(full, priority, out, visited, depth + 1);
    } else if (isFile && ROLLOUT_FILE_RE.test(entry.name)) {
      out.push({
        filePath: full,
        priority,
        threadId: threadIdForFileName(entry.name),
        order: out.length,
      });
    }
  }
}

/**
 * Resolve one file per thread across every root. Both date-nested and flat layouts
 * are supported; on a thread-id collision the `sessions/` copy wins (archiving is a
 * move, so the same UUID can legitimately exist in both trees for a moment).
 */
function discoverFiles(roots) {
  const candidates = [];
  const visited = new Set();
  for (const root of roots) {
    for (const dir of SCAN_DIRS) {
      walkRollouts(path.join(root, dir.name), dir.priority, candidates, visited, 0);
    }
  }
  const chosen = new Map();
  for (const candidate of candidates) {
    const current = chosen.get(candidate.threadId);
    if (
      !current ||
      candidate.priority < current.priority ||
      (candidate.priority === current.priority && candidate.order < current.order)
    ) {
      chosen.set(candidate.threadId, candidate);
    }
  }
  return Array.from(chosen.values()).sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0
  );
}

// ---------------------------------------------------------------------------
// rate limit snapshots
// ---------------------------------------------------------------------------

/**
 * Convert one `RateLimitWindow` to `{ windowMinutes, usedPercent, resetsAt }` with
 * `resetsAt` in **milliseconds**, or null when unusable/stale.
 *
 * `resets_at` from Codex is unix SECONDS. The legacy `resets_in_seconds` variant is
 * relative to the event timestamp.
 */
function buildWindow(raw, eventTsMs) {
  if (!isPlainObject(raw)) return null;
  const windowMinutes = raw.window_minutes;
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null;
  }

  let resetsAtMs = null;
  if (typeof raw.resets_at === 'number' && Number.isFinite(raw.resets_at)) {
    resetsAtMs = raw.resets_at * 1000;
  } else if (
    typeof raw.resets_in_seconds === 'number' &&
    Number.isFinite(raw.resets_in_seconds)
  ) {
    // Legacy builds: relative offset from the event's own timestamp.
    resetsAtMs = eventTsMs + raw.resets_in_seconds * 1000;
  }
  if (resetsAtMs === null) return null;

  // Stale: the window had already reset by the time this event was written.
  if (resetsAtMs <= eventTsMs) return null;

  const usedPercent =
    typeof raw.used_percent === 'number' && Number.isFinite(raw.used_percent)
      ? raw.used_percent
      : null;

  return { windowMinutes, usedPercent, resetsAt: resetsAtMs };
}

function buildCredits(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    hasCredits: raw.has_credits === true,
    unlimited: raw.unlimited === true,
    // Decimal string like "2443.6518000000" — never coerce to a float.
    balance: typeof raw.balance === 'string' ? raw.balance : null,
  };
}

/**
 * Build a RateSnapshot from a token_count event's `rate_limits`.
 * Windows are keyed by `window_minutes`, NEVER by primary/secondary slot — the slot
 * assignment flipped twice across CLI versions.
 */
function buildRateSnapshot(rateLimits, eventTsMs) {
  if (!isPlainObject(rateLimits)) return null;

  const windows = [];
  const seenMinutes = new Set();
  const slots = [rateLimits.primary, rateLimits.secondary];
  if (Array.isArray(rateLimits.additional_rate_limits)) {
    for (const extra of rateLimits.additional_rate_limits) slots.push(extra);
  }
  for (const slot of slots) {
    const win = buildWindow(slot, eventTsMs);
    if (!win || seenMinutes.has(win.windowMinutes)) continue;
    seenMinutes.add(win.windowMinutes);
    windows.push(win);
  }
  windows.sort((a, b) => a.windowMinutes - b.windowMinutes);

  const planType = typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : null;
  const credits = buildCredits(rateLimits.credits);

  if (windows.length === 0 && planType === null && credits === null) return null;

  return { ts: eventTsMs, windows, planType, credits };
}

/**
 * Apply a snapshot to the global gauge, newest-wins.
 *
 * A snapshot with no usable windows — the credits-only `limit_id:"premium"` family, or
 * an event whose windows had all already reset — must NEVER evict one that still has
 * windows: it only refreshes `planType`/`credits` and keeps the window-bearing event's
 * ts, so the live 5h/weekly gauge survives. windows.js falls back on its own once those
 * retained windows expire.
 */
function applyRateSnapshot(ctx, next) {
  if (!next || !(next.ts > ctx.getSnapshotTs())) return;

  const current = ctx.getSnapshot();
  if (
    isPlainObject(current) &&
    Array.isArray(current.windows) &&
    current.windows.length > 0 &&
    next.windows.length === 0
  ) {
    const keptTs = ctx.getSnapshotTs();
    ctx.setSnapshot(
      {
        ts: keptTs,
        windows: current.windows,
        planType: next.planType !== null ? next.planType : current.planType,
        credits: next.credits !== null ? next.credits : current.credits,
      },
      keptTs
    );
    return;
  }

  ctx.setSnapshot(next, next.ts);
}

// ---------------------------------------------------------------------------
// per-file parser state
// ---------------------------------------------------------------------------

function createFileState(threadId, filePath) {
  return {
    threadId,
    path: filePath,
    size: -1,
    mtimeMs: -1,
    offset: 0,

    // identity / lineage
    metaIds: new Set(),
    firstMetaTs: null,
    ownForkedFromId: null,
    sawOwnMeta: false,
    firstMetaForkedFromId: null,

    // running parser state
    model: null,
    run: emptyUsage(),

    // replay-burst bookkeeping
    zoneClosed: false,
    pending: [],
    pendingTotal: 0,
    pendingSnapshot: null,
    baseline: 0,

    deltas: [],
  };
}

function resetFileState(state) {
  const fresh = createFileState(state.threadId, state.path);
  Object.assign(state, fresh);
  return state;
}

/** The `forked_from_id` of *this* thread's own session_meta line. */
function effectiveForkedFromId(state) {
  return state.sawOwnMeta ? state.ownForkedFromId : state.firstMetaForkedFromId;
}

function isForkReplayFile(state) {
  return state.metaIds.size > 1 && effectiveForkedFromId(state) !== null;
}

/** True while this event still falls inside an unclassified replay burst. */
function inPendingReplayZone(state, ts) {
  if (state.zoneClosed || state.firstMetaTs === null) return false;
  return ts - state.firstMetaTs <= REPLAY_EPSILON_MS;
}

/**
 * Resolve the leading (possibly replayed) token_count advances, and the rate limits
 * they carried. Fork => drop them all and remember the baseline. Otherwise => emit
 * the advances and apply the newest held snapshot.
 */
function closeReplayZone(state, ctx) {
  if (state.zoneClosed) return;
  state.zoneClosed = true;

  const replayed = isForkReplayFile(state);

  // A fork replays the ancestor's rate_limits re-stamped with the fork's own envelope
  // ts, so they are only a live gauge reading when the burst was not a replay.
  const held = state.pendingSnapshot;
  state.pendingSnapshot = null;
  if (held && !replayed && ctx) applyRateSnapshot(ctx, held);

  if (state.pending.length === 0) return;

  if (replayed) {
    state.baseline = state.pendingTotal;
    state.pending = [];
    return;
  }
  for (const delta of state.pending) {
    state.deltas.push(delta);
    if (ctx) ctx.sink.push(delta);
  }
  state.pending = [];
}

/**
 * Close the replay zone once wall-clock has moved past the boundary, so that files
 * whose entire content falls inside the 2s window still report their usage.
 *
 * The decision is deliberately held open while the file still has unread bytes (an
 * unterminated trailing line means the rest of the creation burst may still be
 * arriving) unless the file has gone quiet, in which case the tail will never land.
 */
function maybeCloseReplayZoneByClock(state, nowMs, ctx) {
  if (state.zoneClosed) return;
  // No session_meta seen yet: nothing can be classified, and nothing is pending
  // (handleTokenCount closes the zone inline in that case).
  if (state.firstMetaTs === null) return;
  if (nowMs - state.firstMetaTs <= REPLAY_EPSILON_MS + REPLAY_CLOSE_SLACK_MS) return;

  const fullyConsumed = state.size >= 0 && state.offset >= state.size;
  const quiescent = state.mtimeMs >= 0 && nowMs - state.mtimeMs > STALE_TAIL_MS;
  if (fullyConsumed || quiescent) closeReplayZone(state, ctx);
}

// ---------------------------------------------------------------------------
// line handling
// ---------------------------------------------------------------------------

function handleSessionMeta(state, event) {
  const payload = event.payload;
  if (!isPlainObject(payload)) return;
  // Only identity/lineage fields are touched here. base_instructions and
  // dynamic_tools are deliberately never read.
  const id = typeof payload.id === 'string' ? payload.id.toLowerCase() : null;
  const forkedFromId =
    typeof payload.forked_from_id === 'string' && payload.forked_from_id !== ''
      ? payload.forked_from_id
      : null;

  if (id !== null) state.metaIds.add(id);

  if (state.firstMetaTs === null) {
    // Envelope timestamp = when the line was written, which is what bounds the
    // creation-time replay burst (payload.timestamp is the session start instead).
    const ts = parseTimestamp(event.timestamp);
    if (ts !== null) state.firstMetaTs = ts;
    state.firstMetaForkedFromId = forkedFromId;
  }

  if (id !== null && id === state.threadId) {
    state.sawOwnMeta = true;
    state.ownForkedFromId = forkedFromId;
  }
}

function handleTurnContext(state, event) {
  const payload = event.payload;
  if (!isPlainObject(payload)) return;
  // Model only. Nothing else from turn_context is read.
  if (typeof payload.model === 'string' && payload.model !== '') {
    state.model = payload.model;
  }
}

function handleTokenCount(state, event, ctx) {
  const payload = event.payload;
  const ts = parseTimestamp(event.timestamp);
  if (ts === null) {
    ctx.stats.badLines += 1;
    return;
  }

  const rateLimits = payload.rate_limits;
  if (isPlainObject(rateLimits)) {
    const snapshot = buildRateSnapshot(rateLimits, ts);
    if (snapshot && inPendingReplayZone(state, ts)) {
      // Hold it: closeReplayZone() decides whether this is a live reading or a
      // replay of the ancestor's history wearing this file's timestamps.
      if (state.pendingSnapshot === null || snapshot.ts >= state.pendingSnapshot.ts) {
        state.pendingSnapshot = snapshot;
      }
    } else if (snapshot) {
      applyRateSnapshot(ctx, snapshot);
    }
  }

  const info = payload.info;
  if (!isPlainObject(info)) return;
  const totalUsage = info.total_token_usage;
  if (!isPlainObject(totalUsage)) return;

  const current = readUsage(totalUsage);
  const previous = state.run;

  // Cumulative + monotonic: only a strictly positive advance produces a row.
  // `last_token_usage` is never consulted.
  if (!(current.total > previous.total)) return;

  const delta = {
    threadId: state.threadId,
    ts,
    model: state.model,
    input: nonNegative(current.input - previous.input),
    cachedInput: nonNegative(current.cachedInput - previous.cachedInput),
    cacheWriteInput: nonNegative(current.cacheWriteInput - previous.cacheWriteInput),
    output: nonNegative(current.output - previous.output),
    reasoningOutput: nonNegative(current.reasoningOutput - previous.reasoningOutput),
    total: current.total - previous.total,
  };
  state.run = current;

  if (state.zoneClosed) {
    state.deltas.push(delta);
    ctx.sink.push(delta);
    return;
  }

  if (state.firstMetaTs === null) {
    // No session_meta seen yet — nothing can be classified as replay.
    closeReplayZone(state, ctx);
    state.deltas.push(delta);
    ctx.sink.push(delta);
    return;
  }

  if (ts - state.firstMetaTs > REPLAY_EPSILON_MS) {
    closeReplayZone(state, ctx);
    state.deltas.push(delta);
    ctx.sink.push(delta);
    return;
  }

  state.pending.push(delta);
  state.pendingTotal = current.total;
}

/**
 * Decode + dispatch one candidate line. Malformed input is counted, never thrown.
 */
function handleLine(state, lineBuffer, ctx) {
  if (lineBuffer.length === 0) return;
  if (
    !lineBuffer.includes(NEEDLE_TOKEN_COUNT) &&
    !lineBuffer.includes(NEEDLE_SESSION_META) &&
    !lineBuffer.includes(NEEDLE_TURN_CONTEXT)
  ) {
    return;
  }

  const text = lineBuffer.toString('utf8').trim();
  if (text === '') return;

  let event;
  try {
    event = JSON.parse(text);
  } catch (err) {
    ctx.stats.badLines += 1;
    return;
  }
  if (!isPlainObject(event)) {
    ctx.stats.badLines += 1;
    return;
  }

  if (event.type === 'session_meta') {
    handleSessionMeta(state, event);
  } else if (event.type === 'turn_context') {
    handleTurnContext(state, event);
  } else if (
    event.type === 'event_msg' &&
    isPlainObject(event.payload) &&
    event.payload.type === 'token_count'
  ) {
    handleTokenCount(state, event, ctx);
  }
}

/**
 * Read `[state.offset, size)` and consume only COMPLETE lines. A partial trailing
 * line is left unconsumed (the byte offset stops at the last newline) so the next
 * scan re-reads it once the writer finishes it. Rollout files are append-only.
 *
 * @returns {number} bytes consumed this pass
 */
function readIncrement(state, size, ctx) {
  if (size <= state.offset) return 0;

  let fd;
  try {
    fd = fs.openSync(state.path, 'r');
  } catch (err) {
    return 0;
  }

  let committed = state.offset;
  let position = state.offset;
  let leftover = Buffer.alloc(0);

  try {
    while (position < size) {
      const length = Math.min(READ_CHUNK_BYTES, size - position);
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      try {
        read = fs.readSync(fd, buffer, 0, length, position);
      } catch (err) {
        break;
      }
      if (read <= 0) break;
      position += read;

      const chunk = buffer.subarray(0, read);
      const data = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;

      let start = 0;
      let index;
      while ((index = data.indexOf(NEWLINE, start)) !== -1) {
        handleLine(state, data.subarray(start, index), ctx);
        start = index + 1;
      }
      committed += start;

      const rest = data.subarray(start);
      if (rest.length > MAX_LINE_BYTES) {
        // Pathological unterminated line: drop it rather than growing without bound.
        ctx.stats.badLines += 1;
        committed = position;
        leftover = Buffer.alloc(0);
      } else {
        leftover = Buffer.from(rest);
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch (err) {
      /* ignore */
    }
  }

  const consumed = committed - state.offset;
  state.offset = committed;
  return consumed;
}

// ---------------------------------------------------------------------------
// cache (de)serialization
// ---------------------------------------------------------------------------

function serializeDelta(delta, modelIndex) {
  return [
    delta.ts,
    modelIndex(delta.model),
    delta.input,
    delta.cachedInput,
    delta.cacheWriteInput,
    delta.output,
    delta.reasoningOutput,
    delta.total,
  ];
}

function deserializeDelta(row, threadId, models) {
  if (!Array.isArray(row) || row.length < 8) return null;
  const modelIdx = row[1];
  const model =
    typeof modelIdx === 'number' && modelIdx >= 0 && modelIdx < models.length
      ? models[modelIdx]
      : null;
  return {
    threadId,
    ts: finiteNumber(row[0]),
    model,
    input: finiteNumber(row[2]),
    cachedInput: finiteNumber(row[3]),
    cacheWriteInput: finiteNumber(row[4]),
    output: finiteNumber(row[5]),
    reasoningOutput: finiteNumber(row[6]),
    total: finiteNumber(row[7]),
  };
}

function serializeUsage(usage) {
  return [
    usage.input,
    usage.cachedInput,
    usage.cacheWriteInput,
    usage.output,
    usage.reasoningOutput,
    usage.total,
  ];
}

function deserializeUsage(row) {
  if (!Array.isArray(row) || row.length < 6) return emptyUsage();
  return {
    input: finiteNumber(row[0]),
    cachedInput: finiteNumber(row[1]),
    cacheWriteInput: finiteNumber(row[2]),
    output: finiteNumber(row[3]),
    reasoningOutput: finiteNumber(row[4]),
    total: finiteNumber(row[5]),
  };
}

function serializeCache(files, snapshot, snapshotTs) {
  const models = [];
  const modelIds = new Map();
  const modelIndex = (model) => {
    if (typeof model !== 'string') return -1;
    let idx = modelIds.get(model);
    if (idx === undefined) {
      idx = models.length;
      models.push(model);
      modelIds.set(model, idx);
    }
    return idx;
  };

  const threads = {};
  for (const [threadId, state] of files) {
    threads[threadId] = {
      p: state.path,
      s: state.size,
      m: state.mtimeMs,
      o: state.offset,
      mi: Array.from(state.metaIds),
      fm: state.firstMetaTs,
      of: state.ownForkedFromId,
      so: state.sawOwnMeta ? 1 : 0,
      ff: state.firstMetaForkedFromId,
      md: modelIndex(state.model),
      r: serializeUsage(state.run),
      zc: state.zoneClosed ? 1 : 0,
      pt: state.pendingTotal,
      ps: state.pendingSnapshot,
      b: state.baseline,
      pd: state.pending.map((d) => serializeDelta(d, modelIndex)),
      d: state.deltas.map((d) => serializeDelta(d, modelIndex)),
    };
  }

  return {
    v: CACHE_VERSION,
    models,
    snapshot,
    snapshotTs,
    threads,
  };
}

function deserializeCache(cache) {
  const files = new Map();
  const result = { files, snapshot: null, snapshotTs: -Infinity };
  if (!isPlainObject(cache) || cache.v !== CACHE_VERSION) return result;

  const models = Array.isArray(cache.models) ? cache.models.filter((m) => typeof m === 'string') : [];
  const threads = isPlainObject(cache.threads) ? cache.threads : {};

  for (const threadId of Object.keys(threads)) {
    const raw = threads[threadId];
    if (!isPlainObject(raw)) continue;
    const state = createFileState(threadId, typeof raw.p === 'string' ? raw.p : '');
    state.size = typeof raw.s === 'number' && Number.isFinite(raw.s) ? raw.s : -1;
    state.mtimeMs = typeof raw.m === 'number' ? raw.m : -1;
    state.offset = Math.max(0, finiteNumber(raw.o));
    state.metaIds = new Set(Array.isArray(raw.mi) ? raw.mi.filter((v) => typeof v === 'string') : []);
    state.firstMetaTs = typeof raw.fm === 'number' && Number.isFinite(raw.fm) ? raw.fm : null;
    state.ownForkedFromId = typeof raw.of === 'string' ? raw.of : null;
    state.sawOwnMeta = raw.so === 1;
    state.firstMetaForkedFromId = typeof raw.ff === 'string' ? raw.ff : null;
    state.model =
      typeof raw.md === 'number' && raw.md >= 0 && raw.md < models.length ? models[raw.md] : null;
    state.run = deserializeUsage(raw.r);
    state.zoneClosed = raw.zc === 1;
    state.pendingTotal = finiteNumber(raw.pt);
    state.pendingSnapshot =
      isPlainObject(raw.ps) && Array.isArray(raw.ps.windows) && typeof raw.ps.ts === 'number'
        ? raw.ps
        : null;
    state.baseline = finiteNumber(raw.b);
    state.pending = (Array.isArray(raw.pd) ? raw.pd : [])
      .map((row) => deserializeDelta(row, threadId, models))
      .filter(Boolean);
    state.deltas = (Array.isArray(raw.d) ? raw.d : [])
      .map((row) => deserializeDelta(row, threadId, models))
      .filter(Boolean);
    files.set(threadId, state);
  }

  if (isPlainObject(cache.snapshot) && typeof cache.snapshotTs === 'number') {
    result.snapshot = cache.snapshot;
    result.snapshotTs = cache.snapshotTs;
  }
  return result;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * @param {{ roots?: string[], cache?: object|null }} options
 * @returns {{ scan: function(): object, getAllDeltas: function(): object[], getCache: function(): object }}
 */
function createScanner(options) {
  const opts = isPlainObject(options) ? options : {};
  const roots = (Array.isArray(opts.roots) ? opts.roots : []).filter(
    (root) => typeof root === 'string' && root !== ''
  );

  const restored = deserializeCache(opts.cache);
  const files = restored.files;
  let snapshot = restored.snapshot;
  let snapshotTs = restored.snapshotTs;

  function scan() {
    const nowMs = Date.now();
    const sink = [];
    const stats = { files: 0, newBytes: 0, badLines: 0, forkBaselines: 0 };
    const ctx = {
      sink,
      stats,
      getSnapshot: () => snapshot,
      getSnapshotTs: () => snapshotTs,
      setSnapshot: (next, ts) => {
        snapshot = next;
        snapshotTs = ts;
      },
    };

    let discovered;
    try {
      discovered = discoverFiles(roots);
    } catch (err) {
      discovered = [];
    }

    for (const candidate of discovered) {
      stats.files += 1;

      let stat;
      try {
        stat = fs.statSync(candidate.filePath);
      } catch (err) {
        continue;
      }
      if (!stat.isFile()) continue;

      let state = files.get(candidate.threadId);
      if (!state) {
        state = createFileState(candidate.threadId, candidate.filePath);
        files.set(candidate.threadId, state);
      } else {
        const shrank = stat.size < state.size || stat.size < state.offset;
        const wentBackwards = stat.mtimeMs + 1 < state.mtimeMs;
        if (shrank || wentBackwards) {
          // Not append-only any more: drop everything known about this thread.
          resetFileState(state);
        }
      }
      state.path = candidate.filePath;

      if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) {
        maybeCloseReplayZoneByClock(state, nowMs, ctx);
        continue;
      }

      stats.newBytes += readIncrement(state, stat.size, ctx);
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
      maybeCloseReplayZoneByClock(state, nowMs, ctx);
    }

    for (const state of files.values()) {
      maybeCloseReplayZoneByClock(state, nowMs, ctx);
      if (state.baseline > 0) stats.forkBaselines += 1;
    }

    return { newDeltas: sink, rateSnapshot: snapshot, stats };
  }

  function getAllDeltas() {
    const all = [];
    for (const state of files.values()) {
      for (const delta of state.deltas) all.push(delta);
    }
    all.sort((a, b) => a.ts - b.ts);
    return all;
  }

  function getCache() {
    return serializeCache(files, snapshot, Number.isFinite(snapshotTs) ? snapshotTs : null);
  }

  return { scan, getAllDeltas, getCache };
}

module.exports = {
  createScanner,
  // exported for tests / reuse
  buildRateSnapshot,
  REPLAY_EPSILON_MS,
  CACHE_VERSION,
};
