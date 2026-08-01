'use strict';

/**
 * Tests for src/main/parser.js and src/main/windows.js.
 *
 * Run with:  node --test test/parser.test.js
 *
 * Everything below either uses the synthetic fixtures in test/fixtures/ or — for the
 * final, opt-in integration block — the real Codex rollout files on this machine.
 * Nothing here ever touches auth.json, history.jsonl, session_index.jsonl, or
 * conversation content; there is an explicit regression test for that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScanner } = require('../src/main/parser');
const { computeWindows } = require('../src/main/windows');

const FIXTURES = path.join(__dirname, 'fixtures');
const CODEX_HOME = path.join(FIXTURES, 'codex-home');

const THREAD_NORMAL = '019e0000-0000-7000-8000-000000000001';
const THREAD_FORK = '019e0000-0000-7000-8000-000000000002';
const THREAD_EMPTY = '019e0000-0000-7000-8000-000000000003';
const THREAD_GARBAGE = '019e0000-0000-7000-8000-000000000004';
const THREAD_ARCHIVED_FLAT = '019e0000-0000-7000-8000-000000000005';
const THREAD_ARCHIVED_NESTED = '019e0000-0000-7000-8000-000000000006';
const THREAD_COLLISION = '019e0000-0000-7000-8000-000000000007';

const NORMAL_FILE = path.join(
  CODEX_HOME,
  'sessions/2026/07/01/rollout-2026-07-01T10-00-00-' + THREAD_NORMAL + '.jsonl'
);
const FORK_FILE = path.join(
  CODEX_HOME,
  'sessions/2026/07/01/rollout-2026-07-01T11-00-00-' + THREAD_FORK + '.jsonl'
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function scanRoot(root, cache) {
  const scanner = createScanner({ roots: [root], cache: cache || null });
  const result = scanner.scan();
  return { scanner, result };
}

function deltasByThread(deltas) {
  const map = new Map();
  for (const delta of deltas) {
    if (!map.has(delta.threadId)) map.set(delta.threadId, []);
    map.get(delta.threadId).push(delta);
  }
  return map;
}

function sum(deltas, field) {
  return deltas.reduce((acc, d) => acc + d[field], 0);
}

/** Strip identity-irrelevant ordering so two delta lists can be compared directly. */
function normalizeDeltas(deltas) {
  return deltas
    .map((d) => ({
      threadId: d.threadId,
      ts: d.ts,
      model: d.model,
      input: d.input,
      cachedInput: d.cachedInput,
      cacheWriteInput: d.cacheWriteInput,
      output: d.output,
      reasoningOutput: d.reasoningOutput,
      total: d.total,
    }))
    .sort((a, b) => a.ts - b.ts || (a.threadId < b.threadId ? -1 : 1));
}

function roundTrip(cache) {
  return JSON.parse(JSON.stringify(cache));
}

function makeTempRoot(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Pick `count` byte offsets that land strictly inside a line (never on a newline). */
function midLineCuts(buffer, count) {
  const newlines = [];
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0x0a) newlines.push(i);
  assert.ok(newlines.length > count + 1, 'fixture needs more lines than cuts');
  const cuts = [];
  for (let i = 0; i < count; i += 1) {
    const lineIndex = i + 1; // skip the first line so at least one line is complete
    const start = newlines[lineIndex - 1] + 1;
    const end = newlines[lineIndex];
    const cut = start + Math.floor((end - start) / 2);
    assert.notEqual(buffer[cut], 0x0a, 'cut must land mid-line');
    assert.ok(cut > start && cut < end, 'cut must land inside the line');
    cuts.push(cut);
  }
  return cuts;
}

// ---------------------------------------------------------------------------
// (a) normal multi-turn session with duplicate re-emitted token_counts
// ---------------------------------------------------------------------------

test('normal session: one row per positive advance, duplicates ignored', () => {
  const { scanner } = scanRoot(CODEX_HOME);
  const rows = deltasByThread(scanner.getAllDeltas()).get(THREAD_NORMAL);

  assert.equal(rows.length, 3, 'duplicates and phantom events must not create rows');
  assert.deepEqual(
    rows.map((r) => [r.input, r.cachedInput, r.output, r.reasoningOutput, r.total]),
    [
      [900, 400, 100, 40, 1000],
      [2200, 1400, 300, 110, 2500],
      [6000, 3400, 400, 150, 6400],
    ]
  );
  // Session total == MAX of total_token_usage.total_tokens.
  assert.equal(sum(rows, 'total'), 9900);
  // Deltas are attributed to their own event timestamp, not the session start.
  assert.deepEqual(
    rows.map((r) => new Date(r.ts).toISOString()),
    ['2026-07-01T10:00:05.000Z', '2026-07-01T10:00:30.000Z', '2026-07-01T10:01:00.000Z']
  );
});

test('normal session: model is the last-seen turn_context.payload.model', () => {
  const { scanner } = scanRoot(CODEX_HOME);
  const rows = deltasByThread(scanner.getAllDeltas()).get(THREAD_NORMAL);
  assert.deepEqual(
    rows.map((r) => r.model),
    ['gpt-5.5', 'gpt-5.5', 'gpt-5.6-sol']
  );
});

