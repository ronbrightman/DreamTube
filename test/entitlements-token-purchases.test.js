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
//   3. The `!paymentId` branch, which now fails CLOSED (hardening fix,
//      tracker item for-product-store-launch-copy-sweep-purc-m6xhkx) —
//      it used to skip the dedup guard entirely and always credit, a real
//      gap once real money was involved. Covered directly since
//      dodo-webhook.js never actually calls it with a falsy paymentId (a
//      real Dodo payload always has one), so nothing else in this test
//      suite exercises that branch.
//   4. The dodoCustomerId fold-in (tracker item
//      for-product-repeat-purchase-friction-dod-b6pzs6, review round-2
//      finding) — creditTokenPackOnce's optional 5th `dodoCustomerId`
//      argument is folded into creditTokenPackAmountOnce's own existing
//      hardened write rather than a second, separate, unguarded
//      setEntitlement call. Proves the stamp survives a genuinely
//      concurrent spendTokens call — see that test's own doc comment for
//      why this no longer needs a forced mock-blobs read override the way
//      it did before creditTokenPackAmountOnce's blobsCas.casWrite
//      migration (tracker item entitlements-js-retryingwrite-balance-mu-
//      qxm1ih).

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
 * separate 320-token first-ever-read signup grant, which
 * addTokens/syncTokens applies automatically to a genuinely brand-new
 * email the first time its balance is ever materialized. That grant is
 * real, correct, unrelated production behavior (covered by its own tests
 * in entitlements-tokens.test.js) — this helper just keeps it out of
 * these token-purchase-specific assertions. Same helper as
 * dodo-webhook.test.js's seedZeroBalance.
 *
 * ALSO stamps `firstPackPurchaseAt` in the past, so this account is
 * treated as already having a completed pack purchase on file — a
 * realistic default record shape. Since the old +50% first-purchase
 * bonus is retired (2026-08-02, "The Vault" shop redesign — see
 * creditTokenPackAmountOnce's own doc comment), this no longer changes
 * the CREDITED AMOUNT (every credit is the plain base amount regardless
 * of this field now); `firstPackPurchaseAt` is kept seeded here purely
 * because it's still a real, always-present field on a purchased
 * account's record.
 */
async function seedZeroBalance(email) {
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 0, lastClaimAt: Date.now() },
    firstPackPurchaseAt: Date.now() - 999999999
  });
}

/** Seeds a genuinely brand-new-to-purchasing account (zero balance, no prior pack purchase, no firstPackPurchaseAt) — used by the "firstPackPurchaseAt gets stamped" tests further down, plus the daily-claim survival test that needs this account genuinely claimable. No lastClaimAt seeded either. */
async function seedZeroBalanceNoPriorPurchase(email) {
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0 } });
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

