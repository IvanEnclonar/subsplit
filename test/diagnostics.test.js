'use strict';

/**
 * Diagnostics: the unauthenticated health probe (src/main/sync.js) and the
 * folder-opening IPC (src/main/index.js).
 *
 * The load-bearing assertion in here is the negative one: /v1/health must go
 * out with NO Authorization header. It is the one route the server answers
 * without a token, "Test connection" is the button people mash at a URL they
 * typed wrong, and a probe that carried the group secret would put it on the
 * wire (and in a stranger's proxy log) every time.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { checkHealth, HEALTH_TIMEOUT_MS } = require('../src/main/sync.js');

const SERVER = 'https://sync.example.test';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeResponse(options) {
  const opts = options || {};
  const status = opts.status === undefined ? 200 : opts.status;
  const text =
    opts.text !== undefined
      ? opts.text
      : opts.body === undefined || opts.body === null
        ? ''
        : JSON.stringify(opts.body);
  return {
    status,
    headers: { get: () => null },
    async text() {
      return text;
    },
  };
}

/** Every header name a request went out with, lowercased. */
function headerNames(init) {
  return Object.keys((init && init.headers) || {}).map((k) => k.toLowerCase());
}

// ---------------------------------------------------------------------------
// health: the no-auth contract
// ---------------------------------------------------------------------------

test('checkHealth GETs /v1/health with no Authorization header at all', async () => {
  const calls = [];
  const result = await checkHealth({
    serverUrl: SERVER,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse({ status: 200, body: { ok: true, server_time: 1, server_version: '1' } });
    },
  });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, `${SERVER}/v1/health`);
  assert.strictEqual(calls[0].init.method, 'GET');
  assert.deepStrictEqual(headerNames(calls[0].init), ['accept'], 'accept, and nothing else');
  assert.strictEqual(calls[0].init.headers.Authorization, undefined);
  assert.ok(!JSON.stringify(calls[0].init).toLowerCase().includes('bearer'));
  assert.strictEqual(calls[0].init.body, undefined);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.version, '1');
  assert.strictEqual(result.error, null);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
});

test('checkHealth takes no token, so none can reach the wire', async () => {
  const TOKEN = 'ss_grp1_s3cretsecretsecret';
  const calls = [];
  // Passed anyway, the way a careless caller would.
  await checkHealth({
    serverUrl: SERVER,
    token: TOKEN,
    joinToken: TOKEN,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse({ status: 200, body: { ok: true } });
    },
  });

  const sent = JSON.stringify({ url: calls[0].url, init: calls[0].init });
  assert.ok(!sent.includes(TOKEN), 'no fragment of a token appears in the request');
});

test('checkHealth reports the server version, and tolerates its absence', async () => {
  const withVersion = await checkHealth({
    serverUrl: SERVER,
    fetchImpl: async () => makeResponse({ status: 200, body: { ok: true, server_version: '7' } }),
  });
  assert.strictEqual(withVersion.version, '7');

  const without = await checkHealth({
    serverUrl: SERVER,
    fetchImpl: async () => makeResponse({ status: 200, body: { ok: true } }),
  });
  assert.strictEqual(without.ok, true);
  assert.strictEqual(without.version, null);

  const numeric = await checkHealth({
    serverUrl: SERVER,
    fetchImpl: async () => makeResponse({ status: 200, body: { ok: true, server_version: 2 } }),
  });
  assert.strictEqual(numeric.version, '2');
});

// ---------------------------------------------------------------------------
// health: failure is a value, never a throw
// ---------------------------------------------------------------------------