test('normal session: last_token_usage is never summed', () => {
  // What a naive `sum(last_token_usage.total_tokens)` implementation would report.
  let naive = 0;
  for (const line of fs.readFileSync(NORMAL_FILE, 'utf8').split('\n')) {
    if (!line.includes('token_count')) continue;
    const event = JSON.parse(line);
    const info = event.payload.info;
    if (info && info.last_token_usage) naive += info.last_token_usage.total_tokens;
  }
  assert.equal(naive, 113399, 'fixture must contain inflating duplicates + a phantom event');

  const { scanner } = scanRoot(CODEX_HOME);
  const rows = deltasByThread(scanner.getAllDeltas()).get(THREAD_NORMAL);
  assert.equal(sum(rows, 'total'), 9900);
  assert.ok(sum(rows, 'total') < naive);
});

// ---------------------------------------------------------------------------
// (b) forked session with replay burst
// ---------------------------------------------------------------------------

test('forked session: replayed prefix is subtracted as a baseline', () => {
  const { scanner, result } = scanRoot(CODEX_HOME);
  const rows = deltasByThread(scanner.getAllDeltas()).get(THREAD_FORK);

  assert.equal(rows.length, 2, 'the three replayed advances must be dropped entirely');
  assert.deepEqual(
    rows.map((r) => [r.input, r.cachedInput, r.output, r.reasoningOutput, r.total]),
    [
      [5000, 5000, 1000, 400, 6000],
      [8000, 7000, 2000, 800, 10000],
    ]
  );
  // final (215000) - baseline (199000)
  assert.equal(sum(rows, 'total'), 16000);
  assert.ok(rows.every((r) => r.model === 'gpt-5.6-terra'));
  assert.equal(result.stats.forkBaselines, 1);
});

test('forked session: repeated identical session_meta ids do not trigger a baseline', () => {
  // The normal fixture repeats no meta ids and has no forked_from_id, so it must be
  // untouched; the archived fixtures likewise. Only one file in the tree is a fork.
  const { result } = scanRoot(CODEX_HOME);
  assert.equal(result.stats.forkBaselines, 1);
});

// ---------------------------------------------------------------------------
// (c) rate_limits layout variants
// ---------------------------------------------------------------------------

test('rate_limits: 10080-only layout', () => {
  const { result } = scanRoot(path.join(FIXTURES, 'rl-weekly-only'));
  const snap = result.rateSnapshot;
  assert.deepEqual(
    snap.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    [[10080, 35]]
  );
  assert.equal(snap.planType, 'plus');
  // credits.balance stays a decimal STRING — never a float.
  assert.deepEqual(snap.credits, {
    hasCredits: true,
    unlimited: false,
    balance: '2443.6518000000',
  });
  assert.equal(typeof snap.credits.balance, 'string');
});

test('rate_limits: 300 + 10080 layout, and the same result with the slots swapped', () => {
  const straight = scanRoot(path.join(FIXTURES, 'rl-both')).result.rateSnapshot;
  const swapped = scanRoot(path.join(FIXTURES, 'rl-both-swapped')).result.rateSnapshot;

  const expected = [
    [300, 41],
    [10080, 63],
  ];
  assert.deepEqual(
    straight.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    expected
  );
  assert.deepEqual(
    swapped.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    expected,
    'windows must be identified by window_minutes, never by primary/secondary slot'
  );
  assert.deepEqual(
    straight.windows.map((w) => w.resetsAt),
    swapped.windows.map((w) => w.resetsAt)
  );
});

test('rate_limits: resets_at is unix SECONDS, converted to ms at the parse boundary', () => {
  const snap = scanRoot(path.join(FIXTURES, 'rl-both')).result.rateSnapshot;
  const base = Math.floor(Date.parse('2026-07-10T12:00:00.000Z') / 1000);
  assert.deepEqual(
    snap.windows.map((w) => w.resetsAt),
    [(base + 2 * 3600) * 1000, (base + 4 * 86400) * 1000]
  );
  assert.equal(snap.ts, Date.parse('2026-07-10T12:00:05.000Z'));
});

test('rate_limits: legacy resets_in_seconds is relative to the event timestamp', () => {
  const snap = scanRoot(path.join(FIXTURES, 'rl-legacy')).result.rateSnapshot;
  const eventTs = Date.parse('2026-07-10T12:00:05.000Z');
  assert.deepEqual(
    snap.windows.map((w) => [w.windowMinutes, w.usedPercent, w.resetsAt]),
    [
      [300, 17, eventTs + 4200 * 1000],
      [10080, 55, eventTs + 200000 * 1000],
    ]
  );
});

test('rate_limits: windows already reset at event time are dropped', () => {
  const snap = scanRoot(path.join(FIXTURES, 'rl-stale')).result.rateSnapshot;
  assert.deepEqual(
    snap.windows.map((w) => w.windowMinutes),
    [10080],
    'the stale 5h window must not be reported'
  );
});

test('rate_limits: the globally freshest token_count wins', () => {
  const { result } = scanRoot(CODEX_HOME);
  // Latest rate_limits-bearing event in the tree is in the garbage fixture.
  assert.equal(result.rateSnapshot.ts, Date.parse('2026-07-02T10:00:09.000Z'));
  assert.deepEqual(
    result.rateSnapshot.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    [[300, 5]]
  );
});

// ---------------------------------------------------------------------------
// (d) zero-token_count file
// ---------------------------------------------------------------------------

