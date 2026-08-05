// test/whisper-alignment-store.test.js
//
// Covers netlify/functions/lib/whisper-alignment-store.js in isolation —
// tracker.html's for-product-whisper-runaway-5-000-whispe-szk33s item. This
// store's whole job is a CAS claim (blobs10's `setJSON(key, value,
// { onlyIfNew: true })`) so at most ONE caller ever wins the right to submit
// a whisper alignment job for a given ttsRequestId — see that file's header
// comment for the full "why CAS instead of this codebase's usual
// accept-the-residual-race posture" reasoning.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var whisperStore = require('../netlify/functions/lib/whisper-alignment-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('get() returns null before any claim exists', async function () {
  var record = await whisperStore.get(fakeEvent({}), 'fal-ai/kokoro/american-english', 'req1');
  assert.equal(record, null);
});

test('claim() succeeds the first time for a fresh ttsRequestId', async function () {
  var result = await whisperStore.claim(fakeEvent({}), 'fal-ai/kokoro/american-english', 'req1', 'https://cdn.fal.ai/a.mp3');
  assert.equal(result.claimed, true);

  var record = await whisperStore.get(fakeEvent({}), 'fal-ai/kokoro/american-english', 'req1');
  assert.equal(record.whisperRequestId, null); // not submitted yet -- only claimed
  assert.equal(record.audioUrl, 'https://cdn.fal.ai/a.mp3');
});

test('a second claim() for the SAME ttsRequestId loses -- no read/verify race, atomic by construction', async function () {
  var event = fakeEvent({});
  var first = await whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req1', 'https://cdn.fal.ai/a.mp3');
  assert.equal(first.claimed, true);

  var second = await whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req1', 'https://cdn.fal.ai/a.mp3');
  assert.equal(second.claimed, false);
  assert.ok(second.record, 'the loser must get back the winner\'s record');
  assert.equal(second.record.whisperRequestId, null);
});

test('two concurrent claim() calls for the SAME ttsRequestId -- exactly one wins (Promise.all race)', async function () {
  var event = fakeEvent({});
  var results = await Promise.all([
    whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req-race', 'https://cdn.fal.ai/race.mp3'),
    whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req-race', 'https://cdn.fal.ai/race.mp3')
  ]);
  var winners = results.filter(function (r) { return r.claimed; });
  var losers = results.filter(function (r) { return !r.claimed; });
  assert.equal(winners.length, 1, 'exactly one concurrent claim must win');
  assert.equal(losers.length, 1);
});

test('a DIFFERENT ttsRequestId gets its own independent claim -- no cross-request bleed', async function () {
  var event = fakeEvent({});
  var a = await whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req-a', 'https://cdn.fal.ai/a.mp3');
  var b = await whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req-b', 'https://cdn.fal.ai/b.mp3');
  assert.equal(a.claimed, true);
  assert.equal(b.claimed, true);
});

test('recordSubmitted() attaches the whisperRequestId onto the claimed record', async function () {
  var event = fakeEvent({});
  await whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req1', 'https://cdn.fal.ai/a.mp3');
  await whisperStore.recordSubmitted(event, 'fal-ai/kokoro/american-english', 'req1', 'https://cdn.fal.ai/a.mp3', 'whisper-req-1');

  var record = await whisperStore.get(event, 'fal-ai/kokoro/american-english', 'req1');
  assert.equal(record.whisperRequestId, 'whisper-req-1');
  assert.ok(record.submittedAt);
});

test('releaseClaim() deletes the marker so a later attempt can claim fresh', async function () {
  var event = fakeEvent({});
  await whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req1', 'https://cdn.fal.ai/a.mp3');
  await whisperStore.releaseClaim(event, 'fal-ai/kokoro/american-english', 'req1');

  var record = await whisperStore.get(event, 'fal-ai/kokoro/american-english', 'req1');
  assert.equal(record, null);

  var retried = await whisperStore.claim(event, 'fal-ai/kokoro/american-english', 'req1', 'https://cdn.fal.ai/a.mp3');
  assert.equal(retried.claimed, true);
});

test('claim() fails CLOSED (claimed:false, error:exhausted) when the CAS write itself rejects', async function () {
  mockBlobs.setWriteOverride(whisperStore.STORE_NAME, function () {
    return new Error('simulated Blobs 500 -- transient storage-layer fault');
  });

  var result = await whisperStore.claim(fakeEvent({}), 'fal-ai/kokoro/american-english', 'req-writefails', 'https://cdn.fal.ai/x.mp3');
  assert.equal(result.claimed, false);
  assert.equal(result.error, 'exhausted');
});

test('keyFor() scopes by BOTH model and requestId', function () {
  assert.equal(whisperStore.keyFor('fal-ai/kokoro/american-english', 'req1'), 'fal-ai/kokoro/american-english:req1');
});
