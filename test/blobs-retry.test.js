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
    retryDelayMs: 0, // this test is about retry MECHANICS, not the real-world delay — see the dedicated delay tests below
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
    retryDelayMs: 0, // this test is about the attempt COUNT, not the real-world delay — see the dedicated delay tests below
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
    retryDelayMs: 0, // this test is about the attempt COUNT, not the real-world delay — see the dedicated delay tests below
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
    retryDelayMs: 0, // this test is about SKIP semantics, not the real-world delay — see the dedicated delay tests below
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
      retryDelayMs: 0, // this test is about race resolution, not the real-world delay — see the dedicated delay tests below
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
        retryDelayMs: 0, // this test is about race resolution across many trials, not the real-world delay — see the dedicated delay tests below
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

// ----- Inter-attempt delay (root cause fix for tracker item
// for-product-daily-claim-bugs-founder-rea-kei2ub's BUG 2 -- see this
// file's own DEFAULT_RETRY_DELAY_MS doc comment) -----

test('a real delay is inserted between attempts (never before the first) -- exhausting 3 attempts with retryDelayMs:60 takes at least the 2 delays\' worth of real time', async function () {
  mockBlobs.seed(STORE_NAME, 'k10', { count: 0 });
  var attempts = 0;
  var start = Date.now();

  var result = await blobsRetry.retryingWrite({}, STORE_NAME, 'k10', {
    maxAttempts: 3,
    retryDelayMs: 60,
    read: rawRead('k10'),
    mutate: function (current) { attempts++; return { count: current.count + 1 }; },
    verify: function () { return false; } // never passes -- exhausts all 3 attempts, 2 delays
  });

  var elapsed = Date.now() - start;
  assert.equal(attempts, 3);
  assert.equal(result.ok, false);
  assert.ok(elapsed >= 110, 'two 60ms delays between three attempts should add up to close to 120ms of real elapsed time, got ' + elapsed + 'ms');
});

test('retryDelayMs:0 disables the delay entirely -- exhausting 3 attempts stays near-instant', async function () {
  mockBlobs.seed(STORE_NAME, 'k11', { count: 0 });
  var start = Date.now();

  await blobsRetry.retryingWrite({}, STORE_NAME, 'k11', {
    maxAttempts: 3,
    retryDelayMs: 0,
    read: rawRead('k11'),
    mutate: function (current) { return { count: current.count + 1 }; },
    verify: function () { return false; }
  });

  var elapsed = Date.now() - start;
  assert.ok(elapsed < 50, 'retryDelayMs:0 must skip the delay entirely across all attempts, got ' + elapsed + 'ms');
});

test('retryDelayMs defaults to DEFAULT_RETRY_DELAY_MS (200ms) when omitted', function () {
  assert.equal(blobsRetry.DEFAULT_RETRY_DELAY_MS, 200);
});

// ----- Per-attempt diagnostics (tracker.html's
// for-product-bug-founder-affects-all-funn-0efe7t item, round 4 — moved
// here from the now-deleted test/first-dream-email-exhaustion.test.js when
// lib/first-dream-email-store.js moved off this retry loop entirely onto a
// real CAS write (tracker.html's
// for-product-spike-conditional-write-only-rnurgw item); this diagnostics
// feature itself is unchanged and still lives here in blobs-retry.js,
// still used by tracker-store.js/entitlements.js/pending-dreams.js/
// support-store.js, so its test coverage belongs with the module it
// actually tests, not a caller that no longer uses it) -----

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

test('a successful write reports a per-attempt trace (attempt number, elapsed ms, what each read saw) and logs nothing', async function () {
  var lines = await captureConsoleError(async function () {
    var result = await blobsRetry.retryingWrite({}, 'diag-store', 'k', {
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

test('an exhausted loop logs ONE structured line carrying every attempt\'s elapsed ms and what its verify-read actually saw', async function () {
  // Every read against this store comes back as "not visible yet" -- the
  // real-world shape being investigated (write lands, reads lag).
  mockBlobs.setReadOverride('diag-store', function () { return { value: undefined }; });

  var result;
  var lines = await captureConsoleError(async function () {
    result = await blobsRetry.retryingWrite({}, 'diag-store', 'k', {
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

test('the diagnostic never logs the key or any stored value -- shape only (these stores hold usernames, emails and balances)', async function () {
  mockBlobs.setReadOverride('diag-store', function () {
    return { value: { secret: 'someone@example.com' } };
  });

  var lines = await captureConsoleError(async function () {
    await blobsRetry.retryingWrite({}, 'diag-store', 'user@example.com', {
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

test('a SKIP still reports its trace, so a caller can tell which attempt the precondition flipped on', async function () {
  var result = await blobsRetry.retryingWrite({}, 'diag-store', 'k', {
    read: function () { return Promise.resolve({ alreadyThere: true }); },
    mutate: function () { return blobsRetry.SKIP; },
    verify: function () { return true; }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, 'skip');
  assert.equal(result.attempts[0].read, 'value');
});
