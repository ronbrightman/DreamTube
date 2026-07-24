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

// ----- Interrupted-credit resume (dodo-payment-webhook-marker-before-credi-kz94cx) -----
//
// These simulate an earlier call that got interrupted somewhere between
// writing the dedup marker and finishing the credit — e.g. addTokens threw
// on a transient Blobs write failure — by directly seeding the mock Blobs
// stores into that exact intermediate shape, then confirming a later call
// (a Dodo webhook redelivery, in reality) completes the credit exactly
// once: not zero times (the original bug this fixes — a real charge with
// tokens silently, permanently unaccounted for) and not twice (a double
// credit, which the naive "credit first, mark second" reorder would risk
// instead).

test('a marker left "pending" with the balance NOT yet applied (addTokens never ran) resumes and completes the credit exactly once', async function () {
  var email = 'interrupted1@example.com';
  var paymentId = 'pay_interrupted_1';
  await seedZeroBalance(email);

  // Seed exactly the state an interrupted first attempt would have left:
  // the dedup marker committed as 'pending', but the entitlement record
  // has no record of this paymentId's credit ever being applied (addTokens
  // threw before it could run).
  mockBlobs.seed(entitlements.TOKEN_PURCHASES_STORE_NAME, paymentId, {
    email: email,
    tokens: 100,
    status: 'pending',
    claimId: 'stale-claim-from-interrupted-attempt',
    createdAt: Date.now() - 5000
  });

  var result = await entitlements.creditTokenPackOnce({}, email, paymentId, 100);
  assert.equal(result.credited, true, 'a resumed pending marker with no applied credit must complete the credit and report credited:true');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'the balance must reflect exactly one credit');
});

test('a marker left "pending" where the balance was ALREADY applied (only the flip-to-committed write was interrupted) does not double-credit on resume', async function () {
  var email = 'interrupted2@example.com';
  var paymentId = 'pay_interrupted_2';
  await seedZeroBalance(email);

  // Seed the OTHER interrupted state: an earlier attempt's
  // creditTokenPackAmountOnce actually succeeded (balance already bumped,
  // paymentId recorded in appliedTokenPackPaymentIds) but the marker never
  // got flipped to 'committed' — e.g. the process died between the two
  // writes. This is the specific ambiguous case creditTokenPackAmountOnce's
  // idempotency check exists to resolve correctly.
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 100, lastGrantAt: Date.now() },
    appliedTokenPackPaymentIds: [paymentId]
  });
  mockBlobs.seed(entitlements.TOKEN_PURCHASES_STORE_NAME, paymentId, {
    email: email,
    tokens: 100,
    status: 'pending',
    claimId: 'stale-claim-from-interrupted-attempt-2',
    createdAt: Date.now() - 5000
  });

  var result = await entitlements.creditTokenPackOnce({}, email, paymentId, 100);
  assert.equal(result.credited, true, 'resuming a pending marker whose balance was already applied should still report credited:true (finishing the interrupted work, i.e. flipping the marker) — not an error');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'the balance must NOT be credited a second time — this is the double-credit hazard the fix exists to close');
});

test('a marker already "committed" is a genuine redelivery and is never resumed (credited:false, no change to balance)', async function () {
  var email = 'committed1@example.com';
  var paymentId = 'pay_committed_1';
  await seedZeroBalance(email);

  await entitlements.setEntitlement({}, email, { tokens: { balance: 100, lastGrantAt: Date.now() } });
  mockBlobs.seed(entitlements.TOKEN_PURCHASES_STORE_NAME, paymentId, {
    email: email,
    tokens: 100,
    status: 'committed',
    claimId: 'old-claim',
    createdAt: Date.now() - 60000,
    creditedAt: Date.now() - 59000
  });

  var result = await entitlements.creditTokenPackOnce({}, email, paymentId, 100);
  assert.equal(result.credited, false, 'a committed marker means this payment was already fully processed — a redelivery must be a no-op');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'balance must be untouched by a redelivery of an already-committed payment');
});

test('a fresh interrupted-credit call flips the marker to status "committed" so a later redelivery is recognized as already processed', async function () {
  var email = 'interrupted3@example.com';
  var paymentId = 'pay_interrupted_3';
  await seedZeroBalance(email);

  mockBlobs.seed(entitlements.TOKEN_PURCHASES_STORE_NAME, paymentId, {
    email: email,
    tokens: 100,
    status: 'pending',
    claimId: 'stale-claim-3',
    createdAt: Date.now() - 5000
  });

  var first = await entitlements.creditTokenPackOnce({}, email, paymentId, 100);
  assert.equal(first.credited, true);

  // A THIRD delivery now, after the resume above already completed and
  // (per creditTokenPackOnce's own doc comment) flipped the marker to
  // 'committed' — this must behave exactly like the existing "already
  // processed" dedup case, not attempt yet another resume.
  var second = await entitlements.creditTokenPackOnce({}, email, paymentId, 100);
  assert.equal(second.credited, false, 'once resumed and committed, a further redelivery must be a no-op');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'balance must reflect exactly one credit across all three deliveries (interrupted + resume + redelivery)');
});

test('creditTokenPackAmountOnce is idempotent per paymentId when called directly twice', async function () {
  var email = 'directamount@example.com';
  var paymentId = 'pay_direct_amount';
  await seedZeroBalance(email);

  var first = await entitlements.creditTokenPackAmountOnce({}, email, paymentId, 100);
  var second = await entitlements.creditTokenPackAmountOnce({}, email, paymentId, 100);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true, 'a second call for the same paymentId must still report ok:true (already applied) without crediting again');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'balance must reflect exactly one credit despite two calls');
  assert.deepEqual(record.appliedTokenPackPaymentIds, [paymentId], 'paymentId should be recorded exactly once, not duplicated');
});

