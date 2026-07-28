// test/video-status-model-agnostic.test.js
//
// Regression coverage for tracker item
// for-product-switch-default-video-model-t-lqxafa (the veo3.1/lite default
// switch): video-status.js's checkFalStatus/falAppBase must derive the
// polling URL from whatever model string is embedded in the operationName
// it's handed ("fal:<model>:<request_id>", written by generate-video.js at
// submission time), NOT from any hardcoded "fast" (or "lite") literal of
// its own — otherwise switching generate-video.js's default model would
// silently break polling for every in-flight job.
//
// falAppBase(model) is confirmed (by reading it) to use only the first two
// "/"-separated segments of the model string (fal's own queue API routes
// on just the app owner/alias, e.g. "fal-ai/veo3.1" — see that function's
// own doc comment for why using the full model id 404s/405s). These tests
// exercise that end to end through the real handler, for both the new Lite
// default and the still-Fast reference-to-video/image-to-video paths, and
// additionally for a deliberately-invented model string to prove the
// behavior is genuinely driven by the operationName rather than an
// allowlist of known models.

var test = require('node:test');
var assert = require('node:assert/strict');

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/video-status').handler;

var realFetch = global.fetch;

test.beforeEach(function () {
  process.env.FAL_KEY = 'test-fal-key';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.FAL_KEY;
});

function statusEvent(name) {
  return fakeEvent({ method: 'GET', query: { name: name } });
}

/** Stubs fetch to record every URL hit and return a COMPLETED result with a video. */
function stubFalCompleted() {
  var urls = [];
  global.fetch = async function (url) {
    urls.push(String(url));
    if (String(url).indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    return { ok: true, status: 200, text: async function () { return JSON.stringify({ video: { url: 'https://example.com/vid.mp4' } }); } };
  };
  return urls;
}

test('a fal-ai/veo3.1/lite operationName (the new default) polls fal-ai/veo3.1, not a hardcoded /fast path', async function () {
  var urls = stubFalCompleted();
  var res = await handler(statusEvent('fal:fal-ai/veo3.1/lite:req-abc'));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).done, true);
  assert.deepEqual(urls, [
    'https://queue.fal.run/fal-ai/veo3.1/requests/req-abc/status',
    'https://queue.fal.run/fal-ai/veo3.1/requests/req-abc'
  ], 'the variant segment ("lite") must be dropped from the polling URL, not hardcoded to "fast" or carried through as-is');
});

test('a fal-ai/veo3.1/fast/reference-to-video operationName (unchanged Me-photo path) still polls the same fal-ai/veo3.1 app base', async function () {
  var urls = stubFalCompleted();
  var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast/reference-to-video:req-ref-1'));
  assert.equal(res.statusCode, 200);
  assert.ok(urls.every(function (u) { return u.indexOf('/fal-ai/veo3.1/requests/req-ref-1') !== -1; }), JSON.stringify(urls));
});

test('a fal-ai/veo3.1/fast/image-to-video operationName (unchanged upsell path) still polls the same fal-ai/veo3.1 app base', async function () {
  var urls = stubFalCompleted();
  var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast/image-to-video:req-img-1'));
  assert.equal(res.statusCode, 200);
  assert.ok(urls.every(function (u) { return u.indexOf('/fal-ai/veo3.1/requests/req-img-1') !== -1; }), JSON.stringify(urls));
});

test('an entirely invented model string is still handled purely structurally (owner/alias segments), proving this is not a hardcoded-model allowlist', async function () {
  var urls = stubFalCompleted();
  var res = await handler(statusEvent('fal:some-owner/some-future-model/some-variant:req-future-1'));
  assert.equal(res.statusCode, 200);
  assert.ok(urls.every(function (u) { return u.indexOf('/some-owner/some-future-model/requests/req-future-1') !== -1; }), JSON.stringify(urls));
});
