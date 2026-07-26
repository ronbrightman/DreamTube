// test/entitlements-refund.test.js
//
// Direct unit coverage for lib/entitlements.js's refundTokensOnce/
// refundTokenAmountOnce — the auto-refund tracker item
// idea-auto-refund-policy (founder-approved 2026-07-26). Mirrors
// test/entitlements-token-purchases.test.js's own coverage of
// creditTokenPackOnce/creditTokenPackAmountOnce closely, since refunds use
// the exact same two-phase-marker discipline: an OUTER claimId-based
// marker (REFUNDED_JOBS_STORE_NAME, keyed by job id) serializes concurrent
// callers before any of them touch the balance, and an INNER per-email
// dedup array (refundedJobIds, folded into the same write as the balance)
// makes a resumed/interrupted credit safe too.
//
// The single most important property this file proves: a resumed/
// redelivered status check for the SAME job id must only ever refund
// once, EVEN UNDER GENUINE CONCURRENCY — a double-refund would be a real
// money-adjacent bug, not a nitpick. An earlier draft of refundTokensOnce
// (folding the dedup array into the entitlement record alone, with no
// outer marker) failed exactly this property: two concurrent callers
// could both read "not yet refunded" before either wrote, and a plain
// array-membership `verify()` reported success for both, since whichever
// write landed last still contained the job id either way. The
// concurrency tests below are what catch that class of bug.
//
// ROUND-2 REVIEW FINDING (fixed, covered below): refundTokensOnce also
// used to trust `email`/`jobId` outright with no check that the caller
// was actually the account that submitted that job — since both arrive
// as plain, unauthenticated query-string values on video-status.js/
// image-status.js, that meant anyone who learned/guessed a stranger's
// in-flight operationName could redirect that job's one-time refund to
// their own balance, and PERMANENTLY lock the real owner out (the outer
// marker commits on first successful claim, regardless of who claimed
// it). Fixed via lib/job-owners.js: generate-video.js/generate-image.js
// now record which email actually submitted a job id at generation time,
// and refundTokensOnce checks that record BEFORE ever touching the
// marker or a balance. The "email/jobId ownership" tests below are what
// catch a regression of that vulnerability.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var entitlements = require('../netlify/functions/lib/entitlements');
var jobOwners = require('../netlify/functions/lib/job-owners');

test.beforeEach(function () {
  mockBlobs.reset();
});

/**
 * Seeds an email with an existing, zero-balance token record before a
 * refund — isolates a test's balance assertion to just the refund being
 * tested, instead of also having to account for the separate 220-token
 * first-ever-read signup grant syncTokens applies automatically to a
 * genuinely brand-new email. Same helper as entitlements-token-
 * purchases.test.js's/dodo-webhook.test.js's own seedZeroBalance.
 */
async function seedZeroBalance(email) {
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0, lastGrantAt: Date.now() } });
}

/**
 * Seeds a job-owners record binding `jobId` to `email` — the real
 * production equivalent of generate-video.js's/generate-image.js's own
 * recordJobOwnerBestEffort call, made once at generation-submission time.
 * Every test below that expects refundTokensOnce to actually succeed must
 * call this first (mirroring the real flow: a job is only ever
 * refund-eligible because it was legitimately submitted by someone) —
 * this is deliberate, not incidental test setup: it's what the
 * "ownership" security tests further down prove is actually enforced,
 * not just assumed.
 */
async function seedJobOwner(email, jobId) {
  await jobOwners.recordJobOwner({}, jobId, email);
}

test('refunds tokens onto a fresh email and reports refunded:true', async function () {
  await seedZeroBalance('refund1@example.com');
  await seedJobOwner('refund1@example.com', 'job_1');
  var result = await entitlements.refundTokensOnce({}, 'refund1@example.com', 'job_1', 100);
  assert.equal(result.ok, true);
  assert.equal(result.refunded, true);
  var record = await entitlements.getEntitlement({}, 'refund1@example.com');
  assert.equal(record.tokens.balance, 100);
  // refundedJobIds is pruned once REFUNDED_JOBS_STORE_NAME's own marker
  // commits (see forgetRefundedJobId) -- that marker is now the durable
  // "already refunded" record, exactly like appliedTokenPackPaymentIds is
  // pruned once a purchase's own marker commits.
  assert.deepEqual(record.refundedJobIds, []);

  var marker = await mockBlobsRead(entitlements.REFUNDED_JOBS_STORE_NAME, 'job_1');
  assert.equal(marker.status, 'committed');
  assert.equal(marker.amount, 100);
});

