// test/download-video.test.js
//
// Covers netlify/functions/download-video.js — the submit-side HTTP
// surface of the watermark-on-download mechanism (tracker item
// for-product-founder-ruling-08-07-every-u-g81h7v). See
// test/watermark-video.test.js for the underlying mechanism's own
// coverage and test/download-video-status.test.js for the poll side.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/download-video').handler;

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

function dlEvent(query) {
  return fakeEvent({ method: 'GET', query: query });
}

test('rejects a non-GET method', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^WD01/);
});

test('requires both id and src', async function () {
  var res1 = await handler(dlEvent({ id: 'dream-1' }));
  assert.equal(res1.statusCode, 400);
  assert.match(JSON.parse(res1.body).error, /^WD02/);

  var res2 = await handler(dlEvent({ src: 'https://fal.media/x.mp4' }));
  assert.equal(res2.statusCode, 400);
  assert.match(JSON.parse(res2.body).error, /^WD02/);
});

test('missing FAL_KEY -> a clean error, not a silent fallback', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(dlEvent({ id: 'dream-1', src: 'https://fal.media/x.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.status, 'error');
  assert.match(body.error, /^WD03/);
});

test('a cached twin already present -> ready immediately, no fal call at all', async function () {
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-videos-watermarked' }).set('dream-cached', new ArrayBuffer(4), { metadata: { contentType: 'video/mp4', byteLength: 4 } });
  global.fetch = async function () { throw new Error('must not call fal when a twin is already cached'); };

  var res = await handler(dlEvent({ id: 'dream-cached', src: 'https://fal.media/x.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.status, 'ready');
  assert.equal(body.url, '/.netlify/functions/watermarked-video-file?key=dream-cached');
});

test('no cache, no pending job -> submits a fresh blend job and reports processing', async function () {
  var submitCalls = 0;
  global.fetch = async function (url) {
    submitCalls++;
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ request_id: 'req-fresh' }); } };
  };
  var res = await handler(dlEvent({ id: 'dream-fresh', src: 'https://fal.media/clean.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.status, 'processing');
  assert.equal(submitCalls, 1);
});

test('a job already in flight for this dream -> processing, without submitting a SECOND fal job', async function () {
  var submitCalls = 0;
  global.fetch = async function () {
    submitCalls++;
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ request_id: 'req-dup' }); } };
  };
  await handler(dlEvent({ id: 'dream-dup', src: 'https://fal.media/clean.mp4' })); // first call submits
  assert.equal(submitCalls, 1);

  var res = await handler(dlEvent({ id: 'dream-dup', src: 'https://fal.media/clean.mp4' })); // second, overlapping call
  var body = JSON.parse(res.body);
  assert.equal(body.status, 'processing');
  assert.equal(submitCalls, 1, 'must not submit a second, redundant fal job while one is already in flight for the same dream');
});

test('a fal submission failure surfaces a real error, never a silent "ready"', async function () {
  global.fetch = async function () {
    return { ok: false, status: 500, text: async function () { return JSON.stringify({ detail: 'fal is down' }); } };
  };
  var res = await handler(dlEvent({ id: 'dream-fail', src: 'https://fal.media/clean.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.status, 'error');
  assert.match(body.error, /^WD04/);
});

test('a new-job SUBMISSION is rate-limited per IP per day -- a client varying `id` on every request cannot generate unbounded real fal spend', async function () {
  process.env.MAX_DOWNLOAD_VIDEO_PER_IP_PER_DAY = '2';
  var submitCalls = 0;
  global.fetch = async function () {
    submitCalls++;
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ request_id: 'req-' + submitCalls }); } };
  };
  var event1 = fakeEvent({ method: 'GET', query: { id: 'dream-a', src: 'https://fal.media/a.mp4' }, ip: '1.2.3.4' });
  var event2 = fakeEvent({ method: 'GET', query: { id: 'dream-b', src: 'https://fal.media/b.mp4' }, ip: '1.2.3.4' });
  var event3 = fakeEvent({ method: 'GET', query: { id: 'dream-c', src: 'https://fal.media/c.mp4' }, ip: '1.2.3.4' });

  await handler(event1);
  await handler(event2);
  assert.equal(submitCalls, 2, 'first two distinct-dream submissions from this IP today are allowed');

  var res3 = await handler(event3);
  var body3 = JSON.parse(res3.body);
  assert.equal(body3.status, 'error');
  assert.match(body3.error, /^WD05/);
  assert.equal(submitCalls, 2, 'the third submission attempt must never reach fal once the per-IP cap is hit');

  delete process.env.MAX_DOWNLOAD_VIDEO_PER_IP_PER_DAY;
});

test('rate limiting only gates NEW submissions -- a cached-twin hit for a different dream is never blocked by another dream\'s rate-limited IP', async function () {
  process.env.MAX_DOWNLOAD_VIDEO_PER_IP_PER_DAY = '1';
  global.fetch = async function () {
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ request_id: 'req-only' }); } };
  };
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-videos-watermarked' }).set('dream-already-cached', new ArrayBuffer(4), { metadata: { contentType: 'video/mp4', byteLength: 4 } });

  var burnEvent = fakeEvent({ method: 'GET', query: { id: 'dream-burn', src: 'https://fal.media/burn.mp4' }, ip: '9.9.9.9' });
  await handler(burnEvent); // uses up the cap of 1 for this IP

  var cachedEvent = fakeEvent({ method: 'GET', query: { id: 'dream-already-cached', src: 'https://fal.media/x.mp4' }, ip: '9.9.9.9' });
  var res = await handler(cachedEvent);
  var body = JSON.parse(res.body);
  assert.equal(body.status, 'ready', 'a cache hit must still succeed even once this IP has exhausted its new-submission cap');

  delete process.env.MAX_DOWNLOAD_VIDEO_PER_IP_PER_DAY;
});
