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
 * tested, instead of also having to account for the separate 320-token
 * first-ever-read signup grant syncTokens applies automatically to a
 * genuinely brand-new email. Same helper as entitlements-token-
 * purchases.test.js's/dodo-webhook.test.js's own seedZeroBalance.
 */
async function seedZeroBalance(email) {
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0, lastClaimAt: Date.now() } });
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
  // No bonus multiplier (retired 2026-08-02, "The Vault" shop redesign):
  // creditTokenPackOnce credits the plain 500, then +100 for the refund
  // = 600.
  assert.equal(record.tokens.balance, 600);
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
    tokens: { balance: 100, lastClaimAt: Date.now() },
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

  await entitlements.setEntitlement({}, email, { tokens: { balance: 100, lastClaimAt: Date.now() } });
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

// CAS REWRITE NOTE (mirrors entitlements-token-purchases.test.js's own
// identical note for creditTokenPackAmountOnce): refundTokenAmountOnce now
// goes through blobsCas.casWrite (lib/blobs-cas.js), whose reads are
// getWithMetadata() calls — a get()-based setReadOverride no longer
// intercepts anything on this path. Use setCasReadOverride instead, and
// prove the CAS invariant directly: a stale read's conditional write is
// atomically rejected, never silently committed.
test("a stale first CAS read (observing a pre-signup-grant snapshot with a non-current etag) is atomically REJECTED, not silently committed — the retry lands on the real balance", async function () {
  // Seed the record directly (bypassing syncTokens' own init branch
  // entirely) so this test targets ONLY refundTokenAmountOnce's own
  // casWrite loop.
  await entitlements.setEntitlement({}, 'refundstaleread@example.com', { tokens: { balance: 320, lastClaimAt: Date.now() - 100000 } });

  mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) {
      return { value: { data: { email: key, tokens: { balance: 0, lastClaimAt: Date.now() - 100000 } }, etag: 'stale-etag-will-never-match', metadata: {} } };
    }
    return null; // fall through to the real current state
  });

  try {
    var result = await entitlements.refundTokenAmountOnce({}, 'refundstaleread@example.com', 'job_stale_read', 100);
    assert.equal(result.ok, true, 'the retry must still succeed once a fresher attempt reads the real state');

    var record = await entitlements.getEntitlement({}, 'refundstaleread@example.com');
    assert.equal(record.tokens.balance, 320 + 100, 'balance must be 320 (the REAL pre-existing balance) + 100 (this refund) — attempt 1\'s stale-based write (0 + 100 = 100) must have been atomically rejected, never persisted');
  } finally {
    mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
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

  // Every CAS read against the entitlement record comes back with an etag
  // that can never match the real current one, so every attempt's
  // conditional write is atomically rejected — genuine exhaustion, not a
  // write that actually landed but went unobserved.
  mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key) {
    return { value: { data: { email: key, tokens: { balance: 0 } }, etag: 'stale-etag-will-never-match', metadata: {} } };
  });

  try {
    await assert.rejects(
      entitlements.refundTokensOnce({}, email, jobId, 100),
      /exhausted attempts refunding/,
      'genuine exhaustion applying the balance credit must throw too, not leave the marker pending forever with no way to resume'
    );
  } finally {
    mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
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

// ----- Cross-function concurrency: a genuinely concurrent claimDailyTokens
// write on the SAME email must survive refundTokenAmountOnce's own retry
// loop, not get reverted (tracker item
// entitlements-js-retryingwrite-balance-mu-qxm1ih) -----
//
// This is a DIFFERENT bug class than this file's own double-refund
// concurrency tests above (two calls racing for the SAME jobId). This one
// is about a SINGLE refund racing a COMPLETELY UNRELATED write to the same
// email's record (a daily claim) — refundTokenAmountOnce used to capture
// `syncedTokens` ONCE, before its own retryingWrite loop, then reuse that
// one snapshot's balance/lastClaimAt/streak verbatim on EVERY retry
// attempt, instead of re-deriving from that attempt's own fresh read the
// way its refundedJobIds field already correctly did. blobs-retry.js's own
// header comment documents a second/third attempt as a NORMAL, expected
// occurrence (propagation lag), not a rare edge case — so a real
// claimDailyTokens write landing on this SAME email's record between this
// call's outer syncTokens read and a later retry attempt's successful
// write could have its fresher lastClaimAt/streak/balance silently
// reverted by the stale snapshot plus this function's own delta on top. A
// SEQUENTIAL test (await one call, then the other) can never catch this:
// by the time the second call's own syncTokens runs, the first is long
// done and already visible, so old and fixed code compute the identical
// result either way.
//
// Same technique as entitlements-achievements.test.js's/entitlements-
// token-purchases.test.js's own equivalent tests: Promise.all fires a
// REAL, genuinely concurrent claimDailyTokens call racing refundTokensOnce
// on the SAME email, with a mockBlobs read override that intercepts
// refundTokenAmountOnce's own OUTER `syncTokens()` read specifically
// (identified via the call stack, so claimDailyTokens' own reads/writes
// against the same store are never touched) and forces it to see the
// PRE-claim, PRE-refund state — exactly mimicking real Blobs propagation
// lag deterministically instead of leaving it to chance timing. Everything
// after that one forced read (the retryingWrite loop's own read/write/
// verify) sees REAL data, including whatever the genuinely concurrent
// claim has by then actually written. A plain Promise.all of these two
// specific calls with NO forcing at all does not reliably reach this code
// path (confirmed during this fix's own development): refundTokensOnce's
// ownership-check + outer two-phase-marker phases run BEFORE
// refundTokenAmountOnce's own syncTokens call, giving the concurrent claim
// enough of a head start that syncTokens' own read usually already sees
// it — the override above is what makes this reliable rather than
// occasional. FAILS against the pre-fix code, which always built its new
// `tokens` off that one forced-stale `syncedTokens` snapshot regardless of
// how fresh the retryingWrite loop's own read was (the concurrent claim's
// lastClaimAt/streak get silently reverted, and its +20 balance is lost);
// PASSES against the fix, which prefers that attempt's own fresh read
// instead (see baseTokensForAttempt's own doc comment for the exact rule).

test("a genuinely concurrent claimDailyTokens write is NOT reverted by refundTokenAmountOnce's own retry loop (real concurrency, not sequential awaits)", async function () {
  var email = 'refundraceclaim@example.com';
  var jobId = 'job_race_claim';
  var pastCooldown = Date.now() - (entitlements.CLAIM_COOLDOWN_MS + 60000);
  await entitlements.setEntitlement({}, email, { tokens: { balance: 100, lastClaimAt: pastCooldown, streak: 3 }, firstClaimAt: pastCooldown - 1000 });
  await seedJobOwner(email, jobId);

  var forcedOnce = false;
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key) {
    if (forcedOnce) return null;
    // The FIRST STORE_NAME read whose call stack passes through
    // refundTokenAmountOnce is its own outer `syncTokens()` call -- this
    // deliberately targets THAT read, leaving the retryingWrite loop's own
    // read/verify further down untouched (return null falls through to
    // real data).
    if (new Error().stack.indexOf('refundTokenAmountOnce') !== -1) {
      forcedOnce = true;
      return { value: { email: key, tokens: { balance: 100, lastClaimAt: pastCooldown, streak: 3 } } };
    }
    return null;
  });

  var results;
  try {
    results = await Promise.all([
      entitlements.refundTokensOnce({}, email, jobId, 50),
      entitlements.claimDailyTokens({}, email)
    ]);
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }

  assert.equal(results[0].refunded, true, 'the refund must still succeed despite needing a real retry');
  assert.equal(results[1].claimed, true, 'the concurrent claim must still succeed too');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100 + entitlements.DAILY_CLAIM_AMOUNT + 50, 'both the claim (+20) and the refund (+50) must land -- the bug this fix closes would silently discard the claim, leaving only 100 + 50 = 150');
  assert.notEqual(record.tokens.lastClaimAt, pastCooldown, "the concurrent claim's fresh lastClaimAt must survive -- the bug this fix closes would silently revert it back to the pre-claim value");
  assert.equal(record.tokens.streak, 4, "the concurrent claim's bumped streak (3 -> 4) must survive, not get reverted back to 3");
});