test('a session with no token_count events contributes nothing and does not throw', () => {
  const { scanner, result } = scanRoot(CODEX_HOME);
  assert.equal(deltasByThread(scanner.getAllDeltas()).has(THREAD_EMPTY), false);
  assert.ok(result.stats.files >= 7);
});

// ---------------------------------------------------------------------------
// (e) truncated / garbage lines
// ---------------------------------------------------------------------------

test('malformed lines are skipped and counted, good lines around them still parse', () => {
  const { scanner, result } = scanRoot(CODEX_HOME);
  const rows = deltasByThread(scanner.getAllDeltas()).get(THREAD_GARBAGE);

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.input, r.cachedInput, r.output, r.total]),
    [
      [1000, 500, 200, 1200],
      [3000, 2000, 300, 3300],
    ]
  );
  assert.equal(sum(rows, 'total'), 4500);
  // 1 truncated JSON + 2 syntactically broken lines + 1 JSON array + 1 unparseable
  // timestamp. The blank line and the plain-text line carry no whitelisted needle,
  // so they are skipped silently rather than counted.
  assert.equal(result.stats.badLines, 5);
});

// ---------------------------------------------------------------------------
// discovery: archived (flat + nested) and cross-tree collisions
// ---------------------------------------------------------------------------

test('scans archived_sessions in both flat and date-nested layouts', () => {
  const { scanner } = scanRoot(CODEX_HOME);
  const byThread = deltasByThread(scanner.getAllDeltas());
  assert.equal(sum(byThread.get(THREAD_ARCHIVED_FLAT), 'total'), 8000);
  assert.equal(sum(byThread.get(THREAD_ARCHIVED_NESTED), 'total'), 2500);
  assert.equal(byThread.get(THREAD_ARCHIVED_NESTED)[0].model, 'deepseek/deepseek-v4-flash');
});

test('thread key is the filename UUID; sessions/ wins over archived_sessions/', () => {
  const { scanner, result } = scanRoot(CODEX_HOME);
  const rows = deltasByThread(scanner.getAllDeltas()).get(THREAD_COLLISION);
  assert.equal(rows.length, 1);
  assert.equal(sum(rows, 'total'), 11000, 'the sessions/ copy must win');
  assert.equal(rows[0].model, 'gpt-5.6-luna');
  // 7 threads, not 8: the archived duplicate is deduped away, not scanned twice.
  assert.equal(result.stats.files, 7);
});

test('non-rollout files inside sessions/ are ignored', () => {
  const { scanner } = scanRoot(CODEX_HOME);
  assert.equal(scanner.getAllDeltas().reduce((a, d) => a + d.total, 0), 51900);
});

// ---------------------------------------------------------------------------
// cache round-trip
// ---------------------------------------------------------------------------

test('getCache() is JSON-serializable and restores an identical scanner', () => {
  const first = createScanner({ roots: [CODEX_HOME], cache: null });
  const firstResult = first.scan();
  const cache = roundTrip(first.getCache());

  const second = createScanner({ roots: [CODEX_HOME], cache });
  const secondResult = second.scan();

  assert.deepEqual(normalizeDeltas(second.getAllDeltas()), normalizeDeltas(first.getAllDeltas()));
  assert.deepEqual(secondResult.rateSnapshot, firstResult.rateSnapshot);
  assert.equal(secondResult.newDeltas.length, 0, 'an unchanged rescan discovers nothing new');
  assert.equal(secondResult.stats.newBytes, 0, 'unchanged files must not be re-read');
  assert.equal(secondResult.stats.forkBaselines, 1);
});

test('a corrupt or foreign cache is ignored rather than throwing', () => {
  for (const bad of [undefined, null, 42, 'nope', {}, { v: 999 }, { v: 1, threads: 'x' }]) {
    const scanner = createScanner({ roots: [CODEX_HOME], cache: bad });
    const result = scanner.scan();
    assert.equal(scanner.getAllDeltas().reduce((a, d) => a + d.total, 0), 51900);
    assert.ok(result.stats.files >= 7);
  }
});

test('createScanner tolerates missing roots and junk options', () => {
  for (const opts of [undefined, {}, { roots: null }, { roots: ['/definitely/not/here'] }]) {
    const scanner = createScanner(opts);
    const result = scanner.scan();
    assert.deepEqual(result.newDeltas, []);
    assert.equal(result.rateSnapshot, null);
    assert.deepEqual(scanner.getAllDeltas(), []);
    JSON.stringify(scanner.getCache()); // must not throw
  }
});

// ---------------------------------------------------------------------------
// (f) incremental resume, including a mid-line partial write
// ---------------------------------------------------------------------------

