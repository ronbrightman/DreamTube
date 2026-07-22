// test/turnstile.test.js
//
// Direct unit coverage for netlify/functions/lib/turnstile.js's verify()
// — the pure Cloudflare siteverify wrapper generate-video.js's E113
// guardrail calls once it has already confirmed TURNSTILE_SECRET_KEY is
// configured. See test/generate-video-turnstile.test.js for coverage of
// this wired into the actual handler (the conditional-on-configuration
// behavior, guardrail placement, etc.) — this file only exercises verify()
// itself in isolation.

var test = require('node:test');
var assert = require('node:assert/strict');

var turnstile = require('../netlify/functions/lib/turnstile');

var realFetch = global.fetch;

test.afterEach(function () {
  global.fetch = realFetch;
});

test('verify(): no token at all -> rejected without ever calling fetch', async function () {
  var called = false;
  global.fetch = async function () { called = true; };
  var result = await turnstile.verify(null, 'secret', '1.2.3.4');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'missing_token');
  assert.equal(called, false);
});

test('verify(): empty-string token -> also rejected without calling fetch', async function () {
  var result = await turnstile.verify('', 'secret', '1.2.3.4');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'missing_token');
});

test('verify(): a real token -> POSTs { secret, response, remoteip } as JSON to Cloudflare\'s siteverify endpoint', async function () {
  var captured = null;
  global.fetch = async function (url, opts) {
    captured = { url: url, method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async function () { return { success: true }; } };
  };
  await turnstile.verify('a-token', 'a-secret', '9.9.9.9');
  assert.equal(captured.url, turnstile.SITEVERIFY_URL);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.deepEqual(captured.body, { secret: 'a-secret', response: 'a-token', remoteip: '9.9.9.9' });
});

test('verify(): Cloudflare responds { success: true } -> resolved success, reason null', async function () {
  global.fetch = async function () { return { ok: true, status: 200, json: async function () { return { success: true }; } }; };
  var result = await turnstile.verify('good-token', 'secret');
  assert.equal(result.success, true);
  assert.equal(result.reason, null);
});

test('verify(): Cloudflare responds { success: false, "error-codes": [...] } -> rejected with the first error code as reason', async function () {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { success: false, 'error-codes': ['timeout-or-duplicate', 'other-code'] }; } };
  };
  var result = await turnstile.verify('expired-token', 'secret');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'timeout-or-duplicate');
});

test('verify(): Cloudflare responds { success: false } with no error-codes array -> falls back to a generic reason', async function () {
  global.fetch = async function () { return { ok: true, status: 200, json: async function () { return { success: false }; } }; };
  var result = await turnstile.verify('bad-token', 'secret');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'verification_failed');
});

test('verify(): a non-2xx HTTP response from Cloudflare -> rejected, not a thrown error', async function () {
  global.fetch = async function () { return { ok: false, status: 500, json: async function () { return {}; } }; };
  var result = await turnstile.verify('token', 'secret');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'verification_failed');
});

test('verify(): fetch throws (network failure reaching Cloudflare) -> rejected, not a thrown error, reason carries the message', async function () {
  global.fetch = async function () { throw new Error('getaddrinfo ENOTFOUND'); };
  var result = await turnstile.verify('token', 'secret');
  assert.equal(result.success, false);
  assert.match(result.reason, /^network_error: getaddrinfo ENOTFOUND$/);
});

test('verify(): response.json() itself throws (malformed body) -> treated as a failed verification, not a thrown error', async function () {
  global.fetch = async function () { return { ok: true, status: 200, json: async function () { throw new Error('bad json'); } }; };
  var result = await turnstile.verify('token', 'secret');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'verification_failed');
});
