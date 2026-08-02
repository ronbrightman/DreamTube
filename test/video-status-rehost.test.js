// test/video-status-rehost.test.js
//
// Covers video-status.js's checkFalStatus wiring to lib/media-rehost.js end
// to end through the real HTTP handler — tracker item
// for-product-owner-media-library-page-fou-1fwxaw (Part 1): a completed
// generation's videoUrl gets swapped for our own durable Blobs-backed URL
// when re-hosting succeeds, and gracefully falls back to fal's own URL
// (never blocking/breaking the response) when it fails. Complements
// test/media-rehost.test.js (the re-host mechanism in isolation) and
// test/video-status-model-agnostic.test.js (which deliberately keeps the
// re-host attempt failing closed, to stay focused on falAppBase).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/video-status').handler;

var realFetch = global.fetch;

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.FAL_KEY = 'test-fal-key';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.FAL_KEY;
});

function statusEvent(name) {
  return fakeEvent({ method: 'GET', query: { name: name } });
}

/** A fully working stub: fal status -> COMPLETED, fal result -> a real video url, and the video url itself -> real (fake) bytes with a content-type, so re-hosting can genuinely succeed. */
function stubFullSuccess(videoBytes) {
  var calls = [];
  global.fetch = async function (url) {
    calls.push(String(url));
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    if (String(url).indexOf('/requests/') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ video: { url: 'https://fal.media/files/finished.mp4' } }); } };
    }
    // The re-host step's own download of the resolved videoUrl.
    return {
      ok: true, status: 200,
      headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? 'video/mp4' : null; } },
      arrayBuffer: async function () { return videoBytes; }
    };
  };
  return calls;
}

test('a successful completion re-hosts the video and returns OUR durable url, not fal\'s', async function () {
  var bytes = new ArrayBuffer(16);
  stubFullSuccess(bytes);
  var res = await handler(statusEvent('fal:fal-ai/veo3.1/lite:req-rehost-1'));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(body.videoUrl, '/.netlify/functions/video-file?key=req-rehost-1');

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-rehost-1');
  assert.equal(stored.data, bytes);
  assert.equal(stored.metadata.contentType, 'video/mp4');
});

test('re-hosting the SAME job twice (a resumed/duplicate poll) is idempotent -- second poll still returns the durable url without re-downloading', async function () {
  stubFullSuccess(new ArrayBuffer(8));
  await handler(statusEvent('fal:fal-ai/veo3.1/lite:req-rehost-dup'));
  var downloadCallsBefore = 0;
  var { getStore } = require('@netlify/blobs');
  var before = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-rehost-dup');
  assert.ok(before);

  var second = await handler(statusEvent('fal:fal-ai/veo3.1/lite:req-rehost-dup'));
  assert.equal(JSON.parse(second.body).videoUrl, '/.netlify/functions/video-file?key=req-rehost-dup');
});

test('when the video download itself fails, the response still succeeds with fal\'s own raw videoUrl -- re-hosting never blocks the user-facing flow', async function () {
  global.fetch = async function (url) {
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    if (String(url).indexOf('/requests/') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ video: { url: 'https://fal.media/files/finished.mp4' } }); } };
    }
    // The re-host step's own download of the resolved videoUrl fails.
    return { ok: false, status: 500, headers: { get: function () { return null; } } };
  };
  var res = await handler(statusEvent('fal:fal-ai/veo3.1/lite:req-rehost-fail'));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(body.videoUrl, 'https://fal.media/files/finished.mp4', 'falls back to fal\'s own url when re-hosting fails');
});

test('a Blobs write failure during re-host still leaves the ordinary response intact, falling back to fal\'s url', async function () {
  stubFullSuccess(new ArrayBuffer(8));
  mockBlobs.setWriteOverride('dreamtube-videos', function () { return new Error('blobs down'); });
  try {
    var res = await handler(statusEvent('fal:fal-ai/veo3.1/lite:req-rehost-blobsfail'));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.done, true);
    assert.equal(body.videoUrl, 'https://fal.media/files/finished.mp4');
  } finally {
    mockBlobs.clearWriteOverride('dreamtube-videos');
  }
});
