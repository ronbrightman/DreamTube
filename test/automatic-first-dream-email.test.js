// test/automatic-first-dream-email.test.js
//
// Covers the AUTOMATIC first-dream retention-email trigger (tracker.html's
// for-product-activate-automatic-retention-4n74rw item, founder-approved
// 2026-07-27 -- "start sending the first-video retention email
// AUTOMATICALLY when a user's first video finishes - do not wait for
// manual triggering"):
//   - netlify/functions/mark-generation-completed.js's new
//     maybeSendAutomaticFirstDreamEmail -- ENQUEUES the exact same
//     guarded send test/send-first-dream-email.test.js already covers via
//     the client-triggered HTTP endpoint, but resolves identity via
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
// THUMBNAIL-GATED SEND (added 2026-08-04, this same tracker item's
// founder-approved follow-up): mark-generation-completed.js no longer
// sends synchronously -- it only enqueues (lib/first-dream-email-pending-
// store.js's markPending); send-pending-first-dream-emails.js's scheduled
// scanAndSend is what actually decides whether to send now (a real
// thumbnail is already synced) or later (once the founder's 3-minute
// window elapses). Every test below that expects an actual Resend call
// now explicitly forces that decision via this file's own flushPending
// helper (which pushes the pending record's own triggeredAt past the
// deadline, then calls scanAndSend directly -- see
// test/send-pending-first-dream-emails.test.js for that scheduled
// function's OWN dedicated coverage of the wait/send-with-image/
// send-fallback decision itself; this file stays focused on everything
// UPSTREAM of the enqueue, which is completely unchanged by this follow-up
// -- job-owners/pending-dreams race hardening, the video-only scope, the
// pendingId/readyAt double-send guard). Any test below whose own skip
// condition is decided BEFORE the enqueue point (mediaType scope, no
// job-owner record, the readyAt double-send guard, an unverified
// completion, no matching account) needs no flush at all -- nothing was
// ever going to be enqueued in the first place, so there's nothing for a
// later scan to act on.
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
var crypto = require('crypto');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
// See test/helpers/fetch-double.js -- marks this file's own fetch double so
// lib/posthog-capture.js's test-process guard lets its analytics fires reach it.
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

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
 * Spies on global.fetch for the outbound calls this feature makes --
 * Resend (the actual email) and PostHog's capture endpoint (the
 * 'first_dream_email_sent'/'first_dream_email_skipped' events) -- same
 * split-by-URL convention test/dodo-webhook.test.js's
 * installAnalyticsFetchSpy already establishes for its own two-vendor
 * (PostHog + Meta CAPI) fire.
 *
 * `jwksKeyPair` (optional): when a test also needs to fire a real,
 * signature-verified dream-webhook.js call in the SAME scenario (the
 * webhook-vs-automatic-email ordering tests below), pass the Ed25519
 * keypair standing in for fal's own JWKS (same precedent as
 * test/dream-webhook.test.js's own keyPair) and this spy also serves
 * fetchJwks()'s lookup, so callers don't need to layer a second
 * global.fetch override on top of this one.
 */
function installFetchSpy(jwksKeyPair) {
  var resendCalls = [];
  var posthogCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    if (jwksKeyPair && urlStr.indexOf('jwks') !== -1) {
      var jwk = jwksKeyPair.publicKey.export({ format: 'jwk' });
      return { ok: true, status: 200, json: async function () { return { keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x }] }; } };
    }
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
  markInstalledFetchAsTestDouble();
  return { resendCalls: resendCalls, posthogCalls: posthogCalls };
}

/**
 * Builds a real, ED25519-signed fal.ai webhook event for dream-webhook.js
 * -- same signing scheme as test/dream-webhook.test.js's own
 * signRequest/webhookEvent helpers, duplicated here rather than shared
 * (this codebase's own "each test/lib file stays self-contained" -- see
 * e.g. lib/job-owners.js's header comment on duplicating normalizeEmail
 * rather than risk a require cycle -- applied to tests too).
 */
