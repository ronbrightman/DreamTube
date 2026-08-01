// test/first-dream-email-store.test.js
//
// Direct unit coverage for lib/first-dream-email-store.js's CAS rewrite
// (tracker.html's for-product-spike-conditional-write-only-rnurgw item).
// Replaces the old test/first-dream-email-exhaustion.test.js, which tested
// the pre-CAS bounded read -> mutate -> write -> verify retry loop's
// exhaustion/final-confirming-read/self-skip machinery -- none of which
// exists anymore (see lib/first-dream-email-store.js's own header comment
// for the full "why"). The generic per-attempt-diagnostics tests that file
// also carried (testing lib/blobs-retry.js's retryingWrite directly, not
// this store) moved to test/blobs-retry.test.js, the correct home for them
// now that blobs-retry.js itself is unchanged and unrelated to this file.
//
// Black-box, end-to-end coverage of markSentOnce through mark-generation-
// completed.js/send-first-dream-email.js already exists in
// test/automatic-first-dream-email.test.js and
// test/send-first-dream-email.test.js (including their own concurrency
// tests) and is untouched by this rewrite -- this file is the direct,
// implementation-level coverage of the store itself: the CAS write path,
// the "key already exists" atomic loss, and the fail-closed error case.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var firstDreamEmailStore = require('../netlify/functions/lib/first-dream-email-store');

var STORE_NAME = firstDreamEmailStore.STORE_NAME;

test.beforeEach(function () {
  mockBlobs.reset();
});

/** Captures console.error for the duration of `fn`, returning every line it wrote. */
async function captureConsoleError(fn) {
  var lines = [];
  var realError = console.error;
  console.error = function () {
    lines.push(Array.prototype.slice.call(arguments).join(' '));
  };
  try {
    await fn();
  } finally {
    console.error = realError;
  }
  return lines;
}

// ===== hasSent =====

test('hasSent is false before any markSentOnce call for a username', async function () {
  var sent = await firstDreamEmailStore.hasSent(fakeEvent({}), 'freshuser');
  assert.equal(sent, false);
});

test('hasSent is case-insensitive, matching normalizeUsername', async function () {
  await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'MixedCaseUser', 'dream-1');
  var sent = await firstDreamEmailStore.hasSent(fakeEvent({}), 'mixedcaseuser');
  assert.equal(sent, true);
});

test('hasSent fails closed (treats a missing/invalid username as "already sent") for an empty username', async function () {
  var sent = await firstDreamEmailStore.hasSent(fakeEvent({}), '');
  assert.equal(sent, true);
});

// ===== markSentOnce: the CAS write path =====

test('markSentOnce: a fresh username wins the CAS write (modified:true) and returns ok:true with a claimId', async function () {
  var result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'PlainUser', 'dream-1');

  assert.equal(result.ok, true);
  assert.ok(result.claimId, 'the winning claimId must come back so a failed Resend send can still release it');

  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('plainuser', { type: 'json' });
  assert.equal(persisted.claimId, result.claimId);
  assert.equal(persisted.username, 'plainuser', 'the record is keyed and stamped with the NORMALIZED username');
  assert.equal(persisted.dreamId, 'dream-1');
  assert.equal(typeof persisted.sentAt, 'number');
});

test('markSentOnce: per-ACCOUNT, not per-dream -- a second call for the SAME username with a DIFFERENT dreamId still reports alreadySent', async function () {
  var first = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'PlainUser', 'dream-1');
  assert.equal(first.ok, true);

  var second = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'plainuser', 'dream-2');
  assert.equal(second.ok, false);
  assert.equal(second.alreadySent, true);
  assert.equal(second.error, undefined);

  // The original record must be untouched by the losing second attempt.
  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('plainuser', { type: 'json' });
  assert.equal(persisted.dreamId, 'dream-1', 'the losing CAS attempt must never overwrite the winning record');
  assert.equal(persisted.claimId, first.claimId);
});

test('markSentOnce: two DIFFERENT usernames are fully independent', async function () {
  var a = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'usera', 'dream-a');
  var b = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'userb', 'dream-b');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.claimId, b.claimId);
});

test('markSentOnce rejects an empty/invalid username without touching the store', async function () {
  var result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), '', 'dream-1');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_username');
});

// ===== markSentOnce: "key already exists" -- the atomic loss case =====
//
// Under the old read -> mutate -> write -> verify loop this required
// disambiguating whether the pre-existing record was a genuinely separate
// caller's or this same call's own just-landed write racing its own
// verify-read (see git history for that whole "round 5 self-skip" saga).
// Under CAS there is nothing to disambiguate: `setJSON(key, value,
// { onlyIfNew: true })` either creates the key (modified:true) or doesn't
// (modified:false) -- a single atomic operation, no race window, no
// question of "whose write is this really."

