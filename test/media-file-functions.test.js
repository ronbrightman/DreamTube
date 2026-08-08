// test/media-file-functions.test.js
//
// Covers netlify/functions/video-file.mjs and the new
// netlify/functions/image-file.mjs (tracker item
// for-product-owner-media-library-page-fou-1fwxaw) — the streaming
// read-back side of lib/media-rehost.js's write. Both are modern
// Response-based streaming functions (see video-file.mjs's own header
// comment for why), loaded here via dynamic import() since this suite's
// other files are all CommonJS.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

test.beforeEach(function () {
  mockBlobs.reset();
});

function fakeRequest(url) {
  return { url: url };
}

test('video-file.mjs: 400 when key is missing', async function () {
  var videoFile = (await import('../netlify/functions/video-file.mjs')).default;
  var res = await videoFile(fakeRequest('https://dreamtube.life/.netlify/functions/video-file'));
  assert.equal(res.status, 400);
});

test('video-file.mjs: 404 for an unknown key', async function () {
  var videoFile = (await import('../netlify/functions/video-file.mjs')).default;
  var res = await videoFile(fakeRequest('https://dreamtube.life/.netlify/functions/video-file?key=nope'));
  assert.equal(res.status, 404);
});

test('video-file.mjs: a rehosted record (has sourceUrl) redirects to its source (emergency redirect-first, tracker cyp8np)', async function () {
  var mediaRehost = require('../netlify/functions/lib/media-rehost');
  var bytes = new ArrayBuffer(8);
  global.fetch = async function () {
    return { ok: true, status: 200, headers: { get: function () { return 'video/mp4'; } }, arrayBuffer: async function () { return bytes; } };
  };
  await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'vf-key-1');

  var videoFile = (await import('../netlify/functions/video-file.mjs')).default;
  var res = await videoFile(fakeRequest('https://dreamtube.life/.netlify/functions/video-file?key=vf-key-1'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://fal.media/x.mp4');
});

test('image-file.mjs: 400 when key is missing', async function () {
  var imageFile = (await import('../netlify/functions/image-file.mjs')).default;
  var res = await imageFile(fakeRequest('https://dreamtube.life/.netlify/functions/image-file'));
  assert.equal(res.status, 400);
});

test('image-file.mjs: 404 for an unknown key', async function () {
  var imageFile = (await import('../netlify/functions/image-file.mjs')).default;
  var res = await imageFile(fakeRequest('https://dreamtube.life/.netlify/functions/image-file?key=nope'));
  assert.equal(res.status, 404);
});

test('image-file.mjs: a rehosted image (has sourceUrl) redirects to its source (emergency redirect-first), SEPARATE dreamtube-images store', async function () {
  var mediaRehost = require('../netlify/functions/lib/media-rehost');
  var bytes = new ArrayBuffer(5);
  global.fetch = async function () {
    return { ok: true, status: 200, headers: { get: function () { return 'image/png'; } }, arrayBuffer: async function () { return bytes; } };
  };
  await mediaRehost.rehostBestEffort({}, 'image', 'https://fal.media/x.png', 'if-key-1');

  var imageFile = (await import('../netlify/functions/image-file.mjs')).default;
  var res = await imageFile(fakeRequest('https://dreamtube.life/.netlify/functions/image-file?key=if-key-1'));
  assert.equal(res.status, 302);
});

// DEFENSE-IN-DEPTH SIZE GUARD — tracker item
// for-product-urgent-founder-repro-on-drea-uq3a36. lib/media-rehost.js's own
// gate is the real fix (it never hands out a durable url for oversized
// media in the first place — see test/media-rehost.test.js), but a record
// can still land here oversized via a path that writes into the store
// directly (bypassing rehostBestEffort) -- these tests cover that fallback
// so the platform's 20 MB streaming-response cap turns into a clean 302,
// not an opaque 502.

test('video-file.mjs: redirects to metadata.sourceUrl instead of streaming when metadata says the object is over the streaming ceiling', async function () {
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-videos' }).set('vf-big', new ArrayBuffer(4), {
    metadata: { contentType: 'video/mp4', sourceUrl: 'https://fal.media/big-source.mp4', byteLength: 30 * 1024 * 1024 }
  });

  var videoFile = (await import('../netlify/functions/video-file.mjs')).default;
  var res = await videoFile(fakeRequest('https://dreamtube.life/.netlify/functions/video-file?key=vf-big'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://fal.media/big-source.mp4');
});

test('video-file.mjs: an object at/under the ceiling with a sourceUrl now REDIRECTS too (emergency redirect-first posture, tracker cyp8np)', async function () {
  var { getStore } = require('@netlify/blobs');
  var bytes = new ArrayBuffer(6);
  await getStore({ name: 'dreamtube-videos' }).set('vf-small', bytes, {
    metadata: { contentType: 'video/mp4', sourceUrl: 'https://fal.media/small-source.mp4', byteLength: 6 }
  });

  var videoFile = (await import('../netlify/functions/video-file.mjs')).default;
  var res = await videoFile(fakeRequest('https://dreamtube.life/.netlify/functions/video-file?key=vf-small'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://fal.media/small-source.mp4');
});

test('video-file.mjs: a record with NO sourceUrl still streams (fallback path)', async function () {
  var { getStore } = require('@netlify/blobs');
  var bytes = new ArrayBuffer(6);
  await getStore({ name: 'dreamtube-videos' }).set('vf-nosource', bytes, {
    metadata: { contentType: 'video/mp4', byteLength: 6 }
  });

  var videoFile = (await import('../netlify/functions/video-file.mjs')).default;
  var res = await videoFile(fakeRequest('https://dreamtube.life/.netlify/functions/video-file?key=vf-nosource'));
  assert.equal(res.status, 200);
  var buf = await res.arrayBuffer();
  assert.equal(buf.byteLength, 6);
});

test('image-file.mjs: redirects to metadata.sourceUrl instead of streaming when metadata says the object is over the streaming ceiling', async function () {
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-images' }).set('if-big', new ArrayBuffer(4), {
    metadata: { contentType: 'image/png', sourceUrl: 'https://fal.media/big-source.png', byteLength: 30 * 1024 * 1024 }
  });

  var imageFile = (await import('../netlify/functions/image-file.mjs')).default;
  var res = await imageFile(fakeRequest('https://dreamtube.life/.netlify/functions/image-file?key=if-big'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://fal.media/big-source.png');
});
