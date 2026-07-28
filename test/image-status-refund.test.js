// test/image-status-refund.test.js
//
// Covers netlify/functions/image-status.js's auto-refund wiring (tracker
// item idea-auto-refund-policy, founder-approved 2026-07-26) — the image
// counterpart to test/video-status-refund.test.js (see that file's own
// header comment for the full reasoning; identical shape here, just E505/
// E508 and the 10-token image cost instead of E205/E208 and 100).
//
// Also includes the image-path counterpart to video-status-refund.test.js's
// SECURITY tests (round-2 review finding): refundTokensOnce now requires a
// job-owners record binding jobId -> the submitting email before it will
// ever refund anyone — see lib/job-owners.js and lib/entitlements.js's own
// SECURITY doc block on refundTokensOnce.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var jobOwners = require('../netlify/functions/lib/job-owners');
var handler = require('../netlify/functions/image-status').handler;

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

/** Same shape as video-status-refund.test.js's own stubFalAndPosthog, reading resultData.images[0].url instead of resultData.video.url. */
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

/** Seeds a job-owners record binding jobId -> email — see video-status-refund.test.js's own identical helper for the full reasoning. */
async function seedJobOwner(email, jobId) {
  await jobOwners.recordJobOwner({}, jobId, email);
}

test('E505 (fal marked the job failed) refunds 10 tokens, sets tokensRefunded:true, and fires tokens_refunded with the right properties', async function () {
  var email = 'e505refund@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'fal:fal-ai/flux/dev:req1');
  var posthogCalls = stubFalAndPosthog({ status: 'FAILED' }, {});

  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req1', email));
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E505:/);
  assert.equal(body.tokensRefunded, true);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 10, 'exactly the image cost (10) must be refunded');

  assert.equal(posthogCalls.length, 1);
  var phBody = posthogCalls[0].body;
  assert.equal(phBody.event, 'tokens_refunded');
  assert.equal(phBody.distinct_id, email);
  assert.equal(phBody.properties.jobId, 'fal:fal-ai/flux/dev:req1');
  assert.equal(phBody.properties.cost, 10);
  assert.match(phBody.properties.reason, /^E505:/);
  assert.equal(phBody.properties.mediaType, 'image');
});

test('E508 (COMPLETED with no image URL) also refunds 10 tokens', async function () {
  var email = 'e508refund@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'fal:fal-ai/flux/dev:req2');
  stubFalAndPosthog({ status: 'COMPLETED' }, { images: [] });

  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req2', email));
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E508:/);
  assert.equal(body.tokensRefunded, true);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 10);
});

test('E504 (fal status endpoint non-OK) is NOT refund-eligible -- no refund, no event', async function () {
  var email = 'e504norefund@example.com';
  await seedZeroBalance(email);
  var posthogCalls = [];
  global.fetch = async function (url) {
    if (String(url).indexOf('/capture/') !== -1) { posthogCalls.push({}); return { ok: true, status: 200, json: async function () { return {}; }, text: async function () { return 'ok'; } }; }
    return { ok: false, status: 500, text: async function () { return JSON.stringify({ error: 'boom' }); } };
  };

  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req3', email));
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E504:/);
  assert.equal(body.tokensRefunded, undefined);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 0);
  assert.equal(posthogCalls.length, 0);
});

test('E507 (fal result endpoint non-OK) is NOT refund-eligible', async function () {
  var email = 'e507norefund@example.com';
  await seedZeroBalance(email);
  stubFalAndPosthog({ status: 'COMPLETED' }, { detail: 'content policy' }, false);

  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req4', email));
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E507:/);
  assert.equal(body.tokensRefunded, undefined);
});

test('a refund-eligible failure with NO email query param still returns the error normally, with no refund attempted', async function () {
  stubFalAndPosthog({ status: 'FAILED' }, {});
  var res = await handler(statusEvent('fal:fal-ai/flux/dev:req5'));
  var body = JSON.parse(res.body);
  assert.match(body.error, /^E505:/);
  assert.equal(body.tokensRefunded, undefined);
});

test('polling the SAME failed job id twice only refunds once', async function () {
  var email = 'imgresumedpoll@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'fal:fal-ai/flux/dev:req-resume');
  var posthogCalls = stubFalAndPosthog({ status: 'FAILED' }, {});

  var first = await handler(statusEvent('fal:fal-ai/flux/dev:req-resume', email));
  var second = await handler(statusEvent('fal:fal-ai/flux/dev:req-resume', email));

  assert.equal(JSON.parse(first.body).tokensRefunded, true);
  assert.equal(JSON.parse(second.body).tokensRefunded, undefined);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 10);
  assert.equal(posthogCalls.length, 1);
});

test('a refund attempt that genuinely fails (Blobs exhaustion) is caught -- the generation-failure response still reaches the client normally', async function () {
  var email = 'imgrefundattemptfails@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'fal:fal-ai/flux/dev:req-fails');
  stubFalAndPosthog({ status: 'FAILED' }, {});

  mockBlobs.setReadOverride(entitlements.REFUNDED_JOBS_STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    var res = await handler(statusEvent('fal:fal-ai/flux/dev:req-fails', email));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.match(body.error, /^E505:/);
    assert.equal(body.tokensRefunded, undefined);
  } finally {
    mockBlobs.clearReadOverride(entitlements.REFUNDED_JOBS_STORE_NAME);
  }
});

// ----- SECURITY (round-2 review finding): email/jobId ownership, exercised
// through the real HTTP handler -- image-path counterpart to
// video-status-refund.test.js's own identical test. -----

test('SECURITY: GET /image-status?name=<victim job>&email=<attacker email> does NOT refund the attacker, even though the job genuinely failed', async function () {
  var victimEmail = 'imghttpvictim@example.com';
  var attackerEmail = 'imghttpattacker@example.com';
  var jobId = 'fal:fal-ai/flux/dev:req-victim';
  await seedZeroBalance(victimEmail);
  await seedZeroBalance(attackerEmail);
  await seedJobOwner(victimEmail, jobId);
  var posthogCalls = stubFalAndPosthog({ status: 'FAILED' }, {});

  var attackRes = await handler(statusEvent(jobId, attackerEmail));
  var attackBody = JSON.parse(attackRes.body);
  assert.match(attackBody.error, /^E505:/);
  assert.equal(attackBody.tokensRefunded, undefined, 'the response must NOT claim a refund landed for the attacker');

  var attackerRecord = await entitlements.getEntitlement({}, attackerEmail);
  assert.equal(attackerRecord.tokens.balance, 0, "the attacker's balance must be completely untouched");
  assert.equal(posthogCalls.length, 0, 'no tokens_refunded event should fire for a rejected mismatched attempt');

  var victimRes = await handler(statusEvent(jobId, victimEmail));
  assert.equal(JSON.parse(victimRes.body).tokensRefunded, true, "the real owner's own poll must still succeed after the attacker's rejected attempt");

  var victimRecord = await entitlements.getEntitlement({}, victimEmail);
  assert.equal(victimRecord.tokens.balance, 10, 'the real owner must receive their own refund in full');
});