test('markSentOnce: a pre-existing record (seeded directly, simulating a genuinely earlier send) loses the CAS write atomically -- alreadySent, never ok', async function () {
  mockBlobs.seed(STORE_NAME, 'contendeduser', {
    username: 'contendeduser', dreamId: 'other', sentAt: Date.now(), claimId: 'a-different-callers-claim'
  });

  var result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'ContendedUser', 'dream-1');

  assert.equal(result.ok, false);
  assert.equal(result.alreadySent, true);
  assert.equal(result.error, undefined);
});

test('markSentOnce: a pre-existing LEGACY-shaped record (no claimId at all, e.g. a pre-rewrite record) still loses the CAS write -- the key\'s mere presence is what matters, not the record\'s shape', async function () {
  mockBlobs.seed(STORE_NAME, 'legacyuser', { username: 'legacyuser', dreamId: 'old', sentAt: Date.now() });

  var result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'LegacyUser', 'dream-1');

  assert.equal(result.ok, false);
  assert.equal(result.alreadySent, true);
});

test('CONCURRENCY: two genuinely concurrent markSentOnce calls for the SAME username -- exactly one wins, never both, never neither', async function () {
  function claimAttempt(dreamId) {
    return firstDreamEmailStore.markSentOnce(fakeEvent({}), 'RaceUser', dreamId);
  }

  var results = await Promise.all([claimAttempt('dream-a'), claimAttempt('dream-b')]);
  var winners = results.filter(function (r) { return r.ok; });
  assert.equal(winners.length, 1, 'exactly one of two genuinely concurrent claims must win');

  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('raceuser', { type: 'json' });
  assert.equal(persisted.claimId, winners[0].claimId, 'the persisted record must match what the winner actually wrote');
});

// ===== markSentOnce: fail-closed on anything other than the expected
//       "key already exists" CAS rejection =====

test('markSentOnce: the CAS write REJECTING (a genuine transport/server error, never the expected precondition-rejection signal) fails CLOSED with reason=exhausted, never alreadySent, never ok', async function () {
  mockBlobs.setWriteOverride(STORE_NAME, function () {
    return new Error('simulated Blobs 500 -- transient storage-layer fault');
  });

  var result;
  var lines = await captureConsoleError(async function () {
    result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'WriteFailsUser', 'dream-1');
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'exhausted', 'a thrown write is NOT the ordinary "already exists" outcome -- must fail closed');
  assert.equal(result.alreadySent, undefined);
  assert.ok(
    lines.some(function (l) { return /CAS write threw/.test(l); }),
    'the fail-closed path must be loud in logs, same posture as every other unexpected-shape branch in this file'
  );
});

test('markSentOnce: an unexpected CAS write result shape (no real `modified` boolean) also fails CLOSED rather than guessing', async function () {
  // Not reachable against the real blobs10 SDK (its own Store.setJSON
  // either resolves with a real `{ modified: boolean }` or throws -- see
  // node_modules/blobs10/dist/main.cjs) -- this exercises the defensive
  // branch directly via mock-blobs' setResultOverride, which exists
  // exactly for shapes the real implementation should never produce.
  mockBlobs.setResultOverride(STORE_NAME, function () {
    return { result: { unexpected: 'shape' } };
  });

  var result;
  var lines = await captureConsoleError(async function () {
    result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'WeirdShapeUser', 'dream-1');
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'exhausted');
  assert.equal(result.alreadySent, undefined);
  assert.ok(lines.some(function (l) { return /unexpected shape/.test(l); }));
});

// ===== releaseFailedSend =====

test('releaseFailedSend: undoes the claim it was given, making the marker reclaimable', async function () {
  var claim = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'ReleaseUser', 'dream-1');
  assert.equal(claim.ok, true);

  var released = await firstDreamEmailStore.releaseFailedSend(fakeEvent({}), 'ReleaseUser', claim.claimId);
  assert.equal(released.ok, true);

  var again = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'ReleaseUser', 'dream-1');
  assert.equal(again.ok, true, 'a released marker must be genuinely reclaimable -- otherwise a failed Resend send burns the account\'s only email forever');
});

test('releaseFailedSend: refuses to release a claimId that does not match what is actually stored', async function () {
  var claim = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'MismatchUser', 'dream-1');
  assert.equal(claim.ok, true);

  var released = await firstDreamEmailStore.releaseFailedSend(fakeEvent({}), 'MismatchUser', 'some-other-claim-id');
  assert.equal(released.ok, false);

  // The real claim must still be intact.
  var sent = await firstDreamEmailStore.hasSent(fakeEvent({}), 'MismatchUser');
  assert.equal(sent, true);
});

test('releaseFailedSend: no-ops on a username/claimId with nothing stored', async function () {
  var released = await firstDreamEmailStore.releaseFailedSend(fakeEvent({}), 'NeverSentUser', 'some-claim-id');
  assert.equal(released.ok, false);
});

test('releaseFailedSend: rejects a missing username or claimId', async function () {
  assert.equal((await firstDreamEmailStore.releaseFailedSend(fakeEvent({}), '', 'claim')).ok, false);
  assert.equal((await firstDreamEmailStore.releaseFailedSend(fakeEvent({}), 'someuser', '')).ok, false);
});
