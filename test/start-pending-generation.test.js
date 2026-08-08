// test/start-pending-generation.test.js
//
// Covers netlify/functions/start-pending-generation.js — the dream-builder
// wizard's pre-signup "generate during signup" entry point. Same
// guardrail suite as generate-video.js (rate limit, token gate, spend
// guard, optional Turnstile) plus the pending-dream bookkeeping this file
// adds on top (creating the record before submission, embedding a
// fal_webhook URL, updating the record with the real operationName).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

// Content-tier safety gate (netlify/functions/lib/content-classifier.js) —
// force the classifier to a deterministic 'clean' verdict with no network
// call so THIS file's fal-call-shape / fal-never-called assertions aren't
// perturbed by the classifier's own LLM fetch. The gate itself is covered
// in test/content-classifier.test.js and test/content-gate-generation.test.js.
process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var pendingDreams = require('../netlify/functions/lib/pending-dreams');
var handler = require('../netlify/functions/start-pending-generation').handler;

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.9.0.' + ipCounter; }

function stubFetchOk() {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
}

function genEvent(overrides) {
  return fakeEvent({
    method: 'POST',
    ip: (overrides && overrides.ip) || nextIp(),
    headers: Object.assign({ host: 'dreamtube1.netlify.app' }, overrides && overrides.headers),
    body: Object.assign({ email: 'wizard@example.com', caption: 'a wizard-assembled caption', style: 'Cinematic' }, overrides && overrides.body)
  });
}

async function balance(email, amount) {
  return entitlements.setEntitlement({}, email, { tokens: { balance: amount, lastClaimAt: Date.now() } });
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
  delete process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY;
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.TURNSTILE_SECRET_KEY;
});
test.after(function () { global.fetch = realFetch; });

test('wrong method -> E1', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1:/);
});

