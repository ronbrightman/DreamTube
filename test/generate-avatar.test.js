// test/generate-avatar.test.js
//
// Covers netlify/functions/generate-avatar.js: every error code from its
// own header comment (E1-E8), the GENERATION_MOCK_MODE escape hatch, the
// per-IP rate limit's own 'avatar-ip' scope (independent of generate-
// video.js's 'ip' scope), the global daily cap's own 'avatar-global' scope
// (E8, defense-in-depth against many-IP abuse), and a successful call.
// fal.ai is stubbed via a
// fake global.fetch (same approach interpret-dream.test.js/generate-video-
// mock.test.js use) — these tests exercise this function's own logic
// (validation, rate limiting, response-shape handling, content-safety
// humanizing), never a live call to fal.ai. Blobs (used transitively via
// lib/rate-limit.js) is mocked the same way those suites mock it.
//
// Deliberately absent from this suite: any entitlements/token-balance
// assertion. generate-avatar.js never imports lib/entitlements.js at all
// (see that file's own header) — there is no token gate to test here,
// unlike generate-video-tokens.test.js's coverage of generate-video.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/generate-avatar').handler;

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.2.0.' + ipCounter;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function stubFetchOnce(response) {
  global.fetch = async function () { return response; };
}

/** A plausible successful flux/schnell response — shape confirmed against fal's live OpenAPI schema (see generate-avatar.js's own header). */
function sampleFalImageResponse(overrides) {
  return Object.assign({
    images: [{ url: 'https://fal.media/files/fake/avatar.jpeg', width: 512, height: 512, content_type: 'image/jpeg' }],
    has_nsfw_concepts: [false],
    seed: 1234,
    prompt: 'whatever'
  }, overrides);
}

/** Stubs fetch to return the fal image response first, then a tiny real-looking JPEG byte buffer for the follow-up download call. */
function stubFullSuccess(falOverrides) {
  var call = 0;
  global.fetch = async function (url) {
    call += 1;
    if (call === 1) {
      return { ok: true, status: 200, json: async function () { return sampleFalImageResponse(falOverrides); } };
    }
    // The image-download call (downloadAsDataUrl) — a minimal real fetch Response stand-in.
    // Uint8Array.from (not Buffer.from) deliberately here — Buffer.from([...])
    // for a small array is backed by Node's shared internal buffer pool, so
    // its .buffer is the whole multi-KB pool, not just these 4 bytes; a
    // fresh Uint8Array's .buffer is exactly the 4 bytes requested.
    return { ok: true, status: 200, arrayBuffer: async function () { return Uint8Array.from([1, 2, 3, 4]).buffer; } };
  };
}

function genEvent(overrides) {
  var base = {
    method: 'POST',
    ip: nextIp(),
    body: Object.assign({ description: 'a tall person with curly brown hair and glasses' }, overrides && overrides.body)
  };
  if (overrides && overrides.ip) base.ip = overrides.ip;
  if (overrides && 'body' in overrides && typeof overrides.body === 'string') base.body = overrides.body;
  return fakeEvent(base);
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.MAX_AVATAR_GENERATIONS_PER_IP_PER_DAY;
  delete process.env.MAX_AVATAR_GENERATIONS_PER_DAY_GLOBAL;
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- E1 -----

test('non-POST request is rejected E1', async function () {
  var res = await handler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

// ----- E2 -----

test('missing FAL_KEY is rejected E2', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E2: missing_api_key/);
});

test('missing FAL_KEY does NOT block mock mode', async function () {
  delete process.env.FAL_KEY;
  process.env.GENERATION_MOCK_MODE = 'true';
  var calls = 0;
  global.fetch = async function () { calls += 1; return { ok: true, json: async function () { return {}; } }; };
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 0, 'no real fal.ai call should ever fire in mock mode');
});

// ----- E3 -----