// ----- forgetRefundedJobId racing a CAS'd writer for the SAME email: the
// housekeeping cleanup must never revert a concurrent credit (independent
// review finding on the CAS migration itself, fixed here) -----
//
// Mirrors entitlements-token-purchases.test.js's own equivalent
// forgetAppliedTokenPack test exactly -- see that test's own doc comment
// for the full mechanism and why both a read override (covering the
// pre-fix plain `.get()` shape AND the post-fix CAS `.getWithMetadata()`
// shape) and a `delay(0)` before starting forgetRefundedJobId are both
// needed to make this reliable rather than occasional. Before this fix,
// forgetRefundedJobId called setEntitlement -- a PLAIN, UNCONDITIONAL
// read -> merge -> write, no etag, no CAS -- to prune a committed jobId
// out of refundedJobIds; a concurrent CAS'd writer to the SAME email's
// record (claimDailyTokens here) landing in the narrow window between
// setEntitlement's own internal read and its own internal write had its
// credit silently erased the same way forgetAppliedTokenPack's did.
//
// FAILS against the pre-fix code (confirmed directly against a stashed
// copy of the pre-fix function during this fix's own development); PASSES
// against the fix (forgetRefundedJobId's own first CAS attempt's
// conditional write is atomically REJECTED once the real etag has moved
// on, and blobsCas.casWrite's own loop retries with a fresh read).

