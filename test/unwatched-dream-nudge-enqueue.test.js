// test/unwatched-dream-nudge-enqueue.test.js
//
// Covers the ENQUEUE side of the "unwatched dream" retention nudge
// (founder-approved retention plan, piece 1): mark-generation-completed.js's
// maybeEnqueueUnwatchedNudge. This is the integration between
// mark-generation-completed.js, lib/job-owners.js, lib/account-store.js,
// lib/pending-dreams.js, and lib/unwatched-dream-nudge-store.js —
// deliberately separate from test/send-unwatched-dream-nudges.test.js (the
// DOWNSTREAM decide-and-send half). Mirrors test/automatic-first-dream-
// email.test.js's own enqueue-side coverage of the sibling first-dream email.
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

/** A mock-mode operationName old enough to verify as genuinely complete (same helper as the sibling test). */
function realMockOpName(suffix) {
  return 'mock:' + (Date.now() - 60000) + ':' + (suffix || 'op');
}

/** PostHog capture fires (best-effort skip/enqueue telemetry) must not throw on an unexpected fetch — swallow them. */
function installBenignFetchSpy() {
  global.fetch = async function (url) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') !== -1) return { ok: true, status: 200, json: async function () { return {}; } };
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
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
});

test('a completion with NO registered account (a pre-signup visitor) does NOT enqueue — signed-up users only', async function () {
  var op = realMockOpName('noacct');
  // A job-owner email that was never registered.
  await seedJobOwner(op, 'stranger@example.com', 'video');

  var res = await mark(op);
  assert.equal(res.statusCode, 200);
  assert.equal(await pendingNudge(op), null, 'no account -> no nudge');
});

test('an IMAGE completion does NOT enqueue — video-only scope', async function () {
  await registerAccount('imguser', 'imguser@example.com');
  var op = realMockOpName('img');
  await seedJobOwner(op, 'imguser@example.com', 'image');

  await mark(op);
  assert.equal(await pendingNudge(op), null, 'image media type -> no nudge');
});

test('a completion with NO job-owner record does NOT enqueue', async function () {
  await registerAccount('noowner', 'noowner@example.com');
  var op = realMockOpName('noowner');
  // No seedJobOwner call.
  await mark(op);
  assert.equal(await pendingNudge(op), null, 'no owner record -> no nudge');
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
});