/** Direct read against the mock Blobs store, for asserting on the outer marker's own persisted shape. */
async function mockBlobsRead(storeName, key) {
  return require('@netlify/blobs').getStore({ name: storeName }).get(key, { type: 'json' });
}

test('a second sequential call for the SAME job id does not double-refund', async function () {
  await seedZeroBalance('refund2@example.com');
  await seedJobOwner('refund2@example.com', 'job_2');
  var first = await entitlements.refundTokensOnce({}, 'refund2@example.com', 'job_2', 100);
  var second = await entitlements.refundTokensOnce({}, 'refund2@example.com', 'job_2', 100);
  assert.equal(first.refunded, true);
  assert.equal(second.refunded, false, 'a resumed poll of an already-refunded job must report refunded:false, not refund again');

  var record = await entitlements.getEntitlement({}, 'refund2@example.com');
  assert.equal(record.tokens.balance, 100, 'balance must reflect exactly one refund, not two — this is the exact double-refund hazard the fix exists to close');
});

test('a DIFFERENT job id for the same email refunds again (dedup is per-job, not per-email)', async function () {
  await seedZeroBalance('refund3@example.com');
  await seedJobOwner('refund3@example.com', 'job_a');
  await seedJobOwner('refund3@example.com', 'job_b');
  await entitlements.refundTokensOnce({}, 'refund3@example.com', 'job_a', 100);
  await entitlements.refundTokensOnce({}, 'refund3@example.com', 'job_b', 10);
  var record = await entitlements.getEntitlement({}, 'refund3@example.com');
  assert.equal(record.tokens.balance, 110);
});

test('the image cost (10) and video cost (100) both refund correctly for their own job ids', async function () {
  await seedZeroBalance('refund4@example.com');
  await seedJobOwner('refund4@example.com', 'video-job');
  await entitlements.refundTokensOnce({}, 'refund4@example.com', 'video-job', 100);
  var afterVideo = await entitlements.getEntitlement({}, 'refund4@example.com');
  assert.equal(afterVideo.tokens.balance, 100);

  await seedJobOwner('refund4@example.com', 'image-job');
  await entitlements.refundTokensOnce({}, 'refund4@example.com', 'image-job', 10);
  var afterImage = await entitlements.getEntitlement({}, 'refund4@example.com');
  assert.equal(afterImage.tokens.balance, 110);
});

test('a missing/falsy job id skips the dedup guard (and the ownership check, which has nothing to check without a job id) entirely and always refunds (documented escape hatch, unreachable via the real HTTP status endpoints)', async function () {
  await seedZeroBalance('refund5@example.com');
  var first = await entitlements.refundTokensOnce({}, 'refund5@example.com', undefined, 100);
  var second = await entitlements.refundTokensOnce({}, 'refund5@example.com', undefined, 100);
  assert.equal(first.refunded, true);
  assert.equal(second.refunded, true, 'with no job id there is nothing to dedupe against, so both calls refund');

  var record = await entitlements.getEntitlement({}, 'refund5@example.com');
  assert.equal(record.tokens.balance, 200);
});

test('an empty/missing email is a safe no-op (never throws, never touches any balance)', async function () {
  var result = await entitlements.refundTokensOnce({}, '', 'job_x', 100);
  assert.deepEqual(result, { ok: false, refunded: false });
});

test('refundedJobIds (per-email) and appliedTokenPackPaymentIds (per-email) are kept as SEPARATE lists, and REFUNDED_JOBS_STORE_NAME / TOKEN_PURCHASES_STORE_NAME are kept as separate stores', async function () {
  var email = 'refund6@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'job_1');
  await entitlements.creditTokenPackOnce({}, email, 'pay_1', 500);
  await entitlements.refundTokensOnce({}, email, 'job_1', 100);

  var record = await entitlements.getEntitlement({}, email);
  // creditTokenPackOnce delegates to creditTokenPackAmountOnce, which
  // applies Token Economy C's one-time +50% first-purchase bonus for a
  // brand-new email: 500 * 1.5 = 750, then +100 for the refund = 850.
  assert.equal(record.tokens.balance, 850);
  // Both dedup lists are pruned to empty once each mechanism's own outer
  // marker commits -- neither ever contains the OTHER mechanism's id.
  assert.deepEqual(record.refundedJobIds, []);
  assert.deepEqual(record.appliedTokenPackPaymentIds, []);

  assert.notEqual(entitlements.REFUNDED_JOBS_STORE_NAME, entitlements.TOKEN_PURCHASES_STORE_NAME);
});

// ----- The real regression test: genuine concurrency, not sequential -----

