// test/content-gate-generation.test.js
//
// Behavioral coverage for the content-tier safety gate wired into the two
// generation chokepoints (generate-video.js — logged-in; start-pending-
// generation.js — pre-signup funnel) and the output-side re-check in
// publish-dream.js. The classifier's own network call is driven
// deterministically here via CONTENT_CLASSIFIER_MOCK_TIER (no real, paid LLM
// call — see the gate's own doc block), except the two fail-safe tests which
// leave it unset and stub a REAL classifier-error response by URL so the
// fail-open (normal) / fail-closed (named-photo) directions are exercised
// end-to-end through the handler.
//
// Asserts the founder's requirements: explicit text is blocked with no fal
// call and no token spend and the right message; romantic text proceeds;
// clean is unaffected; a named-other-person photo drops the threshold to
// block romantic too, with the named-person message; a self-photo keeps the
// normal romantic allowance; classifier errors fail open for the normal case
// and closed for the named-photo case; and the publish re-check blocks
// explicit from the public feed.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var entitlements = require('../netlify/functions/lib/entitlements');
var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
var cc = require('../netlify/functions/lib/content-classifier');

var genVideoHandler = require('../netlify/functions/generate-video').handler;
var genImageHandler = require('../netlify/functions/generate-image').handler;
var startPendingHandler = require('../netlify/functions/start-pending-generation').handler;
var publishHandler = require('../netlify/functions/publish-dream').handler;

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.9.0.' + ipCounter; }

/** Counts fal-submission fetches (the only fetch that happens once the classifier is mock-driven with no network call). */
function stubFalSpy() {
  var falCalls = 0;
  global.fetch = async function () {
    falCalls++;
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-id' }; } };
  };
  return function () { return falCalls; };
}

/** URL-distinguishing stub: classifier endpoint errors (to drive fail-open/closed), fal endpoint succeeds. */
function stubClassifierErrorFalOk() {
  var falCalls = 0;
  global.fetch = async function (url) {
    if (String(url).indexOf('openrouter') !== -1) {
      return { ok: false, status: 500, json: async function () { return {}; } };
    }
    falCalls++;
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-id' }; } };
  };
  return function () { return falCalls; };
}

async function balance(email, amount) {
  return entitlements.setEntitlement({}, email, { tokens: { balance: amount, lastClaimAt: Date.now() } });
}
async function bal(email) { return (await entitlements.getEntitlement({}, email)).tokens.balance; }

function genVideoEvent(body) {
  return fakeEvent({ method: 'POST', ip: nextIp(), body: Object.assign({ caption: 'a dream', style: 'Cartoon' }, body) });
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.CONTENT_CLASSIFIER_MOCK_TIER;
  delete process.env.OWNER_EMAIL;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
});
test.after(function () { global.fetch = realFetch; });

// ===== generate-video.js (logged-in chokepoint) =====

test('explicit -> E116 block: 422, NO fal call, NO token spend, explicit message', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  var falCount = stubFalSpy();
  await balance('exp@example.com', 300);
  var res = await genVideoHandler(genVideoEvent({ email: 'exp@example.com', caption: 'a graphic sexual scene' }));
  assert.equal(res.statusCode, 422);
  var err = JSON.parse(res.body).error;
  assert.match(err, /^E116: content_policy_blocked/);
  assert.match(err, /explicit sexual content/);
  assert.equal(falCount(), 0, 'no fal submission on a block');
  assert.equal(await bal('exp@example.com'), 300, 'no tokens spent on a block');
});

test('romantic -> ALLOWED: 200, fal called, tokens spent (mainstream romantic is not over-blocked)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var falCount = stubFalSpy();
  await balance('rom@example.com', 300);
  var res = await genVideoHandler(genVideoEvent({ email: 'rom@example.com', caption: 'a couple kiss in the rain' }));
  assert.equal(res.statusCode, 200);
  assert.equal(falCount(), 1);
  assert.equal(await bal('rom@example.com'), 200);
});