function assertIncrementalMatchesOneShot(sourceFile, tmpPrefix) {
  const source = fs.readFileSync(sourceFile);
  const root = makeTempRoot(tmpPrefix);
  const dir = path.join(root, 'sessions', '2026', '07', '01');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(sourceFile));

  const [cut1, cut2] = midLineCuts(source, 2);
  assert.ok(cut1 < cut2);

  // Stage 1: file ends in the MIDDLE of a line.
  fs.writeFileSync(dest, source.subarray(0, cut1));
  let scanner = createScanner({ roots: [root], cache: null });
  scanner.scan();
  let cache = roundTrip(scanner.getCache());
  const offsets = [cache.threads[Object.keys(cache.threads)[0]].o];

  // Stage 2: finish that line and stop mid-line again.
  fs.appendFileSync(dest, source.subarray(cut1, cut2));
  scanner = createScanner({ roots: [root], cache });
  scanner.scan();
  cache = roundTrip(scanner.getCache());
  offsets.push(cache.threads[Object.keys(cache.threads)[0]].o);

  // Stage 3: append the remainder.
  fs.appendFileSync(dest, source.subarray(cut2));
  scanner = createScanner({ roots: [root], cache });
  scanner.scan();
  offsets.push(roundTrip(scanner.getCache()).threads[Object.keys(cache.threads)[0]].o);

  const incremental = normalizeDeltas(scanner.getAllDeltas());

  const oneShotScanner = createScanner({ roots: [root], cache: null });
  oneShotScanner.scan();
  const oneShot = normalizeDeltas(oneShotScanner.getAllDeltas());

  return { incremental, oneShot, offsets, source };
}

test('incremental resume across mid-line partial writes equals a one-shot parse', () => {
  const { incremental, oneShot, offsets, source } = assertIncrementalMatchesOneShot(
    NORMAL_FILE,
    'subsplit-inc-normal-'
  );

  assert.deepEqual(incremental, oneShot);
  assert.equal(
    incremental.reduce((a, d) => a + d.total, 0),
    9900
  );
  // The byte offset only ever advances, and never past the last newline.
  assert.ok(offsets[0] < offsets[1] && offsets[1] < offsets[2]);
  assert.equal(offsets[2], source.length, 'a complete file is fully consumed');
  for (const offset of offsets) {
    assert.ok(offset === 0 || source[offset - 1] === 0x0a, 'offsets land on line boundaries');
  }
});

test('incremental resume through a forked replay burst equals a one-shot parse', () => {
  const { incremental, oneShot } = assertIncrementalMatchesOneShot(
    FORK_FILE,
    'subsplit-inc-fork-'
  );

  assert.deepEqual(incremental, oneShot);
  assert.equal(
    incremental.reduce((a, d) => a + d.total, 0),
    16000,
    'the replay baseline must survive being cut in half by an incremental scan'
  );
  assert.equal(incremental.length, 2);
});

test('a shrinking or rewritten file is re-parsed from zero instead of double-counted', () => {
  const source = fs.readFileSync(NORMAL_FILE);
  const root = makeTempRoot('subsplit-shrink-');
  const dir = path.join(root, 'sessions', '2026', '07', '01');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(NORMAL_FILE));

  fs.writeFileSync(dest, source);
  let scanner = createScanner({ roots: [root], cache: null });
  scanner.scan();
  const cache = roundTrip(scanner.getCache());
  assert.equal(scanner.getAllDeltas().reduce((a, d) => a + d.total, 0), 9900);

  // Truncate to a shorter file, then rescan with the stale cache.
  const newlines = [];
  for (let i = 0; i < source.length; i += 1) if (source[i] === 0x0a) newlines.push(i);
  fs.writeFileSync(dest, source.subarray(0, newlines[5] + 1));
  fs.utimesSync(dest, new Date(), new Date(Date.now() + 5000));

  scanner = createScanner({ roots: [root], cache });
  scanner.scan();
  const total = scanner.getAllDeltas().reduce((a, d) => a + d.total, 0);
  assert.ok(total > 0 && total < 9900, 'stale deltas must be dropped, not appended to');
});

// ---------------------------------------------------------------------------
// privacy
// ---------------------------------------------------------------------------

test('the scanner only ever opens rollout-*.jsonl files', () => {
  const opened = [];
  const realOpenSync = fs.openSync;
  const realReadFileSync = fs.readFileSync;
  const realCreateReadStream = fs.createReadStream;

  fs.openSync = function patchedOpenSync(target, ...rest) {
    opened.push(String(target));
    return realOpenSync.call(fs, target, ...rest);
  };
  fs.readFileSync = function patchedReadFileSync(target, ...rest) {
    opened.push(String(target));
    return realReadFileSync.call(fs, target, ...rest);
  };
  fs.createReadStream = function patchedCreateReadStream(target, ...rest) {
    opened.push(String(target));
    return realCreateReadStream.call(fs, target, ...rest);
  };

  try {
    const scanner = createScanner({ roots: [CODEX_HOME], cache: null });
    scanner.scan();
  } finally {
    fs.openSync = realOpenSync;
    fs.readFileSync = realReadFileSync;
    fs.createReadStream = realCreateReadStream;
  }

  assert.ok(opened.length > 0, 'the scan must actually have read something');
  for (const target of opened) {
    assert.match(
      path.basename(target),
      /^rollout-.+\.jsonl$/,
      'opened a file that is not a rollout: ' + target
    );
  }
  for (const forbidden of ['auth.json', 'history.jsonl', 'session_index.jsonl', 'notes.jsonl']) {
    assert.ok(
      !opened.some((target) => path.basename(target) === forbidden),
      'must never open ' + forbidden
    );
  }
});

test('no conversation text leaks into deltas or the cache', () => {
  const scanner = createScanner({ roots: [CODEX_HOME], cache: null });
  scanner.scan();
  const serialized = JSON.stringify({
    deltas: scanner.getAllDeltas(),
    cache: scanner.getCache(),
  });
  for (const secret of [
    'SYNTHETIC PROMPT TEXT',
    'SYNTHETIC TOOL TEXT',
    'SYNTHETIC-SECRET',
    'SYNTHETIC THREAD NAME',
    'conversation content',
  ]) {
    assert.ok(!serialized.includes(secret), 'leaked: ' + secret);
  }
});