test('two CONCURRENT calls for the SAME job id refund exactly once between them, not twice', async function () {
  var email = 'refundrace1@example.com';
  var jobId = 'job_race_1';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId);

  // Promise.all starts both calls before either awaits through to
  // completion, interleaving at each internal await point exactly the way
  // two near-simultaneous resumed polls of the same already-failed job
  // would (e.g. two tabs open on the same account, or a reload racing an
  // in-flight poll).
  var results = await Promise.all([
    entitlements.refundTokensOnce({}, email, jobId, 100),
    entitlements.refundTokensOnce({}, email, jobId, 100)
  ]);

  var refundedCount = results.filter(function (r) { return r.refunded; }).length;
  assert.equal(refundedCount, 1, 'exactly one of the two concurrent calls should report refunded:true');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'a genuinely concurrent double-poll must still only refund tokens once');
});

test('three CONCURRENT calls for the SAME job id still refund exactly once', async function () {
  var email = 'refundrace2@example.com';
  var jobId = 'job_race_2';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId);

  var results = await Promise.all([
    entitlements.refundTokensOnce({}, email, jobId, 100),
    entitlements.refundTokensOnce({}, email, jobId, 100),
    entitlements.refundTokensOnce({}, email, jobId, 100)
  ]);

  var refundedCount = results.filter(function (r) { return r.refunded; }).length;
  assert.equal(refundedCount, 1);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100);
});

test('concurrent races on DIFFERENT job ids for the same email both go through the dedup guard independently (both refunded:true)', async function () {
  var email = 'refundracediff@example.com';
  await seedZeroBalance(email);
  await seedJobOwner(email, 'job_diff_a');
  await seedJobOwner(email, 'job_diff_b');

  var results = await Promise.all([
    entitlements.refundTokensOnce({}, email, 'job_diff_a', 100),
    entitlements.refundTokensOnce({}, email, 'job_diff_b', 10)
  ]);

  assert.equal(results[0].refunded, true);
  assert.equal(results[1].refunded, true);
});

// ----- Interrupted-refund resume (mirrors entitlements-token-purchases.
// test.js's own "dodo-payment-webhook-marker-before-credi-kz94cx"
// coverage, adapted to refunds) -----

test('a marker left "pending" with the balance NOT yet applied (refundTokenAmountOnce never ran) resumes and completes the refund exactly once', async function () {
  var email = 'refundinterrupted1@example.com';
  var jobId = 'job_interrupted_1';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId);

  mockBlobs.seed(entitlements.REFUNDED_JOBS_STORE_NAME, jobId, {
    email: email,
    amount: 100,
    status: 'pending',
    claimId: 'stale-claim-from-interrupted-attempt',
    createdAt: Date.now() - 5000
  });

  var result = await entitlements.refundTokensOnce({}, email, jobId, 100);
  assert.equal(result.refunded, true, 'a resumed pending marker with no applied credit must complete the refund and report refunded:true');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'the balance must reflect exactly one refund');
});

test('a marker left "pending" where the balance was ALREADY applied (only the flip-to-committed write was interrupted) does not double-refund on resume', async function () {
  var email = 'refundinterrupted2@example.com';
  var jobId = 'job_interrupted_2';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId);

  // Simulates: an earlier attempt's refundTokenAmountOnce actually
  // succeeded (balance already bumped, jobId recorded in
  // refundedJobIds) but the marker never got flipped to 'committed'.
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 100, lastGrantAt: Date.now() },
    refundedJobIds: [jobId]
  });
  mockBlobs.seed(entitlements.REFUNDED_JOBS_STORE_NAME, jobId, {
    email: email,
    amount: 100,
    status: 'pending',
    claimId: 'stale-claim-from-interrupted-attempt-2',
    createdAt: Date.now() - 5000
  });

  var result = await entitlements.refundTokensOnce({}, email, jobId, 100);
  assert.equal(result.refunded, true, 'resuming a pending marker whose balance was already applied should still report refunded:true (finishing the interrupted work) -- not an error');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'the balance must NOT be refunded a second time -- this is the double-refund hazard the fix exists to close');
});

test('a marker already "committed" is a genuine redelivery and is never resumed (refunded:false, no change to balance)', async function () {
  var email = 'refundcommitted1@example.com';
  var jobId = 'job_committed_1';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId); // must pass the ownership check to actually reach the marker logic this test is about

  await entitlements.setEntitlement({}, email, { tokens: { balance: 100, lastGrantAt: Date.now() } });
  mockBlobs.seed(entitlements.REFUNDED_JOBS_STORE_NAME, jobId, {
    email: email,
    amount: 100,
    status: 'committed',
    claimId: 'old-claim',
    createdAt: Date.now() - 60000,
    creditedAt: Date.now() - 59000
  });

  var result = await entitlements.refundTokensOnce({}, email, jobId, 100);
  assert.equal(result.refunded, false, 'a committed marker means this job was already fully processed -- a redelivery/resumed poll must be a no-op');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'balance must be untouched by a redelivery of an already-committed refund');
});

