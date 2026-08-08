// test/download-video-status.test.js
//
// Covers netlify/functions/download-video-status.js — the poll side of
// the watermark-on-download mechanism (tracker item
// for-product-founder-ruling-08-07-every-u-g81h7v). See
// test/watermark-video.test.js for the underlying pollAndFinalize
// coverage this thin handler wraps, and test/download-video.test.js for
// the submit side.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var downloadVideo = require('../netlify/functions/download-video').handler;
var statusHandler = require('../netlify/functions/download-video-status').handler;

var realFetch = global.fetch;

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.FAL_KEY = 'test-fal-key';
  process.env.URL = 'https://dreamtube1.netlify.app';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.FAL_KEY;
  delete process.env.URL;
});

function statusEvent(id) {
  return fakeEvent({ method: 'GET', query: { id: id } });
}

test('rejects a non-GET method', async function () {
  var res = await statusHandler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^WS01/);
});

test('requires id', async function () {
  var res = await statusHandler(fakeEvent({ method: 'GET', query: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^WS02/);
});

test('missing FAL_KEY -> a clean error', async function () {
  delete process.env.FAL_KEY;
  var res = await statusHandler(statusEvent('dream-1'));
  var body = JSON.parse(res.body);
  assert.equal(body.status, 'error');
  assert.match(body.error, /^WS03/);
});

test('no pending job for this id -> error, not a silent hang', async function () {
  var res = await statusHandler(statusEvent('dream-never-submitted'));
  var body = JSON.parse(res.body);
  assert.equal(body.status, 'error');
  assert.equal(body.error, 'no_pending_job');
});

test('end to end: submit via download-video, poll while running, then poll again once fal completes -> ready with the durable twin url', async function () {
  var pollCount = 0;
  global.fetch = async function (url) {
    var s = String(url);
    if (s.indexOf('/status') !== -1) {
      pollCount++;
      var status = pollCount < 2 ? 'IN_PROGRESS' : 'COMPLETED';
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: status }); } };
    }
    if (s.indexOf('/requests/') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ video: { url: 'https://fal.media/blended-e2e.mp4' } }); } };
    }
    if (s.indexOf('queue.fal.run') !== -1) {
      // the initial submission
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ request_id: 'req-e2e' }); } };
    }
    // rehostBestEffort's own byte download
    return {
      ok: true, status: 200,
      headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? 'video/mp4' : null; } },
      arrayBuffer: async function () { return new ArrayBuffer(32); }
    };
  };

  var submitRes = JSON.parse((await downloadVideo(fakeEvent({ method: 'GET', query: { id: 'dream-e2e', src: 'https://fal.media/clean-e2e.mp4' } }))).body);
  assert.equal(submitRes.status, 'processing');

  var poll1 = JSON.parse((await statusHandler(statusEvent('dream-e2e'))).body);
  assert.equal(poll1.status, 'processing');

  var poll2 = JSON.parse((await statusHandler(statusEvent('dream-e2e'))).body);
  assert.equal(poll2.status, 'ready');
  assert.equal(poll2.url, '/.netlify/functions/watermarked-video-file?key=dream-e2e');

  // A subsequent submit call for the same dream must now hit the cache,
  // never re-submit a fal job.
  var submitAgain = JSON.parse((await downloadVideo(fakeEvent({ method: 'GET', query: { id: 'dream-e2e', src: 'https://fal.media/clean-e2e.mp4' } }))).body);
  assert.equal(submitAgain.status, 'ready');
  assert.equal(submitAgain.url, '/.netlify/functions/watermarked-video-file?key=dream-e2e');
});

test('a job that fails on fal\'s side surfaces status:error and clears the marker (a later re-submit is possible)', async function () {
  global.fetch = async function (url) {
    var s = String(url);
    if (s.indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'ERROR' }); } };
    }
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ request_id: 'req-will-fail' }); } };
  };
  await downloadVideo(fakeEvent({ method: 'GET', query: { id: 'dream-will-fail', src: 'https://fal.media/x.mp4' } }));
  var pollRes = JSON.parse((await statusHandler(statusEvent('dream-will-fail'))).body);
  assert.equal(pollRes.status, 'error');
  assert.match(pollRes.error, /job_failed/);

  // Marker cleared -- polling again with nothing pending is a clean error,
  // not a crash or a stuck "processing" forever.
  var pollAgain = JSON.parse((await statusHandler(statusEvent('dream-will-fail'))).body);
  assert.equal(pollAgain.status, 'error');
  assert.equal(pollAgain.error, 'no_pending_job');
});
