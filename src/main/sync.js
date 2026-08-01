'use strict';

// Server client: join / push / poll.
//
// - Bearer auth on every call ("ss_<group>_<secret>").
// - 10s timeout, no retries (the caller schedules).
// - Never throws a bare Error: every rejection carries { code, message } so the
//   UI can render it as state.
//
// `fetchImpl` is injectable so this file is unit-testable under plain node.

const DEFAULT_TIMEOUT_MS = 10000;

class SyncError extends Error {
  constructor(code, message, status) {
    super(message || code || 'Sync failed');
    this.name = 'SyncError';
    this.code = typeof code === 'string' && code ? code : 'unknown';
    if (typeof status === 'number') this.status = status;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

/** Normalize anything thrown by this module (or elsewhere) into { code, message }. */
function toErrorInfo(err) {
  if (!err) return { code: 'unknown', message: 'Unknown error' };
  const code = typeof err.code === 'string' && err.code ? err.code : 'unknown';
  const message =
    typeof err.message === 'string' && err.message ? err.message : String(err);
  return { code, message };
}

function codeForStatus(status) {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 429:
      return 'rate_limited';
    default:
      if (status >= 500) return 'server_error';
      return `http_${status}`;
  }
}

function messageForStatus(status) {
  switch (status) {
    case 400:
      return 'The server rejected the request.';
    case 401:
      return 'Join token was not accepted. Check the token and try again.';
    case 403:
      return 'Join token is not allowed to do that.';
    case 404:
      return 'Server did not recognise the address. Check the server URL.';
    case 409:
      return 'The group is full (or that name is already taken).';
    case 413:
      return 'The update was too large for the server.';
    case 429:
      return 'Too many requests — backing off.';
    default:
      if (status >= 500) return `The server had a problem (HTTP ${status}).`;
      return `Unexpected server response (HTTP ${status}).`;
  }
}

/** Pull { code, message } out of whatever error body the server sent. */
function errorFromBody(body, status) {
  let code = null;
  let message = null;
  if (body && typeof body === 'object') {
    const err = body.error;
    if (err && typeof err === 'object') {
      if (typeof err.code === 'string') code = err.code;
      if (typeof err.message === 'string') message = err.message;
    } else if (typeof err === 'string') {
      code = err;
    }
    if (!message && typeof body.message === 'string') message = body.message;
    if (!code && typeof body.code === 'string') code = body.code;
  }
  return new SyncError(code || codeForStatus(status), message || messageForStatus(status), status);
}

function formatTimeout(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
}

function joinUrl(base, pathname) {
  return String(base).replace(/\/+$/, '') + pathname;
}

// Token goes straight into an HTTP header — reject anything that could smuggle
// header separators or non-ASCII bytes before it reaches fetch().
const TOKEN_RE = /^[\x21-\x7e]+$/;

function validateConfig(serverUrl, token) {
  if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
    return new SyncError('config', 'Set a server URL first.');
  }
  let parsed;
  try {
    parsed = new URL(serverUrl.trim());
  } catch (_err) {
    return new SyncError('config', 'That server URL is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new SyncError('config', 'Server URL must start with http:// or https://.');
  }
  if (typeof token !== 'string' || !token.trim()) {
    return new SyncError('config', 'Paste the join token from whoever set up the group.');
  }
  if (!TOKEN_RE.test(token.trim())) {
    return new SyncError('config', 'That join token contains characters it should not.');
  }
  return null;
}

function isAbortError(err) {
  return Boolean(
    err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20)
  );
}

function headerValue(res, name) {
  if (!res || !res.headers || typeof res.headers.get !== 'function') return null;
  try {
    return res.headers.get(name);
  } catch (_err) {
    return null;
  }
}

/**
 * createSync({ serverUrl, token, fetchImpl?, timeoutMs? })
 *   -> { join(memberName), push(payload), poll(etag|null) }
 */
