// test/entitlements-daily-claim.test.js
//
// Dedicated unit coverage for lib/entitlements.js's claimDailyTokens — the
// daily token claim (2026-07-28, founder-approved, tracker item
// for-product-build-the-daily-token-claim--fngrwd), replacing the old
// lazy background +20/24h drip. See that function's own doc comment for
// the full mechanism this file exercises:
//   - claimable immediately for a record with no lastClaimAt at all
//     (brand-new OR pre-existing/legacy)
//   - a ROLLING 20h cooldown measured off the server clock only (no
//     calendar-day comparison anywhere)
//   - streak: +1 on a gap under 48h since the last claim, reset to 1 on a
//     longer gap or a genuinely first-ever claim
//   - the balance/lastClaimAt/streak write lands in ONE call
//   - the documented `{claimed:false, nextClaimAt}` "not yet" response
//     shape, and the `{claimed:true, balance, streak, nextClaimAt}"
//     success shape

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');

var HOUR_MS = 60 * 60 * 1000;

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.11.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

test('claimDailyTokens on a brand-new email claims immediately: +100 first-claim bonus balance, streak 1, nextClaimAt ~20h out', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'brandnewclaim@example.com'); // materializes the 220-token record
  var before = Date.now();
  var result = await entitlements.claimDailyTokens(ev, 'brandnewclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 320, '220 + 100 (2026-07-28 first-claim-bonus amendment: the account\'s first-ever claim grants 100, not 20)');
  assert.equal(result.amountClaimed, 100, 'amountClaimed reflects the real bonus amount actually credited');
  assert.equal(result.streak, 1, 'first-ever claim always starts the streak at 1');
  assert.ok(result.nextClaimAt >= before + entitlements.CLAIM_COOLDOWN_MS - 1000, 'nextClaimAt ~= now + the cooldown');
});

test('claimDailyTokens works even when getTokenStatus/syncTokens was never called first -- a genuinely fresh email can claim directly, still getting the first-claim bonus', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var result = await entitlements.claimDailyTokens(ev, 'directclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 320, '220 signup grant (materialized lazily inside claimDailyTokens itself) + 100 first-ever-claim bonus');
  assert.equal(result.amountClaimed, 100);
});

test('a pre-existing record with no tokens.lastClaimAt at all (predates this feature) is claimable immediately and still gets the first-claim bonus (it has never actually claimed before)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'legacyclaim@example.com', { tokens: { balance: 40 } });
  var result = await entitlements.claimDailyTokens(ev, 'legacyclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 140, '40 + 100 -- a legacy account that never actually completed a claim before is a genuine first-ever claim');
  assert.equal(result.amountClaimed, 100);
  assert.equal(result.streak, 1);
});

test('claiming twice in a row -- the second claim is rejected as not-yet-claimable, with the SAME shape the spec requires', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'twice@example.com');
  var first = await entitlements.claimDailyTokens(ev, 'twice@example.com');
  assert.equal(first.claimed, true);

  var second = await entitlements.claimDailyTokens(ev, 'twice@example.com');
  assert.deepEqual(Object.keys(second).sort(), ['claimed', 'nextClaimAt'], 'the "not yet" response is exactly {claimed, nextClaimAt} per spec -- no error fields');
  assert.equal(second.claimed, false);
  assert.equal(second.nextClaimAt, first.nextClaimAt, 'nextClaimAt does not move just from a rejected attempt');

  var record = await entitlements.getEntitlement(ev, 'twice@example.com');
  assert.equal(record.tokens.balance, 320, 'balance must NOT have moved on the rejected second attempt (220 + 100 first-claim bonus from the first, successful claim)');
});

// ----- 2026-07-28 first-claim-bonus amendment (founder-approved economy
// amendment, tracker item for-product-daily-claim-bugs-founder-rea-kei2ub):
// the account's FIRST-EVER claim grants FIRST_CLAIM_BONUS_AMOUNT (100),
// every subsequent claim grants the normal DAILY_CLAIM_AMOUNT (20). See
// FIRST_CLAIM_BONUS_AMOUNT's own doc comment for why this is a
// claim-count/firstClaimAt rule, deliberately NOT streak-based. -----

