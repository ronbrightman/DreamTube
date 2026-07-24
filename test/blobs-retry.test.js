// test/blobs-retry.test.js
//
// Direct unit coverage for lib/blobs-retry.js's retryingWrite — the
// shared bounded read -> mutate -> write -> verify retry loop extracted
// once tracker-store.js's writeItemsWithRetry, entitlements.js's
// creditTokenPackOnce, pending-dreams.js's tryTransition, and
// support-store.js's appendMessage all independently reimplemented the
// same pattern (see tracker.html's
// recurring-gap-new-blobs-backed-stores-ke-d11k47 and
// extract-shared-lib-blobs-retry-js-now-th-p1avvq items). Each of those
// four call sites has its own existing test coverage exercising this
// mechanism through its own domain-specific shape (see
// test/tracker.test.js, test/entitlements-token-purchases.test.js,
// test/pending-dreams.test.js, test/support-feedback.test.js) — this file
// tests the shared mechanism itself, in isolation, against the module's
// own generic contract (not any one caller's semantics).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var blobsRetry = require('../netlify/functions/lib/blobs-retry');

var STORE_NAME = 'test-blobs-retry-store';

test.beforeEach(function () {
  mockBlobs.reset();
});

function rawRead(key) {
  return function (event) {
    var { getStore } = require('@netlify/blobs');
    return getStore({ name: STORE_NAME }).get(key, { type: 'json' });
  };
}

// ----- Basic success path -----