test('invalid JSON body is rejected E3', async function () {
  var res = await handler(genEvent({ body: '{not valid json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: invalid_json/);
});

// ----- E4 -----

test('missing description is rejected E4', async function () {
  var res = await handler(genEvent({ body: { description: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: description_required/);
});

test('whitespace-only description is rejected E4', async function () {
  var res = await handler(genEvent({ body: { description: '   ' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: description_required/);
});

test('E4 (and every other guardrail) never even reaches fetch', async function () {
  var calls = 0;
  global.fetch = async function () { calls += 1; return { ok: true, json: async function () { return {}; } }; };
  await handler(genEvent({ body: { description: '' } }));
  assert.equal(calls, 0);
});

// ----- E5 -----

test('exceeding the per-IP daily cap is rejected E5', async function () {
  process.env.MAX_AVATAR_GENERATIONS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  stubFullSuccess();
  var first = await handler(genEvent({ ip: ip }));
  assert.equal(first.statusCode, 200);
  stubFullSuccess();
  var second = await handler(genEvent({ ip: ip }));
  assert.equal(second.statusCode, 429);
  assert.match(JSON.parse(second.body).error, /^E5: rate_limited/);
});

test('a pre-tripped counter under the "avatar-ip" scope blocks the request without touching generate-video.js\'s "ip" scope key', async function () {
  var ip = nextIp();
  mockBlobs.seed('dreamtube-rate-limits', 'avatar-ip:' + todayUtc() + ':' + ip, 999999);
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E5: rate_limited/);
});

test('generate-video.js\'s own "ip" scope bucket does not affect this endpoint\'s rate limit', async function () {
  var ip = nextIp();
  mockBlobs.seed('dreamtube-rate-limits', 'ip:' + todayUtc() + ':' + ip, 999999);
  stubFullSuccess();
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 200);
});

// ----- E8 (global daily cap, defense-in-depth across every IP) -----

test('exceeding the global daily cap is rejected E8, even from a fresh IP that has never been seen before', async function () {
  process.env.MAX_AVATAR_GENERATIONS_PER_DAY_GLOBAL = '1';
  stubFullSuccess();
  var first = await handler(genEvent({ ip: nextIp() }));
  assert.equal(first.statusCode, 200);
  stubFullSuccess();
  var second = await handler(genEvent({ ip: nextIp() })); // a different IP -- the per-IP cap alone would let this through
  assert.equal(second.statusCode, 429);
  assert.match(JSON.parse(second.body).error, /^E8: rate_limited_global/);
});

test('a pre-tripped "avatar-global" counter blocks the request without touching the per-IP "avatar-ip" scope key', async function () {
  mockBlobs.seed('dreamtube-rate-limits', 'avatar-global:' + todayUtc() + ':global', 999999);
  var res = await handler(genEvent({ ip: nextIp() }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E8: rate_limited_global/);
});

test('mock mode: the global daily cap (E8) still applies', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  mockBlobs.seed('dreamtube-rate-limits', 'avatar-global:' + todayUtc() + ':global', 999999);
  var res = await handler(genEvent({ ip: nextIp() }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E8: rate_limited_global/);
});

// ----- E6 (fal rejected or flagged the prompt) -----

test('a non-ok fal response with a plain string detail is rejected E6', async function () {
  stubFetchOnce({ ok: false, status: 400, json: async function () { return { detail: 'bad request' }; } });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E6: bad request/);
});

test('a fal-style validation error (detail array) is rejected E6 with the extracted message', async function () {
  stubFetchOnce({ ok: false, status: 422, json: async function () { return { detail: [{ msg: 'field required', type: 'missing' }] }; } });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E6: field required/);
});

test('a content_policy_violation detail entry is rejected E6 with a humanized message, not the raw fal text', async function () {
  stubFetchOnce({ ok: false, status: 422, json: async function () { return { detail: [{ type: 'content_policy_violation', msg: 'some raw internal fal wording' }] }; } });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 422);
  var error = JSON.parse(res.body).error;
  assert.match(error, /^E6: /);
  assert.match(error, /flagged by the safety system/);
  assert.equal(error.indexOf('some raw internal fal wording'), -1, 'the raw fal wording must never leak to the client');
});

test('a 200 response flagging has_nsfw_concepts is rejected E6 rather than handed back as a real avatar', async function () {
  stubFetchOnce({ ok: true, status: 200, json: async function () { return sampleFalImageResponse({ has_nsfw_concepts: [true] }); } });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 422);
  var error = JSON.parse(res.body).error;
  assert.match(error, /^E6: /);
  assert.match(error, /flagged by the safety system/);
});

// ----- E7 (couldn't reach fal, or couldn't turn the response into a photoDataUrl) -----

test('a network failure reaching fal at all is rejected E7', async function () {
  global.fetch = async function () { throw new Error('ECONNRESET'); };
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E7: fal_request_failed/);
});

test('a 200 response with no images array is rejected E7', async function () {
  stubFetchOnce({ ok: true, status: 200, json: async function () { return { images: [], has_nsfw_concepts: [] }; } });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E7: fal_returned_no_image/);
});

test('a failure downloading the returned image URL is rejected E7', async function () {
  var call = 0;
  global.fetch = async function () {
    call += 1;
    if (call === 1) return { ok: true, status: 200, json: async function () { return sampleFalImageResponse(); } };
    return { ok: false, status: 404 }; // the image-download call fails
  };
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E7: avatar_image_download_failed/);
});

// ----- GENERATION_MOCK_MODE -----

test('mock mode: 200 response shaped { photoDataUrl }, a data: URI, no real fal.ai call fires', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var calls = 0;
  global.fetch = async function () { calls += 1; return { ok: true, json: async function () { return {}; } }; };
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(typeof body.photoDataUrl, 'string');
  assert.equal(body.photoDataUrl.indexOf('data:image/'), 0);
  assert.equal(calls, 0, 'no real fal.ai call should ever fire in mock mode');
});