// ---------------------------------------------------------------------------
// windows.js
// ---------------------------------------------------------------------------

function delta(ts, over) {
  return Object.assign(
    {
      threadId: 't',
      ts,
      model: 'gpt-5.5',
      input: 100,
      cachedInput: 60,
      cacheWriteInput: 0,
      output: 20,
      reasoningOutput: 5,
      total: 120,
    },
    over || {}
  );
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

test('computeWindows: fresh snapshot anchors bounds to resets_at', () => {
  const now = Date.parse('2026-07-15T12:00:00.000Z');
  const snapshot = {
    ts: now - 60000,
    windows: [
      { windowMinutes: 300, usedPercent: 38, resetsAt: now + HOUR },
      { windowMinutes: 10080, usedPercent: 71, resetsAt: now + 2 * DAY },
    ],
    planType: 'plus',
    credits: null,
  };
  const deltas = [
    delta(now - 6 * HOUR), // outside the 5h window, inside weekly
    delta(now - 2 * HOUR),
    delta(now - 30 * 60 * 1000),
    delta(now + 60000), // in the future: excluded from both
  ];

  const out = computeWindows(deltas, snapshot, now);

  assert.equal(out['5h'].window_start, now + HOUR - 5 * HOUR);
  assert.equal(out['5h'].resets_at, now + HOUR);
  assert.equal(out['5h'].used_percent, 38);
  assert.equal(out['5h'].total, 240);
  assert.equal(out['5h'].input, 200);
  assert.equal(out['5h'].cached_input, 120);
  assert.equal(out['5h'].output, 40);

  assert.equal(out.weekly.window_start, now + 2 * DAY - 7 * DAY);
  assert.equal(out.weekly.resets_at, now + 2 * DAY);
  assert.equal(out.weekly.used_percent, 71);
  assert.equal(out.weekly.total, 360);
});

test('computeWindows: WindowTotals carries exactly the contract keys', () => {
  const now = Date.now();
  const out = computeWindows([], null, now);
  for (const key of ['5h', 'weekly']) {
    assert.deepEqual(Object.keys(out[key]).sort(), [
      'cached_input',
      'input',
      'output',
      'resets_at',
      'total',
      'used_percent',
      'window_start',
    ]);
  }
});

test('computeWindows: stale or missing window falls back to a rolling window', () => {
  const now = Date.parse('2026-07-15T12:00:00.000Z');
  const staleSnapshot = {
    ts: now - DAY,
    windows: [{ windowMinutes: 300, usedPercent: 90, resetsAt: now - HOUR }],
    planType: 'plus',
    credits: null,
  };
  const deltas = [delta(now - 4 * HOUR), delta(now - 6 * DAY)];

  const out = computeWindows(deltas, staleSnapshot, now);
  assert.equal(out['5h'].window_start, now - 5 * HOUR);
  assert.equal(out['5h'].resets_at, null);
  assert.equal(out['5h'].used_percent, null);
  assert.equal(out['5h'].total, 120);

  // no weekly window in the snapshot at all
  assert.equal(out.weekly.window_start, now - 7 * DAY);
  assert.equal(out.weekly.resets_at, null);
  assert.equal(out.weekly.used_percent, null);
  assert.equal(out.weekly.total, 240);

  const noSnapshot = computeWindows(deltas, null, now);
  assert.equal(noSnapshot['5h'].resets_at, null);
  assert.equal(noSnapshot.weekly.total, 240);
});

test('computeWindows: fallback can be disabled, yielding null windows', () => {
  const now = Date.parse('2026-07-15T12:00:00.000Z');
  const snapshot = {
    ts: now,
    windows: [{ windowMinutes: 10080, usedPercent: 12, resetsAt: now + DAY }],
    planType: null,
    credits: null,
  };
  const out = computeWindows([delta(now - HOUR)], snapshot, now, { fallback: false });
  assert.equal(out['5h'], null);
  assert.equal(out.weekly.used_percent, 12);
});

test('computeWindows: tolerates junk input', () => {
  const now = Date.now();
  const out = computeWindows(null, { windows: 'nope' }, now);
  assert.equal(out['5h'].total, 0);
  assert.equal(out.weekly.total, 0);

  const out2 = computeWindows(
    [null, 'x', delta(now - 1000), { ts: 'bad' }],
    { windows: [{ windowMinutes: 300, usedPercent: null, resetsAt: null }] },
    now
  );
  assert.equal(out2['5h'].total, 120);
  assert.equal(out2['5h'].used_percent, null);
});

test('computeWindows: parser output feeds straight into windows.js', () => {
  const scanner = createScanner({ roots: [CODEX_HOME], cache: null });
  const result = scanner.scan();
  // Evaluate as of just after the newest fixture delta.
  const now = Date.parse('2026-07-03T09:00:00.000Z');
  const out = computeWindows(scanner.getAllDeltas(), result.rateSnapshot, now);
  assert.equal(out['5h'].total, 11000, 'only the 2026-07-03 session is inside the last 5h');
  assert.equal(out.weekly.total, 51900);
  assert.equal(out.weekly.cached_input, 400 + 1400 + 3400 + 5000 + 7000 + 500 + 2000 + 4000 + 0 + 6000);
});

// ---------------------------------------------------------------------------
// (g) rate-limit gauge: window-less snapshots and fork-replayed rate limits
// ---------------------------------------------------------------------------

const RL_BASE = Date.parse('2026-07-20T12:00:00.000Z');

function iso(ms) {
  return new Date(ms).toISOString();
}

function metaLine(ts, id, forkedFromId) {
  return JSON.stringify({
    timestamp: iso(ts),
    type: 'session_meta',
    payload: {
      id,
      timestamp: iso(ts - 500),
      cwd: '/tmp/fixture',
      originator: 'codex-tui',
      cli_version: '0.146.0-alpha.9.2',
      source: 'cli',
      model_provider: 'openai',
      forked_from_id: forkedFromId || null,
    },
  });
}

function tokenCountLine(ts, total, rateLimits) {
  const usage = {
    input_tokens: total - 200,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 200,
    reasoning_output_tokens: 50,
    total_tokens: total,
  };
  return JSON.stringify({
    timestamp: iso(ts),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 258400 },
      rate_limits: rateLimits,
    },
  });
}