test('a hung health check times out into { ok: false } instead of throwing', async () => {
  let sawAbort = false;
  const started = Date.now();
  const result = await checkHealth({
    serverUrl: SERVER,
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

  assert.ok(sawAbort, 'the AbortSignal fired');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'timeout');
  assert.ok(result.error.message.length > 0);
  assert.strictEqual(result.version, null);
  assert.ok(Number.isFinite(result.latencyMs), 'a failed probe still reports how long it waited');
  assert.ok(Date.now() - started < 2000);
});

test('the health probe gives up in 5s by default', () => {
  assert.strictEqual(HEALTH_TIMEOUT_MS, 5000);
});

test('network, non-2xx and unreadable answers all resolve to { ok: false }', async () => {
  const cases = [
    {
      name: 'connection refused',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      code: 'network',
    },
    {
      name: 'not a SubSplit server',
      fetchImpl: async () => makeResponse({ status: 404, text: '<html>nope</html>' }),
      code: 'not_found',
    },
    {
      name: 'server on fire',
      fetchImpl: async () => makeResponse({ status: 503, body: {} }),
      code: 'server_error',
    },
    {
      name: 'reachable but unhealthy',
      fetchImpl: async () => makeResponse({ status: 200, body: { ok: false } }),
      code: 'unhealthy',
    },
  ];

  for (const testCase of cases) {
    const result = await checkHealth({ serverUrl: SERVER, fetchImpl: testCase.fetchImpl });
    assert.strictEqual(result.ok, false, testCase.name);
    assert.strictEqual(result.error.code, testCase.code, testCase.name);
    assert.ok(result.error.message.length > 0, testCase.name);
  }
});

test('a 2xx that is not a SubSplit answer is a failure, not "Reachable"', async () => {
  // Captive portals, parked domains and SPA catch-alls all answer 200 with
  // something that is not this app. Only { ok: true } counts as reachable.
  const cases = [
    { name: 'captive portal HTML', text: '<!doctype html><html><body>Sign in</body></html>' },
    { name: 'empty body', text: '' },
    { name: 'whitespace body', text: '   \n ' },
    { name: 'unrelated JSON object', body: { status: 'up', service: 'nginx' } },
    { name: 'JSON array', body: [{ ok: true }] },
    { name: 'JSON string', text: '"ok"' },
    { name: 'JSON null', text: 'null' },
    { name: 'ok is truthy but not true', body: { ok: 1 } },
    { name: 'ok is a string', body: { ok: 'true' } },
  ];

  for (const testCase of cases) {
    const result = await checkHealth({
      serverUrl: SERVER,
      fetchImpl: async () =>
        makeResponse({ status: 200, text: testCase.text, body: testCase.body }),
    });
    assert.strictEqual(result.ok, false, testCase.name);
    assert.strictEqual(result.error.code, 'bad_response', testCase.name);
    assert.match(result.error.message, /SubSplit server/, testCase.name);
    assert.strictEqual(result.version, null, testCase.name);
  }

  // …and the real thing still passes.
  const good = await checkHealth({
    serverUrl: SERVER,
    fetchImpl: async () =>
      makeResponse({
        status: 200,
        body: { ok: true, server_time: 1770000000000, server_version: '0.4.1' },
      }),
  });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.version, '0.4.1');
  assert.strictEqual(good.error, null);
});

test('an explicit { ok: false } is still "unhealthy", not "bad_response"', async () => {
  const result = await checkHealth({
    serverUrl: SERVER,
    fetchImpl: async () => makeResponse({ status: 200, body: { ok: false, server_version: '1' } }),
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'unhealthy');
});

test('a health check with no server URL never touches the network', async () => {
  let hits = 0;
  for (const serverUrl of ['', '   ', 'not a url', 'ftp://example.test']) {
    const result = await checkHealth({
      serverUrl,
      fetchImpl: async () => {
        hits += 1;
        return makeResponse({ status: 200, body: { ok: true } });
      },
    });
    assert.strictEqual(result.ok, false, serverUrl);
    assert.strictEqual(result.error.code, 'config', serverUrl);
  }
  assert.strictEqual(hits, 0);
});

test('a trailing slash on the server URL still finds /v1/health', async () => {
  const calls = [];
  await checkHealth({
    serverUrl: 'https://sync.example.test/subsplit///',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return makeResponse({ status: 200, body: { ok: true } });
    },
  });
  assert.strictEqual(calls[0].url, 'https://sync.example.test/subsplit/v1/health');
});

// ---------------------------------------------------------------------------
// main-process wiring: the folder-opening IPC
//
// index.js is the Electron entry point, so it is loaded with `electron` stubbed
// and driven through its `__test` seam.
// ---------------------------------------------------------------------------

const opened = [];
let openPathResult = '';

