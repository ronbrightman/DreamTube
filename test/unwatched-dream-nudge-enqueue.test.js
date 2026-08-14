// test/unwatched-dream-nudge-enqueue.test.js
//
// Covers the ENQUEUE side of the "unwatched dream" retention nudge
// (founder-approved retention plan, piece 1): mark-generation-completed.js's
// maybeEnqueueUnwatchedNudge. This is the integration between
// mark-generation-completed.js, lib/job-owners.js, lib/account-store.js,
// lib/pending-dreams.js, and lib/unwatched-dream-nudge-store.js —
// deliberately separate from test/send-unwatched-dream-nudges.test.js (the
// DOWNSTREAM decide-and-send half).
//
// Proves: a signed-up user's verified VIDEO completion enqueues a pending
// nudge; a completion that resolves to NO registered account (a pre-signup
// visitor) does NOT (the nudge is signed-up-users only); an IMAGE completion
// does NOT (video-only scope); an unverified completion does NOT; and a
// funnel dream whose PRE-SIGNUP ready email already sent (pending-dreams
// readyAt set) does NOT — no overlap with dream-webhook.js's abandonment
// email.
// Run with: node --test test/
//
// SANDBOX LIMITATION: no real Blobs (mock-blobs stands in) and no fal (mock-
// mode operationNames verify via their embedded timestamp) — this proves the
// enqueue decision, not a real generation.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.30.0.' + ipCounter; }

// Recorded PostHog capture calls for the current test — reset each beforeEach.
// The enqueue-decision telemetry (unwatched_dream_nudge_enqueue_decision) fires
// through global.fetch to PostHog's /capture/ endpoint, so the spy records the
// bodies for assertion. Resend calls (the chained enqueue -> send test) are
// recorded too, so this one spy serves both.
var posthogCalls;
var resendCalls;

/** A mock-mode operationName old enough to verify as genuinely complete (same helper as the sibling test). */
function realMockOpName(suffix) {
  return 'mock:' + (Date.now() - 60000) + ':' + (suffix || 'op');
}

/** Records PostHog capture + Resend calls; must not throw on either (both are best-effort side effects). */
function installBenignFetchSpy() {
  posthogCalls = [];
  resendCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    var body = opts && opts.body ? (function () { try { return JSON.parse(opts.body); } catch (e) { return null; } })() : null;
    if (urlStr.indexOf('/capture/') !== -1) { posthogCalls.push(body); return { ok: true, status: 200, json: async function () { return {}; } }; }
    if (urlStr.indexOf('api.resend.com') !== -1) { resendCalls.push(body); return { ok: true, status: 200, json: async function () { return {}; } }; }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
}