function realFalWebhookEvent(pendingId, bodyObj, keyPair) {
  var rawBody = JSON.stringify(bodyObj);
  var timestamp = String(Math.floor(Date.now() / 1000));
  var requestId = 'req-' + pendingId;
  var userId = 'user-' + pendingId;
  var bodyHash = crypto.createHash('sha256').update(Buffer.from(rawBody, 'utf8')).digest('hex');
  var message = Buffer.from([requestId, userId, timestamp, bodyHash].join('\n'), 'utf8');
  var signature = crypto.sign(null, message, keyPair.privateKey).toString('hex');
  return {
    httpMethod: 'POST',
    headers: {
      host: 'dreamtube1.netlify.app',
      'X-Fal-Webhook-Request-Id': requestId,
      'X-Fal-Webhook-User-Id': userId,
      'X-Fal-Webhook-Timestamp': timestamp,
      'X-Fal-Webhook-Signature': signature
    },
    queryStringParameters: { pendingId: pendingId },
    body: rawBody
  };
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
  delete require.cache[require.resolve('../netlify/functions/lib/first-dream-email-pending-store')];
  delete require.cache[require.resolve('../netlify/functions/send-pending-first-dream-emails')];
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

/**
 * Forces a pending record's `triggeredAt` (lib/first-dream-email-pending-
 * store.js) into the past, well beyond send-pending-first-dream-
 * emails.js's own THUMBNAIL_WAIT_MS, then runs its scanAndSend once --
 * modeling "a later scheduled run, after the founder's 3-minute window
 * has elapsed, with no thumbnail ever having synced" without this test
 * suite actually waiting 3 real minutes. A no-op (nothing to flush) for
 * any operationName that was never enqueued in the first place -- exactly
 * what every test whose OWN skip condition fires before the enqueue point
 * needs (see this file's own header comment).
 *
 * `hostHeaders` (optional): threaded into scanAndSend's own event so
 * lib/first-dream-email-sender.js's profileUrl/absoluteImageUrl resolve
 * the same host the corresponding markHandler call used -- pass the same
 * `{ host: '...' }` object a test's own markHandler call used whenever it
 * later asserts on a link's host.
 */
async function flushPending(operationName, hostHeaders) {
  var pendingStore = require('../netlify/functions/lib/first-dream-email-pending-store');
  var sendPending = require('../netlify/functions/send-pending-first-dream-emails');
  var record = await pendingStore.getPending(fakeEvent({}), operationName);
  if (record) {
    mockBlobs.seed(pendingStore.STORE_NAME, operationName, Object.assign({}, record, {
      triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS - 5000
    }));
  }
  return sendPending.scanAndSend(fakeEvent({ headers: hostHeaders || {} }));
}

test('mark-generation-completed: a brand-new account\'s first verified video completion ENQUEUES the retention email, and a later scan (no thumbnail synced within the window) sends it linking to profile.html', async function () {
  await registerAccount('autouser', 'autouser@example.com');
  var opName = realMockOpName('auto-1');
  await seedJobOwner(opName, 'autouser@example.com', 'video');
  var spies = installFetchSpy();

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' }, body: { operationName: opName } }));

  assert.equal(res.statusCode, 200);
  // THUMBNAIL-GATED SEND (see this file's own header comment): the mark
  // request itself only ENQUEUES now -- no Resend call happens on this
  // request at all.
  assert.equal(spies.resendCalls.length, 0, 'must not send synchronously on the mark request -- the send is deferred, gated on the captured thumbnail (or the 3-minute fallback)');

  var scanResult = await flushPending(opName, { host: 'dreamtube1.netlify.app' });
  assert.equal(scanResult.sentFallback, 1, 'no thumbnail was ever synced for this operationName, so the deferred scan must send the fallback template once the window elapses');

  assert.equal(spies.resendCalls.length, 1, 'expected exactly one automatic Resend send, with no client request to send-first-dream-email.js at all');
  assert.deepEqual(spies.resendCalls[0].body.to, ['autouser@example.com']);
  assert.match(spies.resendCalls[0].body.html, /href="https:\/\/dreamtube\.life\/profile\.html"/, 'the automatic email must link to profile.html too');
  // REAL THUMBNAIL (tracker item for-product-dream-ready-email-real-first-
  // qr9fbj) -- no dream was ever synced server-side for this operationName
  // in this test (no client-side finalizeDream/dream-sync call happened),
  // so send-pending-first-dream-emails.js's scan never finds an imageUrl
  // to send with, even after the wait -- falls back to the flat-color
  // banner. See test/send-pending-first-dream-emails.test.js for the
  // dedicated coverage of the "a thumbnail WAS synced in time" case.
  // NOTE: the redesigned shell (tracker item
  // for-product-email-redesign-unsubscribe-l-16ysmp) always renders its
  // own header <img> (the logo) regardless of thumbnail state -- so this
  // checks for absence of the THUMBNAIL <img> specifically (its own
  // distinct object-fit:cover style), not "no <img> anywhere".
  assert.doesNotMatch(spies.resendCalls[0].body.html, /object-fit:cover/, 'no thumbnail was synced within the window -- must fall back to the color banner, not a broken thumbnail <img>');

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
  assert.equal(spies.resendCalls.length, 0, 'the mark request only enqueues -- see this file\'s own header comment');
  await flushPending(firstOp);
  assert.equal(spies.resendCalls.length, 1);

  var secondOp = realMockOpName('repeat-2');
  await seedJobOwner(secondOp, 'repeatuser@example.com', 'video');
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: secondOp } }));
  await flushPending(secondOp);

  var thirdOp = realMockOpName('repeat-3');
  await seedJobOwner(thirdOp, 'repeatuser@example.com', 'video');
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: thirdOp } }));
  await flushPending(thirdOp);

  assert.equal(spies.resendCalls.length, 1, 'a 2nd/3rd completed video for the same account must never trigger a second automatic send');
  // Split by event name (tracker.html's for-product-bug-founder-affects-
  // all-funn-0efe7t gap #6 added a SEPARATE 'first_dream_email_skipped'
  // event, fired server-side for the 2nd/3rd attempt's own
  // guard-already-claimed no-op -- see lib/first-dream-email-sender.js's
  // reportSkip -- so posthogCalls.length alone is no longer a proxy for
  // "the send event fired once"; both event kinds legitimately share the
  // same /capture/ endpoint this spy watches).
  var sentEvents = spies.posthogCalls.filter(function (c) { return c.body.event === 'first_dream_email_sent'; });
  var skippedEvents = spies.posthogCalls.filter(function (c) { return c.body.event === 'first_dream_email_skipped'; });
  assert.equal(sentEvents.length, 1, 'the first_dream_email_sent event must also only fire once ever for this account');
  assert.equal(skippedEvents.length, 2, 'the 2nd and 3rd already-sent attempts must each surface a first_dream_email_skipped event instead of silently vanishing');
  skippedEvents.forEach(function (c) { assert.equal(c.body.properties.reason, 'already_sent'); });
});

