// test/generate-video-turnstile.test.js
//
// Covers netlify/functions/generate-video.js's E113 Cloudflare Turnstile
// guardrail (see that file's error-code doc block and
// docs/TURNSTILE_SETUP.md): fully inert when TURNSTILE_SECRET_KEY is
// unset/placeholder (existing generation behavior, unmodified), and — once
// configured — rejects a missing token or a token Cloudflare's siteverify
// says is invalid, while a token that passes verification lets generation
// proceed normally through to a real 200. The outbound siteverify HTTP
// call is mocked via a URL-routing global.fetch stub (same pattern
// test/generate-video-mock.test.js and test/meta-capi.test.js already use
// for spying on/stubbing outbound calls), since a single fixed-response
// stub can't distinguish the siteverify call from the fal.ai call that
// follows it once verification passes.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var handler = require('../netlify/functions/generate-video').handler;

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.5.0.' + ipCounter;
}

// This suite is about the Turnstile gate, not the token economy — every
// event defaults to a well-funded email so E112 never interferes.
var DEFAULT_EMAIL = 'turnstileuser@example.com';

function genEvent(overrides) {
  return fakeEvent({
    method: 'POST',
    ip: (overrides && overrides.ip) || nextIp(),
    body: Object.assign({ caption: 'a dream about flying', style: 'Cartoon', email: DEFAULT_EMAIL }, overrides && overrides.body)
  });
}

/**
 * Routes global.fetch by URL: Cloudflare's siteverify endpoint gets
 * `siteverifyResponse` (default: success), and everything else (fal.ai)
 * gets a plain successful submission response — so a test can exercise
 * "token passes verification -> generation proceeds" without the fal.ai
 * call itself getting in the way, and vice versa.
 */
function installRoutedFetch(siteverifyResponse) {
  var calls = { siteverify: [], fal: [] };
  global.fetch = async function (url, opts) {
    var body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (typeof url === 'string' && url.indexOf('challenges.cloudflare.com') !== -1) {
      calls.siteverify.push({ url: url, body: body });
      return {
        ok: true,
        status: 200,
        json: async function () { return siteverifyResponse !== undefined ? siteverifyResponse : { success: true }; }
      };
    }
    calls.fal.push({ url: url, body: body });
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
  return calls;
}

test.beforeEach(async function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
  delete process.env.GENERATION_MOCK_MODE;
  await entitlements.setEntitlement({}, DEFAULT_EMAIL, { tokens: { balance: 100000, lastGrantAt: Date.now() } });
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- Fully inert when TURNSTILE_SECRET_KEY is unset/placeholder -----

test('TURNSTILE_SECRET_KEY unset: no siteverify call is ever made, generation proceeds normally with no turnstileToken at all', async function () {
  var calls = installRoutedFetch();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.siteverify.length, 0, 'siteverify must never be called when the guardrail is inert');
  assert.equal(calls.fal.length, 1);
});

test('TURNSTILE_SECRET_KEY set to the literal placeholder string: also treated as unset, no siteverify call', async function () {
  process.env.TURNSTILE_SECRET_KEY = 'REPLACE_WITH_REAL_TURNSTILE_SECRET_KEY';
  var calls = installRoutedFetch();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.siteverify.length, 0);
});

test('TURNSTILE_SECRET_KEY unset: a request that HAS a turnstileToken anyway still succeeds without it ever being checked', async function () {
  var calls = installRoutedFetch();
  var res = await handler(genEvent({ body: { turnstileToken: 'some-token-nobody-verifies' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.siteverify.length, 0);
});

// ----- Missing token, secret key configured -----

test('secret key configured + no turnstileToken in the request -> E113, fal never called', async function () {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  var calls = installRoutedFetch();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /^E113: turnstile_verification_failed: missing_token/);
  assert.equal(calls.fal.length, 0, 'a rejected Turnstile check must never reach fal.ai');
  assert.equal(calls.siteverify.length, 0, 'a missing token is rejected client-side in lib/turnstile.js, no need to call Cloudflare at all');
});

test('secret key configured + empty-string turnstileToken -> also E113 missing_token', async function () {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  var res = await handler(genEvent({ body: { turnstileToken: '' } }));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /^E113: turnstile_verification_failed: missing_token/);
});

// ----- Token fails Cloudflare's verification -----

test('secret key configured + a token Cloudflare rejects -> E113 with the reason, fal never called', async function () {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  var calls = installRoutedFetch({ success: false, 'error-codes': ['invalid-input-response'] });
  var res = await handler(genEvent({ body: { turnstileToken: 'bad-token' } }));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /^E113: turnstile_verification_failed: invalid-input-response/);
  assert.equal(calls.siteverify.length, 1);
  assert.equal(calls.siteverify[0].body.response, 'bad-token');
  assert.equal(calls.siteverify[0].body.secret, 'test-secret-key');
  assert.equal(calls.fal.length, 0);
});

test('secret key configured + siteverify unreachable (network failure) -> E113, fal never called', async function () {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  global.fetch = async function (url) {
    if (typeof url === 'string' && url.indexOf('challenges.cloudflare.com') !== -1) {
      throw new Error('network down');
    }
    return { ok: true, status: 200, json: async function () { return { request_id: 'x' }; } };
  };
  var res = await handler(genEvent({ body: { turnstileToken: 'some-token' } }));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /^E113: turnstile_verification_failed: network_error/);
});

// ----- Token passes verification -----

test('secret key configured + a token Cloudflare accepts -> generation proceeds normally to a 200', async function () {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  var calls = installRoutedFetch({ success: true });
  var res = await handler(genEvent({ body: { turnstileToken: 'good-token' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.siteverify.length, 1);
  assert.equal(calls.fal.length, 1, 'a passed Turnstile check must still proceed through to the real fal.ai call');
});

test('secret key configured + a valid token: tokens are still spent normally (E113 sits alongside E112, not instead of it)', async function () {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  installRoutedFetch({ success: true });
  await entitlements.setEntitlement({}, 'turnstilespend@example.com', { tokens: { balance: 300, lastGrantAt: Date.now() } });
  var res = await handler(genEvent({ body: { email: 'turnstilespend@example.com', turnstileToken: 'good-token' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'turnstilespend@example.com');
  assert.equal(record.tokens.balance, 200);
});

// ----- Placement relative to the other guardrails -----

test('E113 runs before E109/E112/E110 are consumed: a Turnstile rejection leaves the rate-limit counter untouched', async function () {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  var ip = nextIp();
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 403);

  var rateLimit = require('../netlify/functions/lib/rate-limit');
  var todayUtc = new Date().toISOString().slice(0, 10);
  // If E113 had consumed the rate-limit budget, a second identical request
  // would already show count=2 after only one prior real attempt; instead
  // the very first checkAndIncrement call here should still see count=0->1,
  // proving the earlier E113-rejected request never incremented it.
  var check = await rateLimit.checkAndIncrement({}, 'ip', ip, 20);
  assert.equal(check.count, 1, 'the E113-rejected request must not have incremented the E109 rate-limit counter');
});
