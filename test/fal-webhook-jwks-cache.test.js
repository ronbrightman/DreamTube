// test/fal-webhook-jwks-cache.test.js
//
// Direct unit coverage for netlify/functions/lib/fal-webhook-verify.js's
// fetchJwks() caching layer specifically (JWKS_CACHE_TTL_MS, the
// stale-fallback-on-fetch-failure behavior) — this was a non-blocking
// finding from dream-builder-wizard's round-2 review: the cache + fallback
// were added to fix a round-1 finding, but nothing asserted a second call
// within the TTL skips re-fetching, or that a fetch failure with a stale
// cache still serves that cache rather than throwing.
// test/dream-webhook.test.js covers verifySignature() and the webhook
// handler end to end (with fetchJwks monkeypatched generically per test),
// but never exercises fetchJwks()'s own caching contract in isolation —
// this file fills exactly that gap.

var test = require('node:test');
var assert = require('node:assert/strict');

var falWebhookVerify = require('../netlify/functions/lib/fal-webhook-verify');

var realFetch = global.fetch;
var realDateNow = Date.now;

test.beforeEach(function () {
  falWebhookVerify.resetJwksCacheForTests();
});

test.after(function () {
  global.fetch = realFetch;
  Date.now = realDateNow;
});

function mockFetchJwks(keysByCall) {
  var calls = 0;
  global.fetch = async function () {
    var keys = keysByCall[Math.min(calls, keysByCall.length - 1)];
    calls++;
    if (keys === 'FAIL') {
      throw new Error('network down');
    }
    return { ok: true, status: 200, json: async function () { return { keys: keys }; } };
  };
  return function callCount() { return calls; };
}

test('fetchJwks: a second call within the TTL serves the cached copy — no second network fetch', async function () {
  var callCount = mockFetchJwks([[{ kty: 'OKP', crv: 'Ed25519', x: 'key-a' }]]);

  var first = await falWebhookVerify.fetchJwks();
  var second = await falWebhookVerify.fetchJwks();

  assert.equal(callCount(), 1, 'only the FIRST call should have hit the network — the second must be served from cache');
  assert.deepEqual(first, [{ kty: 'OKP', crv: 'Ed25519', x: 'key-a' }]);
  assert.deepEqual(second, first, 'the cached call must return the identical key set');
});

test('fetchJwks: once the TTL has elapsed, the next call fetches fresh (picks up a real key rotation)', async function () {
  var callCount = mockFetchJwks([
    [{ kty: 'OKP', crv: 'Ed25519', x: 'key-old' }],
    [{ kty: 'OKP', crv: 'Ed25519', x: 'key-new' }]
  ]);

  var base = realDateNow();
  Date.now = function () { return base; };
  var first = await falWebhookVerify.fetchJwks();

  // Past JWKS_CACHE_TTL_MS (10 minutes) -- module doesn't export the
  // constant, so this uses a value well past any reasonable TTL rather
  // than depending on the exact number.
  Date.now = function () { return base + 11 * 60 * 1000; };
  var second = await falWebhookVerify.fetchJwks();

  assert.equal(callCount(), 2, 'the TTL expiring must trigger a real second fetch, not keep serving the first cache forever');
  assert.deepEqual(first, [{ kty: 'OKP', crv: 'Ed25519', x: 'key-old' }]);
  assert.deepEqual(second, [{ kty: 'OKP', crv: 'Ed25519', x: 'key-new' }], 'a real key rotation must actually be picked up once the TTL elapses');
});

test('fetchJwks: a refetch failure after the TTL has elapsed still serves the stale cached keys, rather than throwing', async function () {
  var callCount = mockFetchJwks([
    [{ kty: 'OKP', crv: 'Ed25519', x: 'key-good' }],
    'FAIL'
  ]);

  var base = realDateNow();
  Date.now = function () { return base; };
  var first = await falWebhookVerify.fetchJwks();

  Date.now = function () { return base + 11 * 60 * 1000; };
  var second = await falWebhookVerify.fetchJwks();

  assert.equal(callCount(), 2, 'the stale-past-TTL cache must still trigger a real refetch attempt, not just skip it');
  assert.deepEqual(first, [{ kty: 'OKP', crv: 'Ed25519', x: 'key-good' }]);
  assert.deepEqual(second, first, 'a failed refetch must fall back to the last-known-good (even if stale) keys instead of throwing, so a transient fal JWKS outage does not permanently break webhook verification for an in-flight retry');
});

test('fetchJwks: with NOTHING cached yet, a fetch failure genuinely throws (there is no fallback to give)', async function () {
  mockFetchJwks(['FAIL']);
  await assert.rejects(function () { return falWebhookVerify.fetchJwks(); }, /network down/, 'a cold start with no prior successful fetch has no stale cache to fall back to, so this must surface as a real error');
});
