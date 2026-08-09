// test/generate-interp-audio.test.js
//
// Covers netlify/functions/generate-interp-audio.js — Speaking Sage Option
// D (docs/SPEAKING_SAGE_SPEC.md, tracker item
// for-product-build-speaking-sage-wave-fou-8uobuh), voice vendor switched
// to ElevenLabs 2026-08-04 (tracker item
// for-product-founder-decision-08-04-switc-cqveik). fal.ai (ElevenLabs,
// Kokoro, Whisper) is stubbed via a fake global.fetch (same approach
// test/interpret-dream.test.js already established) — these tests exercise
// this function's own logic (validation, persona/voiceId gating, rate
// limiting, request shape, THREE-TIER fallback chain: ElevenLabs sync ->
// kokoro sync -> kokoro queue), not a live call to fal.ai. Blobs (used
// transitively via lib/rate-limit.js) is mocked the same way.
//
// URL routing: most tests below need to distinguish which of the three
// tiers a given fetch call targets (ElevenLabs sync, kokoro sync, kokoro
// queue submit, or the kokoro fallback tier's own whisper caption call) —
// `routedFetch` below does that by URL shape, same spirit as the file's
// own per-tier URL construction.

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

/**
 * Routes a fake fetch call to one of four handlers by URL shape, recording
 * every URL hit along the way (`calls`, in call order) — lets a test stub
 * ONE tier's behavior precisely while leaving the others to their own
 * default ("not called" / throws if reached unexpectedly) so a test can
 * assert exactly how far down the fallback chain a request travelled.
 * Any handler omitted defaults to a network-level throw (proves that tier
 * was never reached, the same way "no such stub" would surface a bug).
 */
function routedFetch(handlers) {
  var calls = [];
  var fn = async function (url, opts) {
    calls.push(url);
    var isElevenlabs = /\/fal-ai\/elevenlabs\/tts\/turbo-v2\.5$/.test(url) && new URL(url).host === 'fal.run';
    var isWhisper = /\/fal-ai\/whisper$/.test(url);
    var isKokoroQueue = /\/fal-ai\/kokoro\/american-english$/.test(url) && new URL(url).host === 'queue.fal.run';
    var isKokoroSync = /\/fal-ai\/kokoro\/american-english$/.test(url) && new URL(url).host === 'fal.run';
    if (isElevenlabs && handlers.elevenlabs) return handlers.elevenlabs(url, opts);
    if (isWhisper && handlers.whisper) return handlers.whisper(url, opts);
    if (isKokoroSync && handlers.kokoroSync) return handlers.kokoroSync(url, opts);
    if (isKokoroQueue && handlers.kokoroQueue) return handlers.kokoroQueue(url, opts);
    throw new Error('unexpected/unstubbed fetch to ' + url);
  };
  fn.calls = calls;
  return fn;
}

