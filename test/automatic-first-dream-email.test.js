// test/automatic-first-dream-email.test.js
//
// Covers the AUTOMATIC first-dream retention-email trigger (tracker.html's
// for-product-activate-automatic-retention-4n74rw item, founder-approved
// 2026-07-27 -- "start sending the first-video retention email
// AUTOMATICALLY when a user's first video finishes - do not wait for
// manual triggering"):
//   - netlify/functions/mark-generation-completed.js's new
//     maybeSendAutomaticFirstDreamEmail -- fires the exact same guarded
//     send test/send-first-dream-email.test.js already covers via the
//     client-triggered HTTP endpoint, but resolves identity via
//     lib/job-owners.js's submission-time operationName -> email binding
//     instead of a client-claimed username + password.
//   - netlify/functions/lib/job-owners.js's mediaType field (new) --
//     preserves the retention email's video-only scope without the
//     client needing to supply anything at this choke point.
//   - netlify/functions/lib/first-dream-email-store.js's markSentOnce,
//     now blobs-retry-backed -- proven race-safe here under GENUINE
//     concurrent completions for the same brand-new account (two videos
//     finishing near-simultaneously), the scenario this task's own
//     instructions called out as "the part most worth getting right."
//
// Deliberately its own file rather than folded into
// test/generation-completion-marker.test.js (which already covers
// verifyOperationCompleted/the completion-marker mechanics in isolation)
// or test/send-first-dream-email.test.js (which covers the client-
// triggered endpoint's own contract) -- this is the integration between
// mark-generation-completed.js, lib/job-owners.js, lib/account-store.js,
// and lib/first-dream-email-sender.js specifically.
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
  return '10.11.0.' + ipCounter;
}

/** A mock-mode operationName whose embedded start timestamp is far enough in the past to verify as genuinely complete -- same helper shape as test/generation-completion-marker.test.js's realMockOpName. */
function realMockOpName(suffix) {
  return 'mock:' + (Date.now() - 60000) + ':' + (suffix || 'op');
}

/**
 * Spies on global.fetch for BOTH outbound calls this feature makes --
 * Resend (the actual email) and PostHog's capture endpoint (the
 * 'first_dream_email_sent' event) -- same split-by-URL convention
 * test/dodo-webhook.test.js's installAnalyticsFetchSpy already
 * establishes for its own two-vendor (PostHog + Meta CAPI) fire.
 */
function installFetchSpy() {
  var resendCalls = [];
  var posthogCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    var body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (urlStr.indexOf('api.resend.com') !== -1) {
      resendCalls.push({ url: urlStr, body: body });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    if (urlStr.indexOf('/capture/') !== -1) {
      posthogCalls.push({ url: urlStr, body: body });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  return { resendCalls: resendCalls, posthogCalls: posthogCalls };
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/mark-generation-completed')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/job-owners')];
  delete require.cache[require.resolve('../netlify/functions/lib/first-dream-email-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/first-dream-email-sender')];
  delete require.cache[require.resolve('../netlify/functions/lib/generation-completion-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
  delete process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY;
  process.env.RESEND_API_KEY = 'resend-test-key';
});
test.after(function () {
  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
});

async function registerAccount(username, email) {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: username, password: 'realpassword1', email: email } }));
  assert.equal(JSON.parse(res.body).ok, true, 'test setup: registration should succeed');
}

/** Seeds a job-owners record exactly as generate-video.js's/generate-image.js's own recordJobOwnerBestEffort would at submission time -- see test/video-status-refund.test.js's identical helper. */
async function seedJobOwner(operationName, email, mediaType) {
  var jobOwners = require('../netlify/functions/lib/job-owners');
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, email, mediaType);
}

test('mark-generation-completed: a brand-new account\'s first verified video completion automatically sends the retention email, linking to profile.html', async function () {
  await registerAccount('autouser', 'autouser@example.com');
  var opName = realMockOpName('auto-1');
  await seedJobOwner(opName, 'autouser@example.com', 'video');
  var spies = installFetchSpy();

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' }, body: { operationName: opName } }));

  assert.equal(res.statusCode, 200);
  assert.equal(spies.resendCalls.length, 1, 'expected exactly one automatic Resend send, with no client request to send-first-dream-email.js at all');
  assert.deepEqual(spies.resendCalls[0].body.to, ['autouser@example.com']);
  assert.match(spies.resendCalls[0].body.html, /href="https:\/\/dreamtube1\.netlify\.app\/profile\.html"/, 'the automatic email must link to profile.html too');

  assert.equal(spies.posthogCalls.length, 1, 'expected the first_dream_email_sent PostHog event to fire on the actual send');
  assert.equal(spies.posthogCalls[0].body.event, 'first_dream_email_sent');
  assert.equal(spies.posthogCalls[0].body.distinct_id, 'autouser', 'distinct_id must be the raw username, matching this codebase\'s posthog.identify() convention');
  assert.equal(spies.posthogCalls[0].body.properties.auto, true, 'must be flagged as the automatic path, not the client-triggered fallback');
});

test('mark-generation-completed: a second (and third) completed video for the SAME account never sends a second automatic email', async function () {
  await registerAccount('repeatuser', 'repeatuser@example.com');
  var spies = installFetchSpy();
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;

  var firstOp = realMockOpName('repeat-1');
  await seedJobOwner(firstOp, 'repeatuser@example.com', 'video');
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: firstOp } }));
  assert.equal(spies.resendCalls.length, 1);

  var secondOp = realMockOpName('repeat-2');
  await seedJobOwner(secondOp, 'repeatuser@example.com', 'video');
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: secondOp } }));

  var thirdOp = realMockOpName('repeat-3');
  await seedJobOwner(thirdOp, 'repeatuser@example.com', 'video');
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: thirdOp } }));

  assert.equal(spies.resendCalls.length, 1, 'a 2nd/3rd completed video for the same account must never trigger a second automatic send');
  assert.equal(spies.posthogCalls.length, 1, 'the first_dream_email_sent event must also only fire once ever for this account');
});

