// test/generate-interp-audio.test.js
//
// Covers netlify/functions/generate-interp-audio.js — Speaking Sage Option
// D (docs/SPEAKING_SAGE_SPEC.md, tracker item
// for-product-build-speaking-sage-wave-fou-8uobuh). fal.ai/Kokoro is
// stubbed via a fake global.fetch (same approach test/interpret-dream.test.js
// already established) — these tests exercise this function's own logic
// (validation, persona/voiceId gating, rate limiting, request shape), not a
// live call to fal.ai. Blobs (used transitively via lib/rate-limit.js) is
// mocked the same way.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var generateInterpAudio = require('../netlify/functions/generate-interp-audio');
var handler = generateInterpAudio.handler;

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.4.0.' + ipCounter;
}

function stubFetchOnce(response) {
  global.fetch = async function () { return response; };
}

function genEvent(overrides) {
  var base = {
    method: 'POST',
    ip: nextIp(),
    body: Object.assign({ dreamId: 'd1', personaKey: 'talmudic', text: 'A hopeful reading of your dream, turning it toward the good.' }, overrides && overrides.body)
  };
  if (overrides && overrides.ip) base.ip = overrides.ip;
  if (overrides && 'body' in overrides && typeof overrides.body === 'string') base.body = overrides.body;
  return fakeEvent(base);
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.MAX_INTERP_AUDIO_PER_IP_PER_DAY;
});

test.after(function () { global.fetch = realFetch; });

test('rejects non-POST with E501', async function () {
  var res = await handler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E501:/);
});

test('rejects when FAL_KEY is missing (mock mode off) with E502', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E502:/);
});

test('rejects invalid JSON body with E503', async function () {
  var res = await handler(genEvent({ body: '{not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E503:/);
});

test('rejects missing/empty text with E504', async function () {
  var res1 = await handler(genEvent({ body: { text: '' } }));
  assert.equal(res1.statusCode, 400);
  assert.match(JSON.parse(res1.body).error, /^E504:/);

  var res2 = await handler(genEvent({ body: { text: '   ' } }));
  assert.match(JSON.parse(res2.body).error, /^E504:/);
});

test('rejects an unknown personaKey with E505', async function () {
  var res = await handler(genEvent({ body: { personaKey: 'not-a-real-persona' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E505:/);
});

test('rejects a persona with no voiceId configured yet with E505 (same "tolerate a missing asset" gate as portraits)', async function () {
  // jung has no voiceId on this branch (only talmudic/The Sage ships voice
  // this wave — scope item 4, "sage persona first").
  var res = await handler(genEvent({ body: { personaKey: 'jung' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E505:/);
});

test('submits to fal-ai/kokoro/american-english with the right voice/speed and returns operationName on success', async function () {
  var capturedUrl = null, capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { request_id: 'req-123' }; } };
  };
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.operationName, 'fal:' + generateInterpAudio.FAL_MODEL + ':req-123');
  assert.match(capturedUrl, /fal-ai\/kokoro\/american-english$/);
  assert.equal(capturedBody.voice, 'am_onyx');
  assert.equal(capturedBody.speed, generateInterpAudio.READING_SPEED);
  assert.equal(capturedBody.speed, 0.8);
  assert.equal(capturedBody.prompt, 'A hopeful reading of your dream, turning it toward the good.');
});

test('surfaces a fal rejection as E506', async function () {
  stubFetchOnce({ ok: false, status: 422, json: async function () { return { detail: 'bad request' }; } });
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E506:/);
});

test('a thrown/network-level fal failure surfaces as a 500 E506', async function () {
  global.fetch = async function () { throw new Error('boom'); };
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E506:/);
});

test('rate-limits under its OWN "interp-audio-ip" scope, separate from interpret-ip', async function () {
  process.env.MAX_INTERP_AUDIO_PER_IP_PER_DAY = '2';
  stubFetchOnce({ ok: true, status: 200, json: async function () { return { request_id: 'r' }; } });
  var ip = nextIp();
  var res1 = await handler(genEvent({ ip: ip }));
  var res2 = await handler(genEvent({ ip: ip }));
  var res3 = await handler(genEvent({ ip: ip }));
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res3.statusCode, 429);
  assert.match(JSON.parse(res3.body).error, /^E507: rate_limited/);
});

test('GENERATION_MOCK_MODE="true" skips the real fal.ai call entirely (zero network calls) and returns a "mock:" operationName', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  delete process.env.FAL_KEY; // mock mode must not require FAL_KEY at all
  var fetchCalls = 0;
  global.fetch = async function () { fetchCalls += 1; throw new Error('should never be called in mock mode'); };
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.match(data.operationName, /^mock:/);
  assert.equal(fetchCalls, 0);
});

test('mock mode still runs the rate-limit guardrail (never a way to bypass it)', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  process.env.MAX_INTERP_AUDIO_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  var res1 = await handler(genEvent({ ip: ip }));
  var res2 = await handler(genEvent({ ip: ip }));
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 429);
});

test('mock mode still runs persona/voiceId validation (never a way to bypass it)', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var res = await handler(genEvent({ body: { personaKey: 'jung' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E505:/);
});