test('refundTokenAmountOnce is idempotent per jobId when called directly twice', async function () {
  var email = 'refunddirectamount@example.com';
  var jobId = 'job_direct_amount';
  await seedZeroBalance(email);

  var first = await entitlements.refundTokenAmountOnce({}, email, jobId, 100);
  var second = await entitlements.refundTokenAmountOnce({}, email, jobId, 100);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true, 'a second call for the same jobId must still report ok:true (already applied) without crediting again');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'balance must reflect exactly one credit despite two calls');
  assert.deepEqual(record.refundedJobIds, [jobId], 'jobId should be recorded exactly once, not duplicated');
});

// ----- Balance-base correctness + exhaustion-must-throw -----

test("refundTokenAmountOnce bases the new balance on syncTokens' own returned value, not a stale independent re-read", async function () {
  // Same three-call sequence entitlements-token-purchases.test.js's own
  // equivalent test documents for creditTokenPackAmountOnce (identical
  // structure — syncTokens then retryingWrite, both against STORE_NAME):
  // call #1 is syncTokens' own getEntitlement (sees nothing, brand-new
  // email); call #2 is that same first-ever-read branch's internal
  // setEntitlement existing-read, persisting the signup grant; call #3 is
  // refundTokenAmountOnce's own retryingWrite `read()` for its first
  // attempt — the one this test actually targets, simulated as landing
  // BEFORE the signup grant's write (from call #2) has propagated to it.
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 3) {
      return { value: { email: key, tokens: { balance: 0, lastGrantAt: Date.now() - 100000 } } };
    }
    return null; // fall through to the real stored value for every other call
  });

  try {
    var result = await entitlements.refundTokenAmountOnce({}, 'refundstaleread@example.com', 'job_stale_read', 100);
    assert.equal(result.ok, true);

    var record = await entitlements.getEntitlement({}, 'refundstaleread@example.com');
    assert.equal(record.tokens.balance, 220 + 100, "balance must be 220 (Token Economy C's INITIAL_GRANT, from syncTokens' own in-memory return value) + 100 (this refund) — a buggy re-read-based implementation would compute 0 + 100 = 100 here, silently discarding the signup grant that had just landed");
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }
});

test('genuine exhaustion writing the initial pending marker (verify never confirms a winner) throws instead of silently returning refunded:false', async function () {
  var email = 'refundexhaustion1@example.com';
  var jobId = 'job_exhaustion_1';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId);

  mockBlobs.setReadOverride(entitlements.REFUNDED_JOBS_STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.refundTokensOnce({}, email, jobId, 100),
      /exhausted attempts writing the pending marker/,
      'genuine exhaustion writing the initial pending marker must throw, not silently return refunded:false with nothing durably recorded and no future retry'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.REFUNDED_JOBS_STORE_NAME);
  }
});

test("genuine exhaustion applying the balance credit (refundTokenAmountOnce's own retry loop) throws too", async function () {
  var email = 'refundexhaustion2@example.com';
  var jobId = 'job_exhaustion_2';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId);
  mockBlobs.seed(entitlements.REFUNDED_JOBS_STORE_NAME, jobId, {
    email: email, amount: 100, status: 'pending', claimId: 'stale', createdAt: Date.now() - 5000
  });

  mockBlobs.setReadOverride(entitlements.STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.refundTokensOnce({}, email, jobId, 100),
      /exhausted attempts refunding/,
      'genuine exhaustion applying the balance credit must throw too, not leave the marker pending forever with no way to resume'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }
});

test('genuine exhaustion flipping the marker to committed (bookkeeping-only failure, balance already landed) also throws', async function () {
  var email = 'refundexhaustion3@example.com';
  var jobId = 'job_exhaustion_3';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId);
  mockBlobs.seed(entitlements.REFUNDED_JOBS_STORE_NAME, jobId, {
    email: email, amount: 100, status: 'pending', claimId: 'stale', createdAt: Date.now() - 5000
  });

  // Let the very first read through (the outer marker lookup that
  // discovers the seeded 'pending' marker and lets the balance credit
  // proceed normally) -- every read after that belongs to the
  // flip-to-committed attempt itself, simulated as permanently stale.
  mockBlobs.setReadOverride(entitlements.REFUNDED_JOBS_STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) return null; // real value
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.refundTokensOnce({}, email, jobId, 100),
      /exhausted attempts flipping the marker/,
      'genuine exhaustion flipping the marker to committed must throw, not silently leave it pending forever'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.REFUNDED_JOBS_STORE_NAME);
  }

  // The balance credit itself must still be correct despite the flip
  // failing to confirm -- this specific failure mode is bookkeeping-only.
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100, 'the balance credit must still have landed even though the flip-to-committed write could not be confirmed');
});