/** A well-formed ElevenLabs sync failure (http error) -- the common "fall through to kokoro" stub used by several tests below. */
function elevenlabsHttpError() {
  return { ok: false, status: 500, json: async function () { return { detail: 'elevenlabs down' }; } };
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

// ── Tracker for-product-founder-spec-08-04-chamber-m-zf5ufo, part 3
//    (INTERIM VOICES, 2026-08-04) ──
// jung/freud/gestalt/scientist now carry the Sage's own `voiceId`
// (`am_onyx`) too — see js/interpreter-personas.js's own header note. The
// "real persona, no voiceId configured" branch of the `!persona ||
// !persona.voiceId` gate (generate-interp-audio.js) therefore has no live
// example among today's five real personas anymore; it remains real
// defense-in-depth for any FUTURE persona added before it gets voice
// casting, but there is nothing left to exercise it with here. This test
// now proves the POSITIVE side instead: jung, one of the four interim-
// voice personas, is genuinely accepted past the gate (mock mode so no
// real fal.ai call is made).
test('an interim-voice persona (jung, borrowing the Sage\'s am_onyx casting per the 2026-08-04 "go wide interim" change) is accepted, not rejected with E505', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var res = await handler(genEvent({ body: { personaKey: 'jung' } }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.match(data.operationName, /^mock:/);
});

// ── Tier 1: ElevenLabs sync (PRIMARY) ───────────────────────────────────

test('ElevenLabs sync success with well-formed timestamps: returns done:true word-level captions, hits ONLY the ElevenLabs sync endpoint (no whisper, no kokoro at all)', async function () {
  var fetchFn = routedFetch({
    elevenlabs: async function (url, opts) {
      var body = JSON.parse(opts.body);
      assert.equal(body.text, 'A hopeful reading of your dream, turning it toward the good.');
      assert.equal(body.voice, 'Brian');
      assert.equal(body.timestamps, true);
      // speed: 0.9 (READING_SPEED) IS sent now — founder 2026-08-09: the
      // default-1.0 ElevenLabs reading read "too fast"; both tiers now read at
      // the same tuned 0.9 pace (see generate-interp-audio.js). No stability
      // override, still (default was fine).
      assert.equal(body.speed, 0.9);
      assert.equal('stability' in body, false);
      return {
        ok: true, status: 200, json: async function () {
          return {
            audio: { url: 'https://cdn.fal.example/el-audio-1.mp3' },
            timestamps: [
              { word: 'A', start: 0, end: 0.3 },
              { word: 'hopeful', start: 0.3, end: 0.9 },
              { word: 'reading.', start: 0.9, end: 1.4 }
            ]
          };
        }
      };
    }
  });
  global.fetch = fetchFn;
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.done, true);
  assert.equal(data.audioUrl, 'https://cdn.fal.example/el-audio-1.mp3');
  assert.equal(data.captionsLevel, 'word');
  assert.equal(data.captions.length, 3);
  assert.deepEqual(data.captions[0], { word: 'A', startMs: 0, endMs: 300 });
  assert.equal(data.audioDurationMs, 1400);
  assert.equal(fetchFn.calls.length, 1, 'must resolve on the ElevenLabs tier alone -- no whisper, no kokoro');
});

test('ElevenLabs sync succeeds but the audio has no timestamps (missing field): degrades to sentence-level captions on the SAME tier -- no whisper, no kokoro fallback', async function () {
  var fetchFn = routedFetch({
    elevenlabs: async function () {
      return { ok: true, status: 200, json: async function () { return { audio: { url: 'https://cdn.fal.example/el-audio-2.mp3' } }; } };
    }
  });
  global.fetch = fetchFn;
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.done, true);
  assert.equal(data.audioUrl, 'https://cdn.fal.example/el-audio-2.mp3');
  assert.equal(data.captionsLevel, 'sentence');
  assert.deepEqual(data.captions, []);
  assert.match(data.degradedReason, /^E508:/);
  assert.equal(fetchFn.calls.length, 1, 'audio succeeded -- must NOT fall back to kokoro just because captions were unavailable');
});

test('ElevenLabs sync succeeds but timestamps is a malformed/unrecognized shape: degrades to sentence-level captions (never throws, never fabricates a caption)', async function () {
  var malformedShapes = [
    [{ foo: 'bar' }, { foo: 'baz' }],           // no recognizable word/start/end fields at all
    'not-an-array',                              // wrong type entirely
    [],                                           // empty
    [{ word: 'A' }, { word: 'hopeful' }]          // word present, but no timing at all
  ];
  for (var i = 0; i < malformedShapes.length; i++) {
    var shape = malformedShapes[i];
    var fetchFn = routedFetch({
      elevenlabs: async function () {
        return { ok: true, status: 200, json: async function () { return { audio: { url: 'https://cdn.fal.example/el-audio-malformed.mp3' }, timestamps: shape }; } };
      }
    });
    global.fetch = fetchFn;
    var res = await handler(genEvent({ ip: nextIp() }));
    assert.equal(res.statusCode, 200);
    var data = JSON.parse(res.body);
    assert.equal(data.done, true, 'shape #' + i);
    assert.equal(data.captionsLevel, 'sentence', 'shape #' + i);
    assert.deepEqual(data.captions, [], 'shape #' + i);
    assert.equal(fetchFn.calls.length, 1, 'shape #' + i + ' -- still must not fall back to kokoro, audio itself succeeded');
  }
});

