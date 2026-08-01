// test/push-dedup-store.test.js
//
// Covers netlify/functions/lib/push-dedup-store.js in isolation — tracker
// item for-product-build-stage-0-pwa-push-f-jbutt5, part 4, and (the CAS
// rewrite below) tracker.html's
// for-product-spike-conditional-write-only-rnurgw item. markSentOnce is a
// thin, generically-keyed wrapper around blobs10's real compare-and-swap
// write (`setJSON(key, value, { onlyIfNew: true })`), same shape as
// lib/first-dream-email-store.js's own markSentOnce — see that file's
// header comment for the fuller "why" (production telemetry, root cause,
// what's verified vs. not).
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var pushDedupStore = require('../netlify/functions/lib/push-dedup-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('hasSent is false before any markSentOnce call for a key', async function () {
  var sent = await pushDedupStore.hasSent(fakeEvent({}), 'video-ready:mock:1:op');
  assert.equal(sent, false);
});

test('markSentOnce succeeds the first time for a fresh key', async function () {
  var result = await pushDedupStore.markSentOnce(fakeEvent({}), 'video-ready:mock:1:op');
  assert.equal(result.ok, true);
  assert.ok(result.claimId);

  var sent = await pushDedupStore.hasSent(fakeEvent({}), 'video-ready:mock:1:op');
  assert.equal(sent, true);
});

test('markSentOnce reports alreadySent on a second call for the SAME key', async function () {
  var event = fakeEvent({});
  var first = await pushDedupStore.markSentOnce(event, 'video-ready:mock:1:op');
  assert.equal(first.ok, true);

  var second = await pushDedupStore.markSentOnce(event, 'video-ready:mock:1:op');
  assert.equal(second.ok, false);
  assert.equal(second.alreadySent, true);
});

test('two DIFFERENT keys are independent -- marking one never blocks the other', async function () {
  var event = fakeEvent({});
  var a = await pushDedupStore.markSentOnce(event, 'video-ready:opA');
  var b = await pushDedupStore.markSentOnce(event, 'video-ready:opB');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test('daily-claim-available keys are scoped per availability window -- a new nextClaimAt gets its own fresh key', async function () {
  var event = fakeEvent({});
  var windowOne = await pushDedupStore.markSentOnce(event, 'daily-claim-available:alice@example.com:1000');
  var windowTwo = await pushDedupStore.markSentOnce(event, 'daily-claim-available:alice@example.com:2000');
  assert.equal(windowOne.ok, true);
  assert.equal(windowTwo.ok, true);

  // But re-scanning the SAME window again is correctly deduped.
  var windowOneAgain = await pushDedupStore.markSentOnce(event, 'daily-claim-available:alice@example.com:1000');
  assert.equal(windowOneAgain.ok, false);
  assert.equal(windowOneAgain.alreadySent, true);
});

// ===== CAS write semantics (tracker.html's
//       for-product-spike-conditional-write-only-rnurgw item) =====
//
// markSentOnce now wins or loses its claim via a single atomic conditional
// write (`store.setJSON(key, value, { onlyIfNew: true })`, see this file's
// header comment) instead of the old bounded read -> mutate -> write ->
// verify retry loop. That eliminates an entire class of test this file used
// to need: there is no more "was this skip actually our own just-landed
// write racing its own verify-read" ambiguity to disambiguate (the old
// round-5 self-clobber tests) -- a conditional write can never observe its
// OWN write as a competing "existing record" in the first place.
// `modified: true` / `modified: false` are the two complete, unambiguous
// outcomes, full stop. Likewise there's no more "legacy record with no
// claimId" special case: the CAS write only ever inspects whether the KEY
// exists, never the existing record's shape.

test('markSentOnce: a pre-existing record for the key loses the CAS write atomically -- no read/verify race to disambiguate', async function () {
  mockBlobs.seed(pushDedupStore.STORE_NAME, 'video-ready:mock:1:contended', {
    key: 'video-ready:mock:1:contended', sentAt: Date.now(), claimId: 'a-different-callers-claim'
  });

  var result = await pushDedupStore.markSentOnce(fakeEvent({}), 'video-ready:mock:1:contended');

  assert.equal(result.ok, false);
  assert.equal(result.alreadySent, true);
  assert.equal(result.error, undefined);

  // The pre-existing record must be untouched by the losing CAS attempt.
  var { getStore } = require('@netlify/blobs');
  var persisted = await getStore({ name: pushDedupStore.STORE_NAME }).get('video-ready:mock:1:contended', { type: 'json' });
  assert.equal(persisted.claimId, 'a-different-callers-claim');
});

test('markSentOnce rejects an empty/falsy key', async function () {
  var result = await pushDedupStore.markSentOnce(fakeEvent({}), '');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_key');
});

test('hasSent fails closed (treats a missing key as "already sent") for a falsy key', async function () {
  var sent = await pushDedupStore.hasSent(fakeEvent({}), '');
  assert.equal(sent, true);
});

// ===== fail-closed: the CAS write does something other than the expected
//       "key already exists" rejection (tracker.html's
//       for-product-spike-conditional-write-only-rnurgw item) =====

test('markSentOnce: the CAS write REJECTING (a genuine transport/server error, never the expected precondition-rejection signal) fails CLOSED, never treated as safe to send', async function () {
  mockBlobs.setWriteOverride(pushDedupStore.STORE_NAME, function () {
    return new Error('simulated Blobs 500 -- transient storage-layer fault');
  });

  var result = await pushDedupStore.markSentOnce(fakeEvent({}), 'video-ready:mock:1:writefails');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'exhausted', 'a thrown write is NOT the ordinary "already exists" outcome -- must fail closed, not be mistaken for alreadySent');
  assert.equal(result.alreadySent, undefined);
});

test('markSentOnce: an unexpected CAS write result shape (no real `modified` boolean) also fails CLOSED rather than guessing', async function () {
  // Not reachable against the real blobs10 SDK (its own Store.setJSON
  // either resolves with a real `{ modified: boolean }` or throws -- see
  // node_modules/blobs10/dist/main.cjs) -- this exercises the defensive
  // branch directly via mock-blobs' setResultOverride, which exists
  // exactly for shapes the real implementation should never produce.
  mockBlobs.setResultOverride(pushDedupStore.STORE_NAME, function () {
    return { result: { unexpected: 'shape', modified: undefined } };
  });

  var result = await pushDedupStore.markSentOnce(fakeEvent({}), 'video-ready:mock:1:weirdshape');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'exhausted');
  assert.equal(result.alreadySent, undefined);
});

test('the fail-closed logs never contain the raw key -- send-daily-claim-pushes.js keys literally embed an email address', async function () {
  var email = 'alice@example.com';
  var key = 'daily-claim-available:' + email + ':1000';
  mockBlobs.setWriteOverride(pushDedupStore.STORE_NAME, function () {
    return new Error('simulated failure');
  });

  var originalError = console.error;
  var logged = [];
  console.error = function () { logged.push(Array.prototype.join.call(arguments, ' ')); };
  try {
    var result = await pushDedupStore.markSentOnce(fakeEvent({}), key);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'exhausted');
  } finally {
    console.error = originalError;
  }

  assert.equal(logged.length, 1, 'the fail-closed path must log exactly once');
  assert.ok(!logged[0].includes(email), 'the log must never contain the raw email address: ' + logged[0]);
  assert.ok(!logged[0].includes(key), 'the log must never contain the raw key at all: ' + logged[0]);
});