test('mock mode: only the exact string "true" turns it on — any other value behaves as unset (real path)', async function () {
  process.env.GENERATION_MOCK_MODE = 'yes';
  stubFullSuccess();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.photoDataUrl.indexOf('data:image/jpeg'), 0);
});

test('mock mode: validation (E4) still runs — no fetch at all', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var calls = 0;
  global.fetch = async function () { calls += 1; return { ok: true, json: async function () { return {}; } }; };
  var res = await handler(genEvent({ body: { description: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4:/);
  assert.equal(calls, 0);
});

test('mock mode: the per-IP rate limit (E5) still applies', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var ip = nextIp();
  mockBlobs.seed('dreamtube-rate-limits', 'avatar-ip:' + todayUtc() + ':' + ip, 999999);
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E5: rate_limited/);
});

// ----- Success -----

test('a normal description succeeds and is returned as { photoDataUrl } built from the downloaded image bytes', async function () {
  stubFullSuccess();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.photoDataUrl, 'data:image/jpeg;base64,' + Buffer.from(Uint8Array.from([1, 2, 3, 4])).toString('base64'));
});

// ----- content_type whitelist (downloadAsDataUrl) -----
//
// image.content_type comes verbatim from fal's own JSON response and flows
// straight into the data: URI this handler returns, which both profile.html
// and create.html then use as an innerHTML-built <img src="...">. It must
// be whitelisted before use, unlike the canvas.toDataURL() upload path
// where that segment is always the literal 'image/jpeg' the browser itself
// produced.

test('an allowed content_type (png) from fal is used as-is in the returned data: URI', async function () {
  stubFullSuccess({ images: [{ url: 'https://fal.media/files/fake/avatar.png', width: 512, height: 512, content_type: 'image/png' }] });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.photoDataUrl.indexOf('data:image/png;base64,'), 0);
});

test('an allowed content_type (webp) from fal is used as-is in the returned data: URI', async function () {
  stubFullSuccess({ images: [{ url: 'https://fal.media/files/fake/avatar.webp', width: 512, height: 512, content_type: 'image/webp' }] });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.photoDataUrl.indexOf('data:image/webp;base64,'), 0);
});

test('a malformed/unexpected content_type from fal falls back to the safe default (image/jpeg) rather than being trusted verbatim', async function () {
  stubFullSuccess({ images: [{ url: 'https://fal.media/files/fake/avatar', width: 512, height: 512, content_type: 'text/html"><script>alert(1)</script>' } ] });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.photoDataUrl.indexOf('data:image/jpeg;base64,'), 0, 'an unwhitelisted content_type must never reach the returned data: URI verbatim');
  assert.equal(body.photoDataUrl.indexOf('script'), -1);
});

test('a missing content_type from fal still falls back to the safe default (image/jpeg), same as before', async function () {
  stubFullSuccess({ images: [{ url: 'https://fal.media/files/fake/avatar', width: 512, height: 512 }] });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.photoDataUrl.indexOf('data:image/jpeg;base64,'), 0);
});

test('the request sent to fal uses the synchronous direct endpoint (fal.run, not queue.fal.run) and carries the description text in the prompt', async function () {
  var capturedUrl = null;
  var capturedBody = null;
  var call = 0;
  global.fetch = async function (url, opts) {
    call += 1;
    if (call === 1) {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async function () { return sampleFalImageResponse(); } };
    }
    return { ok: true, status: 200, arrayBuffer: async function () { return Uint8Array.from([9]).buffer; } };
  };
  var res = await handler(genEvent({ body: { description: 'freckles and a red beard' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(capturedUrl, 'https://fal.run/fal-ai/flux/schnell');
  assert.ok(capturedBody.prompt.indexOf('freckles and a red beard') !== -1);
  assert.equal(capturedBody.image_size.width, 512);
  assert.equal(capturedBody.image_size.height, 512);
  assert.equal(capturedBody.enable_safety_checker, true);
});

test('no entitlements/token check exists on this path — a request works with no email/account context at all', async function () {
  stubFullSuccess();
  var res = await handler(genEvent({ body: {} }));
  assert.equal(res.statusCode, 200);
});