// ============================================================================
// SECURITY: email/jobId ownership check (round-2 review finding)
// ----------------------------------------------------------------------------
// Direct regression coverage for the vulnerability described in this file's
// own header comment: video-status.js/image-status.js pass `email` and
// `jobId` straight from the request query string, unauthenticated. Without
// the ownership check, an attacker who merely knows/guesses a stranger's
// operationName could call refundTokensOnce with their OWN email and the
// VICTIM's jobId and steal that refund -- permanently, since the marker
// commits on first successful claim. These tests prove the fix actually
// blocks that, and that a legitimate, correctly-matched request still
// works.
// ============================================================================

test('SECURITY: an email that never submitted this jobId is refused a refund, even though the job genuinely failed and would otherwise be refund-eligible', async function () {
  var victimEmail = 'refundvictim@example.com';
  var attackerEmail = 'refundattacker@example.com';
  var jobId = 'job_victim_1';
  await seedZeroBalance(victimEmail);
  await seedZeroBalance(attackerEmail);
  // The real submission was made by the victim -- generate-video.js's own
  // recordJobOwnerBestEffort would have written exactly this at
  // submission time.
  await seedJobOwner(victimEmail, jobId);

  // The attacker's request claims the victim's jobId but their OWN email
  // -- exactly the GET /video-status?name=<victim's job>&email=<attacker's
  // email> attack described above.
  var attackResult = await entitlements.refundTokensOnce({}, attackerEmail, jobId, 100);
  assert.equal(attackResult.refunded, false, 'a mismatched email/jobId pair must never be refunded');

  var attackerRecord = await entitlements.getEntitlement({}, attackerEmail);
  assert.equal(attackerRecord.tokens.balance, 0, "the attacker's balance must be completely untouched");

  // Critically: the REAL owner must still be able to claim their own
  // refund afterward -- the attacker's rejected attempt must have left
  // zero side effects (no marker created/consumed) for the legitimate
  // owner's later, correctly-authenticated poll to trip over.
  var victimResult = await entitlements.refundTokensOnce({}, victimEmail, jobId, 100);
  assert.equal(victimResult.refunded, true, "the real owner's own refund must still succeed after an attacker's rejected attempt for the same jobId");

  var victimRecord = await entitlements.getEntitlement({}, victimEmail);
  assert.equal(victimRecord.tokens.balance, 100, 'the real owner must receive their own refund in full');
});

test('SECURITY: a jobId with NO recorded owner at all refuses to refund (fails closed) rather than trusting the caller-supplied email', async function () {
  var email = 'refundnoowner@example.com';
  var jobId = 'job_no_owner_record';
  await seedZeroBalance(email);
  // Deliberately no seedJobOwner call -- simulates a job that predates
  // this store, or whose recordJobOwner write failed at submission time.

  var result = await entitlements.refundTokensOnce({}, email, jobId, 100);
  assert.equal(result.refunded, false, 'no owner record must mean no refund -- the caller-supplied email is never trusted on its own');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 0, 'balance must be untouched when there is no owner record to verify against');
});

test('SECURITY: the ownership check runs BEFORE the outer marker is ever touched -- a rejected mismatched attempt leaves no marker behind', async function () {
  var victimEmail = 'refundvictim2@example.com';
  var attackerEmail = 'refundattacker2@example.com';
  var jobId = 'job_victim_2';
  await seedZeroBalance(victimEmail);
  await seedJobOwner(victimEmail, jobId);

  await entitlements.refundTokensOnce({}, attackerEmail, jobId, 100);

  var marker = await mockBlobsRead(entitlements.REFUNDED_JOBS_STORE_NAME, jobId);
  assert.equal(marker, undefined, "a rejected mismatched attempt must not create ANY marker for this jobId -- proves the check happens before the two-phase-marker logic, not just before the balance credit");
});

test('a correctly-matched email/jobId pair (the legitimate, common case) still refunds normally -- the ownership check is not overly strict', async function () {
  var email = 'reallegituser@example.com';
  var jobId = 'job_legit_1';
  await seedZeroBalance(email);
  await seedJobOwner(email, jobId);

  var result = await entitlements.refundTokensOnce({}, email, jobId, 100);
  assert.equal(result.refunded, true);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100);
});