test('a missing/falsy payment_id refuses to credit at all (fails closed -- nothing to dedupe a redelivery against)', async function () {
  await seedZeroBalance('nopayid@example.com');
  var first = await entitlements.creditTokenPackOnce({}, 'nopayid@example.com', undefined, 100);
  var second = await entitlements.creditTokenPackOnce({}, 'nopayid@example.com', null, 100);
  assert.equal(first.credited, false, 'no payment_id means no way to dedupe a redelivery -- must not credit');
  assert.equal(second.credited, false);

  var record = await entitlements.getEntitlement({}, 'nopayid@example.com');
  assert.equal(record.tokens.balance, 0, 'balance must stay untouched -- neither call should have credited anything');
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
    tokens: { balance: 100, lastClaimAt: Date.now() },
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

  await entitlements.setEntitlement({}, email, { tokens: { balance: 100, lastClaimAt: Date.now() } });
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
// These use mock-blobs.js's setCasReadOverride/clearCasReadOverride (the
// getWithMetadata()-side counterpart to setReadOverride/clearReadOverride,
// see that file's own header comment) to simulate hazards the plain
// in-memory Map can't otherwise reproduce: a CAS read that observes stale
// state (Blobs' read side is still only eventually consistent even under
// real compare-and-swap — see lib/blobs-cas.js's own header comment), and
// a CAS read that never converges within the bounded attempt count.
//
// CAS REWRITE NOTE: this section used to intercept get() (via
// setReadOverride/callIndex counting), simulating blobs-retry.js's old
// read -> mutate -> write -> verify loop. Now that creditTokenPackAmountOnce
// goes through blobsCas.casWrite (lib/blobs-cas.js), its own reads are
// getWithMetadata() calls, a SEPARATE override mechanism — a get()-based
// override no longer intercepts anything on this path. See lib/blobs-
// cas.js's own header comment for why a stale read can no longer silently
// commit a wrong value under CAS (a wrong guess's conditional write is
// atomically rejected, not written) — these tests now PROVE that directly:
// force a stale read on the FIRST attempt, and confirm the write is
// rejected and retried against the real state, rather than merely
// confirming the end-to-end result happens to be right.

test("a stale first CAS read (observing a pre-signup-grant snapshot with a non-current etag) is atomically REJECTED, not silently committed — the retry lands on the real balance", async function () {
  // Seed the record directly (bypassing syncTokens' own init branch
  // entirely) so this test targets ONLY creditTokenPackAmountOnce's own
  // casWrite loop, with no ambiguity about how many getWithMetadata calls
  // syncTokens' own init might separately make.
  await entitlements.setEntitlement({}, 'staleread@example.com', { tokens: { balance: 320, lastClaimAt: Date.now() - 100000 } });

  // Attempt 1 of creditTokenPackAmountOnce's own casWrite loop observes a
  // STALE snapshot (balance 0, as if read before the real 320 grant had
  // propagated) carrying an etag that can never match the record's real
  // current one — forcing the conditional write below to be built on a
  // wrong base. Every later attempt falls through to the real, current
  // state (a real etag that DOES match, so its write succeeds).
  mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) {
      return { value: { data: { email: key, tokens: { balance: 0, lastClaimAt: Date.now() - 100000 } }, etag: 'stale-etag-will-never-match', metadata: {} } };
    }
    return null; // fall through to the real current state
  });

  try {
    var applyResult = await entitlements.creditTokenPackAmountOnce({}, 'staleread@example.com', 'pay_stale_read', 100);
    assert.equal(applyResult.ok, true, 'the retry must still succeed once a fresher attempt reads the real state');

    var record = await entitlements.getEntitlement({}, 'staleread@example.com');
    assert.equal(record.tokens.balance, 320 + 100, 'balance must be 320 (the REAL pre-existing balance) + 100 (this credit) — attempt 1\'s stale-based write (0 + 100 = 100) must have been atomically rejected, never persisted');
  } finally {
    mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
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

  // Every CAS read against the entitlement record comes back with an etag
  // that can never match the real current one — every attempt's
  // conditional write is therefore atomically rejected, genuinely
  // exhausting the loop (not just failing to observe a write that
  // actually landed, the old verify-loop hazard this simulated before the
  // CAS migration — see this section's own header comment).
  mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key) {
    return { value: { data: { email: key, tokens: { balance: 0 } }, etag: 'stale-etag-will-never-match', metadata: {} } };
  });

  try {
    await assert.rejects(
      entitlements.creditTokenPackOnce({}, email, paymentId, 100),
      /exhausted attempts crediting/,
      'genuine exhaustion applying the balance credit must throw too, not leave the marker pending forever with no way to resume'
    );
  } finally {
    mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
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

// ----- dodoCustomerId fold-in vs. a concurrent spendTokens call (review
// round-2 finding, tracker item for-product-repeat-purchase-friction-dod-
// b6pzs6) -----
//
// The bug this closes: dodo-webhook.js's first draft stamped dodoCustomerId
// via a SEPARATE, plain, unguarded `entitlements.setEntitlement(event,
// email, {dodoCustomerId})` call sitting next to (not folded into)
// creditTokenPackOnce's own hardened credit. spendTokens (generate-video.js's
// per-generation deduction — the single highest-frequency writer to this
// same per-email record) is ALSO a plain, unguarded read -> Object.assign ->
// setJSON, with no retry/verify. Two such plain writes racing the same
// record can each build their patch from a stale pre-the-other's-write
// `existing`, so whichever lands second silently reverts or drops whatever
// the other had just changed — see creditTokenPackAmountOnce's own doc
// comment (the "WHY THIS NEEDS ITS OWN WRITE" section it grew as part of
// this fix) for the fuller mechanics.
//
// REBASE NOTE (tracker item for-product-repeat-purchase-friction-dod-b6pzs6,
// rescue/rebase pass): this test originally (2026-07-28) forced the SPECIFIC
// "reverse ordering" interleaving flagged by review against the
// then-current blobsRetry.retryingWrite implementation of
// creditTokenPackAmountOnce, by overriding mock-blobs' plain-get call #3
// (identified at the time as spendTokens' own setEntitlement()-internal
// read) to return a stale, pre-stamp snapshot. Since then,
// creditTokenPackAmountOnce migrated to blobsCas.casWrite (tracker item
// entitlements-js-retryingwrite-balance-mu-qxm1ih) — a genuinely different
// primitive that re-reads fresh (via getWithMetadata, on a SEPARATE
// call-count channel from the plain-get one this test overrides — see
// test/helpers/mock-blobs.js's own casReadOverrides doc comment) on every
// attempt and lets the server reject a write built from a stale read,
// rather than trusting a client-side verify-read the way retryingWrite did.
// Two consequences for this test, both verified empirically while rebasing
// rather than guessed at:
//   1. The plain-get call sequence itself shifted (creditTokenPackAmountOnce's
//      own syncTokens call is now call #3, not spendTokens' setEntitlement
//      read — that moved to call #2), so the OLD override target no longer
//      even touches the right call.
//   2. More fundamentally, forcing ANY plain-get call stale can no longer
//      reproduce the original clobber: creditTokenPackAmountOnce's actual
//      credited value/dodoCustomerId now come from casWrite's own internal
//      FRESH getWithMetadata read (a completely separate, un-overridden
//      channel here), not from the syncTokens fallback this override
//      targets — that fallback is now provably unused whenever a real
//      record already exists (see creditTokenPackAmountOnce's own "stale
//      first CAS read... is atomically REJECTED" test above, which covers
//      exactly this guarantee generically).
// What's still true and worth a regression test: a GENUINELY concurrent
// spendTokens call, racing creditTokenPackOnce with no forcing at all, must
// not cause the dodoCustomerId stamp to go missing. Empirically (verified
// while rebasing, not assumed), this mock environment's natural scheduling
// has creditTokenPackOnce's own atomic write consistently complete AFTER
// spendTokens' simpler read/write chain — the SAFE ordering, since
// casWrite's own fresh read then correctly incorporates spendTokens'
// already-applied deduction on top of the credit, reconciling BOTH effects
// in one write rather than losing either one. (The narrower, opposite
// hazard — spendTokens' OWN plain, unguarded write reverting a
// dodoCustomerId that had already landed, if spendTokens' internal read
// happens to race in stale relative to an EARLIER-landing credit write — is
// a real, but separate and already-accepted, pre-existing tradeoff of
// spendTokens/addTokens' own unguarded-write design, documented generally
// in the STANDING CHECKLIST comment above spendTokens/addTokens; it
// pre-dates this fix and folding dodoCustomerId into creditTokenPackAmountOnce's
// own write was never meant to close it — see that function's own doc
// comment's "Residual, undefended race" section for the identical
// disclosure already made for addTokens' balance field.)
test('creditTokenPackOnce\'s dodoCustomerId stamp (folded into creditTokenPackAmountOnce\'s existing atomic casWrite) survives a genuinely concurrent spendTokens call, reconciling both effects rather than losing either one', async function () {
  var email = 'dodoraceconcurrency@example.com';
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 100, lastClaimAt: Date.now() },
    firstPackPurchaseAt: Date.now() - 999999999 // isolate from the separate first-purchase-bonus behavior
  });

  await Promise.all([
    entitlements.creditTokenPackOnce({}, email, 'pay_dodo_race_concurrency', 100, 'cus_dodo_race_concurrency'),
    entitlements.spendTokens({}, email, 30)
  ]);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.dodoCustomerId, 'cus_dodo_race_concurrency', 'the dodoCustomerId stamp must survive a concurrent spendTokens call racing in around it, not get silently dropped');
  // 100 initial + 100 credited - 30 spent = 170 -- casWrite's own fresh
  // read-per-attempt means BOTH concurrent effects reconcile correctly in
  // this natural interleaving, not just the field this test cares about.
  assert.equal(record.tokens.balance, 170, '100 initial + 100 credited - 30 spent, both concurrent effects correctly reconciled');
});