test('CONCURRENCY: two of a brand-new account\'s videos completing at nearly the same instant send exactly one automatic email, never zero, never two', async function () {
  await registerAccount('raceruser', 'raceruser@example.com');
  var spies = installFetchSpy();
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var pendingStore = require('../netlify/functions/lib/first-dream-email-pending-store');
  var sendPending = require('../netlify/functions/send-pending-first-dream-emails');

  var opA = realMockOpName('race-a');
  var opB = realMockOpName('race-b');
  await seedJobOwner(opA, 'raceruser@example.com', 'video');
  await seedJobOwner(opB, 'raceruser@example.com', 'video');

  // The mark requests themselves only ENQUEUE now (see this file's own
  // header comment) -- each against its OWN operationName key, so there's
  // no real race between them at this step (lib/first-dream-email-pending-
  // store.js's CAS write can't collide with itself across two different
  // keys). The genuine race this test exists to exercise -- TWO attempts
  // to send THE SAME ACCOUNT's once-ever email landing concurrently --
  // now lives one layer downstream, in send-pending-first-dream-emails.js's
  // own scanAndSend, once both of this account's pending records are past
  // their deadline in the SAME window.
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opA } }));
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opB } }));

  var recordA = await pendingStore.getPending(fakeEvent({}), opA);
  var recordB = await pendingStore.getPending(fakeEvent({}), opB);
  var pastDeadline = Date.now() - sendPending.THUMBNAIL_WAIT_MS - 5000;
  mockBlobs.seed(pendingStore.STORE_NAME, opA, Object.assign({}, recordA, { triggeredAt: pastDeadline }));
  mockBlobs.seed(pendingStore.STORE_NAME, opB, Object.assign({}, recordB, { triggeredAt: pastDeadline }));

  // Same "the mock Blobs store's operations are still genuinely async, so
  // a Promise.all races step-by-step exactly like two concurrent Netlify
  // Function invocations would" reasoning as test/session-transfer.test.js's
  // own concurrent-consume test -- two overlapping scheduled-scan
  // invocations, both seeing both of this account's now-past-deadline
  // pending records, is what actually exercises lib/first-dream-email-
  // store.js's blobs-retry-backed claim under a real race, not just two
  // sequential calls that could never collide in a synchronous mock.
  var results = await Promise.all([
    sendPending.scanAndSend(fakeEvent({})),
    sendPending.scanAndSend(fakeEvent({}))
  ]);

  assert.equal(results[0].scanned + results[1].scanned, 4, 'both scans should each see both of this account\'s two pending records');
  assert.equal(spies.resendCalls.length, 1, 'exactly one of the two racing completions must win the send -- never both, never neither');
  // See the "second (and third) completed video" test above for why this
  // is now split by event name -- the race's LOSER now also fires a
  // 'first_dream_email_skipped' event (gap #6), sharing the same
  // /capture/ endpoint this spy watches.
  var sentEvents = spies.posthogCalls.filter(function (c) { return c.body.event === 'first_dream_email_sent'; });
  assert.equal(sentEvents.length, 1);
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

// REWRITTEN (tracker.html's for-product-bug-founder-affects-all-funn-0efe7t,
// gap #3): before the 2026-07-28 fix, EVERY funnel-started generation
// (start-pending-generation.js) hit exactly this "no job-owners record at
// all" case, 100% of the time -- start-pending-generation.js bypassed
// generate-video.js's/generate-image.js's own recordJobOwnerBestEffort
// entirely (see that file's own header comment for the full root-cause
// writeup). This test's title used to frame that as a narrow, acceptable
// edge case ("predates the store, or the write failed") without ever
// naming the funnel path as the actual, common cause in production --
// which in effect asserted the live bug's own broken behavior as correct,
// with nothing in this file ever exercising the real funnel entry point to
// notice. It's rewritten below to (a) make explicit that a genuinely
// missing record is now ONLY the write-failure/predates-the-store case,
// never a funnel-started generation (which gets a real record too, as of
// the fix), and (b) pair it with a new test right after that composes the
// REAL chain (start-pending-generation.js -> claim-pending-generation.js ->
// mark-generation-completed.js) and proves the funnel path now DOES send.
test('mark-generation-completed: an operationName with no job-owners record for a genuine reason OTHER than the funnel path (predates the store, or the write itself failed) is still a silent no-op', async function () {
  // NOTE: this is deliberately NOT how a funnel-started (start-pending-
  // generation.js) operationName behaves anymore -- see the fixed-behavior
  // test immediately below, which starts from that real entry point and
  // asserts the opposite outcome (the email DOES send).
  var opName = realMockOpName('no-owner-1');
  var spies = installFetchSpy();

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));

  assert.equal(res.statusCode, 200, 'the completion marker itself must still be recorded fine -- only the bonus email step no-ops');
  assert.equal(spies.resendCalls.length, 0);
});

// -----------------------------------------------------------------------
// ROOT-CAUSE FIX, END-TO-END (tracker.html's
// for-product-bug-founder-affects-all-funn-0efe7t): composes the REAL
// chain that was actually broken -- start-pending-generation.js (the
// funnel/wizard's pre-signup generation entry point) -> a real signup ->
// claim-pending-generation.js (the wizard's own "I made it in" call) ->
// mark-generation-completed.js (home.html's completion choke point, formerly processing.html's before that page was removed)
// -- rather than hand-seeding a job-owners record the way every other test
// in this file does (which proves mark-generation-completed.js's OWN logic
// is correct in isolation, but would have kept passing even with the real
// bug still live, since start-pending-generation.js was never exercised at
// all). This is the QA-bar test the founder's own standing rule for this
// fix asked for: "no test composes the REAL chain... add an end-to-end
// behavioral test: funnel submission -> completion -> assert the email
// send was actually attempted with the right recipient."
// -----------------------------------------------------------------------

/**
 * Advances the embedded start-timestamp of whatever mock operationName
 * `fn` mints into the past by `pastMs`, so mark-generation-completed.js's
 * verifyOperationCompleted (which requires MOCK_MIN_ELAPSED_MS/5000ms of
 * real elapsed time) treats it as already genuinely complete the instant
 * it's minted, without this test actually waiting 5+ real seconds.
 * Mirrors test/fal-webhook-jwks-cache.test.js's own Date.now monkeypatch
 * precedent -- restored in a `finally` so a thrown error can never leave
 * the process' real clock patched for any later test.
 */
