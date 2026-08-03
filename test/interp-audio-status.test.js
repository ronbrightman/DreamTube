// test/interp-audio-status.test.js
//
// Covers netlify/functions/interp-audio-status.js — Speaking Sage Option D
// (docs/SPEAKING_SAGE_SPEC.md, tracker item
// for-product-build-speaking-sage-wave-fou-8uobuh). fal.ai (both the
// Kokoro TTS status/result endpoints AND the chained Whisper alignment
// call) is stubbed via a fake global.fetch, keyed off the request URL —
// same "stub fetch, assert on the function's own logic" approach every
// other fal-backed function's tests in this suite already use. No real
// network call, no real FAL_KEY needed for any of these.

var test = require('node:test');
var assert = require('node:assert/strict');

var { fakeEvent } = require('./helpers/fake-event');
var interpAudioStatus = require('../netlify/functions/interp-audio-status');
var handler = interpAudioStatus.handler;

var realFetch = global.fetch;

test.beforeEach(function () {
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
});

test.after(function () { global.fetch = realFetch; });

function getEvent(name) {
  return fakeEvent({ method: 'GET', query: name ? { name: name } : null });
}

test('rejects non-GET with method_not_allowed', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
});

test('rejects a missing name param', async function () {
  var res = await handler(getEvent(null));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'name_required');
});

test('rejects when FAL_KEY is missing for a real (non-mock) name', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(getEvent('fal:fal-ai/kokoro/american-english:req1'));
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, 'missing_api_key');
});

test('rejects an unrecognized operationName prefix', async function () {
  var res = await handler(getEvent('bogus:whatever'));
  assert.equal(res.statusCode, 400);
});

test('stage 1 (Kokoro): IN_QUEUE/IN_PROGRESS reports processing with the SAME operationName', async function () {
  global.fetch = async function (url) {
    assert.match(url, /\/requests\/req1\/status$/);
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'IN_QUEUE' }); } };
  };
  var name = 'fal:fal-ai/kokoro/american-english:req1';
  var res = await handler(getEvent(name));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.status, 'processing');
  assert.equal(data.operationName, name);
});

test('stage 1 -> stage 2 handoff: once Kokoro COMPLETES, this submits the Whisper alignment job and hands back a NEW "falw:" operationName', async function () {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push(url);
    if (/\/status$/.test(url)) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    if (/\/requests\/req1$/.test(url)) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ audio: { url: 'https://cdn.fal.ai/sample-reading.mp3' } }); } };
    }
    if (/fal-ai\/whisper$/.test(url) && opts && opts.method === 'POST') {
      var body = JSON.parse(opts.body);
      assert.equal(body.chunk_level, 'word');
      assert.equal(body.audio_url, 'https://cdn.fal.ai/sample-reading.mp3');
      return { ok: true, status: 200, json: async function () { return { request_id: 'whisper-req-1' }; } };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  var res = await handler(getEvent('fal:fal-ai/kokoro/american-english:req1'));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.status, 'processing');
  assert.equal(data.operationName, 'falw:' + encodeURIComponent('https://cdn.fal.ai/sample-reading.mp3') + ':whisper-req-1');
});

test('if Kokoro itself fails (non-COMPLETED terminal status), reports status:"failed"', async function () {
  global.fetch = async function () {
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'ERROR' }); } };
  };
  var res = await handler(getEvent('fal:fal-ai/kokoro/american-english:req1'));
  var data = JSON.parse(res.body);
  assert.equal(data.status, 'failed');
  assert.match(data.error, /^E506:/);
});

test('if Kokoro completes but the whisper SUBMISSION fails, degrades to sentence-level captions rather than failing the whole reading', async function () {
  global.fetch = async function (url, opts) {
    if (/\/status$/.test(url)) return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    if (/\/requests\/req1$/.test(url)) return { ok: true, status: 200, text: async function () { return JSON.stringify({ audio: { url: 'https://cdn.fal.ai/x.mp3' } }); } };
    if (/fal-ai\/whisper$/.test(url)) return { ok: false, status: 500, json: async function () { return { error: 'nope' }; } };
    throw new Error('unexpected fetch: ' + url);
  };
  var res = await handler(getEvent('fal:fal-ai/kokoro/american-english:req1'));
  var data = JSON.parse(res.body);
  assert.equal(data.status, 'done');
  assert.equal(data.audioUrl, 'https://cdn.fal.ai/x.mp3');
  assert.equal(data.captionsLevel, 'sentence');
  assert.deepEqual(data.captions, []);
  assert.match(data.degradedReason, /^E508:/);
});