test('a brand-new account\'s very first claim grants exactly 100 and stamps a top-level firstClaimAt', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'firstclaimbonus@example.com';
  await entitlements.getTokenStatus(ev, email); // -> 220, no lastClaimAt/firstClaimAt yet

  var before = Date.now();
  var result = await entitlements.claimDailyTokens(ev, email);
  assert.equal(result.claimed, true);
  assert.equal(result.amountClaimed, 100);
  assert.equal(result.balance, 320);

  var record = await entitlements.getEntitlement(ev, email);
  assert.ok(record.firstClaimAt, 'firstClaimAt must be stamped on the actual first successful claim');
  assert.ok(record.firstClaimAt >= before, 'firstClaimAt is a real timestamp from this claim, not a leftover/undefined value');
});

test('that same account\'s SECOND claim (after the cooldown) grants the normal 20, and firstClaimAt is never overwritten', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'secondclaimnormal@example.com';
  await entitlements.getTokenStatus(ev, email); // -> 220

  var first = await entitlements.claimDailyTokens(ev, email);
  assert.equal(first.amountClaimed, 100);
  var recordAfterFirst = await entitlements.getEntitlement(ev, email);
  var stampedFirstClaimAt = recordAfterFirst.firstClaimAt;
  assert.ok(stampedFirstClaimAt);

  // Roll the cooldown back so the second claim is actually claimable.
  await entitlements.setEntitlement(ev, email, {
    tokens: Object.assign({}, recordAfterFirst.tokens, { lastClaimAt: recordAfterFirst.tokens.lastClaimAt - (21 * HOUR_MS) })
  });

  var second = await entitlements.claimDailyTokens(ev, email);
  assert.equal(second.claimed, true);
  assert.equal(second.amountClaimed, 20, 'the second-ever claim must grant the normal amount, not another 100 bonus');
  assert.equal(second.balance, 320 + 20);

  var recordAfterSecond = await entitlements.getEntitlement(ev, email);
  assert.equal(recordAfterSecond.firstClaimAt, stampedFirstClaimAt, 'firstClaimAt must never be overwritten once stamped');
});

test('two CONCURRENT first-ever claims for the SAME email cannot both land the 100-token bonus -- exactly one credit, never two', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'firstclaimrace@example.com';
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 0 } }); // no lastClaimAt -- a genuine first-ever claim race

  var results = await Promise.all([
    entitlements.claimDailyTokens(ev, email),
    entitlements.claimDailyTokens(ev, email)
  ]);

  var claimed = results.filter(function (r) { return r.claimed; });
  assert.equal(claimed.length, 1, 'exactly one of the two concurrent first-ever claims should report claimed:true');
  assert.equal(claimed[0].amountClaimed, 100, 'the one winner gets the first-claim bonus, not a smaller/larger amount');

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 100, 'only ONE 100-token bonus must land, never two (200) and never zero');
  assert.ok(record.firstClaimAt, 'firstClaimAt must be stamped exactly once by whichever attempt actually won');
});

// ----- Rolling 20h cooldown -- server clock only, no calendar days -----

test('exactly at the 20h boundary is claimable (>=, not >)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'boundary@example.com', {
    tokens: { balance: 100, lastClaimAt: Date.now() - entitlements.CLAIM_COOLDOWN_MS, streak: 3 }
  });
  var result = await entitlements.claimDailyTokens(ev, 'boundary@example.com');
  assert.equal(result.claimed, true);
});

test('19h59m since the last claim -- still not claimable, even though this could cross a calendar-day boundary', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'notyet@example.com', {
    tokens: { balance: 100, lastClaimAt: Date.now() - (entitlements.CLAIM_COOLDOWN_MS - 60000), streak: 2 }
  });
  var result = await entitlements.claimDailyTokens(ev, 'notyet@example.com');
  assert.equal(result.claimed, false);

  var record = await entitlements.getEntitlement(ev, 'notyet@example.com');
  assert.equal(record.tokens.balance, 100, 'nothing credited');
  assert.equal(record.tokens.streak, 2, 'streak untouched by a rejected attempt');
});

test('a claim made just before local midnight and another just after (crossing a calendar day, but well under 20h apart) is correctly rejected -- proves this is a ROLLING clock check, not a calendar-day one', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  // Simulates "claimed at 11:58pm" by setting lastClaimAt 10 minutes ago,
  // regardless of what the real wall-clock date happens to be when this
  // test runs -- the whole point is that entitlements.js never looks at
  // calendar dates/timezones anywhere, only at raw elapsed milliseconds.
  await entitlements.setEntitlement(ev, 'midnightcross@example.com', {
    tokens: { balance: 100, lastClaimAt: Date.now() - (10 * 60 * 1000), streak: 5 }
  });
  var result = await entitlements.claimDailyTokens(ev, 'midnightcross@example.com');
  assert.equal(result.claimed, false, 'only 10 minutes elapsed -- a calendar-day-based check would have wrongly allowed this the instant the date rolled over');
});