// ----- No first-purchase bonus, ever (retired 2026-08-02, "The Vault"
// shop redesign, tracker item for-product-build-ship-today-founder-app-
// zn9zyy) — direct unit coverage of creditTokenPackOnce /
// creditTokenPackAmountOnce's own crediting decision, and that
// firstPackPurchaseAt is still stamped even though nothing reads it for a
// bonus anymore (it's repurposed to gate the shop's $0.99 starter pack's
// one-time eligibility at checkout-creation time instead — see
// create-checkout-session-dodo.js). See dodo-webhook.test.js for the same
// behavior exercised through the real webhook handler end-to-end. -----

test("creditTokenPackOnce credits the plain base amount on a brand-new-to-purchasing email's first pack (no bonus), and stamps firstPackPurchaseAt", async function () {
  await seedZeroBalanceNoPriorPurchase('unitbonus@example.com');
  var result = await entitlements.creditTokenPackOnce({}, 'unitbonus@example.com', 'pay_unit_bonus', 100);
  assert.equal(result.credited, true);

  var record = await entitlements.getEntitlement({}, 'unitbonus@example.com');
  assert.equal(record.tokens.balance, 100, 'plain base amount, no +50% bonus — that mechanic is retired');
  assert.ok(record.firstPackPurchaseAt, 'firstPackPurchaseAt must still be stamped (repurposed for starter-pack one-time gating)');
});