test('clean -> ALLOWED: 200, fal called, tokens spent', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  var falCount = stubFalSpy();
  await balance('cln@example.com', 300);
  var res = await genVideoHandler(genVideoEvent({ email: 'cln@example.com', caption: 'flying over mountains' }));
  assert.equal(res.statusCode, 200);
  assert.equal(falCount(), 1);
  assert.equal(await bal('cln@example.com'), 200);
});

test('named-other-person photo + romantic -> BLOCKED with the named-person message (anti-NCII), no spend', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var falCount = stubFalSpy();
  await balance('named@example.com', 300);
  var res = await genVideoHandler(genVideoEvent({
    email: 'named@example.com',
    caption: 'a romantic evening',
    characters: [{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 422);
  var err = JSON.parse(res.body).error;
  assert.match(err, /^E116: content_policy_blocked/);
  assert.match(err, /real person you've named and added a photo of/);
  assert.equal(falCount(), 0);
  assert.equal(await bal('named@example.com'), 300);
});

test('self-photo + romantic -> ALLOWED (self keeps the normal romantic allowance)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var falCount = stubFalSpy();
  await balance('self@example.com', 300);
  var res = await genVideoHandler(genVideoEvent({
    email: 'self@example.com',
    caption: 'a romantic evening',
    characters: [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(falCount(), 1, 'self-photo routes to reference-to-video and is allowed');
  assert.equal(await bal('self@example.com'), 200);
});

test('mock mode still enforces the gate: explicit is blocked even in GENERATION_MOCK_MODE (no token spend)', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  await balance('mockexp@example.com', 300);
  var res = await genVideoHandler(genVideoEvent({ email: 'mockexp@example.com', caption: 'explicit stuff' }));
  assert.equal(res.statusCode, 422);
  assert.equal(await bal('mockexp@example.com'), 300, 'mock mode must not spend tokens on a blocked dream');
});

test('classifier error on a NORMAL request -> FAILS OPEN: generation proceeds', async function () {
  var falCount = stubClassifierErrorFalOk();
  await balance('failopen@example.com', 300);
  var res = await genVideoHandler(genVideoEvent({ email: 'failopen@example.com', caption: 'anything' }));
  assert.equal(res.statusCode, 200);
  assert.equal(falCount(), 1, 'a classifier outage must not break generation for the normal case');
  assert.equal(await bal('failopen@example.com'), 200);
});

test('classifier error on a NAMED-PHOTO request -> FAILS CLOSED: blocked, no fal call, no spend', async function () {
  var falCount = stubClassifierErrorFalOk();
  await balance('failclosed@example.com', 300);
  var res = await genVideoHandler(genVideoEvent({
    email: 'failclosed@example.com',
    caption: 'anything',
    characters: [{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /real person you've named and added a photo of/);
  assert.equal(falCount(), 0, 'the NCII landmine must never slip through on a classifier error');
  assert.equal(await bal('failclosed@example.com'), 300);
});

test('explicit text hidden in a character DESCRIPTION is still caught (classifiable text folds descriptions)', async function () {
  // Not mock-driven: verify the real text-assembly path reaches the classifier.
  // Stub the classifier to answer 'explicit' only if the description text is present in the prompt.
  await balance('descbypass@example.com', 300);
  var sawDescription = false;
  global.fetch = async function (url, opts) {
    if (String(url).indexOf('openrouter') !== -1) {
      var body = opts && opts.body ? JSON.parse(opts.body) : {};
      var userMsg = (body.messages || []).map(function (m) { return m.content; }).join(' ');
      if (userMsg.indexOf('explicit-in-desc') !== -1) sawDescription = true;
      return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: '{"tier":"explicit"}' } }] }; } };
    }
    return { ok: true, status: 200, json: async function () { return { request_id: 'x' }; } };
  };
  var res = await genVideoHandler(genVideoEvent({
    email: 'descbypass@example.com',
    caption: 'a clean walk',
    characters: [{ name: 'Bob', isSelf: false, description: 'explicit-in-desc content' }]
  }));
  assert.equal(sawDescription, true, 'the character description must be part of the classified text');
  assert.equal(res.statusCode, 422);
});

// ===== generate-image.js (logged-in IMAGE chokepoint) =====
//
// Founder directive 2026-08-08 "same gate for both image and video": the
// image path mirrors generate-video.js's gate EXACTLY — same E116 code, same
// 422, same no-fal-call/no-token-spend on a block, same fail-open (normal) /
// fail-closed (named-photo) directions. Image token cost is 10 (not 100), so
// a 300-balance account lands at 290 after an allowed image.

function genImageEvent(body) {
  return fakeEvent({ method: 'POST', ip: nextIp(), body: Object.assign({ caption: 'a dream', style: 'Cartoon' }, body) });
}

test('image: explicit -> E116 block: 422, NO fal call, NO token spend, explicit message', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  var falCount = stubFalSpy();
  await balance('img-exp@example.com', 300);
  var res = await genImageHandler(genImageEvent({ email: 'img-exp@example.com', caption: 'a graphic sexual scene' }));
  assert.equal(res.statusCode, 422);
  var err = JSON.parse(res.body).error;
  assert.match(err, /^E116: content_policy_blocked/);
  assert.match(err, /explicit sexual content/);
  assert.equal(falCount(), 0, 'no fal submission on a block');
  assert.equal(await bal('img-exp@example.com'), 300, 'no tokens spent on a block');
});

test('image: suggestive/romantic (e.g. lingerie) -> ALLOWED: 200, fal called, 10 tokens spent (only true explicit is blocked)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var falCount = stubFalSpy();
  await balance('img-rom@example.com', 300);
  var res = await genImageHandler(genImageEvent({ email: 'img-rom@example.com', caption: 'a portrait in lingerie' }));
  assert.equal(res.statusCode, 200);
  assert.equal(falCount(), 1);
  assert.equal(await bal('img-rom@example.com'), 290);
});

test('image: clean -> ALLOWED: 200, fal called, 10 tokens spent', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  var falCount = stubFalSpy();
  await balance('img-cln@example.com', 300);
  var res = await genImageHandler(genImageEvent({ email: 'img-cln@example.com', caption: 'flying over mountains' }));
  assert.equal(res.statusCode, 200);
  assert.equal(falCount(), 1);
  assert.equal(await bal('img-cln@example.com'), 290);
});

test('image: named-other-person photo + romantic -> BLOCKED with the named-person message (anti-NCII), no spend', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var falCount = stubFalSpy();
  await balance('img-named@example.com', 300);
  var res = await genImageHandler(genImageEvent({
    email: 'img-named@example.com',
    caption: 'a romantic evening',
    characters: [{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 422);
  var err = JSON.parse(res.body).error;
  assert.match(err, /^E116: content_policy_blocked/);
  assert.match(err, /real person you've named and added a photo of/);
  assert.equal(falCount(), 0);
  assert.equal(await bal('img-named@example.com'), 300);
});

test('image: mock mode still enforces the gate: explicit is blocked even in GENERATION_MOCK_MODE (no token spend)', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  await balance('img-mockexp@example.com', 300);
  var res = await genImageHandler(genImageEvent({ email: 'img-mockexp@example.com', caption: 'explicit stuff' }));
  assert.equal(res.statusCode, 422);
  assert.equal(await bal('img-mockexp@example.com'), 300, 'mock mode must not spend tokens on a blocked image');
});

test('image: classifier error on a NORMAL request -> FAILS OPEN: generation proceeds', async function () {
  var falCount = stubClassifierErrorFalOk();
  await balance('img-failopen@example.com', 300);
  var res = await genImageHandler(genImageEvent({ email: 'img-failopen@example.com', caption: 'anything' }));
  assert.equal(res.statusCode, 200);
  assert.equal(falCount(), 1, 'a classifier outage must not break image generation for the normal case');
  assert.equal(await bal('img-failopen@example.com'), 290);
});

test('image: classifier error on a NAMED-PHOTO request -> FAILS CLOSED: blocked, no fal call, no spend', async function () {
  var falCount = stubClassifierErrorFalOk();
  await balance('img-failclosed@example.com', 300);
  var res = await genImageHandler(genImageEvent({
    email: 'img-failclosed@example.com',
    caption: 'anything',
    characters: [{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /real person you've named and added a photo of/);
  assert.equal(falCount(), 0, 'the NCII landmine must never slip through on a classifier error');
  assert.equal(await bal('img-failclosed@example.com'), 300);
});

// ===== start-pending-generation.js (pre-signup funnel chokepoint) =====

function startPendingEvent(body) {
  return fakeEvent({ method: 'POST', ip: nextIp(), body: Object.assign({ email: 'funnel@example.com', caption: 'a dream', style: 'Cartoon' }, body) });
}

test('funnel path: explicit -> E12 block: 422, NO fal call, NO spend', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  var falCount = stubFalSpy();
  await balance('funnel@example.com', 300);
  var res = await startPendingHandler(startPendingEvent({ caption: 'explicit sexual content' }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E12: content_policy_blocked/);
  assert.equal(falCount(), 0);
  assert.equal(await bal('funnel@example.com'), 300);
});

test('funnel path: named-other-person photo + romantic -> E12 block (anti-NCII)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var falCount = stubFalSpy();
  await balance('funnel2@example.com', 300);
  var res = await startPendingHandler(startPendingEvent({
    email: 'funnel2@example.com',
    caption: 'a romantic dream',
    characters: [{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /real person you've named and added a photo of/);
  assert.equal(falCount(), 0);
  assert.equal(await bal('funnel2@example.com'), 300);
});

test('funnel path: romantic -> ALLOWED (200 with a pendingId, tokens spent)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  stubFalSpy();
  await balance('funnel3@example.com', 300);
  var res = await startPendingHandler(startPendingEvent({ email: 'funnel3@example.com', caption: 'a sweet kiss' }));
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).pendingId);
  assert.equal(await bal('funnel3@example.com'), 200);
});

// ===== publish-dream.js (output-side re-check) =====

async function publishEvent(body) {
  var ownerHandle = body.ownerHandle || '@pub';
  var username = ownerHandle.charAt(0) === '@' ? ownerHandle.slice(1) : ownerHandle;
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), username);
  return fakeEvent({ method: 'POST', body: Object.assign({ ownerHandle: ownerHandle, authToken: token }, body) });
}
async function feedIndex() { return (await getStore('dreamtube-feed').get('feed-index')) || []; }

test('publish re-check: an explicit caption is blocked from the public feed (E9, ok:false, feed untouched)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  var res = await publishHandler(await publishEvent({ id: 'pd1', caption: 'explicit sexual content', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E9: content_policy_blocked/);
  assert.deepEqual(await feedIndex(), [], 'nothing explicit reaches the shared feed');
});

test('publish re-check: a romantic caption still reaches the public feed (output side is explicit-only)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var res = await publishHandler(await publishEvent({ id: 'pd2', caption: 'a romantic sunset kiss', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal((await feedIndex()).length, 1);
});

test('publish re-check: FAILS OPEN on classifier error (publish proceeds — generation gate is the primary defense)', async function () {
  global.fetch = async function (url) {
    if (String(url).indexOf('openrouter') !== -1) return { ok: false, status: 500, json: async function () { return {}; } };
    return { ok: true, status: 200, json: async function () { return {}; } };
  };
  var res = await publishHandler(await publishEvent({ id: 'pd3', caption: 'anything', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal((await feedIndex()).length, 1);
});
