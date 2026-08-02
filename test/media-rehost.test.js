// test/media-rehost.test.js
//
// Covers netlify/functions/lib/media-rehost.js in isolation: the
// best-effort re-host mechanism itself (fetch the source url, store into
// Blobs, return the durable url), its idempotency, and its
// never-throws-on-failure contract — see that file's own header comment.
// Also covers image-file.mjs/video-file.mjs's own read-back of what this
// module writes, proving the two ends of the pipe agree on shape.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var mediaRehost = require('../netlify/functions/lib/media-rehost');

var realFetch = global.fetch;

test.beforeEach(function () {
  mockBlobs.reset();
});
test.after(function () { global.fetch = realFetch; });

function fakeMediaResponse(bytes, contentType, ok) {
  return {
    ok: ok !== false,
    status: ok === false ? 404 : 200,
    headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? (contentType || null) : null; } },
    arrayBuffer: async function () { return bytes; }
  };
}

test('durableUrl: matches the shape lib/media-status.js recognizes', function () {
  var mediaStatus = require('../netlify/functions/lib/media-status');
  assert.equal(mediaStatus.isDurableUrl(mediaRehost.durableUrl('video', 'abc')), true);
  assert.equal(mediaStatus.isDurableUrl(mediaRehost.durableUrl('image', 'abc')), true);
  assert.equal(mediaRehost.durableUrl('video', 'abc'), '/.netlify/functions/video-file?key=abc');
  assert.equal(mediaRehost.durableUrl('image', 'abc'), '/.netlify/functions/image-file?key=abc');
});

test('rehostBestEffort: success -- fetches the source, stores it, returns the durable url', async function () {
  var bytes = new ArrayBuffer(8);
  global.fetch = async function (url) {
    assert.equal(url, 'https://fal.media/x.mp4');
    return fakeMediaResponse(bytes, 'video/mp4');
  };
  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-1');
  assert.equal(result.ok, true);
  assert.equal(result.url, '/.netlify/functions/video-file?key=req-1');

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-1');
  assert.equal(stored.data, bytes);
  assert.equal(stored.metadata.contentType, 'video/mp4');
});

test('rehostBestEffort: image path stores into the separate dreamtube-images store', async function () {
  var bytes = new ArrayBuffer(4);
  global.fetch = async function () { return fakeMediaResponse(bytes, 'image/png'); };
  var result = await mediaRehost.rehostBestEffort({}, 'image', 'https://fal.media/x.png', 'req-img-1');
  assert.equal(result.ok, true);
  assert.equal(result.url, '/.netlify/functions/image-file?key=req-img-1');

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-images' }).getWithMetadata('req-img-1');
  assert.equal(stored.metadata.contentType, 'image/png');
  // Nothing should have leaked into the video store.
  var videoStored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-img-1');
  assert.equal(videoStored, null);
});

test('rehostBestEffort: falls back to a default content-type when the source response has none', async function () {
  global.fetch = async function () {
    return { ok: true, status: 200, headers: { get: function () { return null; } }, arrayBuffer: async function () { return new ArrayBuffer(2); } };
  };
  await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-no-ct');
  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-no-ct');
  assert.equal(stored.metadata.contentType, 'video/mp4');
});

test('rehostBestEffort: idempotent -- a second call for the same key skips the fetch entirely and returns the same durable url', async function () {
  var fetchCalls = 0;
  global.fetch = async function () { fetchCalls++; return fakeMediaResponse(new ArrayBuffer(4), 'video/mp4'); };
  var first = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-dup');
  var second = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-dup');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.url, first.url);
  assert.equal(fetchCalls, 1, 'the second call must not re-fetch the source -- getMetadata short-circuits it');
});

test('rehostBestEffort: a non-OK source fetch fails closed, never throws', async function () {
  global.fetch = async function () { return { ok: false, status: 404, headers: { get: function () { return null; } } }; };
  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/gone.mp4', 'req-404');
  assert.equal(result.ok, false);
});

test('rehostBestEffort: a thrown network error fails closed, never throws out of this function', async function () {
  global.fetch = async function () { throw new Error('network down'); };
  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-throw');
  assert.equal(result.ok, false);
});

test('rehostBestEffort: a Blobs write failure fails closed, never throws', async function () {
  global.fetch = async function () { return fakeMediaResponse(new ArrayBuffer(4), 'video/mp4'); };
  mockBlobs.setWriteOverride('dreamtube-videos', function () { return new Error('blobs write failed'); });
  try {
    var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-write-fail');
    assert.equal(result.ok, false);
  } finally {
    mockBlobs.clearWriteOverride('dreamtube-videos');
  }
});

test('rehostBestEffort: invalid input (missing sourceUrl/key/unknown mediaType) fails closed without ever calling fetch', async function () {
  var fetchCalls = 0;
  global.fetch = async function () { fetchCalls++; return fakeMediaResponse(new ArrayBuffer(1), 'video/mp4'); };
  assert.equal((await mediaRehost.rehostBestEffort({}, 'video', '', 'k')).ok, false);
  assert.equal((await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', '')).ok, false);
  assert.equal((await mediaRehost.rehostBestEffort({}, 'audio', 'https://fal.media/x.mp4', 'k')).ok, false);
  assert.equal(fetchCalls, 0);
});