// ----- Streak -----

test('streak increments when the gap since the last claim is under 48h', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'streakup@example.com', {
    tokens: { balance: 100, lastClaimAt: Date.now() - (30 * HOUR_MS), streak: 4 } // 30h gap: past the 20h cooldown, under the 48h continuity window
  });
  var result = await entitlements.claimDailyTokens(ev, 'streakup@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.streak, 5);
});

test('streak resets to 1 when the gap since the last claim is 48h or more', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'streakreset@example.com', {
    tokens: { balance: 100, lastClaimAt: Date.now() - (49 * HOUR_MS), streak: 12 }
  });
  var result = await entitlements.claimDailyTokens(ev, 'streakreset@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.streak, 1, 'a real missed day forfeits the streak entirely, per the founder\'s own core decision');
});

test('streak resets to 1 exactly at the 48h continuity boundary (>= 48h resets, matching the entitlements.js doc comment)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'streakexact48@example.com', {
    tokens: { balance: 100, lastClaimAt: Date.now() - entitlements.STREAK_CONTINUITY_MS, streak: 7 }
  });
  var result = await entitlements.claimDailyTokens(ev, 'streakexact48@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.streak, 1);
});

test('a genuinely first-ever claim always starts at streak 1, never derives a bogus streak from a zero/undefined gap', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  // No lastClaimAt at all -- the streak math must not mistake "no previous
  // claim" for "gap of 0ms, therefore continue the streak".
  await entitlements.setEntitlement(ev, 'firstclaimever@example.com', { tokens: { balance: 0, streak: 99 } });
  var result = await entitlements.claimDailyTokens(ev, 'firstclaimever@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.streak, 1, 'a stray pre-set streak field on a never-claimed record must not leak through');
});

// ----- Single atomic write -----
//
// claimDailyTokens' implementation makes exactly ONE `setEntitlement` call
// on a successful claim (see its own doc comment for why: unlike
// creditTokenPackOnce's Dodo-webhook two-phase marker, this has no
// separate marker/status field at all -- balance, lastClaimAt, and streak
// are computed together and handed to a single setEntitlement patch,
// which itself performs exactly one Blobs setJSON call). The clean,
// black-box-observable proof of that (this test harness's in-memory Blobs
// mock has no write-interception hook to count calls directly -- see
// test/helpers/mock-blobs.js) is that the persisted `tokens` sub-object
// contains EXACTLY balance/lastClaimAt/streak and nothing else -- no
// leftover 'pending'/'status'/marker-id field of the kind a two-phase
// write would need and this mechanism deliberately doesn't have.

test('a successful claim writes balance/lastClaimAt/streak together, with no separate marker/status field (proving this is a single, direct write, not a two-phase marker)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'atomicity@example.com', { tokens: { balance: 5 } });

  var result = await entitlements.claimDailyTokens(ev, 'atomicity@example.com');
  assert.equal(result.claimed, true);

  var record = await entitlements.getEntitlement(ev, 'atomicity@example.com');
  assert.equal(record.tokens.balance, 105, '5 + 100 first-ever-claim bonus');
  assert.equal(record.tokens.streak, 1);
  assert.ok(record.tokens.lastClaimAt);
  assert.deepEqual(Object.keys(record.tokens).sort(), ['balance', 'lastClaimAt', 'streak'], 'exactly these three fields -- no pending/status/marker leftover from a multi-step write');
});

// ----- Empty/missing email -----

test('empty/missing email is a safe no-op, matching the documented { claimed:false, nextClaimAt:0 } shape', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var result1 = await entitlements.claimDailyTokens(ev, '');
  var result2 = await entitlements.claimDailyTokens(ev, null);
  assert.deepEqual(result1, { claimed: false, nextClaimAt: 0 });
  assert.deepEqual(result2, { claimed: false, nextClaimAt: 0 });
});

// ----- Multi-day claim streak simulation -----

