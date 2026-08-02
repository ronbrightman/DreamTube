// test/image-status.test.js
//
// Covers netlify/functions/image-status.js: the mock path (checkMockStatus
// — much shorter simulated delay than video's, see that function's own doc
// comment), the active fal.ai path (checkFalImageStatus, reading
// resultData.images[0].url instead of video's resultData.video.url), and
// the E5xx error-code range. Same shape as test/video-status-mock.test.js,
// covers the real (non-mock) fal path too since flux/dev's queue API shape
// is otherwise identical to the video model's (status -> result).
//
// global.fetch is stubbed per-test (never the real network) except the one
// deliberate reachability check, matching video-status-mock.test.js's own
// discipline.

var test = require('node:test');
var assert = require('node:assert/strict');

// image-status.js's checkFalImageStatus now attempts a best-effort re-host
// into Blobs (lib/media-rehost.js — tracker item
// for-product-owner-media-library-page-fou-1fwxaw) once it resolves a real
// imageUrl, so this file needs a working Blobs mock like every other test
// exercising checkFalImageStatus's success path — installed BEFORE
// image-status.js is required, per this mock's own documented usage.
var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/image-status').handler;

var realFetch = global.fetch;

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = function () { throw new Error('image-status.js should not call fetch unless a test explicitly stubs it'); };
  delete process.env.FAL_KEY;
});

test.after(function () {
  global.fetch = realFetch;
});

function statusEvent(name) {
  return fakeEvent({ method: 'GET', query: { name: name } });
}

// ----- Validation -----

test('wrong method -> E501', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E501:/);
});

test('missing name -> E502', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E502:/);
});

test('an unrecognized operationName prefix (neither "mock:" nor "fal:") -> E502', async function () {
  var res = await handler(statusEvent('bogus:something'));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E502:/);
});

// ----- Mock path -----

test('mock operation still within the simulated delay window: done=false', async function () {
  var name = 'mock:' + Date.now() + ':abc123'; // just started
  var res = await handler(statusEvent(name));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.deepEqual(body, { done: false });
});

test('mock operation past the simulated (short) delay window: done=true with a working imageUrl', async function () {
  var name = 'mock:' + (Date.now() - 6000) + ':abc123'; // "started" 6s ago -- past image-status's 5s MOCK_DELAY_MS
  var res = await handler(statusEvent(name));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(typeof body.imageUrl, 'string');
  assert.match(body.imageUrl, /^https:\/\//);
  assert.ok(!body.error);
});

test('image mock mode resolves much faster than video mock mode (proportionate to a real flux/dev completion)', async function () {
  // 3s elapsed: past image-status's 5s window? No -- still within it. This
  // just documents/locks in that the window is materially shorter than
  // video-status.js's 20s, not an exact-value assertion on a private
  // constant.
  var stillWithin = await handler(statusEvent('mock:' + (Date.now() - 3000) + ':x'));
  assert.equal(JSON.parse(stillWithin.body).done, false);
  var past = await handler(statusEvent('mock:' + (Date.now() - 5500) + ':x'));
  assert.equal(JSON.parse(past.body).done, true);
});

test('malformed mock operationName (no parseable timestamp) resolves done=true rather than polling forever', async function () {
  var res = await handler(statusEvent('mock::not-a-number'));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(typeof body.imageUrl, 'string');
});

test('the resolved mock imageUrl is a real, reachable, publicly-hosted image', { timeout: 20000 }, async function () {
  global.fetch = realFetch; // this one test needs the real network to verify reachability
  var name = 'mock:' + (Date.now() - 6000) + ':abc123';
  var res = await handler(statusEvent(name));
  var imageUrl = JSON.parse(res.body).imageUrl;
  // GET, not HEAD -- picsum.photos (this mock URL's host) 405s on HEAD but
  // serves GET fine, and a real <img src> in the app only ever issues a GET
  // anyway, so this matches actual usage rather than an arbitrary probe method.
  var probe = await realFetch(imageUrl, { method: 'GET', redirect: 'follow' });
  assert.ok(probe.ok, 'expected the mock sample image URL to be reachable (HTTP ' + probe.status + ')');
  assert.match(probe.headers.get('content-type') || '', /^image\//);
});

// ----- Active (real fal) path -----

// NOTE: this stub's responses have no arrayBuffer() method, so any test
// below that reaches a real imageUrl also exercises the new best-effort
// re-host attempt (lib/media-rehost.js) hitting that same generic branch
// for the download itself -- it fails closed (see that module's own
// never-throws contract) and body.imageUrl stays exactly the raw fal url
// these tests already assert on. Re-host success/failure behavior itself
// is covered separately (test/media-rehost.test.js).
function stubStatusThenResult(statusBody, resultBody, resultOk) {
  var calls = [];
  global.fetch = async function (url) {
    calls.push(url);
    if (url.indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify(statusBody); } };
    }
    return { ok: resultOk !== false, status: resultOk === false ? 422 : 200, text: async function () { return JSON.stringify(resultBody); } };
  };
  return calls;
}