async function withPastClock(pastMs, fn) {
  var realNow = Date.now;
  Date.now = function () { return realNow() - pastMs; };
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test('END-TO-END ROOT-CAUSE FIX: a funnel-started generation (start-pending-generation.js), once claimed by a real signup and completed, automatically sends the retention email to the funnel user\'s own email', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  delete require.cache[require.resolve('../netlify/functions/start-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/claim-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/lib/pending-dreams')];
  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var claimHandler = require('../netlify/functions/claim-pending-generation').handler;

  var funnelEmail = 'funnel-completer@example.com';

  // 1) The dream-builder wizard's pre-signup "generate during signup" call
  //    -- BEFORE this fix, this is the exact call that never wrote a
  //    job-owners record at all.
  var startRes = await withPastClock(60000, function () {
    return startHandler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: { email: funnelEmail, caption: 'a funnel-built dream', style: 'Cinematic' }
    }));
  });
  assert.equal(startRes.statusCode, 200);
  var startData = JSON.parse(startRes.body);
  assert.ok(startData.pendingId);
  assert.match(startData.operationName, /^mock:/);

  // 2) The real signup completes (same funnel user, same email) --
  //    wizard.html's own next step.
  await registerAccount('funnelcompleter', funnelEmail);

  // 3) wizard.html's own claim-pending-generation call, telling
  //    dream-webhook.js "this one made it in on their own" -- also
  //    required so the pending record is 'claimed', not 'pending', by the
  //    time this test's next assertion (the paired "exactly one email"
  //    test below) checks that the abandonment email path stays silent.
  var claimRes = await claimHandler(fakeEvent({
    method: 'POST', ip: nextIp(), body: { pendingId: startData.pendingId, email: funnelEmail }
  }));
  assert.equal(JSON.parse(claimRes.body).claimed, true, 'test setup: the claim itself must succeed');

  // 4) home.html's real completion choke point -- the same request
  //    js/store.js's markGenerationJustCompleted fires once its poll of
  //    video-status.js sees the (mock) generation done.
  var spies = installFetchSpy();
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var markRes = await markHandler(fakeEvent({
    method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
    body: { operationName: startData.operationName }
  }));
  assert.equal(markRes.statusCode, 200);
  assert.equal(spies.resendCalls.length, 0, 'the mark request only enqueues -- see this file\'s own header comment');
  await flushPending(startData.operationName, { host: 'dreamtube1.netlify.app' });

  assert.equal(spies.resendCalls.length, 1, 'the ROOT CAUSE FIX: a funnel-started generation must now get a job-owners record and trigger the automatic retention email, exactly like a normal signed-in generation already did');
  assert.deepEqual(spies.resendCalls[0].body.to, [funnelEmail], 'the email must go to the funnel user\'s own real email, not anything else');
});

test('EXACTLY ONE EMAIL, NOT TWO: a completed funnel user gets the automatic retention email, and the SAME pending record staying \'claimed\' means the separate abandonment-email path (dream-webhook.js) never also fires for them', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  delete require.cache[require.resolve('../netlify/functions/start-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/claim-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/lib/pending-dreams')];
  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var claimHandler = require('../netlify/functions/claim-pending-generation').handler;
  var pendingDreams = require('../netlify/functions/lib/pending-dreams');

  var funnelEmail = 'exactly-one-email@example.com';

  var startRes = await withPastClock(60000, function () {
    return startHandler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: { email: funnelEmail, caption: 'a funnel-built dream', style: 'Cinematic' }
    }));
  });
  var startData = JSON.parse(startRes.body);

  await registerAccount('exactlyoneuser', funnelEmail);
  await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { pendingId: startData.pendingId, email: funnelEmail } }));

  var falWebhookVerify = require('../netlify/functions/lib/fal-webhook-verify');
  falWebhookVerify.resetJwksCacheForTests();
  var keyPair = crypto.generateKeyPairSync('ed25519');
  var spies = installFetchSpy(keyPair);

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  await markHandler(fakeEvent({
    method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
    body: { operationName: startData.operationName }
  }));
  await flushPending(startData.operationName, { host: 'dreamtube1.netlify.app' });
  assert.equal(spies.resendCalls.length, 1, 'the completer must get exactly one email from the automatic retention-email path');

  // Now simulate fal's own webhook finally arriving for this SAME pending
  // dream (dream-webhook.js) -- since claim-pending-generation.js already
  // marked it 'claimed' above, this must be a harmless no-op that never
  // sends the SEPARATE abandonment email too (see dream-webhook.js's own
  // "already-claimed" branch, and test/dream-webhook.test.js's identical
  // coverage for that branch in isolation).
  var record = await pendingDreams.get({}, startData.pendingId);
  assert.equal(record.status, 'claimed', 'test setup: the pending record must genuinely be claimed by this point');

  var dreamWebhookHandler = require('../netlify/functions/dream-webhook').handler;
  var bodyObj = { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } };
  var webhookRes = await dreamWebhookHandler(realFalWebhookEvent(startData.pendingId, bodyObj, keyPair));
  assert.equal(webhookRes.statusCode, 200);
  assert.equal(JSON.parse(webhookRes.body).claimed, true, 'dream-webhook.js must recognize this record as already claimed');

  assert.equal(spies.resendCalls.length, 1, 'the abandonment-email path must NOT also fire for a user who went on to complete -- exactly one email total, never two');
});

