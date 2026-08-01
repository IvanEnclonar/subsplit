'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { createSync, toErrorInfo } = require('../src/main/sync.js');
const settingsStore = require('../src/main/settings.js');

const SERVER = 'https://sync.example.test';
const TOKEN = 'ss_grp1_s3cret';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeResponse(options) {
  const opts = options || {};
  const status = opts.status === undefined ? 200 : opts.status;
  const headers = new Map(
    Object.entries(opts.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const text =
    opts.text !== undefined
      ? opts.text
      : opts.body === undefined || opts.body === null
        ? ''
        : JSON.stringify(opts.body);
  return {
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        return headers.has(key) ? headers.get(key) : null;
      },
    },
    async text() {
      return text;
    },
  };
}

/** Records every call and replays `responder` (value or function). */
function stubFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof responder === 'function' ? responder(url, init, calls.length - 1) : responder;
  };
  return { calls, fetchImpl };
}

function client(responder, extra) {
  const stub = stubFetch(responder);
  const sync = createSync(
    Object.assign({ serverUrl: SERVER, token: TOKEN, fetchImpl: stub.fetchImpl }, extra || {})
  );
  return { sync, calls: stub.calls };
}

const GROUP_STATE = {
  server_time: 1_700_000_000_000,
  members: [
    {
      member_id: 'ada',
      member_name: 'Ada',
      devices: [{ device_id: 'dev-1', seen_ms_ago: 1200, stale: false }],
      windows: {
        '5h': { window_start: 1, resets_at: 2, used_percent: 12, input: 5, cached_input: 1, output: 2, total: 7, share_pct: 40 },
        weekly: { window_start: 1, resets_at: 2, used_percent: 30, input: 50, cached_input: 10, output: 20, total: 70, share_pct: 55 },
      },
    },
  ],
  account_rate_limit: null,
  etag: 'W/"state-7"',
};

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

test('join posts /v1/join with bearer auth and returns the server body', async () => {
  const body = {
    group_id: 'grp1',
    member_id: 'ada',
    member_name: 'Ada',
    server_time: 1_700_000_000_000,
    poll_interval_s: 60,
  };
  const { sync, calls } = client(makeResponse({ status: 200, body }));

  const result = await sync.join('  Ada  ');

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, `${SERVER}/v1/join`);
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { member_name: 'Ada' });
  assert.ok(calls[0].init.signal, 'a timeout AbortSignal is always attached');
  assert.deepStrictEqual(result, body);
});

test('join rejects an empty name before touching the network', async () => {
  const { sync, calls } = client(makeResponse({ status: 200, body: { member_id: 'x' } }));
  await assert.rejects(
    () => sync.join('   '),
    (err) => err.code === 'config' && typeof err.message === 'string' && err.message.length > 0
  );
  assert.strictEqual(calls.length, 0);
});

