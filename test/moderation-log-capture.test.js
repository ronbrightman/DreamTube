// test/moderation-log-capture.test.js
//
// Proves the MODERATION LOG capture hooks (founder-approved 2026-08-14) fire at
// every content-block emission point in generate-video.js / generate-image.js:
// a REFUSED generation writes exactly one moderation-log record (blocked prompt
// text + reason + mediaType + user + source), while an ALLOWED generation
// writes none. The classifier is driven deterministically via
// CONTENT_CLASSIFIER_MOCK_TIER (no real paid LLM call — same discipline as
// test/content-gate-generation.test.js, which this mirrors). The fal-side
// content_policy_violation path is driven by stubbing the fal submission fetch
// to reject with a content_policy_violation detail.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var moderationLogStore = require('../netlify/functions/lib/moderation-log-store');

var genVideoHandler = require('../netlify/functions/generate-video').handler;
var genImageHandler = require('../netlify/functions/generate-image').handler;

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.44.0.' + ipCounter; }

function stubFalOk() {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-id' }; } };
  };
}

/** Stubs the fal submission fetch to reject with a content_policy_violation detail (FastAPI-style), the shape humanizeFalDetail turns into the "flagged by the safety system" message. */
function stubFalContentPolicy() {
  global.fetch = async function () {
    return {
      ok: false,
      status: 422,
      json: async function () {
        return { detail: [{ type: 'content_policy_violation', loc: ['body', 'prompt'], msg: 'flagged' }] };
      }
    };
  };
}

async function balance(email, amount) {
  return entitlements.setEntitlement({}, email, { tokens: { balance: amount, lastClaimAt: Date.now() } });
}

function records() {
  return moderationLogStore.list(fakeEvent({}), { limit: 10000 });
}

function genVideoEvent(body) {
  return fakeEvent({ method: 'POST', ip: nextIp(), body: Object.assign({ caption: 'a dream', style: 'Cartoon' }, body) });
}
function genImageEvent(body) {
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
  delete process.env.TURNSTILE_SECRET_KEY;
});
test.after(function () {
  global.fetch = realFetch;
  delete process.env.CONTENT_CLASSIFIER_MOCK_TIER;
});

// ===== E116 pre-gate blocks =====

test('generate-video E116 block writes a moderation-log record (reason E116, mediaType video)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  stubFalOk();
  await balance('vexp@example.com', 300);

  var res = await genVideoHandler(genVideoEvent({ email: 'vexp@example.com', caption: 'a blocked video dream', source: 'create' }));
  assert.equal(res.statusCode, 422);

  var recs = await records();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].reason, 'E116');
  assert.equal(recs[0].mediaType, 'video');
  assert.equal(recs[0].promptText, 'a blocked video dream');
  assert.equal(recs[0].user, 'vexp@example.com');
  assert.equal(recs[0].source, 'create');
  assert.ok(!isNaN(Date.parse(recs[0].ts)), 'ts is a real ISO timestamp');
});

test('generate-image E116 block writes a moderation-log record (reason E116, mediaType image)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  stubFalOk();
  await balance('iexp@example.com', 300);

  var res = await genImageHandler(genImageEvent({ email: 'iexp@example.com', caption: 'a blocked image dream' }));
  assert.equal(res.statusCode, 422);

  var recs = await records();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].reason, 'E116');
  assert.equal(recs[0].mediaType, 'image');
  assert.equal(recs[0].promptText, 'a blocked image dream');
  assert.equal(recs[0].user, 'iexp@example.com');
  assert.equal(recs[0].source, null, 'no source sent -> null');
});

// ===== fal-side content_policy_violation blocks =====

test('generate-video fal content_policy_violation writes a record (reason content_policy_violation)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean'; // pass the pre-gate, reach fal
  stubFalContentPolicy();
  await balance('vfal@example.com', 300);

  var res = await genVideoHandler(genVideoEvent({ email: 'vfal@example.com', caption: 'reaches fal then blocked' }));
  assert.notEqual(res.statusCode, 200);

  var recs = await records();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].reason, 'content_policy_violation');
  assert.equal(recs[0].mediaType, 'video');
  assert.equal(recs[0].promptText, 'reaches fal then blocked');
});

test('generate-image fal content_policy_violation writes a record (reason content_policy_violation)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  stubFalContentPolicy();
  await balance('ifal@example.com', 300);

  var res = await genImageHandler(genImageEvent({ email: 'ifal@example.com', caption: 'image reaches fal then blocked' }));
  assert.notEqual(res.statusCode, 200);

  var recs = await records();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].reason, 'content_policy_violation');
  assert.equal(recs[0].mediaType, 'image');
  assert.equal(recs[0].promptText, 'image reaches fal then blocked');
});

// ===== allowed generations write nothing =====

test('an ALLOWED (clean) generation writes NO moderation-log record', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  stubFalOk();
  await balance('ok@example.com', 300);

  var res = await genVideoHandler(genVideoEvent({ email: 'ok@example.com', caption: 'a gentle dream of flying' }));
  assert.equal(res.statusCode, 200);

  var recs = await records();
  assert.equal(recs.length, 0, 'allowed generations must not be logged');
});

// ===== a non-content fal rejection is NOT logged as a content block =====

test('a NON-content fal rejection does not write a moderation-log record', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  global.fetch = async function () {
    // A plain validation error (e.g. bad params, rate limit) — not content policy.
    return { ok: false, status: 400, json: async function () { return { detail: [{ type: 'value_error', msg: 'bad param' }] }; } };
  };
  await balance('other@example.com', 300);

  var res = await genVideoHandler(genVideoEvent({ email: 'other@example.com', caption: 'a normal dream' }));
  assert.notEqual(res.statusCode, 200);

  var recs = await records();
  assert.equal(recs.length, 0, 'only content-policy rejections are logged, not every fal error');
});