const ELECTRON_STUB = {
  app: {
    setAppUserModelId() {},
    requestSingleInstanceLock: () => true,
    on() {},
    whenReady: () => new Promise(() => {}),
    quit() {},
    getLoginItemSettings: () => ({ status: 'enabled' }),
    setLoginItemSettings() {},
    isPackaged: false,
  },
  Menu: { buildFromTemplate: () => ({}) },
  ipcMain: { handle() {} },
  Tray: function Tray() {},
  BrowserWindow: function BrowserWindow() {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  screen: {},
  shell: {
    async openPath(target) {
      opened.push(target);
      return openPathResult;
    },
  },
};

let mainSeam = null;
let dataDir = null;

function loadMain() {
  if (mainSeam) return mainSeam;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subsplit-diag-'));
  process.env.SUBSPLIT_DATA_DIR = dataDir;
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

test('an out-of-range (or non-index) open request opens nothing', async () => {
  const main = loadMain();
  main.state.roots = ['/one/.codex', '/two/.codex'];
  opened.length = 0;

  const rejected = [
    2,           // one past the end
    99,
    -1,
    1.5,
    NaN,
    Infinity,
    null,
    undefined,
    '0',                    // the index as a string is not an index
    '/etc/passwd',          // …and a path is never accepted
    '~/.codex/auth.json',
    'app-data ',            // not the enum
    { index: 0 },
    ['0'],
  ];

  for (const target of rejected) {
    const result = await main.openDiagnosticsTarget(target);
    assert.strictEqual(result.ok, false, `target ${JSON.stringify(target)} must be refused`);
    assert.ok(result.error.length > 0);
  }
  assert.deepStrictEqual(opened, [], 'nothing reached shell.openPath');
});

test('an in-range index and the app-data enum open the folder main resolved', async () => {
  const main = loadMain();
  main.state.roots = ['/one/.codex', '/two/.codex'];
  opened.length = 0;

  assert.deepStrictEqual(await main.openDiagnosticsTarget(0), { ok: true });
  assert.deepStrictEqual(await main.openDiagnosticsTarget(1), { ok: true });
  assert.deepStrictEqual(await main.openDiagnosticsTarget('app-data'), { ok: true });

  assert.deepStrictEqual(opened.slice(0, 2), ['/one/.codex', '/two/.codex']);
  assert.strictEqual(opened[2], dataDir, 'the app data folder comes from settings.js, not the renderer');
});

test('a folder the OS refuses to open is reported, not thrown', async (t) => {
  const main = loadMain();
  main.state.roots = ['/one/.codex'];
  openPathResult = 'no such file or directory';
  t.after(() => {
    openPathResult = '';
  });

  const result = await main.openDiagnosticsTarget(0);
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.length > 0);
});

test('describeRoots reports existence per root, and buildUiState carries it', () => {
  const main = loadMain();
  const real = path.join(__dirname, 'fixtures', 'codex-home');
  main.state.roots = [real, path.join(os.tmpdir(), 'subsplit-not-here-4f2b')];

  assert.deepStrictEqual(main.describeRoots(), [
    { path: real, exists: true },
    { path: path.join(os.tmpdir(), 'subsplit-not-here-4f2b'), exists: false },
  ]);

  const ui = main.buildUiState();
  assert.deepStrictEqual(ui.local.roots, main.describeRoots());
  assert.strictEqual(ui.local.appDataPath, dataDir);
});

test('runHealthCheck stores an unauthenticated result and keeps it out of settings', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const TOKEN = 'ss_a1b2c3d4e5_Zm9vYmFyYmF6cXV4MTIzNA';
  main.state.settings.serverUrl = SERVER;
  main.state.settings.joinToken = TOKEN;

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return makeResponse({ status: 200, body: { ok: true, server_time: 1, server_version: '1' } });
  };

  const health = await main.runHealthCheck();

  assert.strictEqual(calls[0].url, `${SERVER}/v1/health`);
  assert.strictEqual(calls[0].init.headers.Authorization, undefined);
  assert.ok(!JSON.stringify(calls[0]).includes(TOKEN), 'the token is not in the health request');

  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.version, '1');
  assert.ok(Number.isFinite(health.checkedAt));

  const ui = main.buildUiState();
  assert.deepStrictEqual(ui.sync.health, health);
  assert.ok(!JSON.stringify(ui).includes(TOKEN), 'and not in the UiState that carries the result');
});

test('runHealthCheck probes the URL the renderer sent, not the saved one', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  main.state.settings.serverUrl = SERVER;
  const typed = 'https://typo.example.test/subsplit/';

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return makeResponse({ status: 200, body: { ok: true, server_version: '9' } });
  };

  const health = await main.runHealthCheck(`  ${typed}  `);

  assert.strictEqual(calls[0].url, 'https://typo.example.test/subsplit/v1/health');
  assert.strictEqual(health.ok, true);
  // The typed string is a probe target and nothing else.
  assert.strictEqual(main.state.settings.serverUrl, SERVER, 'it is not saved as a setting');
  assert.strictEqual(calls[0].init.headers.Authorization, undefined);
});

