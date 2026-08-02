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
  var res = await videoFile(fakeRequest('https://dreamtube1.netlify.app/.netlify/functions/video-file'));
  assert.equal(res.status, 400);
});

test('video-file.mjs: 404 for an unknown key', async function () {
  var videoFile = (await import('../netlify/functions/video-file.mjs')).default;
  var res = await videoFile(fakeRequest('https://dreamtube1.netlify.app/.netlify/functions/video-file?key=nope'));
  assert.equal(res.status, 404);
});

test('video-file.mjs: streams back exactly what lib/media-rehost.js stored, with its content-type', async function () {
  var mediaRehost = require('../netlify/functions/lib/media-rehost');
  var bytes = new ArrayBuffer(8);
  global.fetch = async function () {
    return { ok: true, status: 200, headers: { get: function () { return 'video/mp4'; } }, arrayBuffer: async function () { return bytes; } };
  };
  await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'vf-key-1');

  var videoFile = (await import('../netlify/functions/video-file.mjs')).default;
  var res = await videoFile(fakeRequest('https://dreamtube1.netlify.app/.netlify/functions/video-file?key=vf-key-1'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'video/mp4');
  var buf = await res.arrayBuffer();
  assert.equal(buf.byteLength, 8);
});

test('image-file.mjs: 400 when key is missing', async function () {
  var imageFile = (await import('../netlify/functions/image-file.mjs')).default;
  var res = await imageFile(fakeRequest('https://dreamtube1.netlify.app/.netlify/functions/image-file'));
  assert.equal(res.status, 400);
});

test('image-file.mjs: 404 for an unknown key', async function () {
  var imageFile = (await import('../netlify/functions/image-file.mjs')).default;
  var res = await imageFile(fakeRequest('https://dreamtube1.netlify.app/.netlify/functions/image-file?key=nope'));
  assert.equal(res.status, 404);
});

test('image-file.mjs: streams back exactly what lib/media-rehost.js stored, with its content-type, from the SEPARATE dreamtube-images store', async function () {
  var mediaRehost = require('../netlify/functions/lib/media-rehost');
  var bytes = new ArrayBuffer(5);
  global.fetch = async function () {
    return { ok: true, status: 200, headers: { get: function () { return 'image/png'; } }, arrayBuffer: async function () { return bytes; } };
  };
  await mediaRehost.rehostBestEffort({}, 'image', 'https://fal.media/x.png', 'if-key-1');

  var imageFile = (await import('../netlify/functions/image-file.mjs')).default;
  var res = await imageFile(fakeRequest('https://dreamtube1.netlify.app/.netlify/functions/image-file?key=if-key-1'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  var buf = await res.arrayBuffer();
  assert.equal(buf.byteLength, 5);
});