test('join rejects a response with no member_id as bad_response', async () => {
  const { sync } = client(makeResponse({ status: 200, body: { group_id: 'grp1' } }));
  await assert.rejects(
    () => sync.join('Ada'),
    (err) => err.code === 'bad_response'
  );
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

test('push PUTs /v1/state and normalizes the response', async () => {
  const payload = {
    member_id: 'ada',
    member_name: 'Ada',
    device_id: 'dev-1',
    seq: 12,
    updated_at: 1_700_000_000_000,
    window_totals: {
      '5h': { window_start: 1, resets_at: 2, used_percent: 12, input: 5, cached_input: 1, output: 2, total: 7 },
      weekly: null,
    },
    rate_limit: null,
  };
  const { sync, calls } = client(
    makeResponse({ status: 200, body: { accepted: true, clock_skew_ms: -412, state: GROUP_STATE } })
  );

  const result = await sync.push(payload);

  assert.strictEqual(calls[0].url, `${SERVER}/v1/state`);
  assert.strictEqual(calls[0].init.method, 'PUT');
  assert.strictEqual(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepStrictEqual(sent, payload);
  assert.deepStrictEqual(Object.keys(sent.window_totals), ['5h', 'weekly']);
  assert.deepStrictEqual(result, {
    accepted: true,
    clock_skew_ms: -412,
    state: GROUP_STATE,
  });
});

test('push defaults accepted/clock_skew_ms/state when the server omits them', async () => {
  const { sync } = client(makeResponse({ status: 200, body: {} }));
  const result = await sync.push({ member_id: 'ada' });
  assert.deepStrictEqual(result, { accepted: true, clock_skew_ms: null, state: null });
});

test('push surfaces a 413 payload cap as { code, message }', async () => {
  const { sync } = client(
    makeResponse({ status: 413, body: { error: { code: 'payload_too_large', message: 'Body over 4KB' } } })
  );
  await assert.rejects(
    () => sync.push({ member_id: 'ada' }),
    (err) => {
      const info = toErrorInfo(err);
      assert.strictEqual(info.code, 'payload_too_large');
      assert.strictEqual(info.message, 'Body over 4KB');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

test('poll(null) sends no If-None-Match and returns { etag, state }', async () => {
  const { sync, calls } = client(
    makeResponse({ status: 200, body: GROUP_STATE, headers: { ETag: 'W/"state-7"' } })
  );

  const result = await sync.poll(null);

  assert.strictEqual(calls[0].url, `${SERVER}/v1/state`);
  assert.strictEqual(calls[0].init.method, 'GET');
  assert.strictEqual(calls[0].init.headers['If-None-Match'], undefined);
  assert.strictEqual(calls[0].init.body, undefined);
  assert.strictEqual(calls[0].init.headers['Content-Type'], undefined);
  assert.strictEqual(result.etag, 'W/"state-7"');
  assert.deepStrictEqual(result.state, GROUP_STATE);
});

test('poll falls back to state.etag when there is no ETag header', async () => {
  const { sync } = client(makeResponse({ status: 200, body: GROUP_STATE }));
  const result = await sync.poll(null);
  assert.strictEqual(result.etag, 'W/"state-7"');
});

test('poll(etag) sends If-None-Match and maps 304 to { notModified: true }', async () => {
  const { sync, calls } = client(makeResponse({ status: 304 }));

  const result = await sync.poll('W/"state-7"');

  assert.strictEqual(calls[0].init.headers['If-None-Match'], 'W/"state-7"');
  assert.deepStrictEqual(result, { notModified: true });
});

test('poll unwraps a { state: GroupState } envelope', async () => {
  const { sync } = client(
    makeResponse({ status: 200, body: { state: GROUP_STATE }, headers: { ETag: 'abc' } })
  );
  const result = await sync.poll(null);
  assert.deepStrictEqual(result.state, GROUP_STATE);
  assert.strictEqual(result.etag, 'abc');
});

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

test('non-2xx rejects with { code, message } derived from the status', async () => {
  const cases = [
    { status: 401, code: 'unauthorized' },
    { status: 403, code: 'forbidden' },
    { status: 404, code: 'not_found' },
    { status: 409, code: 'conflict' },
    { status: 429, code: 'rate_limited' },
    { status: 500, code: 'server_error' },
    { status: 503, code: 'server_error' },
    { status: 418, code: 'http_418' },
  ];
  for (const testCase of cases) {
    const { sync } = client(makeResponse({ status: testCase.status, text: '' }));
    await assert.rejects(
      () => sync.poll(null),
      (err) => {
        const info = toErrorInfo(err);
        assert.strictEqual(info.code, testCase.code, `status ${testCase.status}`);
        assert.ok(info.message.length > 0, 'every error carries a human message');
        assert.strictEqual(err.status, testCase.status);
        return true;
      }
    );
  }
});

test('a server error body overrides the status-derived code and message', async () => {
  const { sync } = client(
    makeResponse({ status: 409, body: { error: { code: 'group_full', message: 'Group is full (16 members)' } } })
  );
  await assert.rejects(
    () => sync.poll(null),
    (err) => err.code === 'group_full' && err.message === 'Group is full (16 members)'
  );
});

test('a { error: "string" } body is treated as a code', async () => {
  const { sync } = client(makeResponse({ status: 400, body: { error: 'bad_seq' } }));
  await assert.rejects(
    () => sync.poll(null),
    (err) => err.code === 'bad_seq' && err.message.length > 0
  );
});

test('non-JSON 2xx bodies reject as bad_response', async () => {
  const { sync } = client(makeResponse({ status: 200, text: '<html>gateway</html>' }));
  await assert.rejects(
    () => sync.poll(null),
    (err) => err.code === 'bad_response'
  );
});

test('a fetch failure rejects as network', async () => {
  const sync = createSync({
    serverUrl: SERVER,
    token: TOKEN,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    () => sync.poll(null),
    (err) => err.code === 'network' && /fetch failed/.test(err.message)
  );
});

test('a hung request aborts and rejects as timeout', async () => {
  let sawAbort = false;
  const sync = createSync({
    serverUrl: SERVER,
    token: TOKEN,
    timeoutMs: 25,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          sawAbort = true;
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  });

  const started = Date.now();
  await assert.rejects(
    () => sync.poll(null),
    (err) => err.code === 'timeout' && err.message.length > 0
  );
  assert.ok(sawAbort, 'the AbortSignal fired');
  assert.ok(Date.now() - started < 2000, 'timeout is honoured promptly');
});

test('the 10s default timeout is used when none is given', () => {
  const sync = createSync({ serverUrl: SERVER, token: TOKEN, fetchImpl: async () => makeResponse({}) });
  assert.strictEqual(sync.timeoutMs, 10000);
});

// ---------------------------------------------------------------------------
// configuration guards
// ---------------------------------------------------------------------------

test('missing or malformed configuration rejects as config without a request', async () => {
  const cases = [
    { serverUrl: '', token: TOKEN },
    { serverUrl: 'not a url', token: TOKEN },
    { serverUrl: 'ftp://example.test', token: TOKEN },
    { serverUrl: SERVER, token: '' },
    { serverUrl: SERVER, token: 'ss_grp1_secret\r\nX-Evil: 1' },
  ];
  for (const testCase of cases) {
    let hits = 0;
    const sync = createSync({
      serverUrl: testCase.serverUrl,
      token: testCase.token,
      fetchImpl: async () => {
        hits += 1;
        return makeResponse({ status: 200, body: GROUP_STATE });
      },
    });
    await assert.rejects(
      () => sync.poll(null),
      (err) => err.code === 'config',
      `expected config error for ${JSON.stringify(testCase)}`
    );
    assert.strictEqual(hits, 0, 'no request is made with bad configuration');
  }
});

test('a trailing slash or path prefix on the server URL is handled', async () => {
  const stub = stubFetch(makeResponse({ status: 200, body: GROUP_STATE }));
  const sync = createSync({
    serverUrl: 'https://sync.example.test/subsplit///',
    token: TOKEN,
    fetchImpl: stub.fetchImpl,
  });
  await sync.poll(null);
  assert.strictEqual(stub.calls[0].url, 'https://sync.example.test/subsplit/v1/state');
});

test('toErrorInfo always produces a { code, message } pair', () => {
  assert.deepStrictEqual(toErrorInfo(null), { code: 'unknown', message: 'Unknown error' });
  const plain = toErrorInfo(new Error('boom'));
  assert.strictEqual(plain.code, 'unknown');
  assert.strictEqual(plain.message, 'boom');
});

// ---------------------------------------------------------------------------
// main-process wiring (src/main/index.js)
//
// index.js is the Electron entry point, so it is loaded here with `electron`
// stubbed and driven through its `__test` seam plus a fake global fetch.
// ---------------------------------------------------------------------------

const ELECTRON_STUB = {
  app: {
    setAppUserModelId() {},
    requestSingleInstanceLock: () => true,
    on() {},
    // Left pending: the Electron-only bootstrap must never run under `node`.
    whenReady: () => new Promise(() => {}),
    quit() {},
    getLoginItemSettings: () => ({}),
    setLoginItemSettings() {},
    isPackaged: false,
  },
  Menu: { buildFromTemplate: () => ({}) },
  ipcMain: { handle() {} },
  Tray: function Tray() {},
  BrowserWindow: function BrowserWindow() {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  screen: {},
};

let mainSeam = null;

function loadMain() {
  if (mainSeam) return mainSeam;
  process.env.SUBSPLIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subsplit-main-'));
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return ELECTRON_STUB;
    return originalLoad.apply(this, arguments);
  };
  try {
    mainSeam = require('../src/main/index.js').__test;
  } finally {
    Module._load = originalLoad;
  }
  return mainSeam;
}

/** Configured-and-idle main process pointed at `serverUrl`. */
function configureMain(main, serverUrl, fetchImpl) {
  if (fetchImpl) globalThis.fetch = fetchImpl;
  main.state.settings = settingsStore.saveSettings({
    memberName: 'Ada',
    memberId: 'ada',
    serverUrl,
    joinToken: TOKEN,
  });
  main.state.windows = { '5h': null, weekly: null };
  Object.assign(main.state, {
    group: null,
    etag: null,
    lastSyncAt: null,
    syncError: null,
    lastPushAt: 0,
    lastPushedKey: null,
    pushInFlight: false,
    pollInFlight: false,
    skipNextPoll: false,
  });
  main.rebuildSyncClient();
}

/** The state part of joinGroup(): a different group, and a new sync client. */
function simulateJoin(main, serverUrl) {
  main.state.settings = settingsStore.saveSettings({ serverUrl });
  main.state.group = null;
  main.state.etag = null;
  main.state.lastPushedKey = null;
  main.state.lastPushAt = 0;
  main.state.syncError = null;
  main.rebuildSyncClient();
}

test('CODEX_HOME splits on the path delimiter, so a comma in a path survives', (t) => {
  const main = loadMain();
  const previous = process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });

  process.env.CODEX_HOME = '/Users/me/Dropbox (Acme, Inc)/.codex';
  assert.deepStrictEqual(main.codexRoots(), [
    path.resolve('/Users/me/Dropbox (Acme, Inc)/.codex'),
  ]);

  process.env.CODEX_HOME = ['/one/.codex', '/two/.codex'].join(path.delimiter);
  assert.deepStrictEqual(main.codexRoots(), [
    path.resolve('/one/.codex'),
    path.resolve('/two/.codex'),
  ]);

  process.env.CODEX_HOME = `${path.delimiter} ${path.delimiter}/three/.codex${path.delimiter}`;
  assert.deepStrictEqual(main.codexRoots(), [path.resolve('/three/.codex')]);

  process.env.CODEX_HOME = '   ';
  assert.deepStrictEqual(main.codexRoots(), [path.join(os.homedir(), '.codex')]);
});

test('a push still in flight to the old server is discarded after a join', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  configureMain(main, 'https://old.example.test', () =>
    held.then(() =>
      makeResponse({ status: 200, body: { accepted: true, clock_skew_ms: 7, state: GROUP_STATE } })
    )
  );

  const pushed = main.maybePush(true);
  simulateJoin(main, 'https://new.example.test');
  release();
  await pushed;

  assert.strictEqual(main.state.group, null, 'the old group state is not applied');
  assert.strictEqual(main.state.etag, null, 'the old etag is not adopted');
  assert.strictEqual(main.state.lastPushedKey, null, 'the new group still needs its first push');
  assert.strictEqual(main.state.skipNextPoll, false, 'the new group is still polled');
  assert.strictEqual(main.state.syncError, null);
  assert.strictEqual(main.state.pushInFlight, false);
});

test('a poll answer from the group we just left is discarded', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  configureMain(main, 'https://old.example.test', () =>
    held.then(() => makeResponse({ status: 200, body: GROUP_STATE, headers: { ETag: 'old-1' } }))
  );

  const polled = main.pollNow(true);
  simulateJoin(main, 'https://new.example.test');
  release();
  await polled;

  assert.strictEqual(main.state.group, null, 'the old group state is not applied');
  assert.strictEqual(main.state.etag, null, 'the old etag is not adopted');
  assert.strictEqual(main.state.lastSyncAt, null, 'the new group has not synced yet');
});

test('a push the server did not accept is reported, not counted as synced', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  let accepted = false;
  configureMain(main, SERVER, async () =>
    makeResponse({ status: 200, body: { accepted, state: GROUP_STATE } })
  );

  await main.maybePush(true);

  assert.strictEqual(main.state.lastPushedKey, null, 'these totals still have to be pushed');
  assert.ok(main.state.syncError, 'a rejected push is not a clean sync');
  assert.strictEqual(main.state.syncError.code, 'not_accepted');
  assert.ok(main.state.syncError.message.length > 0, 'the stall is explained to the user');
  assert.deepStrictEqual(main.state.group, GROUP_STATE, 'the returned state is still authoritative');

  // …and an accepted push clears it again.
  accepted = true;
  await main.maybePush(true);

  assert.strictEqual(main.state.syncError, null);
  assert.ok(main.state.lastPushedKey, 'an accepted push is remembered');
});

test('UiState carries the capacity share, and still never the join token', () => {
  const main = loadMain();
  main.state.group = Object.assign({}, GROUP_STATE, {
    account_rate_limit: {
      ts: 1_700_000_000_000,
      planType: 'plus',
      credits: null,
      windows: [{ windowMinutes: 10080, usedPercent: 50, resetsAt: 1_700_000_600_000 }],
    },
  });

  const ui = main.buildUiState();

  // Ada is the only member, so the whole account gauge is hers.
  assert.strictEqual(ui.capacity.weekly.accountPct, 50);
  assert.strictEqual(ui.capacity.weekly.members.ada, 50);
  assert.strictEqual(ui.capacity['5h'], null, 'no 5h snapshot, no 5h capacity');

  assert.strictEqual(ui.settings.notifyEnabled, true);
  assert.deepStrictEqual(ui.settings.notifyPct, { '5h': null, weekly: null });
  assert.strictEqual(ui.settings.joinToken, undefined, 'the token never reaches the renderer');
  assert.ok(!JSON.stringify(ui).includes(TOKEN));
});

test('joinGroup spends a pending invite, and its token stays out of UiState', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    main.stopTimers();
  });

  const INVITE_SERVER = 'https://invited.example.test';
  const INVITE_TOKEN = 'ss_a1b2c3d4e5_Zm9vYmFyYmF6cXV4MTIzNA';
  const seen = [];

  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (String(url).endsWith('/v1/join')) {
      return makeResponse({
        status: 200,
        body: { group_id: 'a1b2c3d4e5', member_id: 'ada', member_name: 'Ada', poll_interval_s: 60 },
      });
    }
    return makeResponse({ status: 200, body: { accepted: true, state: GROUP_STATE } });
  };

  main.state.pendingInvite = { serverUrl: INVITE_SERVER, joinToken: INVITE_TOKEN };

  // The renderer never had the token, so it submits an empty one.
  await main.joinGroup({ serverUrl: INVITE_SERVER, joinToken: '', memberName: 'Ada' });

  assert.strictEqual(
    seen[0].init.headers.Authorization,
    `Bearer ${INVITE_TOKEN}`,
    'the invite token authenticated the join'
  );
  assert.strictEqual(main.state.settings.joinToken, INVITE_TOKEN, 'and was then persisted');
  assert.strictEqual(main.state.pendingInvite, null, 'a spent invite is not kept around');

  const ui = main.buildUiState();
  assert.ok(!JSON.stringify(ui).includes(INVITE_TOKEN), 'the token never reaches the renderer');
});