test('a SECOND distinct payment_id from the same email also credits the plain base amount — no multiplier on either purchase', async function () {
  await seedZeroBalanceNoPriorPurchase('unitsecond@example.com');
  await entitlements.creditTokenPackOnce({}, 'unitsecond@example.com', 'pay_unit_second_a', 100);
  var afterFirst = await entitlements.getEntitlement({}, 'unitsecond@example.com');
  assert.equal(afterFirst.tokens.balance, 100, 'first purchase credits the plain base amount');

  await entitlements.creditTokenPackOnce({}, 'unitsecond@example.com', 'pay_unit_second_b', 100);
  var afterSecond = await entitlements.getEntitlement({}, 'unitsecond@example.com');
  assert.equal(afterSecond.tokens.balance, 200, '100 (first, plain) + 100 (second, plain) = 200 -- neither purchase gets a bonus');
});

test('an account already marked with a prior firstPackPurchaseAt (e.g. seedZeroBalance) credits the same plain base amount, same as a genuinely first purchase', async function () {
  await seedZeroBalance('alreadypurchased@example.com'); // stamps firstPackPurchaseAt in the past
  var result = await entitlements.creditTokenPackOnce({}, 'alreadypurchased@example.com', 'pay_already_purchased', 100);
  assert.equal(result.credited, true);
  var record = await entitlements.getEntitlement({}, 'alreadypurchased@example.com');
  assert.equal(record.tokens.balance, 100, 'plain base amount regardless of prior purchase history -- no bonus mechanic exists anymore');
});

