// test/job-owners.test.js
//
// Unit coverage of netlify/functions/lib/job-owners.js — in particular
// getJobOwnerRecordWithRetry (added tracker.html's
// for-product-bug-founder-affects-all-funn-0efe7t, reopened round-3
// hardening), the job-owners-store counterpart to lib/pending-dreams.js's
// getWithReadyRetry. Mirrors that file's own getWithReadyRetry test suite
// almost exactly — same hazard, same fix shape, same proof technique
// (mock-blobs' setReadOverride to simulate a read landing behind a write
// that already genuinely happened, which a plain synchronous in-memory Map
// otherwise can't reproduce).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var jobOwners = require('../netlify/functions/lib/job-owners');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('getJobOwnerRecord: a plain get() sees a stale (pre-write) snapshot when a read is simulated as lagging behind a real write -- proves the hazard getJobOwnerRecordWithRetry exists to correct for', async function () {
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), 'fal:model:req-1', 'stale@example.com', 'video');

  mockBlobs.setReadOverride(jobOwners.STORE_NAME, function (key, callCount) {
    if (callCount === 1) return { value: undefined }; // simulates "not visible to this read yet"
    return false; // fall through to the real (already-written) value on every later call
  });

  var staleRead = await jobOwners.getJobOwnerRecord(fakeEvent({ method: 'POST' }), 'fal:model:req-1');
  assert.equal(staleRead, null, 'a plain get() has no way to detect or recover from a single lagging read');
  mockBlobs.clearReadOverride(jobOwners.STORE_NAME);
});

test('getJobOwnerRecordWithRetry: recovers from exactly one lagging read within its bounded retry budget, returning the real record', async function () {
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), 'fal:model:req-2', 'recover@example.com', 'video', 'pending-1');

  mockBlobs.setReadOverride(jobOwners.STORE_NAME, function (key, callCount) {
    if (callCount === 1) return { value: undefined };
    return false;
  });

  var result = await jobOwners.getJobOwnerRecordWithRetry(fakeEvent({ method: 'POST' }), 'fal:model:req-2', { retryDelayMs: 5 });
  assert.ok(result && result.email, 'the retry must recover the real record once the second read sees the already-committed write');
  assert.equal(result.email, 'recover@example.com');
  assert.equal(result.pendingId, 'pending-1');
  mockBlobs.clearReadOverride(jobOwners.STORE_NAME);
});

test('getJobOwnerRecordWithRetry: a job that genuinely never got a record (predates the store, or the write itself failed) is returned as null, no false positive', async function () {
  var result = await jobOwners.getJobOwnerRecordWithRetry(fakeEvent({ method: 'POST' }), 'fal:model:never-recorded', { retryDelayMs: 0 });
  assert.equal(result, null, 'must never fabricate a record that was never actually written');
});

test('getJobOwnerRecordWithRetry: exhausting the retry budget on a read that never converges still returns null rather than throwing -- accepted residual, same posture as pending-dreams.js\'s getWithReadyRetry', async function () {
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), 'fal:model:req-3', 'neverconverge@example.com', 'video');

  // Every read (not just the first) sees nothing -- simulates propagation
  // lag pathological enough to outlast the entire bounded retry budget.
  mockBlobs.setReadOverride(jobOwners.STORE_NAME, function () {
    return { value: undefined };
  });

  var result = await jobOwners.getJobOwnerRecordWithRetry(fakeEvent({ method: 'POST' }), 'fal:model:req-3', { retryDelayMs: 5 });
  assert.equal(result, null, 'exhausting the retry budget must still fail closed (no automatic send), never throw');
  mockBlobs.clearReadOverride(jobOwners.STORE_NAME);
});

test('getJobOwnerRecordWithRetry: a genuinely missing jobId is a plain no-op, same as getJobOwnerRecord', async function () {
  var result = await jobOwners.getJobOwnerRecordWithRetry(fakeEvent({ method: 'POST' }), '', { retryDelayMs: 0 });
  assert.equal(result, null);
});
