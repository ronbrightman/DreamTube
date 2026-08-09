// test/generate-video-vidu-reference.test.js
//
// Covers the Me-photo (reference-to-video) model switch, founder decision
// 2026-08-09: the self-photo path now defaults to fal.ai's Vidu Q1
// reference-to-video (~$0.40/video) instead of veo3.1/fast/reference-to-video
// (~$1.20/video, ~80% of model spend), with a transient-failure fallback to
// the old veo model so a Me-photo generation never just dies. See
// generate-video.js's FAL_MODEL_REFERENCE_TO_VIDEO / referenceToVideoBody /
// callFalReferenceToVideo for the full reasoning.
//
// Two distinct concerns are tested here:
//   1. Request SHAPE — Vidu and veo take different bodies (reference_image_urls
//      vs image_urls; Vidu has no duration/resolution/generate_audio,
//      movement_amplitude:'auto' instead). referenceToVideoBody branches on
//      the model id so an env override back to a veo id still sends the right
//      body.
//   2. FALLBACK POLICY — a plausibly-transient primary failure (thrown
//      network error, HTTP 5xx, HTTP 429) falls back once to veo; a
//      deterministic 4xx (bad request / content-policy rejection) does NOT
//      (surfaced as E106 instead), so a Vidu misconfig can't silently reroute
//      100% of Me-photo traffic back to the expensive model unnoticed.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

// Same content-tier isolation as test/generate-video-image-to-video.test.js:
// force the classifier to a deterministic 'clean' verdict so its own LLM
// fetch never counts as an extra call in the fetch-shape/count assertions
// below (those are about the fal submission, not the classifier).
process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var genVideo = require('../netlify/functions/generate-video');
var handler = genVideo.handler;

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.55.0.' + ipCounter; }

var DEFAULT_EMAIL = 'vidu-ref@example.com';
var SELF_PHOTO = 'data:image/png;base64,AAAA';

var VIDU_MODEL = 'fal-ai/vidu/q1/reference-to-video';
var VEO_MODEL = 'fal-ai/veo3.1/fast/reference-to-video';

function selfPhotoEvent(overrides) {
  return fakeEvent({
    method: 'POST',
    ip: (overrides && overrides.ip) || nextIp(),
    body: Object.assign(
      { caption: 'a dream about flying', style: 'Cartoon', email: DEFAULT_EMAIL,
        characters: [{ name: 'Me', isSelf: true, photoDataUrl: SELF_PHOTO }] },
      overrides && overrides.body
    )
  });
}

function okResp(requestId) {
  return { ok: true, status: 200, json: async function () { return { request_id: requestId }; } };
}
function errResp(status, detail) {
  return { ok: false, status: status, json: async function () { return { detail: detail }; } };
}

/**
 * Records every fetch call and routes the response by URL via `router(url)`,
 * so a test can make the Vidu endpoint fail while the veo endpoint succeeds
 * (or vice versa). A router returning a thrown error simulates a transport
 * failure.
 */
function installRoutedFetchSpy(router) {
  var calls = [];
  global.fetch = async function (url, opts) {
    var u = String(url);
    calls.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null, headers: opts && opts.headers });
    var r = router(u);
    if (r instanceof Error) throw r;
    return r;
  };
  return calls;
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

// ---------- Request shape (unit-level, exported helpers) ----------

test('isViduModel matches on the alias segment, not a bare substring', function () {
  assert.equal(genVideo.isViduModel('fal-ai/vidu/q1/reference-to-video'), true);
  assert.equal(genVideo.isViduModel('fal-ai/veo3.1/fast/reference-to-video'), false);
  // A different owner whose alias merely contains "vidu" must not match.
  assert.equal(genVideo.isViduModel('someowner/providum/x'), false);
});

test('referenceToVideoBody: Vidu shape — reference_image_urls list, movement_amplitude:auto, NO duration/resolution/generate_audio', function () {
  var body = genVideo.referenceToVideoBody(VIDU_MODEL, 'a prompt', SELF_PHOTO, '4s', false);
  assert.deepEqual(body.reference_image_urls, [SELF_PHOTO]);
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.movement_amplitude, 'auto');
  assert.equal(body.duration, undefined);
  assert.equal(body.resolution, undefined);
  assert.equal(body.generate_audio, undefined);
  assert.equal(body.image_urls, undefined, 'Vidu uses reference_image_urls, never veo\'s image_urls');
});

