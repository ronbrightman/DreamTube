// test/generation-completion-marker.test.js
//
// Covers the durable, server-side replacement for the old sessionStorage
// `dreamtube_just_generated_id` marker (tracker.html's
// result-htmls-firstvideocreated-still-dep-qfg48t item, founder-approved
// 2026-07-27):
//   - netlify/functions/lib/generation-completion-store.js: markCompleted /
//     consumeIfPresent, the operationName-keyed Blobs store itself.
//   - netlify/functions/mark-generation-completed.js: the POST endpoint
//     processing.html calls right before its redirect -- INCLUDING
//     verifyOperationCompleted, the server-side re-verification gate
//     added in response to a review finding (see below).
//   - netlify/functions/consume-generation-marker.js: the POST endpoint
//     result.html calls to read + consume the marker exactly once.
//
// SECURITY REGRESSION TEST (review finding, fixed 2026-07-27): the
// original version of this feature accepted a bare client-supplied
// `dreamId` with no verification that a real generation had actually
// completed -- since dream ids are client-invented and already public
// elsewhere in this app, an unauthenticated caller could plant a marker
// for any dreamId they merely knew/guessed, forging a false
// FirstVideoCreated on the victim's own later, ordinary revisit. The fix
// re-keyed everything on the server-issued `operationName` instead (never
// client-invented, never exposed in any UI) AND made mark-generation-
// completed.js independently re-verify (against fal's own status
// endpoint, or the mock path's embedded-timestamp check) that the claimed
// operationName genuinely completed before writing anything. The tests
// below marked "SECURITY:" specifically prove an unverified/fabricated
// operationName cannot cause consume-generation-marker to ever report
// matched:true.
//
// The end-to-end browser-driven proof that result.html actually fires (or
// correctly doesn't fire) FirstVideoCreated using this mechanism lives in
// test/first-video-created-behavioral.test.js -- this file is server-side
// unit coverage only, same split as send-first-dream-email.js/
// test/send-first-dream-email.test.js.
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var realFetch = global.fetch;

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.0.' + ipCounter;
}

/** A mock-mode operationName whose embedded start timestamp is far enough in the past to verify as genuinely complete (well past MOCK_MIN_ELAPSED_MS). */
function realMockOpName(suffix) {
  return 'mock:' + (Date.now() - 60000) + ':' + (suffix || 'op');
}

/** A mock-mode operationName minted "just now" -- simulates a freshly-fabricated claim (an attacker's forged operationName, or a genuinely in-flight job that hasn't actually finished yet), which must NOT verify as complete. */
function freshMockOpName(suffix) {
  return 'mock:' + Date.now() + ':' + (suffix || 'op');
}

/** Spies on global.fetch so a "fal:" operationName's verification check can be controlled without a real network call to fal.ai -- same convention as test/send-first-dream-email.test.js's installFetchSpy. */
function installFalStatusSpy(status) {
  global.fetch = async function () {
    return { ok: true, json: async function () { return { status: status }; } };
  };
}

/**
 * Baseline fetch stub installed before EVERY test in this file (tracker.html's
 * for-product-bug-founder-affects-all-funn-0efe7t item, round 4).
 *
 * These tests drive the REAL mark-generation-completed handler, which runs
 * maybeSendAutomaticFirstDreamEmail -> reportAutoSkip ->
 * lib/posthog-capture.js for every genuinely-verified operationName. That
 * helper's POSTHOG_KEY comes from a checked-in file, not an env var, so
 * before this stub existed these tests POSTed 5 REAL
 * `first_dream_email_skipped { reason:'no_job_owner_record',
 * distinct_id:'unknown' }` events into the founder's REAL production PostHog
 * project on every `npm test` run -- indistinguishable in PostHog from real
 * users failing, and the direct cause of a reported production "skip storm"
 * that rounds of this tracker item were spent chasing.
 *
 * lib/posthog-capture.js now refuses to fire under a test runner at all (its
 * own TEST-ENVIRONMENT GUARD), which is the durable fix; this is the belt to
 * that lib's braces, and keeps this file honest about the fact that its
 * subject makes outbound calls. installFalStatusSpy below still replaces it
 * wholesale for the fal-verification tests -- fine, and unchanged.
 */
function installBlockAllFetch() {
  global.fetch = async function (url) {
    throw new Error('unexpected real network call in a test: ' + String(url));
  };
}

test.beforeEach(function () {
  installBlockAllFetch();
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/mark-generation-completed')];
  delete require.cache[require.resolve('../netlify/functions/consume-generation-marker')];
  delete require.cache[require.resolve('../netlify/functions/lib/generation-completion-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
  delete process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY;
  delete process.env.FAL_KEY;
});
test.after(function () {
  global.fetch = realFetch;
});

// ===== lib/generation-completion-store.js =====

test('generation-completion-store: markCompleted then consumeIfPresent -- true the first time, false every time after', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  await store.markCompleted(event, 'fal:fal-ai/veo3.1/fast:req-abc');
  var first = await store.consumeIfPresent(event, 'fal:fal-ai/veo3.1/fast:req-abc');
  assert.equal(first, true);

  var second = await store.consumeIfPresent(event, 'fal:fal-ai/veo3.1/fast:req-abc');
  assert.equal(second, false, 'the marker was already consumed by the first call');
});

test('generation-completion-store: consumeIfPresent for an operationName that was never marked returns false', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  var result = await store.consumeIfPresent(event, 'fal:fal-ai/veo3.1/fast:never-marked');
  assert.equal(result, false);
});

