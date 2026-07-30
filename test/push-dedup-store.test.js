// test/push-dedup-store.test.js
//
// Covers netlify/functions/lib/push-dedup-store.js in isolation — tracker
// item for-product-build-stage-0-pwa-web-push-f-jbutt5, part 4. Mirrors
// test/blobs-retry.test.js's own exhaustion-scenario conventions (this
// file's markSentOnce is a thin, generically-keyed wrapper around that
// same shared retry loop, same shape as
// lib/first-dream-email-store.js's own markSentOnce).
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

// ===== the SKIP branch's own self-clobber check (round 5) =====
//
// Identical hazard, identical fix as lib/first-dream-email-store.js's own
// markSentOnce (tracker item for-product-bug-founder-affects-all-funn-0efe7t):
// blobs-retry's SKIP fires on ANY existing record, including this same call's
// own just-landed write from a previous attempt whose verify-read lagged
// behind it. Reporting that as alreadySent suppresses a push nobody actually
// sent. The plain in-memory mock is perfectly consistent and can't produce
// this on its own -- setReadOverride simulates the lagging read.

test('markSentOnce: a SKIP caused by OUR OWN previous attempt\'s just-landed write is a WIN, not alreadySent', async function () {
  // Call 1 = attempt 1's read (sees nothing), call 2 = attempt 1's own
  // verify-read (lags, sees nothing) -> retry; call 3 = attempt 2's read,
  // which falls through and now sees attempt 1's OWN record -> SKIP.
  mockBlobs.setReadOverride(pushDedupStore.STORE_NAME, function (key, callIndex) {
    if (callIndex <= 2) return { value: undefined };
    return null;
  });

  var result = await pushDedupStore.markSentOnce(fakeEvent({}), 'video-ready:mock:1:selfskip');

  assert.equal(result.ok, true, 'nobody else claimed this key -- THIS call\'s own write is the one sitting there, so the push must go out');
  assert.ok(result.claimId);
  assert.equal(result.alreadySent, undefined);

  mockBlobs.clearReadOverride(pushDedupStore.STORE_NAME);
  var { getStore } = require('@netlify/blobs');
  var persisted = await getStore({ name: pushDedupStore.STORE_NAME }).get('video-ready:mock:1:selfskip', { type: 'json' });
  assert.equal(persisted.claimId, result.claimId);
});

test('markSentOnce: a SKIP caused by a genuinely DIFFERENT caller\'s record still reports alreadySent', async function () {
  mockBlobs.seed(pushDedupStore.STORE_NAME, 'video-ready:mock:1:contended', {
    key: 'video-ready:mock:1:contended', sentAt: Date.now(), claimId: 'a-different-callers-claim'
  });

  var result = await pushDedupStore.markSentOnce(fakeEvent({}), 'video-ready:mock:1:contended');

  assert.equal(result.ok, false, 'this must NOT overcorrect into treating every skip as ours');
  assert.equal(result.alreadySent, true);
  assert.equal(result.error, undefined);
});

test('markSentOnce: a SKIP caused by a legacy record with NO claimId at all reports alreadySent, never a win', async function () {
  mockBlobs.seed(pushDedupStore.STORE_NAME, 'video-ready:mock:1:legacy', {
    key: 'video-ready:mock:1:legacy', sentAt: Date.now()
  });

  var result = await pushDedupStore.markSentOnce(fakeEvent({}), 'video-ready:mock:1:legacy');

  assert.equal(result.ok, false, 'an undefined claimId on both sides must never read as "this is mine"');
  assert.equal(result.alreadySent, true);
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

test('the exhaustion log never contains the raw key -- send-daily-claim-pushes.js keys literally embed an email address', async function () {
  // Forces every verify-read to miss (see blobs-retry.js's retryingWrite:
  // both the initial read and the post-write verify-read go through this
  // same override), so markSentOnce exhausts maxAttempts and hits its
  // console.error branch -- the one this test is pinning.
  mockBlobs.setReadOverride(pushDedupStore.STORE_NAME, function () { return { value: undefined }; });

  var email = 'alice@example.com';
  var key = 'daily-claim-available:' + email + ':1000';
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

  // blobs-retry.js's own shared exhaustion trace (store name + per-attempt
  // read/verify shapes, no key or value) now also logs on this path, on top
  // of this store's own message -- so this no longer asserts an exact count,
  // only the actual invariant: nothing logged anywhere on this path may ever
  // contain the raw key or email, regardless of how many lines there are.
  assert.ok(logged.length >= 1, 'exhaustion must log at least once');
  logged.forEach(function (line) {
    assert.ok(!line.includes(email), 'no exhaustion log line may ever contain the raw email address: ' + line);
    assert.ok(!line.includes(key), 'no exhaustion log line may ever contain the raw key at all: ' + line);
  });
});
