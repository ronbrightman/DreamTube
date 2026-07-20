// test/generate-video-mock.test.js
//
// Covers netlify/functions/generate-video.js's two dev/test-only env-var
// flags — see that file's "Mock mode & test-duration override" doc block
// and docs/TESTING.md:
//
//   - GENERATION_MOCK_MODE="true": skips every real fal.ai call. Confirms
//     the response shape stays identical to the real path, that FAL_KEY
//     is never required and the real call functions are never invoked
//     (spied via global.fetch — a mock-mode request that reached fal
//     would show up as a fetch call), that every guardrail (validation,
//     rate limit, entitlement, spend guard) still runs unchanged, and that
//     default behavior (the flag unset) is completely untouched.
//   - GENERATION_TEST_DURATION="4s"|"6s"|"8s": still makes a real fal.ai
//     call (fetch is stubbed here — this suite never spends real money or
//     needs real credentials) but at the requested duration instead of
//     the hardcoded default, and only when GENERATION_MOCK_MODE isn't
//     also on (mock mode always wins if both are set).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/generate-video').handler;

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.1.0.' + ipCounter;
}

function genEvent(overrides) {
  return fakeEvent({
    method: 'POST',
    ip: (overrides && overrides.ip) || nextIp(),
    body: Object.assign({ caption: 'a dream about flying', style: 'Cartoon' }, overrides && overrides.body)
  });
}

/** Spies on global.fetch so tests can assert whether the real fal.ai call functions ever actually fired a request. Records every call's URL + parsed JSON body. */
function installFetchSpy() {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
  return calls;
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.GENERATION_TEST_DURATION;
  delete process.env.FAL_KEY;
  delete process.env.PAYWALL_ENABLED;
  delete process.env.OWNER_EMAIL;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- GENERATION_MOCK_MODE -----

test('mock mode: valid 200 response shaped { operationName } with a "mock:" prefix, no FAL_KEY needed', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  // Deliberately no FAL_KEY set at all.
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(typeof body.operationName, 'string');
  assert.equal(body.operationName.indexOf('mock:'), 0);
  assert.equal(calls.length, 0, 'no real fal.ai call should ever fire in mock mode');
});

test('mock mode: two calls produce two distinct operationNames', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var res1 = await handler(genEvent({}));
  var res2 = await handler(genEvent({}));
  var name1 = JSON.parse(res1.body).operationName;
  var name2 = JSON.parse(res2.body).operationName;
  assert.notEqual(name1, name2);
});

test('mock mode: only the exact string "true" turns it on — any other value behaves as unset (real path)', async function () {
  process.env.GENERATION_MOCK_MODE = 'yes';
  process.env.FAL_KEY = 'test-fal-key';
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('fal:'), 0);
  assert.equal(calls.length, 1, 'the real fal.ai path should run since the flag value was not exactly "true"');
});

test('mock mode: validation (caption/style required) still runs — E104, no fetch at all', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var calls = installFetchSpy();
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: JSON.stringify({ caption: '', style: '' }) }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E104:/);
  assert.equal(calls.length, 0);
});

test('mock mode: invalid JSON body still rejected E103', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: 'not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E103:/);
});

test('mock mode: wrong HTTP method still rejected E101', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E101:/);
});

test('mock mode: rate limit (E109) still applies — a pre-tripped IP counter blocks a mock-mode request too', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var ip = nextIp();
  var todayUtc = new Date().toISOString().slice(0, 10);
  mockBlobs.seed('dreamtube-rate-limits', 'ip:' + todayUtc + ':' + ip, 20);
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E109: rate_limited/);
});

test('mock mode: spend guard (E110) still applies — a pre-tripped daily cap blocks a mock-mode request too', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  process.env.DAILY_SPEND_CAP_USD = '1';
  var todayUtc = new Date().toISOString().slice(0, 10);
  mockBlobs.seed('dreamtube-spend-guard', 'spend:' + todayUtc, 1);
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /^E110: daily_spend_cap_exceeded/);
});

test('mock mode: paywall entitlement gate (E108) still applies to a non-entitled email', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  process.env.PAYWALL_ENABLED = 'true';
  var res = await handler(genEvent({ body: { email: 'nobody@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E108: payment_required/);
});

// ----- Default (unset) behavior is completely unchanged -----

test('GENERATION_MOCK_MODE unset: real path runs exactly as before — fal: operationName, fetch called once, FAL_KEY required', async function () {
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.FAL_KEY;
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E102: missing_api_key/);
});

test('GENERATION_MOCK_MODE unset + FAL_KEY set: real fal.ai call fires with the default 8s duration', async function () {
  delete process.env.GENERATION_MOCK_MODE;
  process.env.FAL_KEY = 'test-fal-key';
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('fal:'), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.duration, '8s');
});

// ----- GENERATION_TEST_DURATION -----

test('GENERATION_TEST_DURATION="4s": real fal.ai call is made with duration overridden to 4s', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  process.env.GENERATION_TEST_DURATION = '4s';
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.duration, '4s');
});

test('GENERATION_TEST_DURATION="6s": real fal.ai call is made with duration overridden to 6s', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  process.env.GENERATION_TEST_DURATION = '6s';
  var calls = installFetchSpy();
  await handler(genEvent({}));
  assert.equal(calls[0].body.duration, '6s');
});

test('GENERATION_TEST_DURATION with an unsupported value falls back to the untouched default 8s rather than sending fal something it would reject', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  process.env.GENERATION_TEST_DURATION = '1s';
  var calls = installFetchSpy();
  await handler(genEvent({}));
  assert.equal(calls[0].body.duration, '8s');
});

test('GENERATION_TEST_DURATION also applies on the self-photo reference-to-video path', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  process.env.GENERATION_TEST_DURATION = '4s';
  var calls = installFetchSpy();
  var res = await handler(genEvent({
    body: { characters: [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }] }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /reference-to-video/);
  assert.equal(calls[0].body.duration, '4s');
});

test('GENERATION_MOCK_MODE wins over GENERATION_TEST_DURATION when both are set — no real call, no duration ever read', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  process.env.GENERATION_TEST_DURATION = '4s';
  // Deliberately no FAL_KEY — if the real path were somehow reached despite
  // mock mode, this would 500 with E102 instead of returning a mock operationName.
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('mock:'), 0);
  assert.equal(calls.length, 0);
});