test('referenceToVideoBody: veo shape — image_urls list plus duration/resolution/generate_audio, honoring the passed values', function () {
  var body = genVideo.referenceToVideoBody(VEO_MODEL, 'a prompt', SELF_PHOTO, '6s', false);
  assert.deepEqual(body.image_urls, [SELF_PHOTO]);
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.duration, '6s');
  assert.equal(body.resolution, '720p');
  assert.equal(body.generate_audio, false);
  assert.equal(body.reference_image_urls, undefined);
  assert.equal(body.movement_amplitude, undefined);
});

test('a self-photo request submits to fal-ai/vidu/q1/reference-to-video with the Vidu body + no-expiry header, and encodes the vidu model in the operationName', async function () {
  var calls = installRoutedFetchSpy(function () { return okResp('vidu-req-1'); });
  var res = await handler(selfPhotoEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://queue.fal.run/' + VIDU_MODEL);
  assert.deepEqual(calls[0].body.reference_image_urls, [SELF_PHOTO]);
  assert.equal(calls[0].body.movement_amplitude, 'auto');
  assert.equal(calls[0].body.duration, undefined);
  assert.equal(calls[0].body.generate_audio, undefined);
  // fal media-expiration guard must be present on the Vidu submission too,
  // or the published dream's video 404s ~7 days after creation.
  assert.deepEqual(JSON.parse(calls[0].headers['X-Fal-Object-Lifecycle-Preference']), { expiration_duration_seconds: null });
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('fal:' + VIDU_MODEL + ':'), 0);
});

// ---------- Fallback policy ----------

test('Vidu 5xx (transient) falls back once to the veo reference-to-video model, with veo\'s own body shape, and succeeds', async function () {
  var calls = installRoutedFetchSpy(function (u) {
    return u.indexOf('/vidu/') !== -1 ? errResp(503, 'vidu temporarily unavailable') : okResp('veo-req-1');
  });
  var res = await handler(selfPhotoEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2, 'one failed Vidu call, one successful veo fallback call');
  assert.equal(calls[0].url, 'https://queue.fal.run/' + VIDU_MODEL);
  assert.equal(calls[1].url, 'https://queue.fal.run/' + VEO_MODEL);
  // fallback must use veo's body shape, not Vidu's
  assert.deepEqual(calls[1].body.image_urls, [SELF_PHOTO]);
  assert.equal(calls[1].body.duration, '8s');
  assert.equal(calls[1].body.generate_audio, false);
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('fal:' + VEO_MODEL + ':'), 0, 'operationName encodes the veo model that actually accepted the job, so video-status polls fal-ai/veo3.1');
});