function delayTick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

test("forgetRefundedJobId's housekeeping cleanup does NOT revert a concurrent claimDailyTokens credit (real Promise.all concurrency, forced-stale first read simulating eventual-consistency lag)", async function () {
  for (var i = 0; i < 5; i++) {
    mockBlobs.reset();
    var email = 'forget-refund-race-claim-' + i + '@example.com';
    var pastCooldown = Date.now() - (entitlements.CLAIM_COOLDOWN_MS + 60000);
    var seedRecord = {
      tokens: { balance: 50, lastClaimAt: pastCooldown, streak: 3 },
      firstClaimAt: pastCooldown - 1000,
      refundedJobIds: ['job_old']
    };
    await entitlements.setEntitlement({}, email, seedRecord);
    // The genuinely stale pre-claim snapshot forgetRefundedJobId's own
    // reads will be forced to see -- captured now, before either call
    // below starts. Both call shapes are captured, since which one the
    // current code actually calls is exactly what this test is agnostic
    // to by design (see entitlements-token-purchases.test.js's own
    // equivalent test for the full reasoning).
    var stalePlain = await require('@netlify/blobs').getStore({ name: entitlements.STORE_NAME }).get(email, { type: 'json' });
    var staleCas = await require('@netlify/blobs').getStore({ name: entitlements.STORE_NAME }).getWithMetadata(email, { type: 'json' });

    mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key) {
      if (new Error().stack.indexOf('forgetRefundedJobId') !== -1) return { value: stalePlain };
      return null;
    });
    var forcedCasOnce = false;
    mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key) {
      if (!forcedCasOnce && new Error().stack.indexOf('forgetRefundedJobId') !== -1) {
        forcedCasOnce = true;
        return { value: staleCas };
      }
      return null;
    });

    var claimPromise = entitlements.claimDailyTokens({}, email);
    var forgetPromise = delayTick().then(function () {
      return entitlements.forgetRefundedJobId({}, email, 'job_old');
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
    assert.equal(record.tokens.balance, 50 + claim.amountClaimed, 'trial ' + i + ": the claim's credit must survive forgetRefundedJobId's housekeeping write -- the bug this fix closes would silently revert it back to 50");
    assert.notEqual(record.tokens.lastClaimAt, pastCooldown, 'trial ' + i + ": the claim's fresh lastClaimAt must survive too, not just its balance delta");
    assert.deepEqual(record.refundedJobIds, [], 'trial ' + i + ': the housekeeping prune must still land once the stale attempt is rejected and retried with a fresh read');
  }
});