test('ElevenLabs sync fails (http error) -- falls back to kokoro sync (existing tier, unchanged), full cascade through all three fal.ai endpoints', async function () {
  var fetchFn = routedFetch({
    elevenlabs: elevenlabsHttpError,
    kokoroSync: async function (url, opts) {
      var body = JSON.parse(opts.body);
      assert.equal(body.voice, 'am_onyx'); // persona.kokoroVoiceId, the fallback tier's own voice
      assert.equal(body.speed, generateInterpAudio.READING_SPEED);
      assert.equal(body.prompt, 'A hopeful reading of your dream, turning it toward the good.');
      return { ok: true, status: 200, json: async function () { return { audio: { url: 'https://cdn.fal.example/ko-audio-1.mp3' } }; } };
    },
    whisper: async function (url, opts) {
      var body = JSON.parse(opts.body);
      assert.equal(body.audio_url, 'https://cdn.fal.example/ko-audio-1.mp3');
      return { ok: true, status: 200, json: async function () { return { chunks: [{ text: 'A', timestamp: [0, 0.3] }, { text: 'hopeful', timestamp: [0.3, 0.9] }] }; } };
    }
  });
  global.fetch = fetchFn;
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.done, true);
  assert.equal(data.audioUrl, 'https://cdn.fal.example/ko-audio-1.mp3');
  assert.equal(data.captionsLevel, 'word');
  assert.equal(data.captions.length, 2);
  // Proves the full cascade actually ran: ElevenLabs attempted, THEN kokoro sync, THEN its own whisper leg.
  assert.equal(fetchFn.calls.length, 3);
  assert.ok(new URL(fetchFn.calls[0]).host === 'fal.run' && /elevenlabs/.test(fetchFn.calls[0]));
  assert.ok(new URL(fetchFn.calls[1]).host === 'fal.run' && /kokoro/.test(fetchFn.calls[1]));
  assert.ok(/whisper$/.test(fetchFn.calls[2]));
});

test('ElevenLabs sync throws (network-level failure) -- also falls back to kokoro sync, same as an http error', async function () {
  var fetchFn = routedFetch({
    elevenlabs: async function () { throw new Error('network boom'); },
    kokoroSync: async function () { return { ok: true, status: 200, json: async function () { return { audio: { url: 'https://cdn.fal.example/ko-audio-2.mp3' } }; } }; },
    whisper: async function () { return { ok: false, status: 500, json: async function () { return {}; } }; }
  });
  global.fetch = fetchFn;
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.done, true);
  assert.equal(data.audioUrl, 'https://cdn.fal.example/ko-audio-2.mp3');
  assert.equal(data.captionsLevel, 'sentence'); // kokoro's own whisper leg failed too, degrades same as before
});

// ── Tier 2: kokoro sync (FALLBACK — existing behavior, still exercised) ─

test('kokoro fallback tier: sync succeeds but ITS OWN whisper fails/times out -- degrades to sentence-level captions, still done:true, never falls back further to the queue', async function () {
  var fetchFn = routedFetch({
    elevenlabs: elevenlabsHttpError,
    kokoroSync: async function () { return { ok: true, status: 200, json: async function () { return { audio: { url: 'https://cdn.fal.example/audio-456.mp3' } }; } }; },
    whisper: async function () { return { ok: false, status: 500, json: async function () { return {}; } }; }
  });
  global.fetch = fetchFn;
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.done, true);
  assert.equal(data.audioUrl, 'https://cdn.fal.example/audio-456.mp3');
  assert.equal(data.captionsLevel, 'sentence');
  assert.deepEqual(data.captions, []);
  assert.match(data.degradedReason, /^E508:/);
});

// ── Tier 3: kokoro queue (LEGACY FALLBACK — existing behavior, still exercised) ─