test('a single successful attempt: mutate is applied, write persists, verify passes, returns ok:true with the mutated value', async function () {
  mockBlobs.seed(STORE_NAME, 'k1', { count: 1 });

  var result = await blobsRetry.retryingWrite({}, STORE_NAME, 'k1', {
    read: rawRead('k1'),
    mutate: function (current) { return { count: current.count + 1 }; },
    verify: function (verifyRead) { return verifyRead && verifyRead.count === 2; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.value, { count: 2 });
  assert.deepEqual(result.current, { count: 1 }, 'current must reflect the read BEFORE mutation, not the write');

  var { getStore } = require('@netlify/blobs');
  var persisted = await getStore({ name: STORE_NAME }).get('k1', { type: 'json' });
  assert.deepEqual(persisted, { count: 2 });
});

test('read() receiving a never-written key sees whatever the store actually returns (no implicit normalization) -- callers own their own null/default handling, same as every real call site', async function () {
  var result = await blobsRetry.retryingWrite({}, STORE_NAME, 'never-written', {
    read: rawRead('never-written'),
    mutate: function (current) { return { seenAsCurrent: current, created: true }; },
    verify: function (verifyRead) { return !!(verifyRead && verifyRead.created); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.seenAsCurrent, undefined, 'the mock store returns undefined for a missing key -- this module must not silently coerce it');
});

// ----- Retry on false-negative verify -----

test('a verify that fails on the first attempt but passes on a later one retries with a FRESH read/mutate each time, not a cached one', async function () {
  mockBlobs.seed(STORE_NAME, 'k2', { count: 10 });
  var mutateCalls = 0;
  var verifyCalls = 0;

  var result = await blobsRetry.retryingWrite({}, STORE_NAME, 'k2', {
    maxAttempts: 3,
    read: rawRead('k2'),
    mutate: function (current) {
      mutateCalls++;
      return { count: current.count + 1 };
    },
    verify: function () {
      verifyCalls++;
      return verifyCalls >= 2; // fail the first attempt's verify, pass the second
    }
  });

  assert.equal(result.ok, true);
  assert.equal(mutateCalls, 2, 'mutate must be re-invoked against a fresh read on retry, not reused');
  assert.equal(verifyCalls, 2);
  // Second attempt re-read the ALREADY-mutated value (count: 11) and added
  // 1 again, since mutate isn't told this is a retry -- this is exactly
  // why every real caller's own mutate must be written idempotently
  // against its own target end state; this generic test intentionally
  // uses a NON-idempotent mutate to prove the loop really does re-read
  // and re-mutate on each attempt rather than reusing the first result.
  assert.deepEqual(result.value, { count: 12 });
});

test('every attempt failing verify exhausts maxAttempts and returns ok:false with the LAST attempt\'s mutated value and last read, not a thrown error', async function () {
  mockBlobs.seed(STORE_NAME, 'k3', { count: 0 });
  var attempts = 0;

  var result = await blobsRetry.retryingWrite({}, STORE_NAME, 'k3', {
    maxAttempts: 3,
    read: rawRead('k3'),
    mutate: function (current) {
      attempts++;
      return { count: current.count + 1, attempt: attempts };
    },
    verify: function () { return false; } // never passes
  });

  assert.equal(attempts, 3, 'must stop at exactly maxAttempts, not retry forever');
  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.value.attempt, 3, 'value must be the LAST attempt\'s mutated result');
});

test('maxAttempts defaults to 3 when omitted', async function () {
  mockBlobs.seed(STORE_NAME, 'k4', { count: 0 });
  var attempts = 0;

  await blobsRetry.retryingWrite({}, STORE_NAME, 'k4', {
    read: rawRead('k4'),
    mutate: function (current) { attempts++; return { count: current.count + 1 }; },
    verify: function () { return false; }
  });

  assert.equal(attempts, blobsRetry.DEFAULT_MAX_ATTEMPTS);
  assert.equal(blobsRetry.DEFAULT_MAX_ATTEMPTS, 3, 'matches every one of the four original hand-rolled implementations, all independently chosen at 3');
});

test('a custom maxAttempts is honored exactly (e.g. 1 means no retry at all)', async function () {
  mockBlobs.seed(STORE_NAME, 'k5', { count: 0 });
  var attempts = 0;

  await blobsRetry.retryingWrite({}, STORE_NAME, 'k5', {
    maxAttempts: 1,
    read: rawRead('k5'),
    mutate: function (current) { attempts++; return { count: current.count + 1 }; },
    verify: function () { return false; }
  });

  assert.equal(attempts, 1);
});

// ----- SKIP sentinel -----

test('mutate returning SKIP aborts immediately: no write happens, ok:false, skipped:true, current is the read that triggered it', async function () {
  mockBlobs.seed(STORE_NAME, 'k6', { alreadyDone: true });

  var result = await blobsRetry.retryingWrite({}, STORE_NAME, 'k6', {
    read: rawRead('k6'),
    mutate: function (current) {
      if (current && current.alreadyDone) return blobsRetry.SKIP;
      return { alreadyDone: true };
    },
    verify: function () { throw new Error('verify must never be called on a SKIP'); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.value, undefined);
  assert.deepEqual(result.current, { alreadyDone: true });

  var { getStore } = require('@netlify/blobs');
  var stillThere = await getStore({ name: STORE_NAME }).get('k6', { type: 'json' });
  assert.deepEqual(stillThere, { alreadyDone: true }, 'a SKIP must never write anything, not even a no-op re-write');
});

test('SKIP stops the loop immediately -- mutate is never called a second time even though maxAttempts allows more', async function () {
  mockBlobs.seed(STORE_NAME, 'k7', { done: true });
  var mutateCalls = 0;

  await blobsRetry.retryingWrite({}, STORE_NAME, 'k7', {
    maxAttempts: 5,
    read: rawRead('k7'),
    mutate: function () { mutateCalls++; return blobsRetry.SKIP; },
    verify: function () { return true; }
  });

  assert.equal(mutateCalls, 1);
});

test('a write that lands but whose SKIP-triggering precondition only becomes true after a retry stops as soon as it does', async function () {
  // Simulates: attempt 1 writes successfully, but a concurrent writer's
  // change lands in the window between our write and our own verify-read
  // (so OUR verify sees the concurrent writer's value and correctly
  // fails), and attempt 2's fresh read now shows that concurrent state,
  // making mutate bail via SKIP instead of writing again -- e.g.
  // entitlements.js's creditTokenPackOnce discovering, on retry, that the
  // marker it lost the race for is now visible.
  mockBlobs.seed(STORE_NAME, 'k8', null);
  var attempt = 0;

  var result = await blobsRetry.retryingWrite({}, STORE_NAME, 'k8', {
    maxAttempts: 3,
    read: rawRead('k8'),
    mutate: function (current) {
      attempt++;
      if (current && current.claimed) return blobsRetry.SKIP;
      return { claimed: true, by: 'us' };
    },
    verify: function (verifyRead) {
      if (attempt === 1) {
        // The concurrent writer's change lands right here -- after our
        // own write (already persisted, which is why verifyRead below
        // still shows OUR value on this very call) but before this
        // attempt concludes, so it's what the NEXT attempt's read sees.
        mockBlobs.seed(STORE_NAME, 'k8', { claimed: true, by: 'someone-else' });
        return false;
      }
      return verifyRead && verifyRead.by === 'us';
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(attempt, 2);
  assert.equal(result.current.by, 'someone-else');
});

// ----- Genuine Promise.all concurrency -----

test('CONCURRENCY: two concurrent retryingWrite calls racing a claim-marker write on the SAME key -- exactly one wins', async function () {
  mockBlobs.seed(STORE_NAME, 'race-1', null);

  function claimAttempt(owner) {
    var myClaim;
    return blobsRetry.retryingWrite({}, STORE_NAME, 'race-1', {
      maxAttempts: 3,
      read: rawRead('race-1'),
      mutate: function (current) {
        if (current) return blobsRetry.SKIP; // someone already claimed it
        myClaim = owner;
        return { claimedBy: myClaim };
      },
      verify: function (verifyRead) { return !!(verifyRead && verifyRead.claimedBy === myClaim); }
    });
  }

  var results = await Promise.all([claimAttempt('a'), claimAttempt('b')]);
  var winners = results.filter(function (r) { return r.ok; });
  assert.equal(winners.length, 1, 'exactly one of two genuinely concurrent claim attempts must win');

  var { getStore } = require('@netlify/blobs');
  var persisted = await getStore({ name: STORE_NAME }).get('race-1', { type: 'json' });
  assert.equal(persisted.claimedBy, winners[0].value.claimedBy, 'the persisted state must match what the winner actually wrote');
});

test('CONCURRENCY: repeated trials stay consistent (rules out a lucky single pass)', async function () {
  for (var i = 0; i < 10; i++) {
    var key = 'race-loop-' + i;
    mockBlobs.seed(STORE_NAME, key, null);

    function claimAttempt(owner) {
      var myClaim;
      return blobsRetry.retryingWrite({}, STORE_NAME, key, {
        maxAttempts: 3,
        read: rawRead(key),
        mutate: function (current) {
          if (current) return blobsRetry.SKIP;
          myClaim = owner;
          return { claimedBy: myClaim };
        },
        verify: function (verifyRead) { return !!(verifyRead && verifyRead.claimedBy === myClaim); }
      });
    }

    var results = await Promise.all([claimAttempt('a'), claimAttempt('b'), claimAttempt('c')]);
    var winners = results.filter(function (r) { return r.ok; });
    assert.equal(winners.length, 1, 'trial ' + i + ': exactly one of three concurrent claimants must win');
  }
});

// ----- read() using a caller's own custom logic (not a plain raw get) -----

test('a custom read() (e.g. one that defaults a missing store to a non-null value, like support-store.js\'s getMessages) is honored as-is', async function () {
  var customRead = async function () { return { fromCustomReader: true, list: [] }; };

  var result = await blobsRetry.retryingWrite({}, STORE_NAME, 'k9', {
    read: customRead,
    mutate: function (current) {
      assert.equal(current.fromCustomReader, true, 'mutate must receive exactly what the custom read() returned');
      return { list: current.list.concat(['item']) };
    },
    verify: function (verifyRead) { return verifyRead && verifyRead.list.length === 1; }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { list: ['item'] });
});