test('claiming daily just under 48h apart, three days running, keeps incrementing the streak', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'multiday@example.com'); // -> 220

  var day1 = await entitlements.claimDailyTokens(ev, 'multiday@example.com');
  assert.equal(day1.streak, 1);
  assert.equal(day1.balance, 320, '220 + 100 first-ever-claim bonus');

  // Simulate "the next day" by rolling lastClaimAt back 21h (past the 20h
  // cooldown, well under the 48h streak window).
  var rec1 = await entitlements.getEntitlement(ev, 'multiday@example.com');
  await entitlements.setEntitlement(ev, 'multiday@example.com', {
    tokens: Object.assign({}, rec1.tokens, { lastClaimAt: rec1.tokens.lastClaimAt - (21 * HOUR_MS) })
  });
  var day2 = await entitlements.claimDailyTokens(ev, 'multiday@example.com');
  assert.equal(day2.streak, 2);

  var rec2 = await entitlements.getEntitlement(ev, 'multiday@example.com');
  await entitlements.setEntitlement(ev, 'multiday@example.com', {
    tokens: Object.assign({}, rec2.tokens, { lastClaimAt: rec2.tokens.lastClaimAt - (21 * HOUR_MS) })
  });
  var day3 = await entitlements.claimDailyTokens(ev, 'multiday@example.com');
  assert.equal(day3.streak, 3);
  assert.equal(day3.balance, 220 + 100 + 20 * 2, 'day1 gets the 100 first-claim bonus, day2/day3 get the normal 20 each');
});

// ----- Round 1 review findings: record-shape safety + real concurrency -----

test('firstPackPurchaseAt (a top-level record field, not nested in tokens) survives a claim -- the tokens-key full-replace inside claimDailyTokens must not clobber it', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'claimafterpurchase@example.com';
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 10 }, firstPackPurchaseAt: 1700000000000 });

  var result = await entitlements.claimDailyTokens(ev, email);
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 110, '10 + 100 -- a genuine first-ever CLAIM (independent of any past token-pack purchase)');

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.firstPackPurchaseAt, 1700000000000, 'a claim must never touch fields outside tokens.{balance,lastClaimAt,streak} plus the top-level firstClaimAt marker');
});

test('two CONCURRENT claimDailyTokens calls for the SAME email land exactly one credit between them, not two', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'claimracer@example.com';
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 0 } });

  // Both calls start before either awaits through to completion --
  // Promise.all invokes both synchronously, interleaving at each internal
  // await point exactly the way two open tabs (or a retried client
  // request) racing the claim button would. A bare read-then-write
  // (the pre-fix implementation) lets both calls observe "claimable" off
  // the same stale read before either writes, so both compute
  // balance+20 from the SAME base -- the second write overwrites the
  // first, and only one +20 actually lands even though the caller saw
  // TWO { claimed: true } responses. This test fails against that
  // implementation (only one claimed:true, but re-claiming immediately
  // after would wrongly succeed again since the loser's write silently
  // reset the cooldown) and passes against the real blobsRetry-guarded
  // one (the loser gets an honest { claimed: false }, and the balance
  // reflects exactly one credit).
  var results = await Promise.all([
    entitlements.claimDailyTokens(ev, email),
    entitlements.claimDailyTokens(ev, email)
  ]);

  var claimedCount = results.filter(function (r) { return r.claimed; }).length;
  assert.equal(claimedCount, 1, 'exactly one of the two concurrent claims should report claimed:true');

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 100, 'a genuinely concurrent double-claim attempt must still only credit tokens once -- this is a first-ever claim race, so exactly one 100-token bonus, never two (200) or zero');
  assert.equal(record.tokens.streak, 1);
});

test('three CONCURRENT claimDailyTokens calls for the SAME email still land exactly one credit', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'claimracer3@example.com';
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 0 } });

  var results = await Promise.all([
    entitlements.claimDailyTokens(ev, email),
    entitlements.claimDailyTokens(ev, email),
    entitlements.claimDailyTokens(ev, email)
  ]);

  var claimedCount = results.filter(function (r) { return r.claimed; }).length;
  assert.equal(claimedCount, 1, 'exactly one of the three concurrent claims should report claimed:true');

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 100, 'a first-ever claim race -- exactly one 100-token bonus lands, never more');
});

