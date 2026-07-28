// test/video-status-refund.test.js
//
// Covers netlify/functions/video-status.js's auto-refund wiring (tracker
// item idea-auto-refund-policy, founder-approved 2026-07-26):
// refundAndReport/isRefundEligibleError, and exports.handler's own new
// `email` query param + `tokensRefunded` response field. Complements
// test/video-status-mock.test.js (the pre-existing mock-path coverage,
// untouched by this feature) and test/entitlements-refund.test.js (the
// underlying refundTokensOnce unit coverage) — this file proves the two
// are actually wired together correctly at the handler level: the right
// error codes trigger a refund, the right amount lands, the right
// PostHog event fires, and a resumed poll of an already-refunded job
// doesn't double-refund.
//
// mockBlobs is required (entitlements.js/account-store.js are both
// Blobs-backed); global.fetch is stubbed to catch BOTH fal.ai calls and
// PostHog's capture endpoint, same discipline test/dodo-webhook.test.js's
// installAnalyticsFetchSpy already established for a server-side event
// fire after a real credit.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var jobOwners = require('../netlify/functions/lib/job-owners');
var handler = require('../netlify/functions/video-status').handler;

var realFetch = global.fetch;

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.FAL_KEY = 'test-fal-key';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.FAL_KEY;
});

function statusEvent(name, email) {
  var query = { name: name };
  if (email !== undefined) query.email = email;
  return fakeEvent({ method: 'GET', query: query });
}

/**
 * Stubs global.fetch for both fal.ai's status/result endpoints (mirroring
 * video-status-mock.test.js's/image-status.test.js's own stubStatusThenResult
 * shape) AND PostHog's /capture/ endpoint, returning the recorded PostHog
 * calls so tests can assert on the tokens_refunded event's payload. Any
 * other URL throws, same "no real network in this file" discipline as
 * every other test file in this suite.
 */
function stubFalAndPosthog(statusBody, resultBody, resultOk) {
  var posthogCalls = [];
  global.fetch = async function (url, init) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') !== -1) {
      posthogCalls.push({ url: urlStr, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async function () { return {}; }, text: async function () { return 'ok'; } };
    }
    if (urlStr.indexOf('/status') !== -1) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify(statusBody); } };
    }
    return { ok: resultOk !== false, status: resultOk === false ? 422 : 200, text: async function () { return JSON.stringify(resultBody); } };
  };
  return posthogCalls;
}

async function seedZeroBalance(email) {
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0, lastClaimAt: Date.now() } });
}

/**
 * Seeds a job-owners record binding `jobId` to `email` — the real
 * equivalent of generate-video.js's own recordJobOwnerBestEffort at
 * submission time (round-2 review security fix: refundTokensOnce now
 * requires this to exist and match before ever refunding, see
 * entitlements-refund.test.js's own SECURITY tests for the direct unit
 * coverage). Every test below that expects an actual refund to land must
 * seed this first, exactly like the real flow requires a real prior
 * submission.
 */
async function seedJobOwner(email, jobId) {
  await jobOwners.recordJobOwner({}, jobId, email);
}

// ----- E205 (fal itself marked the job failed) -- refund-eligible -----

test('E205 (fal marked the job failed) refunds 100 tokens, sets tokensRefunded:true, and fires tokens_refunded with the right properties', async function () {
  var email = 'e205refund@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'fal:fal-ai/veo3.1/fast:req1');
  var posthogCalls = stubFalAndPosthog({ status: 'FAILED' }, {});

  var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast:req1', email));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.match(body.error, /^E205:/);
  assert.equal(body.tokensRefunded, true);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'exactly the video cost (100) must be refunded');

  assert.equal(posthogCalls.length, 1, 'expected exactly one tokens_refunded PostHog capture call');
  var phBody = posthogCalls[0].body;
  assert.equal(phBody.event, 'tokens_refunded');
  assert.equal(phBody.distinct_id, email, 'falls back to the normalized email since no matching account record exists');
  assert.equal(phBody.properties.jobId, 'fal:fal-ai/veo3.1/fast:req1');
  assert.equal(phBody.properties.cost, 100);
  assert.match(phBody.properties.reason, /^E205:/);
  assert.equal(phBody.properties.mediaType, 'video');
});

// ----- E208 (COMPLETED but no video URL) -- refund-eligible -----

test('E208 (COMPLETED with no video URL) also refunds 100 tokens and sets tokensRefunded:true', async function () {
  var email = 'e208refund@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'fal:fal-ai/veo3.1/fast:req2');
  stubFalAndPosthog({ status: 'COMPLETED' }, { video: null });

  var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast:req2', email));
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E208:/);
  assert.equal(body.tokensRefunded, true);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100);
});

// ----- Non-eligible codes -- no refund, no event -----

test('E204 (fal status endpoint non-OK) is NOT refund-eligible -- no refund, no tokensRefunded field, no PostHog event', async function () {
  var email = 'e204norefund@example.com';
  await seedZeroBalance(email);
  var posthogCalls = stubFalAndPosthog({}, {});
  global.fetch = async function (url) {
    if (String(url).indexOf('/capture/') !== -1) { posthogCalls.push({}); return { ok: true, status: 200, json: async function () { return {}; }, text: async function () { return 'ok'; } }; }
    return { ok: false, status: 500, text: async function () { return JSON.stringify({ error: 'boom' }); } };
  };

  var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast:req3', email));
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E204:/);
  assert.equal(body.tokensRefunded, undefined, 'a transport-level hiccup must not be treated as a refund-eligible generation failure');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 0, 'balance must be untouched (still the seeded zero) -- a transport hiccup never proves the job failed, so no refund should be attempted');
  assert.equal(posthogCalls.length, 0, 'no tokens_refunded event for a non-eligible code');
});

