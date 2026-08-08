// test/watermark-video.test.js
//
// Covers netlify/functions/lib/watermark-video.js — the watermark-on-
// download mechanism (tracker item for-product-founder-ruling-08-07-
// every-u-g81h7v). Complements test/download-video.test.js and
// test/download-video-status.test.js (the thin HTTP surface over this
// module) and test/share-sheet-behavioral.test.js (real browser coverage
// of the client call site).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var watermarkVideo = require('../netlify/functions/lib/watermark-video');

var realFetch = global.fetch;

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.URL = 'https://dreamtube1.netlify.app';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.URL;
});

var FAKE_EVENT = {};
var FAL_KEY = 'test-fal-key';

test('overlayAssetUrl() builds an absolute, publicly-fetchable url off the site origin', function () {
  assert.equal(watermarkVideo.overlayAssetUrl(), 'https://dreamtube1.netlify.app/assets/watermark-overlay-720x1280.mp4');
});

test('getCachedTwin: not found', async function () {
  var result = await watermarkVideo.getCachedTwin(FAKE_EVENT, 'dream-nope');
  assert.deepEqual(result, { found: false });
});

test('getCachedTwin: found, normal size -> the durable watermarked-video-file url', async function () {
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-videos-watermarked' }).set('dream-1', new ArrayBuffer(8), { metadata: { contentType: 'video/mp4', byteLength: 8 } });
  var result = await watermarkVideo.getCachedTwin(FAKE_EVENT, 'dream-1');
  assert.equal(result.found, true);
  assert.equal(result.url, '/.netlify/functions/watermarked-video-file?key=dream-1');
});

test('getCachedTwin: found, oversized -> falls back to the recorded sourceUrl', async function () {
  var { getStore } = require('@netlify/blobs');
  var big = 19 * 1024 * 1024;
  await getStore({ name: 'dreamtube-videos-watermarked' }).set('dream-big', new ArrayBuffer(8), {
    metadata: { contentType: 'video/mp4', byteLength: big, sourceUrl: 'https://fal.media/big-twin.mp4' }
  });
  var result = await watermarkVideo.getCachedTwin(FAKE_EVENT, 'dream-big');
  assert.equal(result.found, true);
  assert.equal(result.tooLargeToServe, true);
  assert.equal(result.url, 'https://fal.media/big-twin.mp4');
});

test('submitBlendJob: submits the correct blend-video request shape and records a pending job', async function () {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: String(url), opts: opts });
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ request_id: 'req-blend-1' }); } };
  };

  var result = await watermarkVideo.submitBlendJob(FAKE_EVENT, 'dream-2', 'https://fal.media/clean.mp4', FAL_KEY);
  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'req-blend-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://queue.fal.run/fal-ai/workflow-utilities/blend-video');
  assert.equal(calls[0].opts.headers.Authorization, 'Key ' + FAL_KEY);
  assert.equal(calls[0].opts.headers['X-Fal-Object-Lifecycle-Preference'], JSON.stringify({ expiration_duration_seconds: null }));
  var body = JSON.parse(calls[0].opts.body);
  assert.equal(body.top_video_url, 'https://dreamtube1.netlify.app/assets/watermark-overlay-720x1280.mp4');
  assert.equal(body.bottom_video_url, 'https://fal.media/clean.mp4');
  assert.equal(body.blend_mode, 'screen');
  assert.equal(body.opacity, 1);
  assert.equal(body.shortest, false);

  var pending = await watermarkVideo.getPendingJob(FAKE_EVENT, 'dream-2');
  assert.ok(pending);
  assert.equal(pending.requestId, 'req-blend-1');
  assert.equal(pending.model, 'fal-ai/workflow-utilities/blend-video');
});

test('submitBlendJob: a fal-side submission failure does NOT record a pending job', async function () {
  global.fetch = async function () {
    return { ok: false, status: 422, text: async function () { return JSON.stringify({ detail: 'bad request' }); } };
  };
  var result = await watermarkVideo.submitBlendJob(FAKE_EVENT, 'dream-3', 'https://fal.media/clean.mp4', FAL_KEY);
  assert.equal(result.ok, false);
  var pending = await watermarkVideo.getPendingJob(FAKE_EVENT, 'dream-3');
  assert.equal(pending, null);
});