// Round-5 review finding: a SINGLE claimDailyTokens call's own SKIP branch
// could misreport a genuinely successful claim as claimed:false. Sequence:
// attempt 1 writes the credit, but its own verify-read lags behind the
// write (real Blobs eventual consistency -- see blobs-retry.js's own
// header comment); the loop moves to attempt 2, whose fresh `read()` now
// DOES see attempt 1's already-committed write, so `mutate` sees
// `now - lastClaimAt < CLAIM_COOLDOWN_MS` and returns SKIP -- indistinguishable,
// without the attemptId check added below, from "someone else already
// claimed". Mirrors this file's own header-comment reasoning
// (entitlements.js lines ~533-553) and the exhaustion branch's existing
// finalRead.lastClaimAttemptId check -- this closes the same gap one step
// earlier, in the SKIP branch, which is actually the more likely path to
// hit this exact self-clobber (it returns on the very next attempt, not
// only after every attempt is exhausted).
test('a single claim call whose OWN verify-read lags, then loops into a fresh read that sees its own just-committed write, still reports claimed:true (not a false claimed:false self-clobber)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'selflag@example.com';
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 0, lastClaimAt: Date.now() - (25 * HOUR_MS) } });

  // Call #1 against this store is syncTokens' own getEntitlement (record
  // already has tokens, so no seeding write follows). Call #2 is
  // retryingWrite's attempt-1 read() (genuinely sees the not-yet-claimed
  // record). Call #3 is attempt-1's own verify-read, right after its
  // setJSON -- simulate it NOT seeing that just-committed write yet
  // (`{value: undefined}`), forcing a loop to attempt 2. Every other call
  // (attempt-2's read, its own verify) falls through to the real stored
  // value, which by then genuinely contains attempt-1's committed write.
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 3) return { value: undefined };
    return null;
  });

  try {
    var result = await entitlements.claimDailyTokens(ev, email);
    assert.equal(result.claimed, true, 'the claim genuinely landed on attempt 1 -- a self-clobbering SKIP on attempt 2 must not report this as claimed:false');
    assert.equal(result.balance, 20);
    assert.equal(result.streak, 1);
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 20, 'exactly one credit must have landed, not zero and not two');
});