// -----------------------------------------------------------------------
// REVIEW ROUND 1 FINDING (tracker.html's for-product-bug-founder-affects-
// all-funn-0efe7t): the root-cause fix above (start-pending-generation.js
// now recording a job-owners entry for every funnel job) closes the
// original bug but opens a new one for the OPPOSITE ordering from the test
// above. Concrete sequence, fully reachable in normal usage (not a race):
//   1. Wizard always generates video; Veo takes 1-6 minutes
//      (dream-webhook.js's own doc comment).
//   2. The user is still working through style/characters/signup when
//      fal's webhook arrives FIRST -- dream-webhook.js's markReady
//      succeeds (pending -> ready), the abandonment "your dream is ready"
//      email actually sends, then markNotified (ready -> notified).
//   3. The user THEN finishes signup normally in the same wizard tab.
//      claim-pending-generation.js's markClaimed is explicitly allowed to
//      succeed from 'notified' (pending-dreams.js's own doc comment:
//      "claiming after the re-engagement email already fully went out is
//      still meaningful bookkeeping") -- status becomes 'claimed'.
//   4. wizard.html redirects to home.html, which calls
//      mark-generation-completed.js once its poll sees the job done.
//   5. maybeSendAutomaticFirstDreamEmail had ZERO awareness of
//      pending-dreams.js's state -- it only ever consulted
//      job-owners.getJobOwnerRecord. Since the root-cause fix now gives
//      every funnel job a job-owners record, this resolves a real account
//      and fires the automatic email too -- a SECOND email to the same
//      address, violating the founder's "exactly one, never two" decision.
//
// Fix: lib/job-owners.js's recordJobOwner gained an optional pendingId
// (recorded by start-pending-generation.js, which already has it on hand
// at the exact moment it writes the job-owner record). mark-generation-
// completed.js's maybeSendAutomaticFirstDreamEmail now looks up that
// pending-dreams record (when a pendingId is present) and skips the
// automatic send if `readyAt` is set -- readyAt is written atomically the
// INSTANT dream-webhook.js's markReady succeeds, before the abandonment
// email's own network round trip even starts, and (unlike `status`) it is
// NEVER cleared by a later markClaimed transition (tryTransition's patch
// only sets the fields it's given -- see pending-dreams.js's own
// Object.assign order -- so readyAt survives ready/notified -> claimed
// exactly as a durable "the abandonment path already owns this send"
// flag, even once `status` itself has moved on to 'claimed'). A record
// with no pendingId at all (every NON-funnel generate-video.js/
// generate-image.js job) or one that was never marked ready skips this
// check entirely -- zero behavior change for the primary path.
// -----------------------------------------------------------------------

test('WEBHOOK-BEFORE-CLAIM ORDERING: the abandonment email firing first (webhook reaches \'notified\' before the user claims) must suppress the automatic retention email -- exactly one email total, never two', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  delete require.cache[require.resolve('../netlify/functions/start-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/claim-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/dream-webhook')];
  delete require.cache[require.resolve('../netlify/functions/lib/pending-dreams')];
  delete require.cache[require.resolve('../netlify/functions/lib/fal-webhook-verify')];
  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var claimHandler = require('../netlify/functions/claim-pending-generation').handler;
  var dreamWebhookHandler = require('../netlify/functions/dream-webhook').handler;
  var falWebhookVerify = require('../netlify/functions/lib/fal-webhook-verify');
  var pendingDreams = require('../netlify/functions/lib/pending-dreams');
  falWebhookVerify.resetJwksCacheForTests();

  var funnelEmail = 'webhook-before-claim@example.com';
  var keyPair = crypto.generateKeyPairSync('ed25519');
  var spies = installFetchSpy(keyPair);

  // 1) Funnel submission -- same real entry point as the other end-to-end
  //    tests above.
  var startRes = await withPastClock(60000, function () {
    return startHandler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: { email: funnelEmail, caption: 'a funnel-built dream', style: 'Cinematic' }
    }));
  });
  var startData = JSON.parse(startRes.body);
  assert.ok(startData.pendingId);

  // 2) fal's webhook arrives FIRST, while the record is still 'pending' --
  //    the user hasn't finished signup yet. This is dream-webhook.js's own
  //    real success path: markReady (pending -> ready) -> send the
  //    abandonment email -> markNotified (ready -> notified).
  var bodyObj = { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } };
  var webhookRes = await dreamWebhookHandler(realFalWebhookEvent(startData.pendingId, bodyObj, keyPair));
  assert.equal(webhookRes.statusCode, 200);
  assert.equal(spies.resendCalls.length, 1, 'test setup: the abandonment email must have actually sent at this point');

  var afterWebhook = await pendingDreams.get({}, startData.pendingId);
  assert.equal(afterWebhook.status, 'notified', 'test setup: the record must genuinely be notified before the claim below');
  assert.ok(afterWebhook.readyAt, 'test setup: readyAt must be set -- this is the durable signal the fix relies on');

  // 3) The user THEN finishes signup in the same wizard tab -- markClaimed
  //    is explicitly allowed to succeed from 'notified' (see pending-
  //    dreams.js's own doc comment).
  await registerAccount('webhookbeforeclaim', funnelEmail);
  var claimRes = await claimHandler(fakeEvent({
    method: 'POST', ip: nextIp(), body: { pendingId: startData.pendingId, email: funnelEmail }
  }));
  assert.equal(JSON.parse(claimRes.body).claimed, true, 'test setup: the claim itself must succeed from \'notified\'');
  var afterClaim = await pendingDreams.get({}, startData.pendingId);
  assert.equal(afterClaim.status, 'claimed', 'test setup: status has moved on to claimed, same as the normal case');
  assert.ok(afterClaim.readyAt, 'test setup: readyAt must still be set even after the status moved past \'notified\' to \'claimed\'');

  // 4) home.html's real completion choke point -- must NOT fire a
  //    second email, even though a real job-owners record (with a real
  //    matching account) now resolves for this operationName.
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var markRes = await markHandler(fakeEvent({
    method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
    body: { operationName: startData.operationName }
  }));
  assert.equal(markRes.statusCode, 200);

  assert.equal(spies.resendCalls.length, 1, 'THE FIX: the automatic retention email must NOT also fire once the abandonment path already sent -- exactly one email total, never two');
  // This skip fires BEFORE the enqueue point (see this file's own header
  // comment) -- nothing was ever enqueued, so a later scan has nothing to
  // act on either. Flushed anyway, defensively, to prove that stays true.
  await flushPending(startData.operationName, { host: 'dreamtube1.netlify.app' });
  assert.equal(spies.resendCalls.length, 1, 'a later scan must not conjure up a second send either');
});