test("creditTokenPackAmountOnce called directly also credits only the plain base amount (not just via creditTokenPackOnce's wrapper)", async function () {
  await seedZeroBalanceNoPriorPurchase('directbonus@example.com');
  var result = await entitlements.creditTokenPackAmountOnce({}, 'directbonus@example.com', 'pay_direct_bonus', 100);
  assert.equal(result.ok, true);
  var record = await entitlements.getEntitlement({}, 'directbonus@example.com');
  assert.equal(record.tokens.balance, 100);
});

test('a redelivered (same payment_id) first-purchase event does not double-credit', async function () {
  await seedZeroBalanceNoPriorPurchase('redeliverbonus@example.com');
  var first = await entitlements.creditTokenPackOnce({}, 'redeliverbonus@example.com', 'pay_redeliver_bonus', 100);
  var second = await entitlements.creditTokenPackOnce({}, 'redeliverbonus@example.com', 'pay_redeliver_bonus', 100);
  assert.equal(first.credited, true);
  assert.equal(second.credited, false, 'a redelivered event for an already-processed payment_id is a no-op');

  var record = await entitlements.getEntitlement({}, 'redeliverbonus@example.com');
  assert.equal(record.tokens.balance, 100, 'exactly one plain credit, not two');
});

// ----- getTokenStatus's hasMadeFirstPurchase — the client-facing derived
// boolean. Originally gated the now-retired +50% first-purchase-bonus
// callout; as of 2026-08-02 ("The Vault" shop redesign, tracker item
// for-product-build-ship-today-founder-app-zn9zyy) it instead gates the
// $0.99 starter pack's one-time-per-account eligibility (shop.html's
// welcome-offer hero, create-checkout-session-dodo.js's E9 guard) — see
// lib/entitlements.js's own doc comments for the full repurposing story.
// Confirms firstPackPurchaseAt (a top-level field on the entitlement
// record, stamped by creditTokenPackAmountOnce above — NOT a field inside
// record.tokens) actually flows through syncTokens into getTokenStatus's
// returned shape, across both of syncTokens' return branches (brand-new
// record, and the plain passthrough — the OLD third "due-for-a-daily-grant"
// branch is gone entirely as of the 2026-07-28 daily-claim switch, see
// lib/entitlements.js's own doc block), AND across a daily CLAIM
// (claimDailyTokens, which writes its own fresh `tokens` sub-object
// independently of syncTokens), and that the raw timestamp itself is
// never leaked to the client — only the derived boolean. -----

test('getTokenStatus returns hasMadeFirstPurchase: false for an email that has never completed a pack purchase', async function () {
  await seedZeroBalanceNoPriorPurchase('neverpurchased@example.com');
  var status = await entitlements.getTokenStatus({}, 'neverpurchased@example.com');
  assert.equal(status.hasMadeFirstPurchase, false);
  assert.equal(status.firstPackPurchaseAt, undefined, 'the raw timestamp itself must never be exposed to the client, only the derived boolean');
});

test('getTokenStatus returns hasMadeFirstPurchase: true once creditTokenPackOnce has stamped firstPackPurchaseAt', async function () {
  await seedZeroBalanceNoPriorPurchase('nowpurchased@example.com');
  await entitlements.creditTokenPackOnce({}, 'nowpurchased@example.com', 'pay_now_purchased', 100);

  var status = await entitlements.getTokenStatus({}, 'nowpurchased@example.com');
  assert.equal(status.hasMadeFirstPurchase, true);
  assert.equal(status.firstPackPurchaseAt, undefined, 'the raw timestamp itself must never be exposed to the client, only the derived boolean');
});