// BUG 2 (tracker item for-product-daily-claim-bugs-founder-rea-kei2ub,
// 2026-07-28): a real, genuinely eligible user tapped Claim and got
// "Couldn't claim right now -- try again in a moment". Root cause:
// blobs-retry.js's retryingWrite used to fire all `maxAttempts` (3 for
// this call site) back-to-back with ZERO elapsed real time between them,
// against a store this codebase's own docs (entitlements.js's header
// comment) say can lag up to ~60s under real eventual consistency. Three
// attempts within the same handful of milliseconds gives that lag no
// real window to resolve, so a verify-read (or even a plain read()) can
// plausibly keep missing an already-committed write on every single
// attempt -- exhausting the loop and throwing, even though the claim
// itself would have genuinely succeeded if only the next attempt had
// waited a little.
//
// This test simulates exactly that: EVERY read against this store (both
// the loop's own read() and its verify-read) is intercepted to keep
// returning the OLD, pre-claim snapshot -- "this read hasn't picked up
// the just-written update yet, it's still returning whatever was already
// converged before" -- for a fixed real-time LAG_MS window since the
// test started, then falls through to the real, already-committed data
// once that window has elapsed. This models propagation lag as a
// function of genuine wall-clock time, the one thing a synchronous
// in-memory mock can't otherwise reproduce (nothing here behaves
// differently just because more *attempts* happened -- only real elapsed
// time resolves it). With the OLD zero-delay behavior, all 3 attempts
// (plus the final catch-up read) fire within milliseconds -- nowhere
// near enough real time to clear LAG_MS -- so every one of them keeps
// seeing the stale pre-claim snapshot and the claim throws. With the
// fix's real inter-attempt delay, by the 3rd attempt enough wall-clock
// time has genuinely passed for a fresh read to see the already-
// committed write (recognized as this call's own attemptId, so it
// reports claimed:true via the existing self-clobber/SKIP handling —
// see claimDailyTokens' own doc comment) -- succeeding where the
// zero-delay version would have exhausted.
// Tracker item for-product-bug-founder-repro-high-brand-1dtzdc (founder
// repro, 2026-08-01): a brand-new account's very first daily-claim attempt,
// fired seconds after signup (home.html's auto-open-right-after-signup
// flow), silently lost its 220-token signup grant. Root cause: unlike
// creditTokenPackAmountOnce/refundTokenAmountOnce/applyAchievementGrantOnce
// (all fixed 2026-07-29, tracker item entitlements-js-retryingwrite-
// balance-mu-qxm1ih, via baseTokensForAttempt/syncedTokens -- see that
// helper's own doc comment), claimDailyTokens discarded syncTokens' return
// value entirely and let its retryingWrite `mutate` read balance straight
// off `rec.tokens` on EVERY attempt, including attempt 0. For a genuinely
// brand-new email, syncTokens' own first-ever-read branch JUST wrote the
// 220-token seed moments earlier in this SAME call -- and Netlify Blobs has
// no read-your-own-write guarantee (this file's own header comment, and
// syncTokens' `justSeeded` doc comment, both document this exact hazard).
// So attempt 0's fresh read can legitimately still show the pre-seed
// (null/no-tokens) record, and the claim gets computed off a phantom
// balance of 0 instead of the real 220 -- silently discarding the signup
// grant the instant this account's first-ever claim lands, even though the
// claim itself reports `claimed:true` (no error, no visible failure -- the
// balance is just quietly wrong).
test('a claim on a JUST-SEEDED brand-new account, whose own retry loop does not yet see syncTokens\' own seeding write (Netlify Blobs read-your-own-write hazard), still credits off the REAL seeded balance -- must not silently drop the 220-token signup grant', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'freshaccountrace@example.com';

  // No prior setEntitlement/getTokenStatus call -- this IS syncTokens'
  // first-ever-read branch, run from inside claimDailyTokens itself,
  // exactly like home.html's auto-open claim firing before (or racing) any
  // separate get-token-status.js read has propagated.
  var testStart = Date.now();
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    // callIndex 1 is syncTokens' own pre-seed getEntitlement read -- the
    // record genuinely doesn't exist yet, so falling through to the real
    // (empty) map is correct and not part of the hazard being simulated.
    if (callIndex === 1) return null;
    // Everything from callIndex 2 onward (the retryingWrite loop's own
    // read() and every verify-read) simulates NOT seeing syncTokens' own
    // just-committed seed write yet, for a short real-time window -- the
    // read-your-own-write gap this test targets. Falls through to the real
    // (by-then-genuinely-committed) value once the window passes, so the
    // claim can still eventually succeed rather than hanging forever.
    if (Date.now() - testStart < 50) return { value: undefined };
    return null;
  });

  try {
    var result = await entitlements.claimDailyTokens(ev, email);
    assert.equal(result.claimed, true, 'the claim should still succeed once the retry loop catches up');
    assert.equal(result.amountClaimed, 100, 'first-ever claim bonus');
    assert.equal(result.balance, 320, '220 (signup grant, already seeded moments earlier in this same call) + 100 (first-ever-claim bonus) -- must NOT silently drop the signup grant just because attempt 0\'s own read raced its own seeding write');
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 320, 'the persisted record must reflect the real seeded balance too, not just this call\'s return value');
});

test('a read() (and its verify-read) that keeps returning the stale pre-claim snapshot for a real ~250ms propagation-lag window still lands the claim once the fix\'s inter-attempt delay gives it enough real time -- proving the delay does something a synchronous mock can\'t fake by attempt count alone', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'propagationlag@example.com';
  // 25h ago -- comfortably past the 20h cooldown, so this is genuinely
  // claimable regardless of how any individual read is intercepted below.
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 100, lastClaimAt: Date.now() - (25 * HOUR_MS), streak: 4 } });
  var preClaimRecord = await entitlements.getEntitlement(ev, email);

  var testStart = Date.now();
  var LAG_MS = 250;
  // callIndex 1 is syncTokens' own pre-claim getEntitlement read, made
  // before any write in this call -- letting it through as-is is
  // equivalent to returning preClaimRecord anyway (nothing has been
  // written yet at that point), just written this way to make the "call
  // 1 is special" reasoning explicit. Every read from callIndex 2 onward
  // (the retry loop's own read() calls AND every verify-read) is subject
  // to the simulated lag, all seeing the exact same stale snapshot until
  // LAG_MS has genuinely elapsed.
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) return null;
    if (Date.now() - testStart < LAG_MS) return { value: preClaimRecord };
    return null; // lag window has passed -- fall through to the real, already-committed value
  });

  try {
    var result = await entitlements.claimDailyTokens(ev, email);
    assert.equal(result.claimed, true, 'the claim must still land once the fix\'s real inter-attempt delay gives the simulated propagation lag enough wall-clock time to clear');
    assert.equal(result.balance, 120, '100 + 20');
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 120, 'exactly one credit must have landed');
});