function createSync(options) {
  const opts = options || {};
  const serverUrl = typeof opts.serverUrl === 'string' ? opts.serverUrl.trim() : '';
  const token = typeof opts.token === 'string' ? opts.token.trim() : '';
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl =
    typeof opts.fetchImpl === 'function'
      ? opts.fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;

  async function request(method, pathname, requestOptions) {
    const { body, headers } = requestOptions || {};
    const configError = validateConfig(serverUrl, token);
    if (configError) throw configError;
    if (!fetchImpl) {
      throw new SyncError('config', 'No fetch implementation available in this runtime.');
    }

    const url = joinUrl(serverUrl, pathname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestHeaders = Object.assign(
        {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        body !== undefined ? { 'Content-Type': 'application/json' } : null,
        headers || null
      );

      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw new SyncError(
            'timeout',
            `The server did not answer within ${formatTimeout(timeoutMs)}.`
          );
        }
        throw new SyncError(
          'network',
          `Could not reach the server (${(err && err.message) || 'network error'}).`
        );
      }

      const status = Number(res && res.status);
      if (!Number.isFinite(status)) {
        throw new SyncError('bad_response', 'The server sent a response we could not read.');
      }

      if (status === 304) {
        return { status, body: null, etag: headerValue(res, 'etag') };
      }

      let text = '';
      try {
        text = typeof res.text === 'function' ? await res.text() : '';
      } catch (err) {
        if (isAbortError(err)) {
          throw new SyncError(
            'timeout',
            `The server did not answer within ${formatTimeout(timeoutMs)}.`
          );
        }
        throw new SyncError('network', 'The connection dropped while reading the response.');
      }

      let parsed = null;
      if (text && text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch (_err) {
          parsed = null;
        }
      }

      if (status < 200 || status >= 300) {
        throw errorFromBody(parsed, status);
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new SyncError('bad_response', 'The server sent something that was not JSON.');
      }

      return { status, body: parsed, etag: headerValue(res, 'etag') };
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /v1/join -> { group_id, member_id, member_name, server_time, poll_interval_s } */
  async function join(memberName) {
    const name = typeof memberName === 'string' ? memberName.trim() : '';
    if (!name) throw new SyncError('config', 'Enter the name your group should see.');
    if (name.length > 64) throw new SyncError('config', 'That name is too long (64 characters max).');

    const { body } = await request('POST', '/v1/join', { body: { member_name: name } });
    if (!body || typeof body.member_id !== 'string' || !body.member_id) {
      throw new SyncError('bad_response', 'The server did not return a member id.');
    }
    return body;
  }

  /** PUT /v1/state -> { accepted, clock_skew_ms, state } */
  async function push(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new SyncError('config', 'Nothing to push yet.');
    }
    const { body } = await request('PUT', '/v1/state', { body: payload });
    return {
      accepted: body.accepted === undefined ? true : Boolean(body.accepted),
      clock_skew_ms: typeof body.clock_skew_ms === 'number' ? body.clock_skew_ms : null,
      state: body.state && typeof body.state === 'object' ? body.state : null,
    };
  }

  /** GET /v1/state -> { notModified: true } | { etag, state } */
  async function poll(etag) {
    const headers = {};
    if (typeof etag === 'string' && etag) headers['If-None-Match'] = etag;

    const res = await request('GET', '/v1/state', { headers });
    if (res.status === 304) return { notModified: true };

    let state = res.body && typeof res.body === 'object' ? res.body : null;
    // Tolerate a { state: GroupState } envelope as well as a bare GroupState.
    if (state && !Array.isArray(state.members) && state.state && typeof state.state === 'object') {
      state = state.state;
    }
    if (!state) {
      throw new SyncError('bad_response', 'The server did not return any group state.');
    }
    const nextEtag =
      res.etag || (typeof state.etag === 'string' && state.etag ? state.etag : null);
    return { etag: nextEtag, state };
  }

  return { join, push, poll, serverUrl, timeoutMs };
}

module.exports = {
  createSync,
  SyncError,
  toErrorInfo,
  DEFAULT_TIMEOUT_MS,
};
