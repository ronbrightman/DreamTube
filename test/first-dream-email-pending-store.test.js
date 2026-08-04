// test/first-dream-email-pending-store.test.js
//
// Covers netlify/functions/lib/first-dream-email-pending-store.js in
// isolation — tracker item for-product-email-redesign-unsubscribe-l-16ysmp's
// founder-approved thumbnail-gating follow-up (2026-08-03/04). markPending
// is a thin, operationName-keyed wrapper around blobs10's real
// compare-and-swap write (`setJSON(key, value, { onlyIfNew: true })`),
// same shape as lib/push-dedup-store.js's/lib/first-dream-email-store.js's
// own markSentOnce — see either file's own header comment for the fuller
// "why CAS" reasoning, and this store's own header comment for why an
// idempotent enqueue matters here specifically (a duplicate
// maybeSendAutomaticFirstDreamEmail call must not reset the 3-minute
// deadline).
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var pendingStore = require('../netlify/functions/lib/first-dream-email-pending-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('markPending succeeds the first time for a fresh operationName', async function () {
  var result = await pendingStore.markPending(fakeEvent({}), 'mock:1:op-a', 'alice', 'alice@example.com');
  assert.equal(result.ok, true);
  assert.equal(result.alreadyPending, undefined);

  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:op-a');
  assert.equal(record.username, 'alice');
  assert.equal(record.email, 'alice@example.com');
  assert.ok(typeof record.triggeredAt === 'number');
});

test('markPending is idempotent -- a second call for the SAME operationName is a harmless no-op that does not reset triggeredAt', async function () {
  var event = fakeEvent({});
  var first = await pendingStore.markPending(event, 'mock:1:op-b', 'bob', 'bob@example.com');
  assert.equal(first.ok, true);
  var firstRecord = await pendingStore.getPending(event, 'mock:1:op-b');

  // A real duplicate call would still be milliseconds later in practice,
  // but even a same-millisecond one must never win the CAS write.
  var second = await pendingStore.markPending(event, 'mock:1:op-b', 'bob', 'bob@example.com');
  assert.equal(second.ok, true);
  assert.equal(second.alreadyPending, true);

  var afterSecond = await pendingStore.getPending(event, 'mock:1:op-b');
  assert.equal(afterSecond.triggeredAt, firstRecord.triggeredAt, 'the SECOND call must never reset the original triggeredAt -- that would push the 3-minute deadline forward');
});

test('markPending rejects invalid input', async function () {
  var event = fakeEvent({});
  assert.equal((await pendingStore.markPending(event, '', 'bob', 'bob@example.com')).ok, false);
  assert.equal((await pendingStore.markPending(event, 'mock:1:op-c', '', 'bob@example.com')).ok, false);
  assert.equal((await pendingStore.markPending(event, 'mock:1:op-c', 'bob', '')).ok, false);
});

test('getPending returns null for an operationName that was never enqueued', async function () {
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:never-enqueued');
  assert.equal(record, null);
});

test('listPendingOperationNames enumerates every currently-enqueued key', async function () {
  var event = fakeEvent({});
  await pendingStore.markPending(event, 'mock:1:op-x', 'x', 'x@example.com');
  await pendingStore.markPending(event, 'mock:1:op-y', 'y', 'y@example.com');

  var names = await pendingStore.listPendingOperationNames(event);
  assert.equal(names.length, 2);
  assert.ok(names.indexOf('mock:1:op-x') !== -1);
  assert.ok(names.indexOf('mock:1:op-y') !== -1);
});

test('removePending dequeues a record -- it no longer appears in a later listPendingOperationNames/getPending', async function () {
  var event = fakeEvent({});
  await pendingStore.markPending(event, 'mock:1:op-z', 'z', 'z@example.com');

  var result = await pendingStore.removePending(event, 'mock:1:op-z');
  assert.equal(result.ok, true);

  assert.equal(await pendingStore.getPending(event, 'mock:1:op-z'), null);
  assert.equal((await pendingStore.listPendingOperationNames(event)).length, 0);
});

test('removePending is safe to call twice (or on an operationName never enqueued) -- no throw, no error surfaced', async function () {
  var event = fakeEvent({});
  await pendingStore.markPending(event, 'mock:1:op-w', 'w', 'w@example.com');
  await pendingStore.removePending(event, 'mock:1:op-w');
  var second = await pendingStore.removePending(event, 'mock:1:op-w');
  assert.equal(second.ok, true);

  var neverEnqueued = await pendingStore.removePending(event, 'mock:1:never-was-here');
  assert.equal(neverEnqueued.ok, true);
});

test('the CAS write REJECTING (a genuine transport/server error) fails CLOSED, never assumed enqueued', async function () {
  mockBlobs.setWriteOverride(pendingStore.STORE_NAME, function () {
    return new Error('simulated Blobs 500 -- transient storage-layer fault');
  });

  var result = await pendingStore.markPending(fakeEvent({}), 'mock:1:op-fail', 'fail', 'fail@example.com');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'exhausted');
});
