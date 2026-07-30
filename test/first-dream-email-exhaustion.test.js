// test/first-dream-email-exhaustion.test.js
//
// Covers the round-4 work on tracker.html's
// for-product-bug-founder-affects-all-funn-0efe7t item, reopened after
// production telemetry reported that every real first-dream retention-email
// attempt was ending in `reason=exhausted` -- i.e. the chain now gets all the
// way to lib/first-dream-email-store.js's markSentOnce (rounds 1-3 fixed the
// job-owner/ordering problems ahead of it) and then dies claiming the
// send-once marker.
//
// Two things under test here, both of which the existing suite could not
// express before:
//   1. lib/blobs-retry.js's new per-attempt diagnostics -- an exhausted loop
//      used to be a total black box in production logs (see that file's own
//      "PER-ATTEMPT DIAGNOSTICS" comment for why that mattered so much for
//      this specific bug).
//   2. markSentOnce's new FINAL CONFIRMING READ -- the distinction between
//      "our write never landed" (genuinely exhausted, fail closed) and "our
//      write landed but no verify-read inside the loop's ~400ms budget had
//      caught up yet" (claim is genuinely ours, send). Netlify documents
//      Blobs propagation as guaranteed only "within 60 seconds", so the
//      second case is an ordinary outcome, not an exotic one.
//
// The plain in-memory mock store is perfectly, synchronously consistent and
// so can NEVER reproduce this class of failure on its own -- these tests use
// test/helpers/mock-blobs.js's setReadOverride to simulate reads lagging
// behind a write that genuinely landed, which is exactly what that helper
// exists for.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var blobsRetry = require('../netlify/functions/lib/blobs-retry');
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

// ===== lib/blobs-retry.js: per-attempt diagnostics =====

test('blobs-retry: a successful write reports a per-attempt trace (attempt number, elapsed ms, what each read saw) and logs nothing', async function () {
  var lines = await captureConsoleError(async function () {
    var result = await blobsRetry.retryingWrite(fakeEvent({}), 'diag-store', 'k', {
      read: function () {
        var { getStore } = require('@netlify/blobs');
        return getStore({ name: 'diag-store' }).get('k', { type: 'json' });
      },
      mutate: function () { return { v: 1 }; },
      verify: function (verifyRead) { return !!(verifyRead && verifyRead.v === 1); }
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.attempts), 'the trace must be exposed on the result for callers to log/assert on');
    assert.equal(result.attempts.length, 1);
    var a = result.attempts[0];
    assert.equal(a.attempt, 1, 'attempts are 1-indexed for human readability in a log line');
    assert.equal(a.read, 'undefined', 'the key had never been written -- the mock store returns undefined');
    assert.equal(a.verifyRead, 'value', 'the verify-read saw an actual value');
    assert.equal(a.outcome, 'verified');
    assert.equal(typeof a.readAtMs, 'number');
    assert.equal(typeof a.wroteAtMs, 'number');
    assert.equal(typeof a.verifyReadAtMs, 'number');
  });

  assert.deepEqual(lines, [], 'the happy path must stay silent -- this loop runs on every daily token claim, a line per call would bury the signal');
});