test('getTokenStatus keeps returning hasMadeFirstPurchase: true across a later daily CLAIM (2026-07-28 daily-claim switch: syncTokens no longer has a separate "granted" branch at all -- claimDailyTokens is now the only thing that ever changes balance/lastClaimAt/streak outside a purchase, so this proves firstPackPurchaseAt survives THAT write too, not just the plain passthrough the tests above already cover)', async function () {
  await seedZeroBalanceNoPriorPurchase('grantedafterpurchase@example.com');
  await entitlements.creditTokenPackOnce({}, 'grantedafterpurchase@example.com', 'pay_granted_after', 100);

  var claimResult = await entitlements.claimDailyTokens({}, 'grantedafterpurchase@example.com');
  assert.equal(claimResult.claimed, true, 'sanity: the claim itself succeeded');

  var status = await entitlements.getTokenStatus({}, 'grantedafterpurchase@example.com');
  assert.equal(status.hasMadeFirstPurchase, true, 'firstPackPurchaseAt must survive a daily claim, which writes a fresh `tokens` sub-object of its own');
});

// ----- Cross-function concurrency: a genuinely concurrent claimDailyTokens
// write on the SAME email must survive creditTokenPackAmountOnce's own
// retry loop, not get reverted (tracker item
// entitlements-js-retryingwrite-balance-mu-qxm1ih) -----
//
// This is a DIFFERENT bug class than the double-credit concurrency test
// above (two calls racing for the SAME paymentId). This one is about a
// SINGLE token-pack credit racing a COMPLETELY UNRELATED write to the same
// email's record (a daily claim) — creditTokenPackAmountOnce used to
// capture `syncedTokens` ONCE, before its own retryingWrite loop, then
// reuse that one snapshot's balance/lastClaimAt/streak verbatim on EVERY
// retry attempt, instead of re-deriving from that attempt's own fresh
// read the way its appliedTokenPackPaymentIds/firstPackPurchaseAt fields
// already correctly did. blobs-retry.js's own header comment documents a
// second/third attempt as a NORMAL, expected occurrence (propagation lag),
// not a rare edge case — so a real claimDailyTokens write landing on this
// SAME email's record between this call's outer syncTokens read and a
// later retry attempt's successful write could have its fresher
// lastClaimAt/streak/balance silently reverted by the stale snapshot plus
// this function's own delta on top. A SEQUENTIAL test (await one call,
// then the other) can never catch this: by the time the second call's own
// syncTokens runs, the first is long done and already visible, so old and
// fixed code compute the identical result either way.
//
// Same technique as entitlements-achievements.test.js's own equivalent
// test: Promise.all fires a REAL, genuinely concurrent claimDailyTokens
// call racing creditTokenPackOnce on the SAME email, with a mockBlobs read
// override that intercepts creditTokenPackAmountOnce's own OUTER
// `syncTokens()` read specifically (identified via the call stack, so
// claimDailyTokens' own reads/writes against the same store are never
// touched) and forces it to see the PRE-claim, PRE-credit state — exactly
// mimicking real Blobs propagation lag deterministically instead of
// leaving it to chance timing. Everything after that one forced read (the
// retryingWrite loop's own read/write/verify) sees REAL data, including
// whatever the genuinely concurrent claim has by then actually written.
// FAILS against the pre-fix code, which always built its new `tokens` off
// that one forced-stale `syncedTokens` snapshot regardless of how fresh
// the retryingWrite loop's own read was (the concurrent claim's
// lastClaimAt/streak get silently reverted, and its +20 balance is lost);
// PASSES against the fix, which prefers that attempt's own fresh read
// instead (see baseTokensForAttempt's own doc comment for the exact rule).