test('generation-completion-store: different operation names get independent markers', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  await store.markCompleted(event, 'fal:fal-ai/veo3.1/fast:op-1');
  await store.markCompleted(event, 'fal:fal-ai/veo3.1/fast:op-2');

  var consumedOther = await store.consumeIfPresent(event, 'fal:fal-ai/veo3.1/fast:op-2');
  assert.equal(consumedOther, true);
  var stillThere = await store.consumeIfPresent(event, 'fal:fal-ai/veo3.1/fast:op-1');
  assert.equal(stillThere, true, 'marking/consuming one operation must not touch a different operation\'s own marker');
});

test('generation-completion-store: markCompleted/consumeIfPresent no-op safely for an empty/missing operationName', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  await store.markCompleted(event, null);
  await store.markCompleted(event, '');
  var result = await store.consumeIfPresent(event, null);
  assert.equal(result, false);
});

// ===== mark-generation-completed.js: verifyOperationCompleted =====

test('verifyOperationCompleted: a mock operationName with enough elapsed time verifies as complete', async function () {
  var mark = require('../netlify/functions/mark-generation-completed');
  var result = await mark.verifyOperationCompleted(realMockOpName());
  assert.equal(result, true);
});

test('SECURITY: verifyOperationCompleted rejects a freshly-minted mock operationName (not enough elapsed time -- a forged or still-in-flight claim)', async function () {
  var mark = require('../netlify/functions/mark-generation-completed');
  var result = await mark.verifyOperationCompleted(freshMockOpName());
  assert.equal(result, false);
});

test('verifyOperationCompleted: a "fal:" operationName verifies true only when fal itself reports COMPLETED', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  installFalStatusSpy('COMPLETED');
  var mark = require('../netlify/functions/mark-generation-completed');
  var result = await mark.verifyOperationCompleted('fal:fal-ai/veo3.1/fast:req-real-1');
  assert.equal(result, true);
});

test('SECURITY: verifyOperationCompleted rejects a "fal:" operationName that is still IN_PROGRESS', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  installFalStatusSpy('IN_PROGRESS');
  var mark = require('../netlify/functions/mark-generation-completed');
  var result = await mark.verifyOperationCompleted('fal:fal-ai/veo3.1/fast:req-still-going');
  assert.equal(result, false);
});

test('SECURITY: verifyOperationCompleted rejects a "fal:" operationName when FAL_KEY is not configured (fails closed, never open)', async function () {
  var mark = require('../netlify/functions/mark-generation-completed');
  var result = await mark.verifyOperationCompleted('fal:fal-ai/veo3.1/fast:req-no-key');
  assert.equal(result, false);
});

test('SECURITY: verifyOperationCompleted rejects an unrecognized operationName shape (neither "fal:" nor "mock:")', async function () {
  var mark = require('../netlify/functions/mark-generation-completed');
  assert.equal(await mark.verifyOperationCompleted('totally-made-up-string'), false);
  assert.equal(await mark.verifyOperationCompleted(''), false);
  assert.equal(await mark.verifyOperationCompleted(null), false);
});

// ===== mark-generation-completed.js: the handler =====

test('mark-generation-completed: a genuinely-completed mock operationName is recorded and later consumable', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var opName = realMockOpName('e2e-1');
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  var store = require('../netlify/functions/lib/generation-completion-store');
  var consumed = await store.consumeIfPresent(fakeEvent({ method: 'POST' }), opName);
  assert.equal(consumed, true);
});

test('SECURITY: mark-generation-completed does NOT write a marker for an operationName that fails verification -- consume-generation-marker still reports matched:false for it', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var forgedOpName = freshMockOpName('attacker-forged');

  var markRes = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: forgedOpName } }));
  // Still 200s (best-effort, never a distinguishable failure response --
  // see header comment) but must NOT have written anything real.
  assert.equal(markRes.statusCode, 200);

  var consumeRes = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: forgedOpName } }));
  assert.equal(JSON.parse(consumeRes.body).matched, false, 'an unverified/forged operationName must never be consumable as a genuine completion');
});

test('SECURITY: mark-generation-completed does NOT write a marker for a real "fal:" operationName that is still IN_PROGRESS (not actually done yet)', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  installFalStatusSpy('IN_PROGRESS');
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var opName = 'fal:fal-ai/veo3.1/fast:req-in-progress';

  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  var consumeRes = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  assert.equal(JSON.parse(consumeRes.body).matched, false, 'a job that fal itself has not marked COMPLETED must never be consumable');
});

