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
var InterpreterPersonas = require('../js/interpreter-personas');
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

test('rejects a persona with no voiceId configured with E505 (same "tolerate a missing asset" gate as portraits)', async function () {
  // Every real persona currently carries the Sage's interim voice (founder
  // call 2026-08-04, Dream Meaning makeover), so exercise the no-voiceId
  // branch by stubbing the persona lookup — the gate itself must survive
  // for the day a voiceless persona ships again.
  var realGet = InterpreterPersonas.get;
  InterpreterPersonas.get = function (key) {
    if (key === 'voiceless-test-persona') return { key: key, voiceId: null };
    return realGet(key);
  };
  try {
    var res = await handler(genEvent({ body: { personaKey: 'voiceless-test-persona' } }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E505:/);
  } finally {
    InterpreterPersonas.get = realGet;
  }
});

test('sync-first: a real one-round-trip kokoro+whisper success returns done:true with word-level captions, hitting fal.run not the queue', async function () {
  var urls = [];
  global.fetch = async function (url, opts) {
    urls.push(url);
    if (/\/fal-ai\/whisper$/.test(url)) {
      var body = JSON.parse(opts.body);
      assert.equal(body.audio_url, 'https://cdn.fal.example/audio-123.mp3');
      return { ok: true, status: 200, json: async function () {
        return { chunks: [
          { text: 'A', timestamp: [0, 0.3] },
          { text: 'hopeful', timestamp: [0.3, 0.9] }
        ] };
      } };
    }
    // fal.run sync TTS call
    var body2 = JSON.parse(opts.body);
    assert.equal(body2.voice, 'am_onyx');
    assert.equal(body2.speed, generateInterpAudio.READING_SPEED);
    return { ok: true, status: 200, json: async function () { return { audio: { url: 'https://cdn.fal.example/audio-123.mp3' } }; } };
  };
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.done, true);
  assert.equal(data.audioUrl, 'https://cdn.fal.example/audio-123.mp3');
  assert.equal(data.captionsLevel, 'word');
  assert.equal(data.captions.length, 2);
  assert.equal(data.captions[0].word, 'A');
  assert.equal(data.audioDurationMs, 900);
  // Anchored on the host specifically: FAL_API_BASE (the queue endpoint) is
  // 'https://queue.fal.run', which CONTAINS the substring 'fal.run/' -- an
  // unanchored /fal\.run\// regex would silently pass even if a future
  // regression accidentally routed this call through the queue base
  // instead of the sync one.
  assert.ok(urls.every(function (u) { return new URL(u).host === 'fal.run'; }), 'sync-first must hit fal.run (sync), never queue.fal.run, when it succeeds');
});

test('sync-first: kokoro succeeds but whisper fails/times out -- degrades to sentence-level captions, still done:true, never falls back to the queue', async function () {
  global.fetch = async function (url) {
    if (/\/fal-ai\/whisper$/.test(url)) return { ok: false, status: 500, json: async function () { return {}; } };
    return { ok: true, status: 200, json: async function () { return { audio: { url: 'https://cdn.fal.example/audio-456.mp3' } }; } };
  };
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.done, true);
  assert.equal(data.audioUrl, 'https://cdn.fal.example/audio-456.mp3');
  assert.equal(data.captionsLevel, 'sentence');
  assert.deepEqual(data.captions, []);
  assert.match(data.degradedReason, /^E508:/);
});

test('submits to fal-ai/kokoro/american-english with the right voice/speed and returns operationName on success (queue fallback -- exercised when the sync leg does not return a usable audio.url)', async function () {
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
  assert.equal(capturedBody.speed, 0.9); // founder-adjusted 08-04
  assert.equal(capturedBody.prompt, 'A hopeful reading of your dream, turning it toward the good.');
});

test('surfaces a fal rejection as E506 (queue fallback path)', async function () {
  stubFetchOnce({ ok: false, status: 422, json: async function () { return { detail: 'bad request' }; } });
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E506:/);
});

test('a thrown/network-level fal failure on the sync leg falls through to the queue, and a thrown/network-level failure THERE surfaces as a 500 E506', async function () {
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
  var res = await handler(genEvent({ body: { personaKey: 'not-a-real-persona' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E505:/);
});