// -----------------------------------------------------------------------
// REVIEW ROUND 2 FINDING (same tracker item): round 1's fix (gate on
// `pendingRecord.readyAt`) assumed readyAt means "the abandonment email
// path already committed to sending." But readyAt used to be set by TWO
// different dream-webhook.js branches, and only ONE of them sends an
// email:
//   (a) transition.ok === true (pendingDreams.markReady really moved
//       pending -> ready) -- the real send path, sendReadyEmail actually
//       fires.
//   (b) transition.record.status === 'claimed' -- a real signup ALREADY
//       completed before the webhook arrived; this branch is pure
//       bookkeeping ("record the finished video... skip the re-engagement
//       send entirely") and never sends anything -- but it used to ALSO
//       stamp readyAt, indistinguishable from branch (a).
//
// Branch (b) is the LIKELY TYPICAL ordering for a normal (non-abandoning)
// funnel completion, not a rare edge case: claim-pending-generation.js
// fires the instant signup succeeds, which is almost always well before
// Veo's 1-6 minute generation actually finishes. So for most ordinary
// completions, round 1's check would have found readyAt already set (via
// the no-email bookkeeping branch) and incorrectly skipped the automatic
// email -- regressing straight back toward the ORIGINAL "no email ever"
// bug this whole tracker item exists to fix.
//
// Fix: dream-webhook.js's 'claimed' bookkeeping branch no longer stamps
// readyAt at all (just videoUrl) -- readyAt now means, unambiguously,
// "the abandonment email path actually sent (or genuinely committed to
// sending)," exactly once, only ever set by markReady's own real send
// transition. Confirmed via a full-repo grep that nothing else reads or
// writes readyAt besides these two call sites and mark-generation-
// completed.js's own check.
// -----------------------------------------------------------------------

test('CLAIM-BEFORE-WEBHOOK ORDERING (the realistic/typical case): claiming while still \'pending\' (well before Veo finishes), then the webhook arriving and hitting the bookkeeping-only \'claimed\' branch, must NOT suppress the automatic retention email', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  delete require.cache[require.resolve('../netlify/functions/start-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/claim-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/dream-webhook')];
  delete require.cache[require.resolve('../netlify/functions/lib/pending-dreams')];
  delete require.cache[require.resolve('../netlify/functions/lib/fal-webhook-verify')];
  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var claimHandler = require('../netlify/functions/claim-pending-generation').handler;
  var dreamWebhookHandler = require('../netlify/functions/dream-webhook').handler;
  var falWebhookVerify = require('../netlify/functions/lib/fal-webhook-verify');
  var pendingDreams = require('../netlify/functions/lib/pending-dreams');
  falWebhookVerify.resetJwksCacheForTests();

  var funnelEmail = 'claim-before-webhook@example.com';
  var keyPair = crypto.generateKeyPairSync('ed25519');
  var spies = installFetchSpy(keyPair);

  // 1) Funnel submission.
  var startRes = await withPastClock(60000, function () {
    return startHandler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: { email: funnelEmail, caption: 'a funnel-built dream', style: 'Cinematic' }
    }));
  });
  var startData = JSON.parse(startRes.body);
  assert.ok(startData.pendingId);

  // 2) The user finishes signup WELL BEFORE Veo finishes -- the typical
  //    real-world ordering (claim-pending-generation.js fires the instant
  //    signup succeeds; a fresh record is still 'pending' at this point,
  //    nothing to do with the webhook yet).
  await registerAccount('claimbeforewebhook', funnelEmail);
  var claimRes = await claimHandler(fakeEvent({
    method: 'POST', ip: nextIp(), body: { pendingId: startData.pendingId, email: funnelEmail }
  }));
  assert.equal(JSON.parse(claimRes.body).claimed, true, 'test setup: the claim must succeed from \'pending\'');
  var afterClaim = await pendingDreams.get({}, startData.pendingId);
  assert.equal(afterClaim.status, 'claimed');
  assert.equal(afterClaim.readyAt, null, 'test setup: readyAt must still be unset -- no abandonment email has any reason to exist yet');

  // 3) fal's webhook arrives AFTER the claim -- dream-webhook.js's
  //     markReady fails (record is already 'claimed', not 'pending'/
  //     'ready'), so this hits the bookkeeping-only 'claimed' branch:
  //     records videoUrl, sends NO email.
  var bodyObj = { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } };
  var webhookRes = await dreamWebhookHandler(realFalWebhookEvent(startData.pendingId, bodyObj, keyPair));
  assert.equal(webhookRes.statusCode, 200);
  assert.equal(JSON.parse(webhookRes.body).claimed, true, 'test setup: the webhook must recognize this as the already-claimed bookkeeping branch');
  assert.equal(spies.resendCalls.length, 0, 'test setup: the bookkeeping branch must never send the abandonment email');

  var afterWebhook = await pendingDreams.get({}, startData.pendingId);
  assert.equal(afterWebhook.videoUrl, 'https://cdn.fal/finished.mp4', 'test setup: videoUrl bookkeeping must still be recorded');
  assert.equal(afterWebhook.readyAt, null, 'THE FIX: readyAt must stay unset -- this bookkeeping branch never actually sent an email, so it must never look like it did');

  // 4) home.html's real completion choke point -- the automatic
  //    retention email is the ONLY email this user will ever get, and it
  //    MUST fire here.
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var markRes = await markHandler(fakeEvent({
    method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
    body: { operationName: startData.operationName }
  }));
  assert.equal(markRes.statusCode, 200);
  assert.equal(spies.resendCalls.length, 0, 'the mark request only enqueues -- see this file\'s own header comment');
  await flushPending(startData.operationName, { host: 'dreamtube1.netlify.app' });

  assert.equal(spies.resendCalls.length, 1, 'THE FIX: the automatic retention email MUST still fire for the typical claim-before-webhook ordering -- this is the only email this user will ever get');
  assert.deepEqual(spies.resendCalls[0].body.to, [funnelEmail]);
});

