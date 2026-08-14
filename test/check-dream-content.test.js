// test/check-dream-content.test.js
//
// Unit coverage for netlify/functions/check-dream-content.js — the
// PRE-SIGNUP content gate endpoint (founder-directed 2026-08-14). It is a
// read-only, no-side-effect twin of the generation-time gate: it delegates
// to content-classifier.js's evaluateGenerationGate and returns
// { allowed, tier }, blocking explicit (and any sexual/romantic tier when a
// named-other-person photo is attached) BEFORE the email/signup step.
//
// Follows content-gate-generation.test.js's conventions: the classifier's
// own network call is driven deterministically via CONTENT_CLASSIFIER_MOCK_TIER
// (no real, paid LLM call), except the fail-safe tests, which leave it unset
// and stub a real classifier-error response so the fail-open (normal) /
// fail-closed (named-photo) directions are exercised end-to-end through the
// handler. Blobs (rate-limit.js) is mocked in-memory.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var handler = require('../netlify/functions/check-dream-content').handler;

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.7.0.' + ipCounter; }

function post(body, ip) {
  return fakeEvent({ method: 'POST', ip: ip || nextIp(), body: body });
}

/** Stubs fetch so any classifier call errors (drives fail-open/closed). */
function stubClassifierError() {
  global.fetch = async function () { return { ok: false, status: 500, json: async function () { return {}; } }; };
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.CONTENT_CLASSIFIER_MOCK_TIER;
  delete process.env.MAX_CONTENT_GATE_CHECKS_PER_IP_PER_DAY;
});
test.after(function () { global.fetch = realFetch; });

// ---- method / body guards ----

test('non-POST -> 405 E801', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E801/);
});

test('invalid JSON -> 200 allowed:true (a malformed pre-check must never hard-block a real user)', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, true);
  assert.equal(body.reason, 'invalid_json');
});

// ---- the three tiers (classifier mock-driven) ----

test('explicit -> allowed:false, tier explicit', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  var res = await handler(post({ caption: 'a graphic sexual scene' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, false);
  assert.equal(body.tier, 'explicit');
});

// Moderation-log bridge (2026-08-14): a pre-signup block must ALSO record the
// blocked text to the moderation log, since this gate now intercepts explicit
// content before the generation-time capture point — otherwise the founder
// loses the very visibility the log was built for.
test('a pre-signup BLOCK records the blocked text to the moderation log (reason E116_preemail); a clean check records NOTHING', async function () {
  var moderationLog = require('../netlify/functions/lib/moderation-log-store');

  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  var blocked = await handler(post({ caption: 'a graphic sexual scene', source: 'wizard' }));
  assert.equal(JSON.parse(blocked.body).allowed, false);

  var records = await moderationLog.list(fakeEvent({}), { limit: 50 });
  assert.equal(records.length, 1, 'a pre-signup block must write exactly one moderation-log record');
  assert.equal(records[0].reason, 'E116_preemail');
  assert.equal(records[0].promptText, 'a graphic sexual scene', 'the blocked text must be captured verbatim');
  assert.equal(records[0].source, 'wizard', 'the surface tag must be recorded');
  assert.equal(records[0].user, 'anonymous', 'a pre-signup block has no account yet');

  // A subsequent CLEAN check writes no new record.
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  await handler(post({ caption: 'a calm river at dawn' }));
  var after = await moderationLog.list(fakeEvent({}), { limit: 50 });
  assert.equal(after.length, 1, 'a clean pre-check must not write a moderation-log record');
});

test('clean -> allowed:true, tier clean', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  var res = await handler(post({ caption: 'flying over mountains' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, true);
  assert.equal(body.tier, 'clean');
});

test('romantic -> allowed:true, tier romantic (mainstream romantic is NOT over-blocked pre-signup)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var res = await handler(post({ caption: 'a couple kiss in the rain' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, true);
  assert.equal(body.tier, 'romantic');
});

// ---- named-other-person-photo threshold (anti-NCII) ----

test('named-other-person photo + romantic -> allowed:false (stricter NCII threshold)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var res = await handler(post({
    caption: 'a romantic evening',
    characters: [{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).allowed, false);
});

test('self-photo + romantic -> allowed:true (self keeps the normal romantic allowance)', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var res = await handler(post({
    caption: 'a romantic evening',
    characters: [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).allowed, true);
});

// ---- deterministic explicit-keyword backstop (no classifier call) ----

test('an unambiguous explicit KEYWORD is blocked even with no FAL_KEY (keyword backstop, no classifier call)', async function () {
  delete process.env.FAL_KEY;
  var called = 0;
  global.fetch = async function () { called++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  var res = await handler(post({ caption: 'I was having sex' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, false);
  assert.equal(body.tier, 'explicit');
  assert.equal(called, 0, 'the keyword backstop short-circuits before any classifier call');
});

// ---- fail-safe directions (real classifier-error stub) ----

test('classifier error on a NORMAL request -> FAILS OPEN (allowed:true)', async function () {
  stubClassifierError();
  var res = await handler(post({ caption: 'anything at all' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, true);
  assert.equal(body.reason, 'fail_open');
});

test('classifier error on a NAMED-PHOTO request -> FAILS CLOSED (allowed:false)', async function () {
  stubClassifierError();
  var res = await handler(post({
    caption: 'anything at all',
    characters: [{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).allowed, false);
});

test('missing FAL_KEY on a NORMAL request -> FAILS OPEN (allowed:true — this sandbox has no FAL_KEY)', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(post({ caption: 'a gentle walk in the woods' }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).allowed, true);
});

// ---- rate limiting ----

test('rate limit exceeded on a NORMAL request -> FAILS OPEN (allowed:true — the limiter protects LLM cost, never hard-blocks a person)', async function () {
  process.env.MAX_CONTENT_GATE_CHECKS_PER_IP_PER_DAY = '2';
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  var ip = nextIp();
  // First 2 pass through to the classifier (and block, being explicit).
  var r1 = JSON.parse((await handler(post({ caption: 'explicit scene' }, ip))).body);
  var r2 = JSON.parse((await handler(post({ caption: 'explicit scene' }, ip))).body);
  assert.equal(r1.allowed, false);
  assert.equal(r2.allowed, false);
  // The 3rd exceeds the cap -> fails open regardless of content.
  var r3 = JSON.parse((await handler(post({ caption: 'explicit scene' }, ip))).body);
  assert.equal(r3.allowed, true);
  assert.equal(r3.reason, 'rate_limited');
});

test('rate limit exceeded but a NAMED-PHOTO payload is STILL evaluated (fail-closed safeguard is not a cost concern)', async function () {
  process.env.MAX_CONTENT_GATE_CHECKS_PER_IP_PER_DAY = '1';
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var ip = nextIp();
  // Burn the single allowed check with a normal request.
  await handler(post({ caption: 'clean walk' }, ip));
  // Now over the cap — but a named-photo romantic payload must still block.
  var res = await handler(post({
    caption: 'a romantic evening',
    characters: [{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAAA' }]
  }, ip));
  assert.equal(JSON.parse(res.body).allowed, false);
});

// ---- no side effects ----

test('an empty caption -> allowed:true, no throw (safe to call with nothing to check)', async function () {
  var res = await handler(post({ caption: '' }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).allowed, true);
});