/** One `RateLimitWindow` as Codex writes it: `resets_at` is unix SECONDS. */
function win(windowMinutes, usedPercent, resetsAtMs) {
  return {
    used_percent: usedPercent,
    window_minutes: windowMinutes,
    resets_at: Math.floor(resetsAtMs / 1000),
  };
}

/** The `limit_id:"codex"` family: this is the one that carries the windows. */
function codexLimits(primary, secondary, over) {
  return Object.assign(
    {
      limit_id: 'codex',
      limit_name: null,
      primary,
      secondary,
      credits: null,
      individual_limit: null,
      plan_type: 'plus',
      rate_limit_reached_type: null,
    },
    over || {}
  );
}

/** The `limit_id:"premium"` family: no windows at all, only credits + plan_type. */
function premiumLimits(over) {
  return Object.assign(
    {
      limit_id: 'premium',
      limit_name: null,
      primary: null,
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
      individual_limit: null,
      plan_type: 'plus',
      rate_limit_reached_type: null,
    },
    over || {}
  );
}

function writeRollout(root, label, threadId, lines) {
  const dir = path.join(root, 'sessions', '2026', '07', '20');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-' + label + '-' + threadId + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('a credits-only premium token_count refreshes plan/credits without evicting the windows', () => {
  const root = makeTempRoot('subsplit-rl-premium-');
  const thread = '019e0000-0000-7000-8000-0000000000f1';
  const fiveH = RL_BASE + 2 * HOUR;
  const weekly = RL_BASE + 4 * DAY;

  writeRollout(root, 'a', thread, [
    metaLine(RL_BASE, thread, null),
    tokenCountLine(
      RL_BASE + 5000,
      1000,
      codexLimits(win(300, 100, fiveH), win(10080, 21, weekly))
    ),
    // 18s later, the other limit family: no windows, just credits and a plan.
    tokenCountLine(
      RL_BASE + 23000,
      2000,
      premiumLimits({
        plan_type: 'pro',
        credits: { has_credits: true, unlimited: false, balance: '250.0000000000' },
      })
    ),
  ]);

  const { scanner, result } = scanRoot(root);
  const snap = result.rateSnapshot;

  assert.deepEqual(
    snap.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    [
      [300, 100],
      [10080, 21],
    ],
    'a window-less snapshot must never evict the live 5h/weekly windows'
  );
  assert.equal(snap.planType, 'pro', 'plan_type is still taken from the newer event');
  assert.deepEqual(snap.credits, {
    hasCredits: true,
    unlimited: false,
    balance: '250.0000000000',
  });
  assert.equal(snap.ts, RL_BASE + 5000, 'the merged snapshot keeps the window-bearing ts');

  const out = computeWindows(scanner.getAllDeltas(), snap, RL_BASE + 60000);
  assert.equal(out['5h'].used_percent, 100, 'the tray percentage must not go blank');
  assert.equal(out['5h'].resets_at, fiveH);
  assert.equal(out.weekly.used_percent, 21);

  // and it survives serializeCache -> deserializeCache
  const restored = createScanner({ roots: [root], cache: roundTrip(scanner.getCache()) });
  assert.deepEqual(restored.scan().rateSnapshot, snap);
});

test('a token_count whose windows have all already reset does not evict them either', () => {
  const root = makeTempRoot('subsplit-rl-allstale-');
  const thread = '019e0000-0000-7000-8000-0000000000f2';
  const fiveH = RL_BASE + 2 * HOUR;
  const weekly = RL_BASE + 4 * DAY;

  writeRollout(root, 'a', thread, [
    metaLine(RL_BASE, thread, null),
    tokenCountLine(RL_BASE + 5000, 1000, codexLimits(win(300, 100, fiveH), win(10080, 21, weekly))),
    // Both windows had already reset when this event was written -> zero usable windows.
    tokenCountLine(
      RL_BASE + 23000,
      2000,
      codexLimits(win(300, 4, RL_BASE - HOUR), win(10080, 5, RL_BASE - DAY), { plan_type: 'pro' })
    ),
  ]);

  const snap = scanRoot(root).result.rateSnapshot;
  assert.deepEqual(
    snap.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    [
      [300, 100],
      [10080, 21],
    ]
  );
  assert.equal(snap.planType, 'pro');
  assert.equal(snap.ts, RL_BASE + 5000);
});

