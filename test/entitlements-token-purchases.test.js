// test/entitlements-token-purchases.test.js
//
// Direct unit coverage for lib/entitlements.js's creditTokenPackOnce —
// previously only exercised transitively via dodo-webhook.test.js, which
// awaits each webhook call fully before firing the next, so it only ever
// proved the safe sequential-redelivery case. This file adds:
//   1. The basic single-credit / sequential-redelivery-dedup cases
//      directly against the function (not through the webhook handler).
//   2. A genuine CONCURRENCY test — two calls raced via Promise.all
//      against the same paymentId — which is what actually catches a
//      double-credit: a plain check-then-set (read "not processed" ->
//      write marker -> credit) lets two concurrent callers both read
//      "not processed" before either writes, so both credit. That's a
//      straightforward TOCTOU bug, not a rare edge case — it reproduces
//      deterministically against the in-memory mock store below, same as
//      this codebase's other Blobs-race tests (see
//      tracker-store.js's own writeItemsWithRetry and the race coverage
//      around it).
//   3. The `!paymentId` fallback branch, which intentionally skips the
//      dedup guard entirely (documented in creditTokenPackOnce's own
//      comment) — covered directly since dodo-webhook.js never actually
//      calls it with a falsy paymentId (a real Dodo payload always has
//      one), so nothing else in this test suite exercises that branch.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var entitlements = require('../netlify/functions/lib/entitlements');

test.beforeEach(function () {
  mockBlobs.reset();
});

/**
 * Seeds an email with an existing, zero-balance token record before a
 * credit — isolates a test's balance assertion to just the credit being
 * tested, instead of also having to account for this same file's own
 * separate 200-token first-ever-read signup grant, which
 * addTokens/syncTokens applies automatically to a genuinely brand-new
 * email the first time its balance is ever materialized. That grant is
 * real, correct, unrelated production behavior (covered by its own tests
 * in entitlements-tokens.test.js) — this helper just keeps it out of
 * these token-purchase-specific assertions. Same helper as
 * dodo-webhook.test.js's seedZeroBalance.
 */
async function seedZeroBalance(email) {
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0, lastGrantAt: Date.now() } });
}

test('credits tokens onto a fresh email and reports credited:true', async function () {
  await seedZeroBalance('buyer@example.com');
  var result = await entitlements.creditTokenPackOnce({}, 'buyer@example.com', 'pay_1', 100);
  assert.equal(result.credited, true);
  var record = await entitlements.getEntitlement({}, 'buyer@example.com');
  assert.equal(record.tokens.balance, 100);
});

test('a second sequential call with the SAME payment_id does not double-credit', async function () {
  await seedZeroBalance('buyer2@example.com');
  var first = await entitlements.creditTokenPackOnce({}, 'buyer2@example.com', 'pay_2', 100);
  var second = await entitlements.creditTokenPackOnce({}, 'buyer2@example.com', 'pay_2', 100);
  assert.equal(first.credited, true);
  assert.equal(second.credited, false, 'a redelivered/repeated call for an already-processed payment_id must report credited:false');

  var record = await entitlements.getEntitlement({}, 'buyer2@example.com');
  assert.equal(record.tokens.balance, 100, 'balance must reflect exactly one credit, not two');
});

test('a DIFFERENT payment_id for the same email credits again (dedup is per-payment, not per-email)', async function () {
  await seedZeroBalance('repeat@example.com');
  await entitlements.creditTokenPackOnce({}, 'repeat@example.com', 'pay_a', 100);
  await entitlements.creditTokenPackOnce({}, 'repeat@example.com', 'pay_b', 100);
  var record = await entitlements.getEntitlement({}, 'repeat@example.com');
  assert.equal(record.tokens.balance, 200);
});

test('a missing/falsy payment_id skips the dedup guard entirely and always credits (documented escape hatch)', async function () {
  await seedZeroBalance('nopayid@example.com');
  var first = await entitlements.creditTokenPackOnce({}, 'nopayid@example.com', undefined, 100);
  var second = await entitlements.creditTokenPackOnce({}, 'nopayid@example.com', undefined, 100);
  assert.equal(first.credited, true);
  assert.equal(second.credited, true, 'with no payment_id there is nothing to dedupe against, so both calls credit');

  var record = await entitlements.getEntitlement({}, 'nopayid@example.com');
  assert.equal(record.tokens.balance, 200, 'both calls credited since there was no payment_id to guard with');
});

// ----- The real regression test: genuine concurrency, not sequential -----

test('two CONCURRENT calls for the SAME payment_id credit exactly once between them, not twice', async function () {
  var email = 'racer@example.com';
  var paymentId = 'pay_race_1';
  await seedZeroBalance(email);

  // Both calls are started before either has a chance to await through to
  // completion — Promise.all invokes both synchronously, so they
  // interleave at each internal await point exactly the way two
  // concurrently-arriving webhook deliveries (or one redelivered within
  // Blobs' eventual-consistency window) would. A plain check-then-set
  // implementation lets both calls observe "not yet processed" before
  // either writes its marker, so both proceed to addTokens — this test
  // fails (balance == 200) against that implementation and must pass
  // (balance == 100) against a real dedup guard.
  var results = await Promise.all([
    entitlements.creditTokenPackOnce({}, email, paymentId, 100),
    entitlements.creditTokenPackOnce({}, email, paymentId, 100)
  ]);

  var creditedCount = results.filter(function (r) { return r.credited; }).length;
  assert.equal(creditedCount, 1, 'exactly one of the two concurrent calls should report credited:true');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'a genuinely concurrent double-delivery must still only credit tokens once');
});

test('three CONCURRENT calls for the SAME payment_id still credit exactly once', async function () {
  var email = 'racer3@example.com';
  var paymentId = 'pay_race_3';
  await seedZeroBalance(email);

  var results = await Promise.all([
    entitlements.creditTokenPackOnce({}, email, paymentId, 500),
    entitlements.creditTokenPackOnce({}, email, paymentId, 500),
    entitlements.creditTokenPackOnce({}, email, paymentId, 500)
  ]);

  var creditedCount = results.filter(function (r) { return r.credited; }).length;
  assert.equal(creditedCount, 1);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 500);
});

test('concurrent races on DIFFERENT payment_ids for the same email both go through the dedup guard independently (both credited:true)', async function () {
  // Deliberately does NOT assert the exact resulting balance. Once both
  // payment_ids clear the dedup-marker guard (this test's actual point —
  // two distinct payment_ids must never be treated as duplicates of each
  // other, i.e. dedup is per-payment, never a per-email lock), each one
  // calls addTokens independently — and addTokens/syncTokens itself has
  // its own separate, pre-existing, already-documented last-write-wins
  // race on the shared per-email balance under real concurrency (see
  // this file's own header comment: "two near-simultaneous ... requests
  // from the same email both reading the same pre-spend balance" is an
  // accepted tradeoff already). That race is not what this fix (or this
  // review round) is about — it pre-dates creditTokenPackOnce entirely
  // and applies equally to, say, two concurrent generate-video.js spends.
  // Asserting an exact post-race balance here would conflate two
  // different hazards; the dedup guard's own job is only to prove both
  // distinct payment_ids were allowed to proceed at all.
  var email = 'racerdiff@example.com';

  var results = await Promise.all([
    entitlements.creditTokenPackOnce({}, email, 'pay_diff_a', 100),
    entitlements.creditTokenPackOnce({}, email, 'pay_diff_b', 500)
  ]);

  assert.equal(results[0].credited, true);
  assert.equal(results[1].credited, true);
});