test("a genuinely concurrent claimDailyTokens write is NOT reverted by creditTokenPackAmountOnce's own retry loop (real concurrency, not sequential awaits)", async function () {
  var email = 'purchaseraceclaim@example.com';
  var pastCooldown = Date.now() - (entitlements.CLAIM_COOLDOWN_MS + 60000);
  // firstPackPurchaseAt already set, matching a realistic already-purchased
  // account's record shape -- doesn't change the credited amount either
  // way (no bonus mechanic exists anymore), kept for realism only.
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 100, lastClaimAt: pastCooldown, streak: 3 },
    firstClaimAt: pastCooldown - 1000,
    firstPackPurchaseAt: pastCooldown - 2000
  });

  var forcedOnce = false;
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key) {
    if (forcedOnce) return null;
    // The FIRST STORE_NAME read whose call stack passes through
    // creditTokenPackAmountOnce is its own outer `syncTokens()` call --
    // this deliberately targets THAT read, leaving the retryingWrite
    // loop's own read/verify further down untouched (return null falls
    // through to real data).
    if (new Error().stack.indexOf('creditTokenPackAmountOnce') !== -1) {
      forcedOnce = true;
      return { value: { email: key, tokens: { balance: 100, lastClaimAt: pastCooldown, streak: 3 }, firstPackPurchaseAt: pastCooldown - 2000 } };
    }
    return null;
  });

  var results;
  try {
    results = await Promise.all([
      entitlements.creditTokenPackOnce({}, email, 'pay_race_claim', 50),
      entitlements.claimDailyTokens({}, email)
    ]);
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }

  assert.equal(results[0].credited, true, 'the token-pack credit must still succeed despite needing a real retry');
  assert.equal(results[1].claimed, true, 'the concurrent claim must still succeed too');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100 + entitlements.DAILY_CLAIM_AMOUNT + 50, 'both the claim (+20) and the plain +50 pack credit (no bonus multiplier exists anymore) must land -- the bug this fix closes would silently discard the claim, leaving only 100 + 50 = 150');
  assert.notEqual(record.tokens.lastClaimAt, pastCooldown, "the concurrent claim's fresh lastClaimAt must survive -- the bug this fix closes would silently revert it back to the pre-claim value");
  assert.equal(record.tokens.streak, 4, "the concurrent claim's bumped streak (3 -> 4) must survive, not get reverted back to 3");
});

// ----- forgetAppliedTokenPack racing a CAS'd writer for the SAME email:
// the housekeeping cleanup must never revert a concurrent credit
// (independent review finding on the CAS migration itself, fixed here) -----
//
// A DIFFERENT bug class again, this time in forgetAppliedTokenPack itself
// (the best-effort cleanup creditTokenPackOnce calls right after its own
// marker commits, see that function's own doc comment above). Before this
// fix, forgetAppliedTokenPack called setEntitlement -- a PLAIN,
// UNCONDITIONAL read -> merge -> write, no etag, no CAS at all -- to prune
// a committed paymentId out of appliedTokenPackPaymentIds. If a concurrent
// CAS'd writer to the SAME email's record (claimDailyTokens here) commits
// its own credit in the narrow window between setEntitlement's own
// internal read and its own internal write, that unconditional write
// silently reverted the WHOLE record -- including tokens.balance/
// lastClaimAt/streak -- back to the stale value setEntitlement's read
// saw, erasing the claim entirely. Exactly the "claim erasure" shape this
// whole file's CAS migration exists to close, just reached through a
// housekeeping path the original migration didn't touch.
//
// A plain, undelayed Promise.all of these two calls does not reliably
// reach this window either (confirmed during this fix's own
// development): forgetAppliedTokenPack is a short operation with nothing
// ahead of it to give a concurrent claim a head start, so it naturally
// completes its whole read/write cycle before claimDailyTokens' own write
// lands, in either call order -- never exercising the interesting case.
// Two devices make this reliable instead of occasional: (1) a mockBlobs
// read override that forces every STORE_NAME read inside
// forgetAppliedTokenPack's own call stack (both its plain `.get()` reads,
// pre-fix, and its `.getWithMetadata()` CAS read, post-fix -- the override
// covers both call shapes so this ONE test genuinely exercises whichever
// implementation is actually in the tree) to see the genuinely stale
// PRE-claim record, captured right after seeding, before either call
// starts -- exactly mimicking real Blobs propagation lag on forget's read
// side, deterministically instead of leaving it to chance timing; (2)
// starting forgetAppliedTokenPack after a `delay(0)`, so claimDailyTokens'
// own write has genuinely already landed for real by the time forget's
// forced-stale attempt tries to write against it -- without this, forget's
// forced-stale write can land while the real current state still
// legitimately matches it (claim hasn't written yet), which would never
// actually exercise a real conflict either way.
//
// FAILS against the pre-fix code (forgetAppliedTokenPack's plain
// setEntitlement call has no etag to reject a stale base, so its
// unconditional write silently reverts the claim's already-committed
// credit back to the pre-claim snapshot -- confirmed directly against a
// stashed copy of the pre-fix function during this fix's own development);
// PASSES against the fix (forgetAppliedTokenPack's own first CAS attempt's
// conditional write is atomically REJECTED once it reaches the server,
// since the real etag has already moved on -- blobsCas.casWrite's own loop
// retries with a fresh read, which correctly sees the claim's landed
// credit, and re-applies just the paymentId removal on top of it).