/** Ancestor session + a fork that replays its history under the fork's own timestamps. */
function writeForkPair(root, live) {
  const ancestor = '019e0000-0000-7000-8000-0000000000f3';
  const fork = '019e0000-0000-7000-8000-0000000000f4';
  const forkTs = RL_BASE + 5 * 60 * 1000;

  writeRollout(root, 'a', ancestor, [
    metaLine(RL_BASE, ancestor, null),
    tokenCountLine(
      RL_BASE + 5000,
      900000,
      codexLimits(win(300, 45, RL_BASE + 2 * HOUR), win(10080, 82, RL_BASE + 4 * DAY))
    ),
  ]);

  // The replayed lines carry the ancestor's OLD percentages but are re-stamped with
  // the fork's own envelope ts (+1..3ms), so they look like the freshest event around.
  const replayed = codexLimits(win(300, 12, RL_BASE + HOUR), win(10080, 30, RL_BASE + 2 * DAY));
  const lines = [
    metaLine(forkTs, fork, ancestor),
    metaLine(forkTs + 1, ancestor, null),
    tokenCountLine(forkTs + 2, 500000, replayed),
    tokenCountLine(forkTs + 3, 900000, replayed),
  ];
  if (live) {
    lines.push(
      tokenCountLine(
        forkTs + 10000,
        950000,
        codexLimits(win(300, 51, RL_BASE + 2 * HOUR), win(10080, 35, RL_BASE + 4 * DAY))
      )
    );
  }
  writeRollout(root, 'b', fork, lines);
  return forkTs;
}

test('fork-replayed rate_limits never advance the gauge', () => {
  const root = makeTempRoot('subsplit-rl-fork-');
  writeForkPair(root, false);

  const { scanner, result } = scanRoot(root);
  const snap = result.rateSnapshot;

  assert.equal(snap.ts, RL_BASE + 5000, 'the replay burst must not become the freshest snapshot');
  assert.deepEqual(
    snap.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    [
      [300, 45],
      [10080, 82],
    ],
    'lines dropped as replay for token math must not drive the rate-limit gauge'
  );
  // token math is unchanged: the replayed advances are still baseline-subtracted.
  assert.equal(scanner.getAllDeltas().reduce((a, d) => a + d.total, 0), 900000);
  assert.equal(result.stats.forkBaselines, 1);
});

test('a live post-fork token_count does update the gauge', () => {
  const root = makeTempRoot('subsplit-rl-forklive-');
  const forkTs = writeForkPair(root, true);

  const { scanner, result } = scanRoot(root);
  const snap = result.rateSnapshot;

  assert.equal(snap.ts, forkTs + 10000);
  assert.deepEqual(
    snap.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    [
      [300, 51],
      [10080, 35],
    ]
  );
  assert.equal(scanner.getAllDeltas().reduce((a, d) => a + d.total, 0), 950000);
});

test('a non-fork file whose only token_count is inside the replay window still reports it', () => {
  const root = makeTempRoot('subsplit-rl-burst-');
  const thread = '019e0000-0000-7000-8000-0000000000f5';

  writeRollout(root, 'a', thread, [
    metaLine(RL_BASE, thread, null),
    tokenCountLine(RL_BASE + 500, 4000, codexLimits(win(300, 60, RL_BASE + HOUR), null)),
  ]);

  const { scanner, result } = scanRoot(root);
  assert.equal(result.rateSnapshot.ts, RL_BASE + 500);
  assert.deepEqual(
    result.rateSnapshot.windows.map((w) => [w.windowMinutes, w.usedPercent]),
    [[300, 60]]
  );
  assert.equal(scanner.getAllDeltas().reduce((a, d) => a + d.total, 0), 4000);
});

// ---------------------------------------------------------------------------
// integration against the real Codex data on this machine (opt-in)
// ---------------------------------------------------------------------------

const REAL_CODEX_HOME = path.join(os.homedir(), '.codex');
const HAS_REAL_DATA = fs.existsSync(path.join(REAL_CODEX_HOME, 'sessions'));

/**
 * Independent, minimal re-read of the real rollout files used ONLY to compute the
 * naive (non-deduped) total and to verify the monotonicity invariant. Uses the same
 * substring prefilter, so conversation lines are never decoded.
 */
