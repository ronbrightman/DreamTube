// test/blobs-cas.test.js
//
// Direct unit coverage for lib/blobs-cas.js's casWrite — the shared REAL
// compare-and-swap read -> mutate -> conditional-write loop built on
// @netlify/blobs 10.x's `onlyIfNew`/`onlyIfMatch` (installed as the
// separately-aliased `blobs10` package — see package.json and
// lib/first-dream-email-store.js's own header comment for the "why a
// separate alias" reasoning). Extracted for entitlements.js's balance-
// record writers (syncTokens' init write, claimDailyTokens,
// creditTokenPackAmountOnce, refundTokenAmountOnce,
// applyAchievementGrantOnce) and like-dream.js's feed-index write — see
// each call site's own doc comment for its domain-specific shape. This
// file tests the shared mechanism itself, in isolation, against the
// module's own generic contract (not any one caller's semantics) — mirrors
// test/blobs-retry.test.js's own equivalent coverage for the older,
// verify-loop-based sibling module.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var blobsCas = require('../netlify/functions/lib/blobs-cas');

var STORE_NAME = 'test-blobs-cas-store';

test.beforeEach(function () {
  mockBlobs.reset();
});

// ----- Basic success paths -----

test('a brand-new key: mutate creates it, the write is a real onlyIfNew CAS create, returns ok:true', async function () {
  var result = await blobsCas.casWrite({}, STORE_NAME, 'k1', {
    mutate: function (current) {
      assert.equal(current, null, 'a never-written key must read as null, not undefined -- getWithMetadata\'s own documented contract');
      return { count: 1 };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.value, { count: 1 });
  assert.equal(result.current, null, 'current must reflect the read BEFORE mutation');

  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('k1', { type: 'json' });
  assert.deepEqual(persisted, { count: 1 });
});

test('an existing key: mutate updates it, the write is a real onlyIfMatch CAS update against the read etag, returns ok:true', async function () {
  mockBlobs.seed(STORE_NAME, 'k1', { count: 1 });

  var result = await blobsCas.casWrite({}, STORE_NAME, 'k1', {
    mutate: function (current) { return { count: current.count + 1 }; }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { count: 2 });
  assert.deepEqual(result.current, { count: 1 });

  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('k1', { type: 'json' });
  assert.deepEqual(persisted, { count: 2 });
});

// ----- SKIP -----

test('mutate returning SKIP aborts immediately -- no write, skipped:true, current reflects the read', async function () {
  mockBlobs.seed(STORE_NAME, 'already-done', { done: true });

  var result = await blobsCas.casWrite({}, STORE_NAME, 'already-done', {
    mutate: function (current) {
      if (current && current.done) return blobsCas.SKIP;
      return { done: true };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.value, undefined);
  assert.deepEqual(result.current, { done: true });
});

// ----- The actual point of this module: a stale read's write is REJECTED, not silently committed -----

test('a stale read (a snapshot whose etag no longer matches the real current one) has its conditional write atomically REJECTED -- the loop retries against a fresh read instead of committing a wrong value', async function () {
  mockBlobs.seed(STORE_NAME, 'k1', { count: 1 });

  // Attempt 1 sees a plausible-looking snapshot with a non-current etag --
  // as if a genuinely concurrent write had already landed between this
  // read and the real current state. This is exactly the class of bug
  // lib/blobs-retry.js's own verify-loop could NOT close (a write built
  // from a stale read could still commit if its own verify-read happened
  // to read back its own just-written data) -- under real CAS the write
  // itself is rejected server-side, unconditionally.
  mockBlobs.setCasReadOverride(STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) {
      return { value: { data: { count: 1 }, etag: 'stale-etag-will-never-match', metadata: {} } };
    }
    return null; // fall through to the real current state
  });

  try {
    var result = await blobsCas.casWrite({}, STORE_NAME, 'k1', {
      mutate: function (current) { return { count: current.count + 1 }; }
    });
    assert.equal(result.ok, true, 'must succeed once a fresher attempt reads the real state');
    assert.deepEqual(result.value, { count: 2 }, 'must be based on the REAL count (1), not a phantom base');
  } finally {
    mockBlobs.clearCasReadOverride(STORE_NAME);
  }

  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('k1', { type: 'json' });
  assert.deepEqual(persisted, { count: 2 }, 'exactly one increment must have landed, not zero and not two');
});

// ----- Genuine concurrency: two REAL casWrite calls racing the same key -----

test('two genuinely concurrent casWrite calls incrementing the SAME key both land -- neither clobbers the other (Promise.all interleaving, not sequential awaits)', async function () {
  mockBlobs.seed(STORE_NAME, 'counter', { count: 0 });

  var results = await Promise.all([
    blobsCas.casWrite({}, STORE_NAME, 'counter', { mutate: function (current) { return { count: current.count + 1 }; } }),
    blobsCas.casWrite({}, STORE_NAME, 'counter', { mutate: function (current) { return { count: current.count + 1 }; } })
  ]);

  results.forEach(function (r) { assert.equal(r.ok, true, 'both concurrent callers must eventually win -- one on the first attempt, the loser after a real CAS rejection and retry'); });

  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('counter', { type: 'json' });
  assert.equal(persisted.count, 2, 'both increments must be reflected -- a lost update would leave this at 1');
});

test('three genuinely concurrent casWrite calls incrementing the SAME key all land', async function () {
  mockBlobs.seed(STORE_NAME, 'counter3', { count: 0 });

  var results = await Promise.all([
    blobsCas.casWrite({}, STORE_NAME, 'counter3', { mutate: function (current) { return { count: current.count + 1 }; } }),
    blobsCas.casWrite({}, STORE_NAME, 'counter3', { mutate: function (current) { return { count: current.count + 1 }; } }),
    blobsCas.casWrite({}, STORE_NAME, 'counter3', { mutate: function (current) { return { count: current.count + 1 }; } })
  ]);

  results.forEach(function (r) { assert.equal(r.ok, true); });

  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('counter3', { type: 'json' });
  assert.equal(persisted.count, 3, 'all three increments must land');
});

// ----- Genuine exhaustion -----

test('a CAS read that never converges within maxAttempts genuinely exhausts -- ok:false, skipped:false, no write ever commits', async function () {
  mockBlobs.seed(STORE_NAME, 'stuck', { count: 1 });

  // Every read comes back with an etag that can never match the real
  // current one -- every attempt's conditional write is atomically
  // rejected, deterministically exhausting the loop (not a write that
  // actually landed but went unobserved -- that ambiguity doesn't exist
  // under real CAS, see this file's header comment).
  mockBlobs.setCasReadOverride(STORE_NAME, function (key) {
    return { value: { data: { count: 1 }, etag: 'stale-etag-will-never-match', metadata: {} } };
  });

  try {
    var result = await blobsCas.casWrite({}, STORE_NAME, 'stuck', {
      maxAttempts: 3,
      retryDelayMs: 0,
      mutate: function (current) { return { count: current.count + 1 }; }
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.equal(result.value, undefined, 'exhaustion must never report a value that was never actually persisted');
  } finally {
    mockBlobs.clearCasReadOverride(STORE_NAME);
  }

  var { getStore } = require('blobs10');
  var persisted = await getStore({ name: STORE_NAME }).get('stuck', { type: 'json' });
  assert.deepEqual(persisted, { count: 1 }, 'the real stored value must be completely untouched -- no attempt\'s write ever actually committed');
});

test('maxAttempts is respected -- exactly that many CAS attempts are made, no more', async function () {
  mockBlobs.seed(STORE_NAME, 'countattempts', { count: 1 });
  var attempts = 0;
  mockBlobs.setCasReadOverride(STORE_NAME, function (key) {
    attempts++;
    return { value: { data: { count: 1 }, etag: 'stale-etag-will-never-match', metadata: {} } };
  });

  try {
    await blobsCas.casWrite({}, STORE_NAME, 'countattempts', {
      maxAttempts: 4,
      retryDelayMs: 0,
      mutate: function (current) { return { count: current.count + 1 }; }
    });
  } finally {
    mockBlobs.clearCasReadOverride(STORE_NAME);
  }

  assert.equal(attempts, 4, 'exactly maxAttempts CAS reads must have been made');
});

// ----- retryDelayMs -----

test('retryDelayMs inserts a real delay between attempts (never before the first, never after the last)', async function () {
  mockBlobs.seed(STORE_NAME, 'timed', { count: 1 });
  mockBlobs.setCasReadOverride(STORE_NAME, function () {
    return { value: { data: { count: 1 }, etag: 'stale-etag-will-never-match', metadata: {} } };
  });

  var start = Date.now();
  try {
    await blobsCas.casWrite({}, STORE_NAME, 'timed', {
      maxAttempts: 3,
      retryDelayMs: 50,
      mutate: function (current) { return { count: current.count + 1 }; }
    });
  } finally {
    mockBlobs.clearCasReadOverride(STORE_NAME);
  }
  var elapsed = Date.now() - start;
  // 3 attempts -> 2 inter-attempt delays of 50ms each = ~100ms minimum,
  // comfortably distinguishable from retryDelayMs:0's near-instant run.
  assert.ok(elapsed >= 90, 'expected at least ~100ms of real elapsed delay across 2 inter-attempt gaps, saw ' + elapsed + 'ms');
});

test('retryDelayMs:0 disables the delay entirely (near-instant even across multiple attempts)', async function () {
  mockBlobs.seed(STORE_NAME, 'fast', { count: 1 });
  mockBlobs.setCasReadOverride(STORE_NAME, function () {
    return { value: { data: { count: 1 }, etag: 'stale-etag-will-never-match', metadata: {} } };
  });

  var start = Date.now();
  try {
    await blobsCas.casWrite({}, STORE_NAME, 'fast', {
      maxAttempts: 5,
      retryDelayMs: 0,
      mutate: function (current) { return { count: current.count + 1 }; }
    });
  } finally {
    mockBlobs.clearCasReadOverride(STORE_NAME);
  }
  var elapsed = Date.now() - start;
  assert.ok(elapsed < 50, 'expected a near-instant run with retryDelayMs:0, saw ' + elapsed + 'ms');
});