// ----- Round-2 review findings: stale-read balance clobber, and exhaustion-must-throw -----
//
// These use mock-blobs.js's setReadOverride/clearReadOverride to simulate
// hazards the plain in-memory Map can't otherwise reproduce: a read that
// lands behind a write that already happened (Blobs has no
// read-your-own-write guarantee — see this file's own header comment on
// the strong-consistency incident), and a verify read that never
// converges within the bounded attempt count.
//
// NOTE on an earlier, broken version of these tests: the first attempt at
// this monkeypatched `require('@netlify/blobs').getStore` directly, but
// entitlements.js/blobs-retry.js both do `var { getStore } =
// require('@netlify/blobs')` at module-load time, copying the function
// reference into a local binding — reassigning the exports property
// afterward never reaches those already-bound locals, so the override
// silently had no effect at all (every test using it "passed" or "failed"
// for the wrong reason — the real, un-intercepted store was used
// throughout). setReadOverride fixes this by living inside fakeGetStore's
// own closure instead, which every caller already holds a reference to
// regardless of when they destructured it.

test("creditTokenPackAmountOnce bases the new balance on syncTokens' own returned value, not a stale independent re-read (a stale re-read would silently discard a just-applied signup grant)", async function () {
  // Against a brand-new email, two STORE_NAME reads happen BEFORE
  // creditTokenPackAmountOnce's own independent retryingWrite `read()`
  // ever runs: syncTokens' own getEntitlement (call #1, genuinely sees
  // nothing) and, once that decides to apply the first-ever signup grant,
  // setEntitlement's own internal existing-read as part of persisting it
  // (call #2). Call #3 is the one this test actually targets —
  // creditTokenPackAmountOnce's own read, landing (in this simulation)
  // BEFORE syncTokens' just-completed signup-grant write has propagated
  // to it. Every later get() call (the verify-read, and any retry) sees
  // the real current state.
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 3) {
      return { value: { email: key, tokens: { balance: 0, lastGrantAt: Date.now() - 100000 } } };
    }
    return null; // fall through to the real stored value for every other call
  });

  try {
    // Deliberately brand-new/unseeded: syncTokens (called first, inside
    // creditTokenPackAmountOnce) applies the one-time 290-token signup
    // grant as part of this very call.
    var applyResult = await entitlements.creditTokenPackAmountOnce({}, 'staleread@example.com', 'pay_stale_read', 100);
    assert.equal(applyResult.ok, true);

    var record = await entitlements.getEntitlement({}, 'staleread@example.com');
    assert.equal(record.tokens.balance, 290 + 100, "balance must be 290 (signup grant, from syncTokens' own in-memory return value) + 100 (this credit) — a buggy re-read-based implementation would compute 0 + 100 = 100 here, silently discarding the signup grant that had just landed");
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }
});

test('genuine exhaustion writing the initial pending marker (verify never confirms a winner) throws instead of silently returning credited:false', async function () {
  var email = 'exhaustion1@example.com';
  var paymentId = 'pay_exhaustion_1';
  await seedZeroBalance(email);

  // setJSON still actually writes; get() always reports "nothing here" --
  // simulates reads that never converge on our own write within the
  // bounded attempt count, a real (if rare) propagation-lag scenario this
  // file's own header comment already accepts as possible.
  mockBlobs.setReadOverride(entitlements.TOKEN_PURCHASES_STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.creditTokenPackOnce({}, email, paymentId, 100),
      /exhausted attempts/,
      'genuine exhaustion writing the initial pending marker must throw, not silently return credited:false with nothing durably recorded and no future retry'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.TOKEN_PURCHASES_STORE_NAME);
  }
});

test("genuine exhaustion applying the balance credit (creditTokenPackAmountOnce's own retry loop) throws too", async function () {
  var email = 'exhaustion2@example.com';
  var paymentId = 'pay_exhaustion_2';
  await seedZeroBalance(email);
  mockBlobs.seed(entitlements.TOKEN_PURCHASES_STORE_NAME, paymentId, {
    email: email, tokens: 100, status: 'pending', claimId: 'stale', createdAt: Date.now() - 5000
  });

  mockBlobs.setReadOverride(entitlements.STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.creditTokenPackOnce({}, email, paymentId, 100),
      /exhausted attempts crediting/,
      'genuine exhaustion applying the balance credit must throw too, not leave the marker pending forever with no way to resume'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }
});

test('genuine exhaustion flipping the marker to committed (bookkeeping-only failure, balance already landed) also throws', async function () {
  var email = 'exhaustion3@example.com';
  var paymentId = 'pay_exhaustion_3';
  await seedZeroBalance(email);
  mockBlobs.seed(entitlements.TOKEN_PURCHASES_STORE_NAME, paymentId, {
    email: email, tokens: 100, status: 'pending', claimId: 'stale', createdAt: Date.now() - 5000
  });

  // Let the very first read through (the outer marker lookup that
  // discovers the seeded 'pending' marker and lets the balance credit
  // proceed normally) -- every read after that belongs to the
  // flip-to-committed attempt itself, simulated as permanently stale.
  mockBlobs.setReadOverride(entitlements.TOKEN_PURCHASES_STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) return null; // real value
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.creditTokenPackOnce({}, email, paymentId, 100),
      /exhausted attempts flipping the marker/,
      'genuine exhaustion flipping the marker to committed must throw, not silently leave it pending forever'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.TOKEN_PURCHASES_STORE_NAME);
  }

  // The balance credit itself must still be correct despite the flip
  // failing to confirm — this specific failure mode is bookkeeping-only.
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'the balance credit must still have landed even though the flip-to-committed write could not be confirmed');
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
