'use strict';

// One-paste invites.
//
//   subsplit1-<base64url(JSON)>      JSON = { u: serverUrl, t: joinToken }
//
// The main process owns both ends: it builds the blob from its own settings and
// parses one out of the clipboard, so the join token never has to be read out
// loud, retyped, or handed to the renderer.
//
// Pure — no Electron, no I/O, never throws.

const PREFIX = 'subsplit1-';

/** Clipboard text is read this far and no further. */
const MAX_TEXT_CHARS = 8 * 1024;
const MAX_BLOB_CHARS = 2 * 1024;
const MAX_URL_CHARS = 512;

/** The join-token grammar the server enforces (parseBearer in server/core.js). */
const TOKEN_RE = /^ss_[a-z0-9]{4,32}_[A-Za-z0-9_-]{16,128}$/;

// The blob usually arrives embedded in chat text. The lookbehind keeps
// `xsubsplit1-…` (and any other prefix) from matching.
const BLOB_RE = /(?<![A-Za-z0-9_-])subsplit1-([A-Za-z0-9_-]+)/;

const NOT_FOUND =
  'No SubSplit invite on the clipboard — copy the whole code your admin sent you, then try again.';
const BAD_INVITE =
  'That doesn’t look like a SubSplit invite. Ask your group admin for a fresh one.';

function failure(message) {
  return { ok: false, error: message };
}

/**
 * The server URL an invite may carry, re-derived from the parsed URL so that the
 * string that gets validated is the string that gets used. null when it is not
 * one we will talk to. Trailing slashes come off the way sync.js builds request
 * URLs (`joinUrl`), so the same server is always the same string.
 */
function canonicalServerUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_CHARS) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (_err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.host) return null;
  // Credentials in the authority hide the real host behind a trusted-looking
  // name — `https://our-server.example@evil.example` connects to evil.example
  // while reading as ours in a 360px-wide field. Never legitimate here.
  if (url.username || url.password) return null;
  const href = url.href.replace(/\/+$/, '');
  return href.length <= MAX_URL_CHARS ? href : null;
}

/**
 * JSON.parse that refuses anything carrying a prototype-pollution key rather
 * than quietly dropping it — an invite that tries is not an invite we want.
 */
function parseJsonStrict(text) {
  let poisoned = false;
  let value;
  try {
    value = JSON.parse(text, function reviver(key, val) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        poisoned = true;
        return undefined;
      }
      return val;
    });
  } catch (_err) {
    return null;
  }
  if (poisoned) return null;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * buildInvite({ serverUrl, joinToken }) -> string | null
 * null when either half is missing or malformed — a broken invite is worse
 * than no invite.
 */
function buildInvite(input) {
  const opts = input && typeof input === 'object' ? input : {};
  const serverUrl = canonicalServerUrl(opts.serverUrl);
  const joinToken = typeof opts.joinToken === 'string' ? opts.joinToken.trim() : '';
  if (!serverUrl || !TOKEN_RE.test(joinToken)) return null;
  const json = JSON.stringify({ u: serverUrl, t: joinToken });
  return PREFIX + Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * parseInvite(text) ->
 *   { ok: true, serverUrl, joinToken } | { ok: false, error: string }
 * `text` may be a whole chat message; the blob is extracted from it.
 */
function parseInvite(text) {
  if (typeof text !== 'string' || !text) return failure(NOT_FOUND);

  const match = BLOB_RE.exec(text.slice(0, MAX_TEXT_CHARS));
  if (!match) return failure(NOT_FOUND);

  const blob = match[1];
  if (blob.length > MAX_BLOB_CHARS) return failure(BAD_INVITE);

  let json;
  try {
    json = Buffer.from(blob, 'base64url').toString('utf8');
  } catch (_err) {
    return failure(BAD_INVITE);
  }

  const payload = parseJsonStrict(json);
  if (!payload) return failure(BAD_INVITE);

  const serverUrl = canonicalServerUrl(payload.u);
  const joinToken = typeof payload.t === 'string' ? payload.t.trim() : '';
  if (!serverUrl) return failure(BAD_INVITE);
  if (!TOKEN_RE.test(joinToken)) return failure(BAD_INVITE);

  return { ok: true, serverUrl, joinToken };
}

/** "ss_ab12…(hidden)" — enough to recognise, never enough to use. */
function maskToken(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) return '';
  return `${value.slice(0, 7)}…(hidden)`;
}

module.exports = {
  PREFIX,
  MAX_TEXT_CHARS,
  MAX_BLOB_CHARS,
  MAX_URL_CHARS,
  TOKEN_RE,
  canonicalServerUrl,
  buildInvite,
  parseInvite,
  maskToken,
};