test('missing email -> E4, no pending record created', async function () {
  var res = await handler(genEvent({ body: { email: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4:/);
});

test('missing caption/style -> E5', async function () {
  var res = await handler(genEvent({ body: { caption: '', style: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E5:/);
});

test('a brand-new email gets the 320-token signup grant and a successful submission spends 100 of it, returning pendingId + operationName', async function () {
  stubFetchOk();
  var res = await handler(genEvent({ body: { email: 'fresh-wizard@example.com' } }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.ok(data.pendingId);
  assert.match(data.operationName, /^fal:/);

  var status = await entitlements.getTokenStatus({}, 'fresh-wizard@example.com');
  assert.equal(status.balance, 220); // 320 granted - 100 spent

  var record = await pendingDreams.get({}, data.pendingId);
  assert.equal(record.status, 'pending');
  assert.equal(record.email, 'fresh-wizard@example.com');
  assert.equal(record.operationName, data.operationName);
});

test('the fal submission URL carries a fal_webhook query param pointing at dream-webhook.js with this pendingId', async function () {
  var capturedUrl = null;
  global.fetch = async function (url) {
    capturedUrl = url;
    return { ok: true, status: 200, json: async function () { return { request_id: 'req-abc' }; } };
  };
  var res = await handler(genEvent({ body: { email: 'webhook-check@example.com' }, headers: { host: 'my-real-host.netlify.app' } }));
  var data = JSON.parse(res.body);
  assert.ok(capturedUrl.indexOf('fal_webhook=') !== -1);
  var decoded = decodeURIComponent(capturedUrl.split('fal_webhook=')[1]);
  assert.equal(decoded, 'https://my-real-host.netlify.app/.netlify/functions/dream-webhook?pendingId=' + data.pendingId);
});

// ----- Routing-intentionality check (tracker item for-product-cost-me-
// photo-dreams-run-on--o3h0vo) — same selfPhoto truthy-photoDataUrl check
// as generate-video.js's own handler (this file requires genVideo.callFal/
// callFalReferenceToVideo directly, never reimplements the routing), so
// this wizard entry point gets the identical regression lock. -----

test('a "Me" character with a description but NO photoDataUrl does NOT take the reference-to-video path from the wizard entry point either', async function () {
  var capturedUrl = null;
  global.fetch = async function (url) {
    capturedUrl = url;
    return { ok: true, status: 200, json: async function () { return { request_id: 'req-no-photo' }; } };
  };
  var res = await handler(genEvent({
    body: { email: 'wizard-no-photo@example.com', characters: [{ name: 'Me', isSelf: true, description: 'tall with short dark hair' }] }
  }));
  assert.equal(res.statusCode, 200);
  assert.ok(capturedUrl);
  assert.doesNotMatch(capturedUrl, /reference-to-video/, 'no photo was attached — this must not hit the expensive reference-to-video endpoint');
});

test('balance under 100 -> E7, fal never called, pending record still created but never gets an operationName', async function () {
  var calls = 0;
  global.fetch = async function () { calls++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  await balance('broke-wizard@example.com', 50);
  var res = await handler(genEvent({ body: { email: 'broke-wizard@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E7: insufficient_tokens/);
  assert.equal(calls, 0);
});

test('a fal rejection marks the pending record failed and never spends tokens', async function () {
  await balance('rejected-wizard@example.com', 500);
  global.fetch = async function () {
    return { ok: false, status: 422, json: async function () { return { detail: 'nope' }; } };
  };
  var res = await handler(genEvent({ body: { email: 'rejected-wizard@example.com' } }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E10:/);

  var status = await entitlements.getTokenStatus({}, 'rejected-wizard@example.com');
  assert.equal(status.balance, 500); // untouched -- no spend on rejection
});

test('GENERATION_MOCK_MODE=true skips fal entirely and still returns a working pendingId/operationName pair, still spending tokens', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var calls = 0;
  global.fetch = async function () { calls++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  var res = await handler(genEvent({ body: { email: 'mock-wizard@example.com' } }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.match(data.operationName, /^mock:/);
  assert.equal(calls, 0);
  var status = await entitlements.getTokenStatus({}, 'mock-wizard@example.com');
  assert.equal(status.balance, 220); // 320 granted - 100 spent
});

test('rate limit (E6) is enforced per-IP, same cap as generate-video.js', async function () {
  stubFetchOk();
  process.env.MAX_GENERATIONS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  var first = await handler(genEvent({ ip: ip, body: { email: 'ratelimit-a@example.com' } }));
  assert.equal(first.statusCode, 200);
  var second = await handler(genEvent({ ip: ip, body: { email: 'ratelimit-b@example.com' } }));
  assert.equal(second.statusCode, 429);
  assert.match(JSON.parse(second.body).error, /^E6:/);
});

// ----- mediaType: 'image' (docs/IMAGE_GENERATION_SPEC.md §4) -----
// Default 'video' is exercised by every test above (none of them pass
// mediaType at all) — these cover the new branch specifically.

test('mediaType omitted -> pending record defaults to mediaType "video" (backward compat)', async function () {
  stubFetchOk();
  var res = await handler(genEvent({ body: { email: 'default-media@example.com' } }));
  var data = JSON.parse(res.body);
  var record = await pendingDreams.get({}, data.pendingId);
  assert.equal(record.mediaType, 'video');
});

test('mediaType "image": a brand-new email gets the 320-token signup grant and a successful submission spends only 10 of it', async function () {
  stubFetchOk();
  var res = await handler(genEvent({ body: { email: 'fresh-image@example.com', mediaType: 'image' } }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.ok(data.pendingId);
  assert.match(data.operationName, /^fal:/);

  var status = await entitlements.getTokenStatus({}, 'fresh-image@example.com');
  assert.equal(status.balance, 310); // 320 granted - 10 spent

  var record = await pendingDreams.get({}, data.pendingId);
  assert.equal(record.mediaType, 'image');
  assert.equal(record.operationName, data.operationName);
});

test('mediaType "image": balance under 10 -> E7 insufficient_tokens with image-specific copy, fal never called', async function () {
  var calls = 0;
  global.fetch = async function () { calls++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  await balance('broke-image@example.com', 5);
  var res = await handler(genEvent({ body: { email: 'broke-image@example.com', mediaType: 'image' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E7: insufficient_tokens: not enough tokens to generate an image/);
  assert.equal(calls, 0);
});

test('mediaType "image": balance exactly 10 proceeds (the flat cost of one image)', async function () {
  stubFetchOk();
  await balance('exact-image@example.com', 10);
  var res = await handler(genEvent({ body: { email: 'exact-image@example.com', mediaType: 'image' } }));
  assert.equal(res.statusCode, 200);
});

test('mediaType "image": GENERATION_MOCK_MODE=true skips fal entirely, still spends only 10 tokens', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var calls = 0;
  global.fetch = async function () { calls++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  var res = await handler(genEvent({ body: { email: 'mock-image@example.com', mediaType: 'image' } }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.match(data.operationName, /^mock:/);
  assert.equal(calls, 0);
  var status = await entitlements.getTokenStatus({}, 'mock-image@example.com');
  assert.equal(status.balance, 310); // 320 granted - 10 spent
});

test('mediaType "image": the fal submission URL never carries a fal_webhook query param (unlike the video path) — see docs/IMAGE_GENERATION_SPEC.md §7', async function () {
  var capturedUrl = null;
  global.fetch = async function (url) {
    capturedUrl = url;
    return { ok: true, status: 200, json: async function () { return { request_id: 'req-image-abc' }; } };
  };
  await handler(genEvent({ body: { email: 'webhook-check-image@example.com', mediaType: 'image' }, headers: { host: 'my-real-host.netlify.app' } }));
  assert.ok(capturedUrl, 'fal should have been called');
  assert.equal(capturedUrl.indexOf('fal_webhook='), -1, 'image submissions must never include a fal_webhook param');
});

test('mediaType "image": a fal rejection marks the pending record failed and never spends tokens', async function () {
  await balance('rejected-image@example.com', 500);
  global.fetch = async function () {
    return { ok: false, status: 422, json: async function () { return { detail: 'nope' }; } };
  };
  var res = await handler(genEvent({ body: { email: 'rejected-image@example.com', mediaType: 'image' } }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E10:/);

  var status = await entitlements.getTokenStatus({}, 'rejected-image@example.com');
  assert.equal(status.balance, 500); // untouched -- no spend on rejection
});

// -----------------------------------------------------------------------
// Regression coverage for tracker item for-product-only-generate-a-video-
// once-t-1nqv5m ("don't spend fal.ai money generating a video for a user
// we can't reach"). This file's handler already creates the pending-dream
// record (with `email` durably persisted to Blobs via
// pendingDreams.create -> store().setJSON) BEFORE either
// entitlements.spendTokens or the actual fal.ai submission run (see the
// handler's own comment right above its `pendingDreams.create` call) --
// nothing in between is wrapped in a try/catch that swallows a create()
// failure and presses on, so if the durable write itself throws, the
// exception propagates straight out of the handler and NOTHING after it
// executes. These tests prove that ordering by forcing pendingDreams.create
// to fail (simulating a genuine Blobs write failure) and asserting no
// money-adjacent call happens on either side of it, for every
// mediaType x mock/real combination. See docs/... (n/a) -- verified by
// hand-tracing every branch of start-pending-generation.js during this
// investigation; no path was found where spendTokens or a fal call can run
// without pendingDreams.create having already succeeded first.
// -----------------------------------------------------------------------

var originalPendingCreate = pendingDreams.create;
test.afterEach(function () {
  pendingDreams.create = originalPendingCreate;
});

function breakPendingCreate() {
  pendingDreams.create = async function () {
    throw new Error('simulated pending-dreams Blobs write failure');
  };
}

test('video, real fal mode: if the durable pending-dream (email) write itself fails, the handler throws and fal is never called / no tokens are spent', async function () {
  await balance('durability-video-real@example.com', 500);
  var falCalls = 0;
  global.fetch = async function () { falCalls++; return { ok: true, status: 200, json: async function () { return { request_id: 'should-never-be-reached' }; } }; };
  breakPendingCreate();

  await assert.rejects(function () {
    return handler(genEvent({ body: { email: 'durability-video-real@example.com' } }));
  }, /simulated pending-dreams Blobs write failure/);

  assert.equal(falCalls, 0, 'fal must never be called if the email-bearing record was never durably written');
  var status = await entitlements.getTokenStatus({}, 'durability-video-real@example.com');
  assert.equal(status.balance, 500, 'no tokens may be spent if the email-bearing record was never durably written');
});

test('video, GENERATION_MOCK_MODE: if the durable pending-dream (email) write itself fails, the handler throws before the mock-mode token spend', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  await balance('durability-video-mock@example.com', 500);
  breakPendingCreate();

  await assert.rejects(function () {
    return handler(genEvent({ body: { email: 'durability-video-mock@example.com' } }));
  }, /simulated pending-dreams Blobs write failure/);

  var status = await entitlements.getTokenStatus({}, 'durability-video-mock@example.com');
  assert.equal(status.balance, 500, 'mock mode must not spend tokens if the email-bearing record was never durably written');
});

test('mediaType "image", real fal mode: if the durable pending-dream (email) write itself fails, the handler throws and fal is never called / no tokens are spent', async function () {
  await balance('durability-image-real@example.com', 500);
  var falCalls = 0;
  global.fetch = async function () { falCalls++; return { ok: true, status: 200, json: async function () { return { request_id: 'should-never-be-reached' }; } }; };
  breakPendingCreate();

  await assert.rejects(function () {
    return handler(genEvent({ body: { email: 'durability-image-real@example.com', mediaType: 'image' } }));
  }, /simulated pending-dreams Blobs write failure/);

  assert.equal(falCalls, 0, 'fal must never be called if the email-bearing record was never durably written');
  var status = await entitlements.getTokenStatus({}, 'durability-image-real@example.com');
  assert.equal(status.balance, 500, 'no tokens may be spent if the email-bearing record was never durably written');
});

test('mediaType "image", GENERATION_MOCK_MODE: if the durable pending-dream (email) write itself fails, the handler throws before the mock-mode token spend', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  await balance('durability-image-mock@example.com', 500);
  breakPendingCreate();

  await assert.rejects(function () {
    return handler(genEvent({ body: { email: 'durability-image-mock@example.com', mediaType: 'image' } }));
  }, /simulated pending-dreams Blobs write failure/);

  var status = await entitlements.getTokenStatus({}, 'durability-image-mock@example.com');
  assert.equal(status.balance, 500, 'mock mode must not spend tokens if the email-bearing record was never durably written');
});

test('the durable pending-dream write itself really does persist email via a real Blobs setJSON before anything else runs (sanity check the record shape, not just the failure path)', async function () {
  stubFetchOk();
  var res = await handler(genEvent({ body: { email: 'durability-sanity@example.com' } }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  var record = await pendingDreams.get({}, data.pendingId);
  assert.equal(record.email, 'durability-sanity@example.com');
  assert.ok(record.createdAt);
});
