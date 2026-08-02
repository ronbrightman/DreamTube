// test/generate-video-image-to-video.test.js
//
// Covers the "Turn this into a video" upsell reactivation in
// netlify/functions/generate-video.js: an optional sourceImageUrl field on
// the POST body routes the request through the reactivated
// callFalImageToVideo (fal-ai/veo3.1/fast/image-to-video) instead of the
// normal text-to-video/reference-to-video paths, with its own E114
// rejection code (deliberately not E108/E111, which are retired) — see
// docs/IMAGE_GENERATION_SPEC.md §6 and generate-video.js's own doc
// comments for the full reasoning.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var genVideo = require('../netlify/functions/generate-video');
var handler = genVideo.handler;

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.30.0.' + ipCounter; }

var DEFAULT_EMAIL = 'imagetovideo@example.com';
var SOURCE_IMAGE_URL = 'https://fal.media/files/sample/original-image.png';

function genEvent(overrides) {
  return fakeEvent({
    method: 'POST',
    ip: (overrides && overrides.ip) || nextIp(),
    body: Object.assign({ caption: 'a dream about flying', style: 'Cartoon', email: DEFAULT_EMAIL }, overrides && overrides.body)
  });
}

function installFetchSpy() {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null, headers: opts && opts.headers });
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-i2v-request-id' }; } };
  };
  return calls;
}

function stubFetchRejected() {
  global.fetch = async function () {
    return { ok: false, status: 422, json: async function () { return { detail: 'nope' }; } };
  };
}

async function balance(email, amount) {
  return entitlements.setEntitlement({}, email, { tokens: { balance: amount, lastClaimAt: Date.now() } });
}

test.beforeEach(async function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.GENERATION_TEST_DURATION;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
  delete process.env.TURNSTILE_SECRET_KEY;
  await entitlements.setEntitlement({}, DEFAULT_EMAIL, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
});

test.after(function () {
  global.fetch = realFetch;
});

test('a sourceImageUrl request submits to fal-ai/veo3.1/fast/image-to-video with image_url set to it', async function () {
  var calls = installFetchSpy();
  // generate_audio is unconditionally false for every path in this file as
  // of tracker item for-product-turn-off-audio-dialogue-gene-ooeyoj
  // (founder directive 2026-08-02) -- audioOn is irrelevant now (this
  // request doesn't even send it) -- see
  // test/generate-video-audio-toggle.test.js for the full audioOn coverage
  // this file doesn't duplicate.
  var res = await handler(genEvent({ body: { sourceImageUrl: SOURCE_IMAGE_URL } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /image-to-video$/);
  assert.equal(calls[0].body.image_url, SOURCE_IMAGE_URL);
  assert.equal(calls[0].body.prompt.indexOf('a dream about flying'), 0);
  assert.equal(calls[0].body.aspect_ratio, '9:16');
  assert.equal(calls[0].body.duration, '8s');
  assert.equal(calls[0].body.generate_audio, false);
  // tracker item for-product-bug-build-re-host-image-drea-0hpbm0 — fal's
  // media-expiration docs say generated media (this animated video
  // included) is retained "for at least 7 days by default," so this
  // submission must disable that expiry or the published dream 404s
  // roughly a week after creation. See generate-video-mock.test.js's own
  // dedicated header tests for the other two active video call sites.
  assert.deepEqual(JSON.parse(calls[0].headers['X-Fal-Object-Lifecycle-Preference']), { expiration_duration_seconds: null });
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('fal:fal-ai/veo3.1/fast/image-to-video:'), 0);
});

test('a sourceImageUrl request honors GENERATION_TEST_DURATION exactly like the other two fal paths', async function () {
  process.env.GENERATION_TEST_DURATION = '4s';
  var calls = installFetchSpy();
  await handler(genEvent({ body: { sourceImageUrl: SOURCE_IMAGE_URL } }));
  assert.equal(calls[0].body.duration, '4s');
});

test('a fal rejection on the image-to-video path -> E114, no tokens spent', async function () {
  stubFetchRejected();
  await balance('i2v-rejected@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'i2v-rejected@example.com', sourceImageUrl: SOURCE_IMAGE_URL } }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E114:/);
  var record = await entitlements.getEntitlement({}, 'i2v-rejected@example.com');
  assert.equal(record.tokens.balance, 300, 'a rejected submission must not spend tokens');
});

test('a successful image-to-video submission spends the flat 100 tokens, same as any other video', async function () {
  installFetchSpy();
  await balance('i2v-spend@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'i2v-spend@example.com', sourceImageUrl: SOURCE_IMAGE_URL } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'i2v-spend@example.com');
  assert.equal(record.tokens.balance, 200);
});

test('sourceImageUrl takes priority over a self-photo reference-to-video request when both are somehow present — mutually exclusive per request', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({
    body: {
      sourceImageUrl: SOURCE_IMAGE_URL,
      characters: [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }]
    }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /image-to-video$/, 'must route to image-to-video, not reference-to-video, when sourceImageUrl is present');
});

test('the E112 token gate still applies before an image-to-video submission is ever attempted', async function () {
  var calls = 0;
  global.fetch = async function () { calls++; return { ok: true, status: 200, json: async function () { return { request_id: 'x' }; } }; };
  await balance('i2v-broke@example.com', 50);
  var res = await handler(genEvent({ body: { email: 'i2v-broke@example.com', sourceImageUrl: SOURCE_IMAGE_URL } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E112:/);
  assert.equal(calls, 0);
});

test('an empty-string sourceImageUrl is treated as absent — routes through the normal text-to-video path instead', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { sourceImageUrl: '' } }));
  assert.equal(res.statusCode, 200);
  // Asserts against the live, env-configurable FAL_MODEL export (see
  // generate-video.js — defaults to fal-ai/veo3.1/lite as of tracker item
  // for-product-switch-default-video-model-t-lqxafa) rather than a
  // hardcoded model string, so this doesn't need updating again the next
  // time the default text-to-video model changes.
  assert.equal(calls[0].url, 'https://queue.fal.run/' + genVideo.FAL_MODEL, 'an empty sourceImageUrl must not route to image-to-video');
});

test('callFalImageToVideo is exported and posts the expected body shape directly', async function () {
  var calls = installFetchSpy();
  var result = await genVideo.callFalImageToVideo('a test prompt', SOURCE_IMAGE_URL, 'test-fal-key', '6s', false);
  assert.equal(result.ok, true);
  assert.match(result.operationName, /^fal:fal-ai\/veo3\.1\/fast\/image-to-video:/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.image_url, SOURCE_IMAGE_URL);
  assert.equal(calls[0].body.duration, '6s');
  assert.equal(calls[0].body.generate_audio, false);
});

test('FAL_MODEL_IMAGE_TO_VIDEO is exported as the expected model id', function () {
  assert.equal(genVideo.FAL_MODEL_IMAGE_TO_VIDEO, 'fal-ai/veo3.1/fast/image-to-video');
});