function inspectRealRollouts() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^rollout-.+\.jsonl$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(REAL_CODEX_HOME, 'sessions'));
  walk(path.join(REAL_CODEX_HOME, 'archived_sessions'));

  const perThread = new Map();
  let decreases = 0;
  let unexpectedTransitions = 0;

  for (const file of files) {
    const threadId = /([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(file));
    const key = threadId ? threadId[1].toLowerCase() : path.basename(file);

    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    let position = 0;
    let leftover = Buffer.alloc(0);
    let maxTotal = 0;
    let previous = 0;

    const handle = (lineBuffer) => {
      if (!lineBuffer.includes('token_count')) return;
      let event;
      try {
        event = JSON.parse(lineBuffer.toString('utf8'));
      } catch (err) {
        return;
      }
      if (!event || event.type !== 'event_msg') return;
      const payload = event.payload;
      if (!payload || payload.type !== 'token_count' || !payload.info) return;
      const totals = payload.info.total_token_usage;
      const last = payload.info.last_token_usage;
      if (!totals || typeof totals.total_tokens !== 'number') return;
      const current = totals.total_tokens;
      if (current < previous) decreases += 1;
      const advance = current - previous;
      if (advance !== 0 && (!last || advance !== last.total_tokens)) unexpectedTransitions += 1;
      previous = current;
      if (current > maxTotal) maxTotal = current;
    };

    try {
      while (position < size) {
        const length = Math.min(4 * 1024 * 1024, size - position);
        const buffer = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buffer, 0, length, position);
        if (read <= 0) break;
        position += read;
        const data =
          leftover.length > 0 ? Buffer.concat([leftover, buffer.subarray(0, read)]) : buffer.subarray(0, read);
        let start = 0;
        let index;
        while ((index = data.indexOf(0x0a, start)) !== -1) {
          handle(data.subarray(start, index));
          start = index + 1;
        }
        leftover = Buffer.from(data.subarray(start));
      }
    } finally {
      fs.closeSync(fd);
    }

    // sessions/ wins on collision, and sessions/ is walked first.
    if (!perThread.has(key)) perThread.set(key, maxTotal);
  }

  let naiveTotal = 0;
  for (const value of perThread.values()) naiveTotal += value;
  return { fileCount: files.length, threadCount: perThread.size, naiveTotal, decreases, unexpectedTransitions, perThread };
}

test(
  'integration: real ~/.codex rollout files',
  { skip: HAS_REAL_DATA ? false : 'no ~/.codex/sessions on this machine' },
  () => {
    const scanner = createScanner({ roots: [REAL_CODEX_HOME], cache: null });
    const result = scanner.scan();
    const deltas = scanner.getAllDeltas();
    const dedupedTotal = deltas.reduce((acc, d) => acc + d.total, 0);

    const reference = inspectRealRollouts();

    // 1. Monotonicity held inside every file.
    assert.equal(reference.decreases, 0, 'total_token_usage must be monotonic non-decreasing');
    assert.equal(
      reference.unexpectedTransitions,
      0,
      'every advance must equal last_token_usage.total_tokens'
    );

    // 2. No negative or zero deltas: one row per POSITIVE advance only.
    for (const d of deltas) {
      assert.ok(d.total > 0, 'delta totals must be strictly positive');
      assert.ok(d.input >= 0 && d.cachedInput >= 0 && d.output >= 0 && d.reasoningOutput >= 0);
      assert.ok(d.cachedInput <= d.input || d.input === 0, 'cached input is a subset of input');
      assert.ok(Number.isFinite(d.ts) && d.ts > 0);
      assert.ok(d.model === null || typeof d.model === 'string');
    }

    // 3. Dedupe actually removed the fork-replay inflation.
    assert.ok(result.stats.forkBaselines > 0, 'this machine has forked sessions');
    assert.ok(
      dedupedTotal < reference.naiveTotal,
      'deduped total must be strictly below the naive per-file sum'
    );
    // Per thread, the deduped sum can never exceed that file's final cumulative total.
    for (const d of deltasByThread(deltas)) {
      const [threadId, rows] = d;
      const naive = reference.perThread.get(threadId);
      if (naive === undefined) continue;
      assert.ok(
        sum(rows, 'total') <= naive,
        'thread ' + threadId + ' exceeded its own cumulative total'
      );
    }

    // 4. Rate snapshot is sane.
    assert.ok(result.rateSnapshot, 'expected a rate-limit snapshot from real data');
    for (const win of result.rateSnapshot.windows) {
      assert.ok([300, 10080].includes(win.windowMinutes));
      assert.ok(win.resetsAt > result.rateSnapshot.ts, 'stale windows must be dropped');
    }
    if (result.rateSnapshot.credits) {
      assert.ok(
        result.rateSnapshot.credits.balance === null ||
          typeof result.rateSnapshot.credits.balance === 'string'
      );
    }

    // 5. Incremental rescan with a persisted cache is a no-op.
    const cache = roundTrip(scanner.getCache());
    const again = createScanner({ roots: [REAL_CODEX_HOME], cache });
    const againResult = again.scan();
    assert.equal(againResult.stats.newBytes, 0);
    assert.equal(againResult.newDeltas.length, 0);
    assert.equal(
      again.getAllDeltas().reduce((acc, d) => acc + d.total, 0),
      dedupedTotal
    );

    const inflation = (reference.naiveTotal / dedupedTotal).toFixed(4);
    console.log(
      [
        '',
        '  real ~/.codex integration:',
        '    files scanned      : ' + result.stats.files + ' (walked ' + reference.fileCount + ')',
        '    bytes read         : ' + result.stats.newBytes.toLocaleString('en-US'),
        '    bad lines          : ' + result.stats.badLines,
        '    fork baselines     : ' + result.stats.forkBaselines,
        '    delta rows         : ' + deltas.length.toLocaleString('en-US'),
        '    naive total tokens : ' + reference.naiveTotal.toLocaleString('en-US'),
        '    deduped total      : ' + dedupedTotal.toLocaleString('en-US'),
        '    inflation avoided  : ' + inflation + 'x',
        '',
      ].join('\n')
    );
  }
);