/** The recorded enqueue-decision event bodies (there is exactly one per mark() that reaches a verified completion). */
function enqueueDecisions() {
  return posthogCalls.filter(function (c) { return c && c.event === 'unwatched_dream_nudge_enqueue_decision'; });
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/mark-generation-completed')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/job-owners')];
  delete require.cache[require.resolve('../netlify/functions/lib/unwatched-dream-nudge-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
  delete process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY;
  process.env.RESEND_API_KEY = 'resend-test-key';
  installBenignFetchSpy();
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

async function seedJobOwner(operationName, email, mediaType, pendingId) {
  var jobOwners = require('../netlify/functions/lib/job-owners');
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, email, mediaType, pendingId);
}

function mark(operationName) {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  return markHandler(fakeEvent({ method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' }, body: { operationName: operationName } }));
}

async function pendingNudge(operationName) {
  var nudgeStore = require('../netlify/functions/lib/unwatched-dream-nudge-store');
  return nudgeStore.getPending(fakeEvent({}), operationName);
}

test('a signed-up user\'s verified VIDEO completion ENQUEUES a pending unwatched-dream nudge', async function () {
  await registerAccount('nudgeuser', 'nudgeuser@example.com');
  var op = realMockOpName('nudge-1');
  await seedJobOwner(op, 'nudgeuser@example.com', 'video');

  var res = await mark(op);
  assert.equal(res.statusCode, 200);

  var record = await pendingNudge(op);
  assert.ok(record, 'a pending nudge must be enqueued');
  assert.equal(record.username, 'nudgeuser');
  assert.equal(record.email, 'nudgeuser@example.com');
  assert.equal(typeof record.triggeredAt, 'number');

  // Durable enqueue-DECISION telemetry — the signal whose absence hid this
  // path being dead. A real enqueue fires { enqueued:true }.
  var decisions = enqueueDecisions();
  assert.equal(decisions.length, 1, 'exactly one enqueue-decision event per verified completion');
  assert.equal(decisions[0].properties.enqueued, true, 'a real enqueue is reported as enqueued:true');
  assert.equal(decisions[0].distinct_id, 'nudgeuser', 'keyed by the account username');
});

test('a completion with NO registered account (a pre-signup visitor) does NOT enqueue — signed-up users only', async function () {
  var op = realMockOpName('noacct');
  // A job-owner email that was never registered.
  await seedJobOwner(op, 'stranger@example.com', 'video');

  var res = await mark(op);
  assert.equal(res.statusCode, 200);
  assert.equal(await pendingNudge(op), null, 'no account -> no nudge');

  var decisions = enqueueDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].properties.skipped, 'no_account', 'a completion with no registered account is reported skipped:no_account');
});

test('an IMAGE completion does NOT enqueue — video-only scope', async function () {
  await registerAccount('imguser', 'imguser@example.com');
  var op = realMockOpName('img');
  await seedJobOwner(op, 'imguser@example.com', 'image');

  await mark(op);
  assert.equal(await pendingNudge(op), null, 'image media type -> no nudge');

  var decisions = enqueueDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].properties.skipped, 'not_video', 'an image completion is reported skipped:not_video');
});

test('a completion with NO job-owner record does NOT enqueue', async function () {
  await registerAccount('noowner', 'noowner@example.com');
  var op = realMockOpName('noowner');
  // No seedJobOwner call.
  await mark(op);
  assert.equal(await pendingNudge(op), null, 'no owner record -> no nudge');

  var decisions = enqueueDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].properties.skipped, 'no_owner', 'a completion with no owner record is reported skipped:no_owner');
});

test('an UNVERIFIED completion (a freshly-fabricated mock operationName) does NOT enqueue', async function () {
  await registerAccount('freshuser', 'freshuser@example.com');
  // Minted the instant before calling -- too new to pass the mock-mode
  // elapsed check, so verifyOperationCompleted returns false and nothing runs.
  var op = 'mock:' + Date.now() + ':fresh';
  await seedJobOwner(op, 'freshuser@example.com', 'video');

  await mark(op);
  assert.equal(await pendingNudge(op), null, 'an unverified completion writes nothing');
});

test('a funnel dream whose PRE-SIGNUP ready email already sent (readyAt set) does NOT enqueue — no overlap with the abandonment email', async function () {
  await registerAccount('funneluser', 'funneluser@example.com');
  var op = realMockOpName('funnel');
  var pendingId = 'pending-funnel-1';
  // Funnel-started job: carries a pendingId.
  await seedJobOwner(op, 'funneluser@example.com', 'video', pendingId);
  // Its pending-dreams record already has readyAt set -> the pre-signup
  // "your dream is ready" email already went out for this dream.
  var pendingDreams = require('../netlify/functions/lib/pending-dreams');
  mockBlobs.seed(pendingDreams.STORE_NAME, pendingId, { id: pendingId, status: 'notified', readyAt: Date.now(), email: 'funneluser@example.com' });

  await mark(op);
  assert.equal(await pendingNudge(op), null, 'the pre-signup email already covered this dream -> no nudge');

  var decisions = enqueueDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].properties.skipped, 'ready_email_overlap', 'a funnel dream whose pre-signup email already sent is reported skipped:ready_email_overlap');
});