test('getPendingJob: a marker older than the stale window is treated as absent', async function () {
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-watermark-jobs' }).setJSON('dream-stale', {
    requestId: 'req-old', model: 'fal-ai/workflow-utilities/blend-video', createdAt: Date.now() - (6 * 60 * 1000)
  });
  var pending = await watermarkVideo.getPendingJob(FAKE_EVENT, 'dream-stale');
  assert.equal(pending, null);
});

test('pollAndFinalize: no pending job for this dreamId', async function () {
  var result = await watermarkVideo.pollAndFinalize(FAKE_EVENT, 'dream-none', FAL_KEY);
  assert.deepEqual(result, { status: 'error', error: 'no_pending_job' });
});

function seedPendingJob(dreamId, requestId) {
  var { getStore } = require('@netlify/blobs');
  return getStore({ name: 'dreamtube-watermark-jobs' }).setJSON(dreamId, {
    requestId: requestId, model: 'fal-ai/workflow-utilities/blend-video', createdAt: Date.now()
  });
}

test('pollAndFinalize: job still IN_PROGRESS -> processing, job marker untouched', async function () {
  await seedPendingJob('dream-4', 'req-4');
  global.fetch = async function (url) {
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'IN_PROGRESS' }); } };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  var result = await watermarkVideo.pollAndFinalize(FAKE_EVENT, 'dream-4', FAL_KEY);
  assert.deepEqual(result, { status: 'processing' });
  var pending = await watermarkVideo.getPendingJob(FAKE_EVENT, 'dream-4');
  assert.ok(pending, 'a still-running job must not be cleared');
});

test('pollAndFinalize: fal marks the job failed -> error, and the pending marker is cleared', async function () {
  await seedPendingJob('dream-5', 'req-5');
  global.fetch = async function (url) {
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'ERROR' }); } };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  var result = await watermarkVideo.pollAndFinalize(FAKE_EVENT, 'dream-5', FAL_KEY);
  assert.equal(result.status, 'error');
  assert.match(result.error, /job_failed/);
  var pending = await watermarkVideo.getPendingJob(FAKE_EVENT, 'dream-5');
  assert.equal(pending, null);
});

test('pollAndFinalize: COMPLETED but no video url in the result -> error, marker cleared', async function () {
  await seedPendingJob('dream-6', 'req-6');
  global.fetch = async function (url) {
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    return { ok: true, status: 200, text: async function () { return JSON.stringify({}); } };
  };
  var result = await watermarkVideo.pollAndFinalize(FAKE_EVENT, 'dream-6', FAL_KEY);
  assert.deepEqual(result, { status: 'error', error: 'no_video_in_response' });
  var pending = await watermarkVideo.getPendingJob(FAKE_EVENT, 'dream-6');
  assert.equal(pending, null);
});

test('pollAndFinalize: COMPLETED with a real video url -> rehosts into the twin store and returns OUR durable url', async function () {
  await seedPendingJob('dream-7', 'req-7');
  var bytes = new ArrayBuffer(16);
  global.fetch = async function (url) {
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    if (String(url).indexOf('/requests/') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ video: { url: 'https://fal.media/blended.mp4' } }); } };
    }
    // rehostBestEffort's own download of the blended video.
    return {
      ok: true, status: 200,
      headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? 'video/mp4' : null; } },
      arrayBuffer: async function () { return bytes; }
    };
  };
  var result = await watermarkVideo.pollAndFinalize(FAKE_EVENT, 'dream-7', FAL_KEY);
  assert.equal(result.status, 'ready');
  assert.equal(result.url, '/.netlify/functions/watermarked-video-file?key=dream-7');

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-videos-watermarked' }).getWithMetadata('dream-7');
  assert.equal(stored.data, bytes);

  var pending = await watermarkVideo.getPendingJob(FAKE_EVENT, 'dream-7');
  assert.equal(pending, null, 'a finalized job\'s marker must be cleared so a later re-check goes straight to the cached-twin path');
});

test('pollAndFinalize: COMPLETED but our own re-host fetch fails -> still ready, falls back to fal\'s own (no-expiry) url', async function () {
  await seedPendingJob('dream-8', 'req-8');
  global.fetch = async function (url) {
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    if (String(url).indexOf('/requests/') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ video: { url: 'https://fal.media/blended-8.mp4' } }); } };
    }
    throw new Error('network hiccup re-hosting'); // rehostBestEffort's own fetch(sourceUrl) fails
  };
  var result = await watermarkVideo.pollAndFinalize(FAKE_EVENT, 'dream-8', FAL_KEY);
  assert.deepEqual(result, { status: 'ready', url: 'https://fal.media/blended-8.mp4' });
});
