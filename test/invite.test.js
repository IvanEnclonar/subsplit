'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildInvite, parseInvite, maskToken, PREFIX } = require('../src/main/invite.js');

const SERVER = 'https://subsplit.example.workers.dev';
const TOKEN = 'ss_a1b2c3d4e5_Zm9vYmFyYmF6cXV4MTIzNA';

function blobFor(payload) {
  return PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// round trip
// ---------------------------------------------------------------------------

test('an invite round-trips through build -> parse', () => {
  const invite = buildInvite({ serverUrl: SERVER, joinToken: TOKEN });
  assert.ok(invite.startsWith(PREFIX), 'the version prefix is always present');
  assert.ok(!/[^A-Za-z0-9_-]/.test(invite.slice(PREFIX.length)), 'the blob is chat-safe base64url');

  assert.deepStrictEqual(parseInvite(invite), {
    ok: true,
    serverUrl: SERVER,
    joinToken: TOKEN,
  });
});

test('build trims, and refuses a half-built invite instead of emitting a broken one', () => {
  assert.strictEqual(
    buildInvite({ serverUrl: `  ${SERVER}  `, joinToken: `  ${TOKEN}  ` }),
    buildInvite({ serverUrl: SERVER, joinToken: TOKEN })
  );
  assert.strictEqual(buildInvite({ serverUrl: SERVER, joinToken: '' }), null);
  assert.strictEqual(buildInvite({ serverUrl: '', joinToken: TOKEN }), null);
  assert.strictEqual(buildInvite({ serverUrl: 'ftp://example.test', joinToken: TOKEN }), null);
  assert.strictEqual(buildInvite(null), null);
});

test('the blob is extracted from the chat message around it', () => {
  const invite = buildInvite({ serverUrl: SERVER, joinToken: TOKEN });
  const messages = [
    `hey — here's the invite: ${invite} (paste it into SubSplit)`,
    `${invite}\n\nsent from my phone`,
    `\t${invite}\t`,
  ];
  for (const message of messages) {
    const result = parseInvite(message);
    assert.strictEqual(result.ok, true, message);
    assert.strictEqual(result.joinToken, TOKEN);
    assert.strictEqual(result.serverUrl, SERVER);
  }
});

// ---------------------------------------------------------------------------
// rejections — all friendly, none thrown
// ---------------------------------------------------------------------------

test('anything that is not a well-formed invite is refused with a message', () => {
  const oversizedBlob = PREFIX + 'a'.repeat(2049);
  const cases = {
    'wrong version prefix': `subsplit2-${buildInvite({ serverUrl: SERVER, joinToken: TOKEN }).slice(PREFIX.length)}`,
    'prefix glued to other text': `xsubsplit1-${buildInvite({ serverUrl: SERVER, joinToken: TOKEN }).slice(PREFIX.length)}`,
    'no prefix at all': `${SERVER} ${TOKEN}`,
    'blob over 2KB': oversizedBlob,
    'not JSON': `${PREFIX}${Buffer.from('not json at all', 'utf8').toString('base64url')}`,
    'JSON that is not an object': blobFor(['u', 't']),
    'missing token': blobFor({ u: SERVER }),
    'missing url': blobFor({ t: TOKEN }),
    'url that is not http(s)': blobFor({ u: 'ftp://example.test', t: TOKEN }),
    'url that is not a url': blobFor({ u: 'example dot com', t: TOKEN }),
    'url over 512 chars': blobFor({ u: `https://example.test/${'p'.repeat(512)}`, t: TOKEN }),
    'token failing the server grammar': blobFor({ u: SERVER, t: 'ss_GROUP_secret' }),
    'token secret too short': blobFor({ u: SERVER, t: 'ss_a1b2c3d4e5_short' }),
    'token missing the ss_ prefix': blobFor({ u: SERVER, t: 'xx_a1b2c3d4e5_Zm9vYmFyYmF6cXV4MTIzNA' }),
    'empty string': '',
    'non-string': null,
    'number': 42,
  };

  for (const [label, input] of Object.entries(cases)) {
    const result = parseInvite(input);
    assert.strictEqual(result.ok, false, label);
    assert.strictEqual(typeof result.error, 'string', label);
    assert.ok(result.error.length > 0, label);
    assert.strictEqual(result.joinToken, undefined, label);
  }
});

test('a url carrying credentials is refused, whichever host it really points at', () => {
  // `new URL(...).host` here is evil.example: the trusted-looking half is the
  // *username*, and in a 360px field the "@evil.example" tail sits off-screen.
  const spoofed = 'https://subsplit-prod.acme-eng.workers.dev@evil.example';
  assert.strictEqual(parseInvite(blobFor({ u: spoofed, t: TOKEN })).ok, false);
  assert.strictEqual(parseInvite(blobFor({ u: 'https://user:pw@evil.example', t: TOKEN })).ok, false);
  assert.strictEqual(buildInvite({ serverUrl: spoofed, joinToken: TOKEN }), null);
});

test('the url that comes back is the parsed one, not the raw string', () => {
  // The WHATWG parser drops tab/CR/LF before parsing, so validating the raw
  // string and then returning it hands on something never actually checked —
  // and `<input>` strips those characters again, breaking the server match.
  const smuggled = parseInvite(blobFor({ u: 'https://a.test/\r\nX-Injected: 1', t: TOKEN }));
  assert.strictEqual(smuggled.ok, true);
  assert.ok(!/[\r\n\t]/.test(smuggled.serverUrl), 'control characters never survive');

  // Trailing slashes come off the way sync.js builds request URLs, so one
  // server is always one string.
  assert.strictEqual(parseInvite(blobFor({ u: `${SERVER}/`, t: TOKEN })).serverUrl, SERVER);
  assert.strictEqual(
    buildInvite({ serverUrl: `${SERVER}/`, joinToken: TOKEN }),
    buildInvite({ serverUrl: SERVER, joinToken: TOKEN })
  );
});

test('a payload carrying prototype-pollution keys is rejected outright', () => {
  const polluted = `{"u":${JSON.stringify(SERVER)},"t":${JSON.stringify(TOKEN)},"__proto__":{"polluted":true}}`;
  const result = parseInvite(PREFIX + Buffer.from(polluted, 'utf8').toString('base64url'));

  assert.strictEqual(result.ok, false);
  assert.strictEqual({}.polluted, undefined, 'Object.prototype is untouched');

  const nested = `{"u":${JSON.stringify(SERVER)},"t":${JSON.stringify(TOKEN)},"x":{"constructor":{"prototype":{"bad":1}}}}`;
  assert.strictEqual(parseInvite(PREFIX + Buffer.from(nested, 'utf8').toString('base64url')).ok, false);
});

test('clipboard text is only read 8KB deep', () => {
  const invite = buildInvite({ serverUrl: SERVER, joinToken: TOKEN });
  assert.strictEqual(parseInvite('x'.repeat(8 * 1024 - 1) + ' ' + invite).ok, false);
  assert.strictEqual(parseInvite('x'.repeat(64) + ' ' + invite).ok, true);
});

// ---------------------------------------------------------------------------
// masking
// ---------------------------------------------------------------------------

test('a masked token is recognisable and unusable', () => {
  const masked = maskToken(TOKEN);
  assert.strictEqual(masked, 'ss_a1b2…(hidden)');
  assert.ok(!masked.includes(TOKEN));
  assert.ok(!TOKEN.includes(masked));
  // The secret half never appears in any form.
  assert.ok(!masked.includes('Zm9vYmFy'));
  assert.strictEqual(maskToken(''), '');
  assert.strictEqual(maskToken(null), '');
});