test('a pending invite for a different server is not used', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    main.stopTimers();
  });

  const INVITE_TOKEN = 'ss_a1b2c3d4e5_Zm9vYmFyYmF6cXV4MTIzNA';
  main.state.pendingInvite = {
    serverUrl: 'https://invited.example.test',
    joinToken: INVITE_TOKEN,
  };
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return makeResponse({ status: 401, body: {} });
  };

  // Specifically 'config': the join must fail for want of a token, not by being
  // sent to the wrong host and rejected there. Accepting 'unauthorized' too
  // would pass with the serverUrl guard deleted.
  await assert.rejects(
    () => main.joinGroup({ serverUrl: 'https://elsewhere.example.test', joinToken: '', memberName: 'Ada' }),
    (err) => err.code === 'config'
  );
  assert.deepStrictEqual(seen, [], 'no request is made at all, so the token cannot leak');
  assert.ok(main.state.pendingInvite, 'a failed join keeps the invite for a retry');
});

test('a pending invite survives a cosmetic edit to the server URL', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    main.stopTimers();
  });

  const INVITE_TOKEN = 'ss_a1b2c3d4e5_Zm9vYmFyYmF6cXV4MTIzNA';
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (String(url).endsWith('/v1/join')) {
      return makeResponse({
        status: 200,
        body: { group_id: 'a1b2c3d4e5', member_id: 'ada', member_name: 'Ada', poll_interval_s: 60 },
      });
    }
    return makeResponse({ status: 200, body: { accepted: true, state: GROUP_STATE } });
  };

  main.state.pendingInvite = {
    serverUrl: 'https://invited.example.test',
    joinToken: INVITE_TOKEN,
  };

  // Same server, typed with the trailing slash the admin's message had. Every
  // request built from either spelling is byte-identical (joinUrl in sync.js),
  // so the invite must not be dropped over it.
  await main.joinGroup({
    serverUrl: 'https://invited.example.test/',
    joinToken: '',
    memberName: 'Ada',
  });

  assert.strictEqual(seen[0].init.headers.Authorization, `Bearer ${INVITE_TOKEN}`);
  assert.strictEqual(main.state.pendingInvite, null, 'and it is spent');
});