test('E207 (fal result endpoint non-OK) is NOT refund-eligible', async function () {
  var email = 'e207norefund@example.com';
  await seedZeroBalance(email);
  stubFalAndPosthog({ status: 'COMPLETED' }, { detail: 'content policy' }, false);

  var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast:req4', email));
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E207:/);
  assert.equal(body.tokensRefunded, undefined);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 0, 'balance must be untouched -- seeded at 0, no refund attempted');
});

// ----- No email -> no refund attempted, but the failure still reports normally -----

test('a refund-eligible failure with NO email query param still returns the error normally, with no refund attempted', async function () {
  stubFalAndPosthog({ status: 'FAILED' }, {});
  var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast:req5')); // no email
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E205:/);
  assert.equal(body.tokensRefunded, undefined);
});

// ----- Idempotency at the handler level: a resumed poll must not double-refund -----

test('polling the SAME failed job id twice (e.g. a page reload resuming the poll) only refunds once', async function () {
  var email = 'resumedpoll@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'fal:fal-ai/veo3.1/fast:req-resume');
  var posthogCalls = stubFalAndPosthog({ status: 'FAILED' }, {});

  var first = await handler(statusEvent('fal:fal-ai/veo3.1/fast:req-resume', email));
  var second = await handler(statusEvent('fal:fal-ai/veo3.1/fast:req-resume', email));

  assert.equal(JSON.parse(first.body).tokensRefunded, true);
  assert.equal(JSON.parse(second.body).tokensRefunded, undefined, 'the second (resumed) poll of the same already-refunded job must not report a fresh refund');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'balance must reflect exactly one refund across both polls');
  assert.equal(posthogCalls.length, 1, 'tokens_refunded must fire exactly once, not on the resumed poll too');
});

// ----- A refund attempt that hits a genuine Blobs failure must not break the response -----

test('a refund attempt that genuinely fails (Blobs exhaustion) is caught -- the generation-failure response still reaches the client normally', async function () {
  var email = 'refundattemptfails@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'fal:fal-ai/veo3.1/fast:req-fails');
  stubFalAndPosthog({ status: 'FAILED' }, {});

  // Simulate refundTokensOnce's own outer-marker write never confirming a
  // winner (see entitlements-refund.test.js's identical exhaustion test) --
  // this makes entitlements.refundTokensOnce throw internally.
  mockBlobs.setReadOverride(entitlements.REFUNDED_JOBS_STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast:req-fails', email));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.match(body.error, /^E205:/, 'the real generation-failure error must still reach the client even though the refund attempt itself failed');
    assert.equal(body.tokensRefunded, undefined);
  } finally {
    mockBlobs.clearReadOverride(entitlements.REFUNDED_JOBS_STORE_NAME);
  }
});

// ----- SECURITY (round-2 review finding): email/jobId ownership, exercised
// through the real HTTP handler, not just the underlying entitlements.js
// unit -- proves the fix actually closes the endpoint-level attack, not
// just the library function in isolation. -----

test('SECURITY: GET /video-status?name=<victim job>&email=<attacker email> does NOT refund the attacker, even though the job genuinely failed', async function () {
  var victimEmail = 'httpvictim@example.com';
  var attackerEmail = 'httpattacker@example.com';
  var jobId = 'fal:fal-ai/veo3.1/fast:req-victim';
  await seedZeroBalance(victimEmail);
  await seedZeroBalance(attackerEmail);
  // The real submission was the victim's -- generate-video.js's own
  // recordJobOwnerBestEffort would have written exactly this.
  await seedJobOwner(victimEmail, jobId);
  var posthogCalls = stubFalAndPosthog({ status: 'FAILED' }, {});

  // The attacker polls the VICTIM's jobId with their OWN email.
  var attackRes = await handler(statusEvent(jobId, attackerEmail));
  var attackBody = JSON.parse(attackRes.body);
  assert.match(attackBody.error, /^E205:/, 'the real fal failure is still reported (this endpoint has no auth to reject the request outright)');
  assert.equal(attackBody.tokensRefunded, undefined, 'the response must NOT claim a refund landed for the attacker');

  var attackerRecord = await entitlements.getEntitlement({}, attackerEmail);
  assert.equal(attackerRecord.tokens.balance, 0, "the attacker's balance must be completely untouched");
  assert.equal(posthogCalls.length, 0, 'no tokens_refunded event should fire for a rejected mismatched attempt');

  // The real owner must still be able to poll and get their own refund
  // afterward -- the attacker's attempt must have left no side effects.
  var victimRes = await handler(statusEvent(jobId, victimEmail));
  assert.equal(JSON.parse(victimRes.body).tokensRefunded, true, "the real owner's own poll must still succeed after the attacker's rejected attempt");

  var victimRecord = await entitlements.getEntitlement({}, victimEmail);
  assert.equal(victimRecord.tokens.balance, 100, 'the real owner must receive their own refund in full');
});