// -----------------------------------------------------------------------
// NARROW RESIDUAL RACE, HARDENED (tracker.html's
// narrow-residual-race-mark-generation-com-wenb3g item): the
// WEBHOOK-BEFORE-CLAIM ORDERING test above proves the *typical* case
// (readyAt already fully visible by the time mark-generation-completed.js
// reads it) stays correct. This test proves the narrower case that same
// test could never reach with a synchronous in-memory mock: dream-
// webhook.js's markReady has ALREADY genuinely committed readyAt to the
// store, but mark-generation-completed.js's own INDEPENDENT read of that
// same key initially lands on a stale, pre-write snapshot (Blobs' eventual
// consistency) -- exactly the window lib/pending-dreams.js's
// getWithReadyRetry exists to narrow. Uses mock-blobs' setReadOverride
// (the same mechanism test/blobs-retry.test.js/test/pending-dreams.test.js
// use for this class of hazard) to simulate the lagging read deterministically,
// since a plain synchronous Map can never reproduce genuine propagation lag.
// -----------------------------------------------------------------------

test('RESIDUAL RACE HARDENING: a readyAt write that has genuinely landed but has not yet propagated to mark-generation-completed.js\'s own independent read must still suppress the automatic email, not double-send', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  delete require.cache[require.resolve('../netlify/functions/start-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/claim-pending-generation')];
  delete require.cache[require.resolve('../netlify/functions/dream-webhook')];
  delete require.cache[require.resolve('../netlify/functions/lib/pending-dreams')];
  delete require.cache[require.resolve('../netlify/functions/lib/fal-webhook-verify')];
  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var claimHandler = require('../netlify/functions/claim-pending-generation').handler;
  var dreamWebhookHandler = require('../netlify/functions/dream-webhook').handler;
  var falWebhookVerify = require('../netlify/functions/lib/fal-webhook-verify');
  var pendingDreams = require('../netlify/functions/lib/pending-dreams');
  falWebhookVerify.resetJwksCacheForTests();

  var funnelEmail = 'residual-race@example.com';
  var keyPair = crypto.generateKeyPairSync('ed25519');
  var spies = installFetchSpy(keyPair);

  // 1) Funnel submission, then the webhook arrives FIRST (same real
  //    ordering as the WEBHOOK-BEFORE-CLAIM test above) -- readyAt is now
  //    genuinely, durably committed on the underlying store.
  var startRes = await withPastClock(60000, function () {
    return startHandler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: { email: funnelEmail, caption: 'a funnel-built dream', style: 'Cinematic' }
    }));
  });
  var startData = JSON.parse(startRes.body);
  assert.ok(startData.pendingId);

  var bodyObj = { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } };
  var webhookRes = await dreamWebhookHandler(realFalWebhookEvent(startData.pendingId, bodyObj, keyPair));
  assert.equal(webhookRes.statusCode, 200);
  assert.equal(spies.resendCalls.length, 1, 'test setup: the abandonment email must have actually sent');

  var trueRecord = await pendingDreams.get({}, startData.pendingId);
  assert.ok(trueRecord.readyAt, 'test setup: readyAt is genuinely, durably set on the real store at this point');

  await registerAccount('residualrace', funnelEmail);
  var claimRes = await claimHandler(fakeEvent({
    method: 'POST', ip: nextIp(), body: { pendingId: startData.pendingId, email: funnelEmail }
  }));
  assert.equal(JSON.parse(claimRes.body).claimed, true, 'test setup: the claim must succeed from \'notified\'');

  // 2) Simulate mark-generation-completed.js's OWN read of this exact
  //    record lagging behind the write above -- the first get() against
  //    this store returns a snapshot with readyAt still null, even though
  //    the real store (asserted above) already has it durably set. Every
  //    later read falls through to the real, already-committed value --
  //    modeling propagation catching up within getWithReadyRetry's own
  //    bounded retry window, not a hazard that never resolves.
  mockBlobs.setReadOverride(pendingDreams.STORE_NAME, function (key, callCount) {
    if (callCount === 1) return { value: Object.assign({}, trueRecord, { readyAt: null }) };
    return false;
  });

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var markRes = await markHandler(fakeEvent({
    method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
    body: { operationName: startData.operationName }
  }));
  assert.equal(markRes.statusCode, 200);

  mockBlobs.clearReadOverride(pendingDreams.STORE_NAME);

  assert.equal(spies.resendCalls.length, 1, 'THE FIX: even with mark-generation-completed.js\'s own first read of readyAt landing stale, the bounded retry must recover the true value and skip the automatic send -- exactly one email total, never two');
  // This skip fires BEFORE the enqueue point -- nothing was enqueued for
  // startData.operationName, so a later scan has nothing to act on either.
  await flushPending(startData.operationName, { host: 'dreamtube1.netlify.app' });
  assert.equal(spies.resendCalls.length, 1, 'a later scan must not conjure up a second send either');
});