test('blobs-retry: an exhausted loop logs ONE structured line carrying every attempt\'s elapsed ms and what its verify-read actually saw', async function () {
  // Every read against this store comes back as "not visible yet" -- the
  // real-world shape being investigated (write lands, reads lag).
  mockBlobs.setReadOverride('diag-store', function () { return { value: undefined }; });

  var result;
  var lines = await captureConsoleError(async function () {
    result = await blobsRetry.retryingWrite(fakeEvent({}), 'diag-store', 'k', {
      read: function () {
        var { getStore } = require('@netlify/blobs');
        return getStore({ name: 'diag-store' }).get('k', { type: 'json' });
      },
      mutate: function () { return { v: 1 }; },
      verify: function (verifyRead) { return !!(verifyRead && verifyRead.v === 1); },
      maxAttempts: 3,
      retryDelayMs: 5
    });
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.attempts.length, 3, 'all three attempts must be represented, not just the last');
  result.attempts.forEach(function (a, i) {
    assert.equal(a.attempt, i + 1);
    assert.equal(a.read, 'undefined');
    assert.equal(a.verifyRead, 'undefined', 'this is the fact that was previously invisible in production: the verify-read saw NOTHING, rather than a competing writer\'s value');
    assert.equal(a.outcome, 'verify_failed');
  });

  assert.equal(lines.length, 1, 'exactly one structured line, not one per attempt -- concurrent invocations interleave in Netlify\'s logs');
  assert.match(lines[0], /blobs-retry: exhausted 3 attempts/);
  assert.match(lines[0], /store=diag-store/);
  assert.match(lines[0], /totalElapsedMs=\d+/);
  assert.match(lines[0], /"verifyRead":"undefined"/, 'the per-attempt trace itself must be in the line, not just a count');
});

test('blobs-retry: the diagnostic never logs the key or any stored value -- shape only (these stores hold usernames, emails and balances)', async function () {
  mockBlobs.setReadOverride('diag-store', function () {
    return { value: { secret: 'someone@example.com' } };
  });

  var lines = await captureConsoleError(async function () {
    await blobsRetry.retryingWrite(fakeEvent({}), 'diag-store', 'user@example.com', {
      read: function () {
        var { getStore } = require('@netlify/blobs');
        return getStore({ name: 'diag-store' }).get('user@example.com', { type: 'json' });
      },
      mutate: function () { return { v: 1 }; },
      verify: function () { return false; },
      maxAttempts: 2,
      retryDelayMs: 0
    });
  });

  assert.equal(lines.length, 1);
  assert.ok(lines[0].indexOf('user@example.com') === -1, 'the KEY must never reach the log line');
  assert.ok(lines[0].indexOf('someone@example.com') === -1, 'a stored VALUE must never reach the log line');
  assert.match(lines[0], /"verifyRead":"value"/, 'but it must still record that the read DID see something -- the shape is the diagnostic');
});

test('blobs-retry: a SKIP still reports its trace, so a caller can tell which attempt the precondition flipped on', async function () {
  var result = await blobsRetry.retryingWrite(fakeEvent({}), 'diag-store', 'k', {
    read: function () { return Promise.resolve({ alreadyThere: true }); },
    mutate: function () { return blobsRetry.SKIP; },
    verify: function () { return true; }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, 'skip');
  assert.equal(result.attempts[0].read, 'value');
});

// ===== markSentOnce: the final confirming read =====

test('markSentOnce: when every verify-read inside the loop lags but the write genuinely landed, the final confirming read recognizes OUR OWN claim and the send goes ahead', async function () {
  // markSentOnce runs maxAttempts=3, each attempt doing exactly two reads
  // (the loop's read + its verify-read) = 6 reads, all of which lag here.
  // Read 7 is the new final confirming read; letting it fall through to the
  // real stored value is the whole point -- the write DID land.
  mockBlobs.setReadOverride(STORE_NAME, function (key, callIndex) {
    if (callIndex <= 6) return { value: undefined };
    return null; // fall through to what's genuinely stored
  });

  var result;
  var lines = await captureConsoleError(async function () {
    result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'LaggyUser', 'dream-1');
  });

  assert.equal(result.ok, true, 'the marker is genuinely, durably ours -- refusing to send here is what produced reason=exhausted for every real user');
  assert.ok(result.claimId, 'the winning claimId must come back so a failed Resend send can still release it');
  assert.ok(
    lines.some(function (l) { return /final confirming read shows OUR OWN claim landed/.test(l); }),
    'this path must stay loud -- it means the retry budget is genuinely too short for this environment'
  );

  var { getStore } = require('@netlify/blobs');
  var persisted = await getStore({ name: STORE_NAME }).get('laggyuser', { type: 'json' });
  assert.equal(persisted.claimId, result.claimId);
  assert.equal(persisted.username, 'laggyuser', 'the record is keyed and stamped with the NORMALIZED username');
});

test('markSentOnce: a genuinely lost race -- the final confirming read shows a DIFFERENT claimId -- reports alreadySent, never ok', async function () {
  mockBlobs.setReadOverride(STORE_NAME, function (key, callIndex) {
    if (callIndex <= 6) return { value: undefined };
    // A concurrent, legitimate racer's claim is what actually landed.
    return { value: { username: 'raceduser', dreamId: 'other', sentAt: Date.now(), claimId: 'a-different-callers-claim' } };
  });

  var result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'RacedUser', 'dream-1');

  assert.equal(result.ok, false, 'the other caller is the one sending -- this call must not');
  assert.equal(result.alreadySent, true);
  assert.equal(result.error, undefined);
});

test('markSentOnce: when nothing is visible even on the final confirming read, it still fails CLOSED with reason=exhausted', async function () {
  mockBlobs.setReadOverride(STORE_NAME, function () { return { value: undefined }; });

  var result;
  var lines = await captureConsoleError(async function () {
    result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'GhostUser', 'dream-1');
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'exhausted', 'no evidence the claim is ours -- refusing to send stays the safe outcome');
  assert.equal(result.alreadySent, undefined);
  assert.ok(
    lines.some(function (l) { return /exhausted attempts claiming the send-once marker/.test(l) && /blobs-retry trace/.test(l); }),
    'the exhaustion log must now carry the blobs-retry per-attempt trace, which is what makes a real occurrence diagnosable'
  );
});

