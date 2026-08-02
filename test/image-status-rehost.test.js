// test/image-status-rehost.test.js
//
// Covers image-status.js's checkFalImageStatus wiring to
// lib/media-rehost.js end to end — the image counterpart to
// test/video-status-rehost.test.js (see that file's own header comment for
// the full reasoning; identical shape here).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/image-status').handler;

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

function stubFullSuccess(imageBytes) {
  global.fetch = async function (url) {
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    if (String(url).indexOf('/requests/') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ images: [{ url: 'https://fal.media/files/finished.png' }] }); } };
    }
    return {
      ok: true, status: 200,
      headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? 'image/png' : null; } },
      arrayBuffer: async function () { return imageBytes; }
    };
  };
}

test('a successful completion re-hosts the image and returns OUR durable url, not fal\'s', async function () {
  var bytes = new ArrayBuffer(10);
  stubFullSuccess(bytes);
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req-img-rehost-1'));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(body.imageUrl, '/.netlify/functions/image-file?key=req-img-rehost-1');

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-images' }).getWithMetadata('req-img-rehost-1');
  assert.equal(stored.data, bytes);
  assert.equal(stored.metadata.contentType, 'image/png');
});

test('when the image download fails, the response still succeeds with fal\'s own raw imageUrl', async function () {
  global.fetch = async function (url) {
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    if (String(url).indexOf('/requests/') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ images: [{ url: 'https://fal.media/files/finished.png' }] }); } };
    }
    return { ok: false, status: 500, headers: { get: function () { return null; } } };
  };
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req-img-rehost-fail'));
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(body.imageUrl, 'https://fal.media/files/finished.png');
});