test('Vidu 429 (rate limit) also falls back to veo', async function () {
  var calls = installRoutedFetchSpy(function (u) {
    return u.indexOf('/vidu/') !== -1 ? errResp(429, 'rate limited') : okResp('veo-req-2');
  });
  var res = await handler(selfPhotoEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://queue.fal.run/' + VEO_MODEL);
});

test('a thrown network error on the Vidu call falls back to veo', async function () {
  var calls = installRoutedFetchSpy(function (u) {
    return u.indexOf('/vidu/') !== -1 ? new Error('ECONNRESET') : okResp('veo-req-3');
  });
  var res = await handler(selfPhotoEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://queue.fal.run/' + VEO_MODEL);
});

test('Vidu 422 (content-policy / bad request) does NOT fall back — surfaced as E106, single call, no tokens spent', async function () {
  await balance('vidu-422@example.com', 300);
  var calls = installRoutedFetchSpy(function () { return errResp(422, 'content_policy'); });
  var res = await handler(selfPhotoEvent({ body: { email: 'vidu-422@example.com' } }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E106:/);
  assert.equal(calls.length, 1, 'a deterministic 4xx must not trigger the veo fallback');
  var record = await entitlements.getEntitlement({}, 'vidu-422@example.com');
  assert.equal(record.tokens.balance, 300, 'a rejected submission must not spend tokens');
});

test('a Vidu content-policy rejection on the reference photo shows the PHOTO-specific guidance (Vidu\'s field is reference_image_urls, not veo\'s image_urls) — E106, no fallback', async function () {
  var contentPolicyResp = {
    ok: false,
    status: 422,
    json: async function () {
      return { detail: [{ type: 'content_policy_violation', loc: ['body', 'reference_image_urls', 0], msg: 'flagged' }] };
    }
  };
  var calls = installRoutedFetchSpy(function () { return contentPolicyResp; });
  var res = await handler(selfPhotoEvent());
  assert.equal(res.statusCode, 422);
  assert.equal(calls.length, 1, 'a content-policy 4xx is deterministic — no veo fallback');
  var err = JSON.parse(res.body).error;
  assert.match(err, /^E106:/);
  assert.match(err, /reference photo was flagged/, 'must map the Vidu reference_image_urls location to the photo-specific guidance');
  assert.doesNotMatch(err, /description was flagged/);
});

test('Vidu 400 (bad request) does NOT fall back either — this is what makes a Vidu misconfig fail loudly instead of silently rerouting to veo', async function () {
  var calls = installRoutedFetchSpy(function () { return errResp(400, 'bad request'); });
  var res = await handler(selfPhotoEvent());
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E106:/);
  assert.equal(calls.length, 1);
});

test('both Vidu (5xx) and the veo fallback (5xx) failing -> E106, no tokens spent', async function () {
  await balance('vidu-both-fail@example.com', 300);
  var calls = installRoutedFetchSpy(function () { return errResp(500, 'everything down'); });
  var res = await handler(selfPhotoEvent({ body: { email: 'vidu-both-fail@example.com' } }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E106:/);
  assert.equal(calls.length, 2, 'Vidu 5xx triggers the veo fallback; both failing yields E106');
  var record = await entitlements.getEntitlement({}, 'vidu-both-fail@example.com');
  assert.equal(record.tokens.balance, 300);
});

test('a successful Vidu submission spends the flat 100 tokens, same as any other video (cost switch does not change the per-video token price)', async function () {
  await balance('vidu-spend@example.com', 300);
  installRoutedFetchSpy(function () { return okResp('vidu-req-spend'); });
  var res = await handler(selfPhotoEvent({ body: { email: 'vidu-spend@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'vidu-spend@example.com');
  assert.equal(record.tokens.balance, 200);
});

// ---------- callFalReferenceToVideo directly (the exported entry both real
// callers use — the handler here and start-pending-generation.js) ----------

test('callFalReferenceToVideo defaults to Vidu and returns a vidu-encoded operationName', async function () {
  installRoutedFetchSpy(function () { return okResp('direct-vidu'); });
  var result = await genVideo.callFalReferenceToVideo('a prompt', SELF_PHOTO, 'test-fal-key', '8s', false);
  assert.equal(result.ok, true);
  assert.match(result.operationName, /^fal:fal-ai\/vidu\/q1\/reference-to-video:/);
});

// ---------- Env rollback: primary already veo -> no pointless double-call ----------
//
// When FAL_MODEL_REFERENCE_TO_VIDEO is env-flipped back to the veo id, there
// is no different model to fall back TO, so a 5xx must return E106 after a
// SINGLE call (not retry the same veo endpoint twice). Uses a fresh module
// load with the env override, into a local binding, so the file's other
// tests (which use the default-Vidu `handler`) are unaffected.
test('env override FAL_MODEL_REFERENCE_TO_VIDEO=veo: a veo-primary 5xx does NOT double-call — single attempt, then E106', async function () {
  var prev = process.env.FAL_MODEL_REFERENCE_TO_VIDEO;
  process.env.FAL_MODEL_REFERENCE_TO_VIDEO = VEO_MODEL;
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  var genVeo = require('../netlify/functions/generate-video');
  try {
    assert.equal(genVeo.FAL_MODEL_REFERENCE_TO_VIDEO, VEO_MODEL);
    var calls = installRoutedFetchSpy(function () { return errResp(500, 'veo down'); });
    var res = await genVeo.handler(selfPhotoEvent());
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E106:/);
    assert.equal(calls.length, 1, 'primary already being veo means there is nothing different to fall back to');
    assert.equal(calls[0].url, 'https://queue.fal.run/' + VEO_MODEL);
    assert.deepEqual(calls[0].body.image_urls, [SELF_PHOTO], 'veo body shape when the override points at veo');
  } finally {
    if (prev === undefined) delete process.env.FAL_MODEL_REFERENCE_TO_VIDEO;
    else process.env.FAL_MODEL_REFERENCE_TO_VIDEO = prev;
    delete require.cache[require.resolve('../netlify/functions/generate-video')];
  }
});