test('IN_QUEUE / IN_PROGRESS -> done:false, no result endpoint hit', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var calls = stubStatusThenResult({ status: 'IN_QUEUE' }, {});
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req1'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { done: false });
  assert.equal(calls.length, 1);
});

test('COMPLETED -> fetches the result endpoint and returns imageUrl from images[0].url', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  stubStatusThenResult({ status: 'COMPLETED' }, { images: [{ url: 'https://fal.media/files/sample.png' }] });
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req2'));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(body.imageUrl, 'https://fal.media/files/sample.png');
});

test('the status/result URLs route on just "owner/alias" (fal-ai/flux), not the full submission model id', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var calls = stubStatusThenResult({ status: 'COMPLETED' }, { images: [{ url: 'https://fal.media/x.png' }] });
  await handler(statusEvent('fal:fal-ai/flux/dev:req3'));
  assert.ok(calls[0].indexOf('/fal-ai/flux/requests/req3/status') !== -1, calls[0]);
  assert.ok(calls[1].indexOf('/fal-ai/flux/requests/req3') !== -1 && calls[1].indexOf('/status') === -1, calls[1]);
});

test('a non-IN_QUEUE/IN_PROGRESS/COMPLETED status -> E505 generation_failed', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  stubStatusThenResult({ status: 'FAILED' }, {});
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req4'));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.match(body.error, /^E505: generation_failed: FAILED/);
});

test('COMPLETED but the result has no images in it -> E508', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  stubStatusThenResult({ status: 'COMPLETED' }, { images: [] });
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req5'));
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.match(body.error, /^E508: no_image_in_response/);
});

test('non-JSON status response -> E503', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  global.fetch = async function () {
    return { ok: true, status: 200, text: async function () { return 'not json'; } };
  };
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req6'));
  assert.match(JSON.parse(res.body).error, /^E503:/);
});

test('non-OK status endpoint response -> E504', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  global.fetch = async function () {
    return { ok: false, status: 500, text: async function () { return JSON.stringify({ error: 'boom' }); } };
  };
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req7'));
  assert.match(JSON.parse(res.body).error, /^E504:/);
});

test('non-JSON result response (after a COMPLETED status) -> E506', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var first = true;
  global.fetch = async function (url) {
    if (url.indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ status: 'COMPLETED' }); } };
    }
    return { ok: true, status: 200, text: async function () { return 'not json'; } };
  };
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req8'));
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.match(body.error, /^E506:/);
});

test('non-OK result endpoint response (after a COMPLETED status) -> E507', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  stubStatusThenResult({ status: 'COMPLETED' }, { detail: 'content policy' }, false);
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req9'));
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.match(body.error, /^E507:/);
});

test('missing FAL_KEY on a "fal:" operationName -> E510', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req10'));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E510:/);
});

test('an uncaught exception in the handler -> E509', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  global.fetch = function () { throw new Error('boom'); };
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req11'));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E509:/);
});