test('an absent (or non-string) renderer URL falls back to the stored one', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  main.state.settings.serverUrl = SERVER;

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return makeResponse({ status: 200, body: { ok: true } });
  };

  const absent = [undefined, null, '', '   ', 42, { serverUrl: 'https://evil.test' }, ['https://evil.test']];

  for (const value of absent) {
    const health = await main.runHealthCheck(value);
    assert.strictEqual(health.ok, true, JSON.stringify(value) || 'undefined');
  }

  assert.strictEqual(calls.length, absent.length);
  for (const url of calls) {
    assert.strictEqual(url, `${SERVER}/v1/health`, 'every fallback probe hit the stored URL');
  }
});

test('a typed URL that is not a URL is reported as typed, not silently swapped', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  // The stored server is healthy and would answer "Reachable" — which is exactly
  // the answer the user must NOT get about a URL they typed wrong.
  main.state.settings.serverUrl = SERVER;
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    return makeResponse({ status: 200, body: { ok: true } });
  };

  const malformed = [
    'not a url',
    'sync.example.test',                     // no scheme
    'ftp://example.test',
    'file:///etc/passwd',
    'javascript:fetch("https://evil.test")',
  ];

  for (const value of malformed) {
    const health = await main.runHealthCheck(value);
    assert.strictEqual(health.ok, false, value);
    assert.strictEqual(health.error.code, 'config', value);
    assert.ok(health.error.message.length > 0, value);
    assert.strictEqual(health.version, null, value);
    assert.ok(Number.isFinite(health.checkedAt), value);
    // …and it is the answer the panel shows.
    assert.deepStrictEqual(main.buildUiState().sync.health, health, value);
  }

  assert.strictEqual(hits, 0, 'a URL that does not parse never becomes a request');
  assert.strictEqual(main.state.settings.serverUrl, SERVER, 'and is not saved anywhere');
});

test('a failed health check lands in UiState as { ok: false } with a reason', async (t) => {
  const main = loadMain();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  main.state.settings.serverUrl = SERVER;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  const health = await main.runHealthCheck();
  assert.strictEqual(health.ok, false);
  assert.strictEqual(health.error.code, 'network');
  assert.strictEqual(main.buildUiState().sync.health.ok, false);
});

// ---------------------------------------------------------------------------
// preload: the health channel carries the typed URL, and only a string
// ---------------------------------------------------------------------------

const preloadInvokes = [];

function loadPreload() {
  const exposed = {};
  const stub = {
    contextBridge: {
      exposeInMainWorld(key, value) {
        exposed[key] = value;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        preloadInvokes.push({ channel, args });
        return Promise.resolve(null);
      },
      on() {},
      removeListener() {},
    },
  };
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return stub;
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve('../src/preload/preload.js')];
    require('../src/preload/preload.js');
  } finally {
    Module._load = originalLoad;
  }
  return exposed.subsplit;
}

test('testConnection forwards the Server URL field on diag:health, as a string', async () => {
  const api = loadPreload();
  preloadInvokes.length = 0;

  await api.testConnection('https://typed.example.test');
  assert.deepStrictEqual(preloadInvokes[0], {
    channel: 'diag:health',
    args: ['https://typed.example.test'],
  });

  // Anything that is not a string becomes '' — main then uses the stored URL.
  for (const value of [undefined, null, 42, {}, ['https://evil.test']]) {
    preloadInvokes.length = 0;
    await api.testConnection(value);
    assert.deepStrictEqual(preloadInvokes[0].args, [''], JSON.stringify(value) || 'undefined');
  }
});

// ---------------------------------------------------------------------------
// the disabled state of the probe button is visible (it lasts up to 5s)
// ---------------------------------------------------------------------------

test('a disabled .btn is dimmed and does not repaint on hover', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');
  assert.match(css, /\.btn\[disabled\]\s*\{[^}]*opacity/, 'a generic .btn[disabled] rule exists');
  assert.match(
    css,
    /\.btn-ghost\[disabled\]:hover\s*\{[^}]*background/,
    'and the ghost hover repaint is cancelled while disabled'
  );
});