test('CONCURRENCY: two of a brand-new account\'s videos completing at nearly the same instant send exactly one automatic email, never zero, never two', async function () {
  await registerAccount('raceruser', 'raceruser@example.com');
  var spies = installFetchSpy();
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;

  var opA = realMockOpName('race-a');
  var opB = realMockOpName('race-b');
  await seedJobOwner(opA, 'raceruser@example.com', 'video');
  await seedJobOwner(opB, 'raceruser@example.com', 'video');

  // Same "the mock Blobs store's operations are still genuinely async, so
  // a Promise.all races step-by-step exactly like two concurrent Netlify
  // Function invocations would" reasoning as test/session-transfer.test.js's
  // own concurrent-consume test -- this is what actually exercises
  // lib/first-dream-email-store.js's blobs-retry-backed claim under a real
  // race, not just two sequential calls that could never collide in a
  // synchronous mock.
  var results = await Promise.all([
    markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opA } })),
    markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opB } }))
  ]);

  results.forEach(function (r) { assert.equal(r.statusCode, 200); });
  assert.equal(spies.resendCalls.length, 1, 'exactly one of the two racing completions must win the send -- never both, never neither');
  assert.equal(spies.posthogCalls.length, 1);
});

test('mark-generation-completed: image mediaType is out of scope for the automatic send, matching the client-triggered endpoint\'s own video-only scope', async function () {
  await registerAccount('imageuser', 'imageuser@example.com');
  var opName = realMockOpName('image-1');
  await seedJobOwner(opName, 'imageuser@example.com', 'image');
  var spies = installFetchSpy();

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));

  assert.equal(res.statusCode, 200);
  assert.equal(spies.resendCalls.length, 0, 'an image-only completion must never trigger the video-only retention email');
});

test('mark-generation-completed: a job-owners record with no recorded mediaType (predates this field) fails CLOSED -- no automatic send, never assumed to be video', async function () {
  await registerAccount('legacyuser', 'legacyuser@example.com');
  var opName = realMockOpName('legacy-1');
  await seedJobOwner(opName, 'legacyuser@example.com', undefined); // no mediaType at all -- the pre-2026-07-27 record shape
  var spies = installFetchSpy();

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));

  assert.equal(spies.resendCalls.length, 0, 'an unrecorded mediaType must never be treated as video');
});

test('mark-generation-completed: an operationName with no job-owners record at all (predates the store, or the write failed) is a silent no-op', async function () {
  var opName = realMockOpName('no-owner-1');
  var spies = installFetchSpy();

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));

  assert.equal(res.statusCode, 200, 'the completion marker itself must still be recorded fine -- only the bonus email step no-ops');
  assert.equal(spies.resendCalls.length, 0);
});

test('mark-generation-completed: a job-owners email with no matching registered account is a silent no-op (no account to email)', async function () {
  var opName = realMockOpName('no-account-1');
  await seedJobOwner(opName, 'never-registered@example.com', 'video');
  var spies = installFetchSpy();

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));

  assert.equal(spies.resendCalls.length, 0);
});

test('mark-generation-completed: an operationName that fails completion verification never triggers the automatic email either (no marker, no send)', async function () {
  await registerAccount('unverifieduser', 'unverifieduser@example.com');
  // A freshly-minted mock operationName -- not enough elapsed time to
  // verify as genuinely complete (see test/generation-completion-marker
  // .test.js's own identical freshMockOpName scenario).
  var opName = 'mock:' + Date.now() + ':fresh';
  await seedJobOwner(opName, 'unverifieduser@example.com', 'video');
  var spies = installFetchSpy();

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));

  assert.equal(spies.resendCalls.length, 0, 'an unverified completion must never trigger the retention email, even with a real job-owner record on file');
});

test('mark-generation-completed + send-first-dream-email: the automatic path and the client-triggered fallback cooperate -- whichever fires first wins, the other is a harmless no-op', async function () {
  await registerAccount('cooperateuser', 'cooperateuser@example.com');
  var opName = realMockOpName('cooperate-1');
  await seedJobOwner(opName, 'cooperateuser@example.com', 'video');
  var spies = installFetchSpy();

  // The automatic path fires first (as it would in practice -- see
  // mark-generation-completed.js's own header comment on why it almost
  // always wins the real race against result.html loading).
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  assert.equal(spies.resendCalls.length, 1);

  // result.html's own client fallback still fires its request regardless
  // (it has no idea the automatic path already won) -- must be a no-op,
  // not a second send.
  var sendHandler = require('../netlify/functions/send-first-dream-email').handler;
  var fallbackRes = await sendHandler(fakeEvent({
    method: 'POST', ip: nextIp(),
    body: {
      username: 'cooperateuser', password: 'realpassword1', dreamId: 'dream-1',
      caption: 'A dream', style: 'Cinematic', videoUrl: 'https://example.com/v.mp4', mediaType: 'video'
    }
  }));
  assert.equal(JSON.parse(fallbackRes.body).ok, true);
  assert.equal(spies.resendCalls.length, 1, 'the client-triggered fallback must not send a second email once the automatic path already won');
});