test('both sync tiers fail -- submits to fal-ai/kokoro/american-english (queue) with the right voice/speed and returns operationName', async function () {
  var fetchFn = routedFetch({
    elevenlabs: elevenlabsHttpError,
    kokoroSync: async function () { return { ok: false, status: 500, json: async function () { return {}; } }; },
    kokoroQueue: async function (url, opts) {
      var body = JSON.parse(opts.body);
      assert.equal(body.voice, 'am_onyx');
      assert.equal(body.speed, generateInterpAudio.READING_SPEED);
      assert.equal(body.speed, 0.9); // founder-adjusted 08-04, unaffected by the ElevenLabs switch
      assert.equal(body.prompt, 'A hopeful reading of your dream, turning it toward the good.');
      return { ok: true, status: 200, json: async function () { return { request_id: 'req-123' }; } };
    }
  });
  global.fetch = fetchFn;
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.operationName, 'fal:' + generateInterpAudio.FAL_MODEL + ':req-123');
});

test('surfaces a fal rejection as E506 (all three tiers fail, in order, cascading down to the queue error)', async function () {
  stubFetchOnce({ ok: false, status: 422, json: async function () { return { detail: 'bad request' }; } });
  var res = await handler(genEvent());
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E506:/);
});

test('a thrown/network-level fal failure on every tier falls all the way through to the queue, and a thrown/network-level failure THERE surfaces as a 500 E506', async function () {
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
  // Not a real persona at all (rather than 'jung' — since the 2026-08-04
  // interim-voice change, jung DOES carry a voiceId now; see this file's
  // "interim-voice persona" test above), so this still genuinely exercises
  // the `!persona` half of the gate under mock mode.
  var res = await handler(genEvent({ body: { personaKey: 'not-a-real-persona' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E505:/);
});

// ── persona voiceId semantics (js/interpreter-personas.js) ─────────────

test('talmudic persona carries the ElevenLabs voice name as voiceId (primary tier) and the original kokoro voice id as kokoroVoiceId (fallback tier)', function () {
  var InterpreterPersonas = require('../js/interpreter-personas');
  var persona = InterpreterPersonas.get('talmudic');
  assert.equal(persona.voiceId, 'Brian');
  assert.equal(persona.kokoroVoiceId, 'am_onyx');
});

// ── parseElevenLabsCaptions (defensive shape parsing) ───────────────────

test('parseElevenLabsCaptions: accepts word/start/end field names', function () {
  var captions = generateInterpAudio.parseElevenLabsCaptions([
    { word: 'A', start: 0, end: 0.3 },
    { word: 'hopeful', start: 0.3, end: 0.9 }
  ]);
  assert.deepEqual(captions, [
    { word: 'A', startMs: 0, endMs: 300 },
    { word: 'hopeful', startMs: 300, endMs: 900 }
  ]);
});

test('parseElevenLabsCaptions: also accepts this codebase\'s own whisper-chunk convention (text/timestamp:[start,end]) as a fallback shape', function () {
  var captions = generateInterpAudio.parseElevenLabsCaptions([
    { text: 'A', timestamp: [0, 0.3] },
    { text: 'hopeful', timestamp: [0.3, 0.9] }
  ]);
  assert.deepEqual(captions, [
    { word: 'A', startMs: 0, endMs: 300 },
    { word: 'hopeful', startMs: 300, endMs: 900 }
  ]);
});

test('parseElevenLabsCaptions: returns null (never throws, never []) on null/undefined/non-array input', function () {
  assert.equal(generateInterpAudio.parseElevenLabsCaptions(null), null);
  assert.equal(generateInterpAudio.parseElevenLabsCaptions(undefined), null);
  assert.equal(generateInterpAudio.parseElevenLabsCaptions('not-an-array'), null);
  assert.equal(generateInterpAudio.parseElevenLabsCaptions([]), null);
});

test('parseElevenLabsCaptions: degrades to null when most items fail to parse (low hit rate signals a wrong guessed shape, not a few odd words)', function () {
  var captions = generateInterpAudio.parseElevenLabsCaptions([
    { word: 'A', start: 0, end: 0.3 },
    { totally: 'unrecognized' },
    { also: 'unrecognized' },
    { still: 'unrecognized' }
  ]);
  assert.equal(captions, null);
});
