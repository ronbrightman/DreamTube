// test/generate-video-model-rotation.test.js
//
// Covers generate-video.js's PixVerse V6 model-rotation routing added for
// tracker item for-product-new-edit-mechanism-founder-i-qmsdgj
// (docs/EDIT_MECHANISM_SPEC.md §2/§3.4) — founder-approved, cost-approved,
// live from day one, no flag gate. Exercises:
//   - `requestedModel: 'pixverse-v6'` routes the plain text-to-video branch
//     to callFalPixverse/FAL_MODEL_PIXVERSE_V6 instead of callFal/FAL_MODEL.
//   - a missing/unrecognized requestedModel keeps the default (veo3.1-lite)
//     path completely unchanged — this feature is purely additive.
//   - the response carries `modelUsed` matching whichever model actually ran.
//   - rotation is scoped OUT of the self-photo reference-to-video and
//     "turn this into a video" image-to-video paths (spec §3.6) — a
//     requestedModel on either of those is silently ignored, and the
//     response's modelUsed is null (rotation doesn't apply there).
//   - a rejected PixVerse submission surfaces the new E115 code.
//   - mock mode reports the same modelUsed a real request would, with no
//     real fal.ai call.

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

function nextIp() {
  ipCounter += 1;
  return '10.4.0.' + ipCounter;
}

var DEFAULT_EMAIL = 'modelrotation@example.com';

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
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
  return calls;
}

test.beforeEach(async function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.FAL_KEY;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
  await entitlements.setEntitlement({}, DEFAULT_EMAIL, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- Default (no requestedModel) behavior is unchanged -----

test('no requestedModel: plain text-to-video still uses the default FAL_MODEL, modelUsed reports veo3.1-lite', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.modelUsed, 'veo3.1-lite');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(genVideo.FAL_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('an unrecognized requestedModel value is silently ignored — default path runs unchanged', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { requestedModel: 'some-typo-model' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.modelUsed, 'veo3.1-lite');
  assert.doesNotMatch(calls[0].url, /pixverse/);
});

// ----- requestedModel: 'pixverse-v6' -----

test('requestedModel: pixverse-v6 routes the plain text-to-video branch to FAL_MODEL_PIXVERSE_V6, modelUsed reports pixverse-v6', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { requestedModel: 'pixverse-v6' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.modelUsed, 'pixverse-v6');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(genVideo.FAL_MODEL_PIXVERSE_V6.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(body.operationName.indexOf('fal:' + genVideo.FAL_MODEL_PIXVERSE_V6 + ':'), 0);
});

test('requestedModel: pixverse-v6 sends the no-expiry header, same as every other active fal submission', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, headers: opts && opts.headers });
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
  var res = await handler(genEvent({ body: { requestedModel: 'pixverse-v6' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(calls[0].headers['X-Fal-Object-Lifecycle-Preference']), { expiration_duration_seconds: null });
});

test('a rejected PixVerse submission is surfaced as E115, no tokens spent', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  global.fetch = async function () {
    return { ok: false, status: 422, json: async function () { return { detail: [{ msg: 'bad prompt' }] }; } };
  };
  var before = await entitlements.getTokenStatus(fakeEvent({}), DEFAULT_EMAIL, {});
  var res = await handler(genEvent({ body: { requestedModel: 'pixverse-v6' } }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E115: bad prompt/);
  var after = await entitlements.getTokenStatus(fakeEvent({}), DEFAULT_EMAIL, {});
  assert.equal(after.balance, before.balance, 'a rejected submission must not spend tokens');
});

// ----- Rotation scope: reference-to-video / image-to-video are excluded -----

test('requestedModel: pixverse-v6 is ignored on the self-photo reference-to-video path — modelUsed is null, rotation out of scope', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var calls = installFetchSpy();
  var res = await handler(genEvent({
    body: {
      requestedModel: 'pixverse-v6',
      characters: [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }]
    }
  }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.modelUsed, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /reference-to-video/);
  assert.doesNotMatch(calls[0].url, /pixverse/);
});

test('requestedModel: pixverse-v6 is ignored on the "turn this into a video" image-to-video path — modelUsed is null', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  var calls = installFetchSpy();
  var res = await handler(genEvent({
    body: { requestedModel: 'pixverse-v6', sourceImageUrl: 'https://fal.example/some-image.png' }
  }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.modelUsed, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /image-to-video/);
  assert.doesNotMatch(calls[0].url, /pixverse/);
});

// ----- Mock mode reports the same modelUsed, with zero real calls -----

test('mock mode + requestedModel: pixverse-v6 reports modelUsed: pixverse-v6, no real fal.ai call', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { requestedModel: 'pixverse-v6' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.modelUsed, 'pixverse-v6');
  assert.equal(calls.length, 0);
});

test('mock mode + no requestedModel reports modelUsed: veo3.1-lite', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).modelUsed, 'veo3.1-lite');
});

test('mock mode + requestedModel: pixverse-v6 but WITH a self-photo: rotation still out of scope, modelUsed null', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var res = await handler(genEvent({
    body: {
      requestedModel: 'pixverse-v6',
      characters: [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }]
    }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).modelUsed, null);
});

// ----- Exported constants -----

test('MODEL_KEY_VEO_LITE / MODEL_KEY_PIXVERSE_V6 / FAL_MODEL_PIXVERSE_V6 are exported with the spec-mandated literal values', function () {
  assert.equal(genVideo.MODEL_KEY_VEO_LITE, 'veo3.1-lite');
  assert.equal(genVideo.MODEL_KEY_PIXVERSE_V6, 'pixverse-v6');
  assert.equal(genVideo.FAL_MODEL_PIXVERSE_V6, 'fal-ai/pixverse/v6/text-to-video');
});

test('FAL_MODEL_PIXVERSE_V6 is env-configurable, matching this file\'s existing model-swap convention', function () {
  process.env.FAL_MODEL_PIXVERSE_V6 = 'fal-ai/pixverse/v7/text-to-video';
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  var reloaded = require('../netlify/functions/generate-video');
  assert.equal(reloaded.FAL_MODEL_PIXVERSE_V6, 'fal-ai/pixverse/v7/text-to-video');
  delete process.env.FAL_MODEL_PIXVERSE_V6;
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
});