test('a funnel dream whose pending-dreams record has NO readyAt (claimed before the webhook) DOES enqueue', async function () {
  await registerAccount('funnelok', 'funnelok@example.com');
  var op = realMockOpName('funnelok');
  var pendingId = 'pending-funnelok-1';
  await seedJobOwner(op, 'funnelok@example.com', 'video', pendingId);
  var pendingDreams = require('../netlify/functions/lib/pending-dreams');
  // Claimed, but the abandonment email never sent (no readyAt).
  mockBlobs.seed(pendingDreams.STORE_NAME, pendingId, { id: pendingId, status: 'claimed', email: 'funnelok@example.com' });

  await mark(op);
  assert.ok(await pendingNudge(op), 'no abandonment email sent -> the nudge still enqueues');

  var decisions = enqueueDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].properties.enqueued, true, 'a claimed funnel dream with no abandonment email is reported enqueued:true');
});

// END-TO-END CONTRACT (the actual bug): a fresh completed video dream for a
// registered account must ENQUEUE via mark-generation-completed AND, once its
// dream carries a thumbnail (the server-side `imageUrl` the home.html capture
// now restores at the completion landing point), the scheduled sender must
// actually SEND it. Before the fix, the enqueue worked but the dream never
// gained an imageUrl in the new (home.html) flow, so the sender silently
// dropped every record at give-up — 0 sent, 0 skipped. This chains both halves.
test('END-TO-END: mark-generation-completed ENQUEUES, then the scheduled sender SENDS the nudge once the dream has a thumbnail', async function () {
  var sendNudges = require('../netlify/functions/send-unwatched-dream-nudges');
  var nudgeStore = require('../netlify/functions/lib/unwatched-dream-nudge-store');
  var dreamStore = require('../netlify/functions/lib/dream-store');

  await registerAccount('chainuser', 'chainuser@example.com');
  var op = realMockOpName('chain');
  await seedJobOwner(op, 'chainuser@example.com', 'video');

  // 1) Completion lands -> enqueue.
  var res = await mark(op);
  assert.equal(res.statusCode, 200);
  var pending = await pendingNudge(op);
  assert.ok(pending, 'the completion must enqueue a pending nudge');
  assert.equal(enqueueDecisions()[0].properties.enqueued, true);

  // 2) The dream syncs WITH a real thumbnail (imageUrl) — exactly what the
  //    restored home.html capture produces — and correlates by sourceOperationName.
  await dreamStore.upsertPrivateDream(fakeEvent({}), 'chainuser', {
    id: 'dream-' + op, ownerHandle: '@chainuser',
    storyText: 'I was flying over a lake of stars', style: 'Cinematic', mediaType: 'video',
    videoUrl: 'https://example.com/v.mp4', imageUrl: 'https://img.example/thumb.jpg',
    sourceOperationName: op
  });

  // 3) Age the record past the 7-minute unwatched floor (without waiting).
  var current = await nudgeStore.getPending(fakeEvent({}), op);
  mockBlobs.seed(nudgeStore.PENDING_STORE_NAME, op, Object.assign({}, current, {
    triggeredAt: Date.now() - (sendNudges.READY_AGE_MS + 5000)
  }));

  // 4) The scheduled scan sends exactly one real email and dequeues.
  var scan = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(scan.sent, 1, 'the sender must actually send the enqueued, thumbnailed, unwatched dream');
  assert.equal(resendCalls.length, 1, 'exactly one Resend send');
  assert.match(resendCalls[0].html, /flying over a lake of stars/, 'the dream text rides the nudge');
  assert.match(resendCalls[0].html, /https:\/\/img\.example\/thumb\.jpg/, 'the captured thumbnail is embedded');
  assert.equal(await pendingNudge(op), null, 'dequeued after a real send');
});