function delayTick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

test("forgetAppliedTokenPack's housekeeping cleanup does NOT revert a concurrent claimDailyTokens credit (real Promise.all concurrency, forced-stale first read simulating eventual-consistency lag)", async function () {
  for (var i = 0; i < 5; i++) {
    mockBlobs.reset();
    var email = 'forget-race-claim-' + i + '@example.com';
    var pastCooldown = Date.now() - (entitlements.CLAIM_COOLDOWN_MS + 60000);
    var seedRecord = {
      tokens: { balance: 50, lastClaimAt: pastCooldown, streak: 3 },
      firstClaimAt: pastCooldown - 1000,
      appliedTokenPackPaymentIds: ['pay_old']
    };
    await entitlements.setEntitlement({}, email, seedRecord);
    // The genuinely stale pre-claim snapshot forgetAppliedTokenPack's own
    // reads will be forced to see -- captured now, before either call
    // below starts, exactly like a real lagging read would. Plain shape
    // (for the pre-fix `.get()` path) and CAS shape (`{data, etag,
    // metadata}`, for the post-fix `.getWithMetadata()` path) are both
    // captured, since which one the current code actually calls is
    // exactly what this test is agnostic to by design.
    var stalePlain = await require('@netlify/blobs').getStore({ name: entitlements.STORE_NAME }).get(email, { type: 'json' });
    var staleCas = await require('@netlify/blobs').getStore({ name: entitlements.STORE_NAME }).getWithMetadata(email, { type: 'json' });

    mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key) {
      if (new Error().stack.indexOf('forgetAppliedTokenPack') !== -1) return { value: stalePlain };
      return null;
    });
    var forcedCasOnce = false;
    mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key) {
      if (!forcedCasOnce && new Error().stack.indexOf('forgetAppliedTokenPack') !== -1) {
        forcedCasOnce = true;
        return { value: staleCas };
      }
      return null;
    });

    var claimPromise = entitlements.claimDailyTokens({}, email);
    var forgetPromise = delayTick().then(function () {
      return entitlements.forgetAppliedTokenPack({}, email, 'pay_old');
    });

    var results;
    try {
      results = await Promise.all([forgetPromise, claimPromise]);
    } finally {
      mockBlobs.clearReadOverride(entitlements.STORE_NAME);
      mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
    }

    var claim = results[1];
    assert.equal(claim.claimed, true, 'trial ' + i + ': the concurrent claim must succeed');
    var record = await entitlements.getEntitlement({}, email);
    assert.equal(record.tokens.balance, 50 + claim.amountClaimed, 'trial ' + i + ": the claim's credit must survive forgetAppliedTokenPack's housekeeping write -- the bug this fix closes would silently revert it back to 50");
    assert.notEqual(record.tokens.lastClaimAt, pastCooldown, 'trial ' + i + ": the claim's fresh lastClaimAt must survive too, not just its balance delta");
    assert.deepEqual(record.appliedTokenPackPaymentIds, [], 'trial ' + i + ': the housekeeping prune must still land once the stale attempt is rejected and retried with a fresh read');
  }
});