test('mark-generation-completed: a genuinely-completed "fal:" operationName IS consumable', async function () {
  process.env.FAL_KEY = 'test-fal-key';
  installFalStatusSpy('COMPLETED');
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var opName = 'fal:fal-ai/veo3.1/fast:req-really-done';

  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  var consumeRes = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  assert.equal(JSON.parse(consumeRes.body).matched, true);
});

test('mark-generation-completed: missing operationName -> E3, still 400 (nothing to record)', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3/);
});

test('mark-generation-completed: wrong method -> E1', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1/);
});

test('mark-generation-completed: invalid JSON body -> E2', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': nextIp() }, body: 'not json', queryStringParameters: {} });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2/);
});

test('mark-generation-completed: per-IP rate limit blocks further marks from the same source once exceeded', async function () {
  process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY = '2';
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var ip = nextIp();

  var r1 = await markHandler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: realMockOpName('rl-1') } }));
  var r2 = await markHandler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: realMockOpName('rl-2') } }));
  var r3 = await markHandler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: realMockOpName('rl-3') } }));

  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r3.statusCode, 429);
});

// ===== consume-generation-marker.js =====

test('consume-generation-marker: end-to-end -- mark (genuinely completed) then consume matches exactly once, false after', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var opName = realMockOpName('flow-1');

  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));

  var first = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  assert.equal(JSON.parse(first.body).matched, true);

  var second = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  assert.equal(JSON.parse(second.body).matched, false, 'the marker was already consumed -- a reload of result.html must not match again');
});

test('consume-generation-marker: an operationName that was never marked returns matched:false (an ordinary revisit of an old dream, or one with no sourceOperationName at all)', async function () {
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var res = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: 'fal:fal-ai/veo3.1/fast:never-marked-2' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).matched, false);
});

test('consume-generation-marker: a different operationName than the one marked does not match', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var realOpName = realMockOpName('real-1');

  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: realOpName } }));
  var res = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: 'fal:fal-ai/veo3.1/fast:imposter-1' } }));
  assert.equal(JSON.parse(res.body).matched, false);

  // The real marker must still be there, untouched by the mismatched attempt.
  var stillThere = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: realOpName } }));
  assert.equal(JSON.parse(stillThere.body).matched, true);
});

test('consume-generation-marker: missing operationName -> E3', async function () {
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var res = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3/);
});

test('consume-generation-marker: wrong method -> E1', async function () {
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var res = await consumeHandler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1/);
});

test('consume-generation-marker: invalid JSON body -> E2', async function () {
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var res = await consumeHandler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': nextIp() }, body: 'not json', queryStringParameters: {} });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2/);
});

test('consume-generation-marker: per-IP rate limit blocks further consume attempts from the same source once exceeded', async function () {
  process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY = '2';
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var ip = nextIp();

  var r1 = await consumeHandler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: 'fal:fal-ai/veo3.1/fast:x1' } }));
  var r2 = await consumeHandler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: 'fal:fal-ai/veo3.1/fast:x2' } }));
  var r3 = await consumeHandler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: 'fal:fal-ai/veo3.1/fast:x3' } }));

  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r3.statusCode, 429);
});

// ===== SECURITY: the actual attack scenario the review flagged =====

test('SECURITY: an attacker who knows a victim\'s public dreamId (e.g. off profile.html/explore.html) gains nothing -- dreamId is no longer part of this protocol at all', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;

  // The old, vulnerable shape: an attacker POSTs the victim's real,
  // publicly-known dreamId. Both endpoints only ever look at
  // `operationName` now -- a `dreamId` field, if sent at all, is simply
  // ignored, so this has no effect whatsoever on any real completion.
  var attackerAttempt = await markHandler(fakeEvent({
    method: 'POST', ip: nextIp(),
    body: { dreamId: 'victim-real-dream-id-from-profile-html' }
  }));
  assert.equal(attackerAttempt.statusCode, 400, 'with no operationName field at all, this is just a missing-field rejection, not a plantable marker');
  assert.match(JSON.parse(attackerAttempt.body).error, /^E3/);

  // Even if the attacker also throws in a plausible-looking operationName
  // they don't actually control/own, it must fail verification and never
  // become consumable.
  var forgedOp = freshMockOpName('attacker-guess');
  var attackerWithFakeOp = await markHandler(fakeEvent({
    method: 'POST', ip: nextIp(),
    body: { dreamId: 'victim-real-dream-id-from-profile-html', operationName: forgedOp }
  }));
  assert.equal(attackerWithFakeOp.statusCode, 200);

  var consumeAsVictim = await consumeHandler(fakeEvent({
    method: 'POST', ip: nextIp(),
    body: { operationName: forgedOp }
  }));
  assert.equal(JSON.parse(consumeAsVictim.body).matched, false, 'the victim\'s later, ordinary revisit must never be told a completion happened because of anything the attacker sent');
});
