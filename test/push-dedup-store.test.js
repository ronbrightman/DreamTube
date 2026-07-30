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

  assert.equal(logged.length, 1, 'exhaustion must log exactly once');
  assert.ok(!logged[0].includes(email), 'exhaustion log must never contain the raw email address: ' + logged[0]);
  assert.ok(!logged[0].includes(key), 'exhaustion log must never contain the raw key at all: ' + logged[0]);
});