// -----------------------------------------------------------------------
// ROUND-3 HARDENING (tracker.html's for-product-bug-founder-affects-all-
// funn-0efe7t, REOPENED after failing founder QA and burning a real
// production user's 203 no_job_owner_record retries over 7 hours): the
// RESIDUAL RACE HARDENING test above proves mark-generation-completed.js's
// OWN pending-dreams (readyAt) read already recovers from exactly this
// class of lagging-read hazard via getWithReadyRetry. Its job-owners read
// (getJobOwnerRecord) had NO equivalent at all -- a genuine, confirmed
// inconsistency within the SAME function -- closed by
// lib/job-owners.js's new getJobOwnerRecordWithRetry. This test proves
// that fix using the identical proof technique (mock-blobs'
// setReadOverride simulating a write that already genuinely landed on the
// real store but hasn't yet propagated to this independent read).
// -----------------------------------------------------------------------

test('ROUND-3 HARDENING: a job-owners write that has genuinely landed but has not yet propagated to mark-generation-completed.js\'s own independent read must still resolve and send, not silently skip as no_job_owner_record', async function () {
  await registerAccount('lagginguser', 'lagginguser@example.com');
  var opName = realMockOpName('lagging-1');
  await seedJobOwner(opName, 'lagginguser@example.com', 'video');
  var spies = installFetchSpy();

  var jobOwners = require('../netlify/functions/lib/job-owners');
  // Simulate ONE lagging read against the job-owners store specifically:
  // the very next get() sees nothing yet, even though the real store
  // (seedJobOwner above) already has the record durably written -- exactly
  // the "issued but not yet visible to an independent reader" window this
  // fix exists for.
  mockBlobs.setReadOverride(jobOwners.STORE_NAME, function (key, callCount) {
    if (callCount === 1) return { value: undefined };
    return false; // fall through to the real (already-written) value on every later call
  });

  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  mockBlobs.clearReadOverride(jobOwners.STORE_NAME);
  await flushPending(opName);

  assert.equal(res.statusCode, 200);
  assert.equal(spies.resendCalls.length, 1, 'THE FIX: a single lagging read of the job-owners store must not surface as no_job_owner_record -- the bounded retry must recover the real record and send');
  var skippedEvents = spies.posthogCalls.filter(function (c) { return c.body.event === 'first_dream_email_skipped' && c.body.properties.reason === 'no_job_owner_record'; });
  assert.equal(skippedEvents.length, 0, 'must not fire the no_job_owner_record skip event when the record genuinely exists, just lagged on the first read');
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

test('mark-generation-completed + send-first-dream-email: the client-triggered fallback firing FIRST (now the realistic ordering, per the automatic path\'s own deferred/gated send) cooperates cleanly -- the automatic path\'s later scan is a harmless no-op', async function () {
  await registerAccount('cooperateuser', 'cooperateuser@example.com');
  var opName = realMockOpName('cooperate-1');
  await seedJobOwner(opName, 'cooperateuser@example.com', 'video');
  var spies = installFetchSpy();

  // THUMBNAIL-GATED SEND (see this file's own header comment): the
  // automatic path's real send is now deferred by up to 3 minutes, so the
  // client-triggered fallback (fired the moment result.html loads) is the
  // REALISTIC winner of this race now, not the automatic path -- the
  // reverse of this test's pre-2026-08-04 framing. Enqueue via the mark
  // request first (mirroring the real ordering: home.html calls both
  // markGenerationJustCompleted and, moments later, its own fallback),
  // but do NOT flush yet.
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  assert.equal(spies.resendCalls.length, 0);

  // result.html's own client fallback fires next, well within the
  // 3-minute window, and wins the real send.
  var sendHandler = require('../netlify/functions/send-first-dream-email').handler;
  var fallbackRes = await sendHandler(fakeEvent({
    method: 'POST', ip: nextIp(),
    body: {
      username: 'cooperateuser', password: 'realpassword1', dreamId: 'dream-1',
      caption: 'A dream', style: 'Cinematic', videoUrl: 'https://example.com/v.mp4', mediaType: 'video'
    }
  }));
  assert.equal(JSON.parse(fallbackRes.body).ok, true);
  assert.equal(spies.resendCalls.length, 1, 'the client-triggered fallback wins the real send');

  // The automatic path's later deferred scan (once the 3-minute window
  // elapses with no thumbnail synced) must be a harmless no-op -- the
  // once-ever guard already claimed by the fallback above.
  await flushPending(opName);
  assert.equal(spies.resendCalls.length, 1, 'the automatic path\'s later scan must not send a second email once the client-triggered fallback already won');
});

test('mark-generation-completed + send-first-dream-email: the automatic path winning first (client never reaches result.html at all) cooperates cleanly -- the fallback endpoint is a harmless no-op', async function () {
  await registerAccount('automatonuser', 'automatonuser@example.com');
  var opName = realMockOpName('cooperate-2');
  await seedJobOwner(opName, 'automatonuser@example.com', 'video');
  var spies = installFetchSpy();

  // Models the client never getting far enough to call the fallback at
  // all (tab closed, connection lost) -- the automatic path's own
  // deferred scan, once the 3-minute window elapses, is the ONLY thing
  // that ever sends.
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  await flushPending(opName);
  assert.equal(spies.resendCalls.length, 1);

  // A late-arriving client fallback (e.g. a delayed retry) must still be a
  // harmless no-op.
  var sendHandler = require('../netlify/functions/send-first-dream-email').handler;
  var fallbackRes = await sendHandler(fakeEvent({
    method: 'POST', ip: nextIp(),
    body: {
      username: 'automatonuser', password: 'realpassword1', dreamId: 'dream-1',
      caption: 'A dream', style: 'Cinematic', videoUrl: 'https://example.com/v.mp4', mediaType: 'video'
    }
  }));
  assert.equal(JSON.parse(fallbackRes.body).ok, true);
  assert.equal(spies.resendCalls.length, 1, 'the client-triggered fallback must not send a second email once the automatic path already won');
});