test('markSentOnce: the ordinary uncontended path is unchanged -- first call wins, every later call reports alreadySent', async function () {
  var first = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'PlainUser', 'dream-1');
  assert.equal(first.ok, true);

  var second = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'plainuser', 'dream-2');
  assert.equal(second.ok, false);
  assert.equal(second.alreadySent, true, 'per-ACCOUNT, not per-dream, and case-insensitive');
});

// ===== markSentOnce: the SKIP branch's own self-clobber check (round 5) =====
//
// Round 4 fixed the EXHAUSTION branch ("no verify-read ever saw our claim")
// but left the identical hazard live one step earlier, on the SKIP branch.
// blobs-retry's SKIP fires whenever a fresh read shows an existing record --
// and that record can be OUR OWN just-landed write from a previous attempt in
// this very same call, seen by a read that finally caught up after the
// verify-read that raced it did not. Reporting that as alreadySent silently
// burns a real account's one-time-ever retention email with nothing sent
// behind it, and (unlike a lost race) nobody else is sending either.

test('markSentOnce: a SKIP caused by OUR OWN previous attempt\'s just-landed write is a WIN, not alreadySent', async function () {
  // Attempt 1: read sees nothing (call 1) -> write lands for real -> its own
  // verify-read lags and sees nothing (call 2) -> verify fails, loop retries.
  // Attempt 2: this read (call 3) falls through to the real store and now
  // sees attempt 1's OWN record -> mutate returns SKIP.
  mockBlobs.setReadOverride(STORE_NAME, function (key, callIndex) {
    if (callIndex <= 2) return { value: undefined };
    return null; // fall through to what genuinely landed
  });

  var result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'SelfSkipUser', 'dream-1');

  assert.equal(result.ok, true, 'the record causing the SKIP carries THIS call\'s own claimId -- nobody else claimed anything, so this call holds the claim and must send');
  assert.ok(result.claimId, 'the winning claimId must come back so a failed Resend send can still release it');
  assert.equal(result.alreadySent, undefined);

  mockBlobs.clearReadOverride(STORE_NAME);
  var { getStore } = require('@netlify/blobs');
  var persisted = await getStore({ name: STORE_NAME }).get('selfskipuser', { type: 'json' });
  assert.equal(persisted.claimId, result.claimId, 'the claim reported back must be the one actually sitting in the store');
});

test('markSentOnce: a SKIP caused by a genuinely DIFFERENT caller\'s record still reports alreadySent', async function () {
  mockBlobs.seed(STORE_NAME, 'contendeduser', {
    username: 'contendeduser', dreamId: 'other', sentAt: Date.now(), claimId: 'a-different-callers-claim'
  });

  var result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'ContendedUser', 'dream-1');

  assert.equal(result.ok, false, 'this must NOT overcorrect into treating every skip as ours');
  assert.equal(result.alreadySent, true);
  assert.equal(result.error, undefined);
});

test('markSentOnce: a SKIP caused by a legacy record with NO claimId at all reports alreadySent, never a win', async function () {
  // Pre-fix record shape (written before claimId existed). A naive
  // `current.claimId === claimId` check would compare undefined to undefined
  // -- for a call whose mutate never even ran, claimId is undefined too --
  // and wrongly report a win against someone else's already-sent email.
  mockBlobs.seed(STORE_NAME, 'legacyuser', { username: 'legacyuser', dreamId: 'old', sentAt: Date.now() });

  var result = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'LegacyUser', 'dream-1');

  assert.equal(result.ok, false, 'an undefined claimId on both sides must never read as "this is mine"');
  assert.equal(result.alreadySent, true);
});

test('markSentOnce: releaseFailedSend still undoes only the claim it was given, including one won via the final confirming read', async function () {
  mockBlobs.setReadOverride(STORE_NAME, function (key, callIndex) {
    if (callIndex <= 6) return { value: undefined };
    return null;
  });
  var claim = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'ReleaseUser', 'dream-1');
  assert.equal(claim.ok, true);
  mockBlobs.clearReadOverride(STORE_NAME);

  var released = await firstDreamEmailStore.releaseFailedSend(fakeEvent({}), 'ReleaseUser', claim.claimId);
  assert.equal(released.ok, true);

  var again = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'ReleaseUser', 'dream-1');
  assert.equal(again.ok, true, 'a released marker must be genuinely reclaimable -- otherwise a failed Resend send burns the account\'s only email forever');
});