test('stage 2 (whisper): IN_QUEUE reports processing with the SAME (falw:) operationName', async function () {
  var name = 'falw:' + encodeURIComponent('https://cdn.fal.ai/x.mp3') + ':whisper-req-1';
  global.fetch = async function (url) {
    assert.match(url, /\/requests\/whisper-req-1\/status$/);
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'IN_QUEUE' }); } };
  };
  var res = await handler(getEvent(name));
  var data = JSON.parse(res.body);
  assert.equal(data.status, 'processing');
  assert.equal(data.operationName, name);
});

test('stage 2 complete with real word chunks: resolves done with word-level captions, ms-converted, and audioDurationMs from the last word', async function () {
  var name = 'falw:' + encodeURIComponent('https://cdn.fal.ai/x.mp3') + ':whisper-req-1';
  global.fetch = async function (url) {
    if (/\/status$/.test(url)) return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    return {
      ok: true, status: 200, text: async function () {
        return JSON.stringify({
          text: 'Hello there friend',
          chunks: [
            { text: 'Hello', timestamp: [0, 0.5] },
            { text: 'there', timestamp: [0.5, 0.9] },
            { text: 'friend', timestamp: [0.9, 1.4] }
          ]
        });
      }
    };
  };
  var res = await handler(getEvent(name));
  var data = JSON.parse(res.body);
  assert.equal(data.status, 'done');
  assert.equal(data.captionsLevel, 'word');
  assert.equal(data.audioUrl, 'https://cdn.fal.ai/x.mp3');
  assert.deepEqual(data.captions, [
    { word: 'Hello', startMs: 0, endMs: 500 },
    { word: 'there', startMs: 500, endMs: 900 },
    { word: 'friend', startMs: 900, endMs: 1400 }
  ]);
  assert.equal(data.audioDurationMs, 1400);
});

test('stage 2 complete but with NO usable chunks: degrades to sentence-level (non-fatal, still resolves done with the audio url)', async function () {
  var name = 'falw:' + encodeURIComponent('https://cdn.fal.ai/x.mp3') + ':whisper-req-1';
  global.fetch = async function (url) {
    if (/\/status$/.test(url)) return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ text: 'hi', chunks: [] }); } };
  };
  var res = await handler(getEvent(name));
  var data = JSON.parse(res.body);
  assert.equal(data.status, 'done');
  assert.equal(data.captionsLevel, 'sentence');
  assert.deepEqual(data.captions, []);
  assert.equal(data.audioUrl, 'https://cdn.fal.ai/x.mp3');
});

test('parseWordChunks: drops malformed individual chunks rather than failing the whole parse', function () {
  var out = interpAudioStatus.parseWordChunks({
    chunks: [
      { text: 'Real', timestamp: [0, 0.3] },
      { text: '', timestamp: [0.3, 0.5] }, // empty text -- dropped
      { text: 'word', timestamp: null },   // missing timestamp -- dropped
      { text: 'Another', timestamp: [0.5, 0.8] }
    ]
  });
  assert.deepEqual(out, [
    { word: 'Real', startMs: 0, endMs: 300 },
    { word: 'Another', startMs: 500, endMs: 800 }
  ]);
});

test('parseWordChunks: returns null (not []) for missing/empty chunks -- the caller treats null as "trigger the fallback"', function () {
  assert.equal(interpAudioStatus.parseWordChunks({}), null);
  assert.equal(interpAudioStatus.parseWordChunks({ chunks: [] }), null);
  assert.equal(interpAudioStatus.parseWordChunks({ chunks: [{ text: '', timestamp: [0, 1] }] }), null);
});

test('mock mode: "mock:" operationName resolves processing then done with a real, small, stable sample audio + fixed captions, without ever touching global.fetch', async function () {
  var fetchCalls = 0;
  global.fetch = async function () { fetchCalls += 1; throw new Error('should never be called for a mock: name'); };
  var startedAt = Date.now();
  var name = 'mock:' + startedAt + ':abc123';
  var immediate = await handler(getEvent(name));
  assert.equal(JSON.parse(immediate.body).status, 'processing');

  var staleName = 'mock:' + (Date.now() - 60000) + ':abc123'; // already "old enough"
  var later = await handler(getEvent(staleName));
  var data = JSON.parse(later.body);
  assert.equal(data.status, 'done');
  assert.equal(data.audioUrl, interpAudioStatus.MOCK_SAMPLE_AUDIO_URL);
  assert.equal(data.captionsLevel, 'word');
  assert.ok(Array.isArray(data.captions) && data.captions.length > 0);
  assert.equal(fetchCalls, 0);
});
