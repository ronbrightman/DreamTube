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

test('claimDailyTokens on a brand-new email claims immediately: +20 balance, streak 1, nextClaimAt ~20h out', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'brandnewclaim@example.com'); // materializes the 170-token record
  var before = Date.now();
  var result = await entitlements.claimDailyTokens(ev, 'brandnewclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 190, '170 + 20 (2026-08-08 retune: the first-claim bonus was retired to equal the normal daily 20)');
  assert.equal(result.amountClaimed, 20, 'amountClaimed reflects the real amount actually credited');
  assert.equal(result.streak, 1, 'first-ever claim always starts the streak at 1');
  assert.ok(result.nextClaimAt >= before + entitlements.CLAIM_COOLDOWN_MS - 1000, 'nextClaimAt ~= now + the cooldown');
});

test('claimDailyTokens works even when getTokenStatus/syncTokens was never called first -- a genuinely fresh email can claim directly, still getting the first-claim bonus', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var result = await entitlements.claimDailyTokens(ev, 'directclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 190, '170 signup grant (materialized lazily inside claimDailyTokens itself) + 20 first-ever-claim grant');
  assert.equal(result.amountClaimed, 20);
});

test('a pre-existing record with no tokens.lastClaimAt at all (predates this feature) is claimable immediately and still gets the first-claim bonus (it has never actually claimed before)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'legacyclaim@example.com', { tokens: { balance: 40 } });
  var result = await entitlements.claimDailyTokens(ev, 'legacyclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 60, '40 + 20 -- a legacy account that never actually completed a claim before is a genuine first-ever claim');
  assert.equal(result.amountClaimed, 20);
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
  assert.equal(record.tokens.balance, 190, 'balance must NOT have moved on the rejected second attempt (170 + 20 from the first, successful claim)');
});

// ----- First-claim amount (2026-08-08 retune, tracker item
// for-product-daily-claim-bugs-founder-rea-kei2ub as originally shipped,
// then retuned): the account's FIRST-EVER claim now grants
// FIRST_CLAIM_BONUS_AMOUNT, which was pulled back to equal
// DAILY_CLAIM_AMOUNT (20) — the larger first-claim bonus is retired, so
// every claim (first or subsequent) grants 20. The firstClaimAt marker is
// still stamped exactly once, and the amount is still resolved through the
// same claim-count/firstClaimAt code path. -----

test('a brand-new account\'s very first claim grants exactly 20 and stamps a top-level firstClaimAt', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'firstclaimbonus@example.com';
  await entitlements.getTokenStatus(ev, email); // -> 170, no lastClaimAt/firstClaimAt yet

  var before = Date.now();
  var result = await entitlements.claimDailyTokens(ev, email);
  assert.equal(result.claimed, true);
  assert.equal(result.amountClaimed, 20);
  assert.equal(result.balance, 190);

  var record = await entitlements.getEntitlement(ev, email);
  assert.ok(record.firstClaimAt, 'firstClaimAt must be stamped on the actual first successful claim');
  assert.ok(record.firstClaimAt >= before, 'firstClaimAt is a real timestamp from this claim, not a leftover/undefined value');
});

test('that same account\'s SECOND claim (after the cooldown) also grants 20, and firstClaimAt is never overwritten', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'secondclaimnormal@example.com';
  await entitlements.getTokenStatus(ev, email); // -> 170

  var first = await entitlements.claimDailyTokens(ev, email);
  assert.equal(first.amountClaimed, 20);
  var recordAfterFirst = await entitlements.getEntitlement(ev, email);
  var stampedFirstClaimAt = recordAfterFirst.firstClaimAt;
  assert.ok(stampedFirstClaimAt);

  // Roll the cooldown back so the second claim is actually claimable.
  await entitlements.setEntitlement(ev, email, {
    tokens: Object.assign({}, recordAfterFirst.tokens, { lastClaimAt: recordAfterFirst.tokens.lastClaimAt - (21 * HOUR_MS) })
  });

  var second = await entitlements.claimDailyTokens(ev, email);
  assert.equal(second.claimed, true);
  assert.equal(second.amountClaimed, 20, 'the second-ever claim grants the normal amount, same as the first now');
  assert.equal(second.balance, 190 + 20);

  var recordAfterSecond = await entitlements.getEntitlement(ev, email);
  assert.equal(recordAfterSecond.firstClaimAt, stampedFirstClaimAt, 'firstClaimAt must never be overwritten once stamped');
});

test('two CONCURRENT first-ever claims for the SAME email cannot both land the 20-token grant -- exactly one credit, never two', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'firstclaimrace@example.com';
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 0 } }); // no lastClaimAt -- a genuine first-ever claim race

  var results = await Promise.all([
    entitlements.claimDailyTokens(ev, email),
    entitlements.claimDailyTokens(ev, email)
  ]);

  var claimed = results.filter(function (r) { return r.claimed; });
  assert.equal(claimed.length, 1, 'exactly one of the two concurrent first-ever claims should report claimed:true');
  assert.equal(claimed[0].amountClaimed, 20, 'the one winner gets the claim amount, not a smaller/larger amount');

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 20, 'only ONE 20-token grant must land, never two (40) and never zero');
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
  assert.equal(record.tokens.balance, 25, '5 + 20 first-ever-claim grant');
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
  await entitlements.getTokenStatus(ev, 'multiday@example.com'); // -> 170

  var day1 = await entitlements.claimDailyTokens(ev, 'multiday@example.com');
  assert.equal(day1.streak, 1);
  assert.equal(day1.balance, 190, '170 + 20 first-ever-claim grant');

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
  assert.equal(day3.balance, 170 + 20 * 3, 'each of day1/day2/day3 grants the normal 20 (first-claim bonus retired 2026-08-08)');
});

// ----- Round 1 review findings: record-shape safety + real concurrency -----

test('firstPackPurchaseAt (a top-level record field, not nested in tokens) survives a claim -- the tokens-key full-replace inside claimDailyTokens must not clobber it', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'claimafterpurchase@example.com';
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 10 }, firstPackPurchaseAt: 1700000000000 });

  var result = await entitlements.claimDailyTokens(ev, email);
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 30, '10 + 20 -- a genuine first-ever CLAIM (independent of any past token-pack purchase)');

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
  assert.equal(record.tokens.balance, 20, 'a genuinely concurrent double-claim attempt must still only credit tokens once -- this is a first-ever claim race, so exactly one 20-token grant, never two (40) or zero');
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
  assert.equal(record.tokens.balance, 20, 'a first-ever claim race -- exactly one 20-token grant lands, never more');
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
// ── CAS REWRITE NOTE (tracker item for-product-p1-urgent-fresh-signup-
//    can-d-qhrrqy's follow-up: the @netlify/blobs 10.x conditional-write
//    migration) ──
// claimDailyTokens now goes through blobsCas.casWrite (lib/blobs-cas.js)
// instead of blobsRetry.retryingWrite — a REAL compare-and-swap write
// (onlyIfNew/onlyIfMatch) replaces the old read -> mutate -> write ->
// verify loop. The three tests this section used to hold (a
// "self-clobbering SKIP" false negative, a read-your-own-write race on a
// just-seeded account, and a propagation-lag exhaustion scenario) all
// targeted a get()-based read/verify hazard that a get()-based
// setReadOverride could intercept — claimDailyTokens' own reads are now
// getWithMetadata() calls (a SEPARATE mock mechanism, setCasReadOverride —
// see test/helpers/mock-blobs.js's own header comment on why). The
// self-clobber scenario is gone entirely under real CAS (see
// claimDailyTokens' own doc comment: a CAS write's `modified` result is
// unambiguous, so there is no "was this actually my own write" question
// left to misread as a false SKIP) — replaced below with the genuinely
// new invariant CAS provides: a stale read's conditional write is
// atomically REJECTED, never silently committed on a wrong base.

test("a stale first CAS read (observing a pre-claim snapshot with a non-current etag) is atomically REJECTED, not silently committed — the retry lands claimed:true against the real state", async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'selflag@example.com';
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 0, lastClaimAt: Date.now() - (25 * HOUR_MS) } });

  // Attempt 1 of claimDailyTokens' own casWrite loop observes a snapshot
  // that LOOKS claimable (matching the real pre-claim state) but carries
  // an etag that can never match the record's real current one — as if a
  // genuinely concurrent write had already landed between this read and
  // the real current state. The resulting conditional write must be
  // rejected, not committed, and the next attempt must retry against the
  // real state instead.
  mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) {
      return { value: { data: { email: key, tokens: { balance: 0, lastClaimAt: Date.now() - (25 * HOUR_MS) } }, etag: 'stale-etag-will-never-match', metadata: {} } };
    }
    return null; // fall through to the real current state
  });

  try {
    var result = await entitlements.claimDailyTokens(ev, email);
    assert.equal(result.claimed, true, 'the claim must still land once a fresher attempt reads the real state');
    assert.equal(result.balance, 20);
    assert.equal(result.streak, 1);
  } finally {
    mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
  }

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 20, 'exactly one credit must have landed, not zero and not two');
});

// Tracker item for-product-bug-founder-repro-high-brand-1dtzdc (founder
// repro, 2026-08-01): a brand-new account's very first daily-claim attempt,
// fired seconds after signup (home.html's auto-open-right-after-signup
// flow), silently lost its signup grant under the pre-CAS implementation.
// Under real CAS this can no longer happen even in principle: a claim
// attempt built off a stale/wrong balance guess can never actually commit
// (its conditional write is atomically rejected the instant the record's
// real state doesn't match) — this test proves that directly rather than
// merely proving the end-to-end amount happens to come out right.
test("a claim whose OWN first CAS read does not yet see the real, already-seeded signup grant (a stale read landing just before propagation) is atomically REJECTED and retries against the real balance -- must not silently drop the signup grant", async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'freshaccountrace@example.com';

  // Seed the record for REAL first (syncTokens' own init branch, run to
  // genuine completion) -- mirrors claimDailyTokens always awaiting its
  // own outer syncTokens() call before its casWrite loop ever starts, so
  // by the time that loop runs the real 170-token grant already exists
  // server-side.
  await entitlements.getTokenStatus(ev, email);

  // Force claimDailyTokens' own FIRST casWrite attempt to see NOTHING, as
  // if the real, already-committed record hadn't propagated to this read
  // yet -- since the key genuinely exists, the resulting onlyIfNew write
  // is atomically rejected, and the loop retries against a fresh read.
  mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) return { value: null };
    return null; // fall through to the real current state
  });

  try {
    var result = await entitlements.claimDailyTokens(ev, email);
    assert.equal(result.claimed, true, 'the claim should still succeed once the retry catches up');
    assert.equal(result.amountClaimed, 20, 'first-ever claim amount');
    assert.equal(result.balance, 190, '170 (real signup grant, already committed before this loop started) + 20 (first-ever-claim grant) -- must NOT silently drop the signup grant just because attempt 1\'s own read raced the real, already-committed state');
  } finally {
    mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
  }

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 190, 'the persisted record must reflect the real seeded balance too, not just this call\'s return value');
});

test("a first CAS read that keeps returning the stale pre-claim snapshot for a real ~250ms propagation-lag window still lands the claim once the fix's inter-attempt delay gives it enough real time -- proving the delay does something a synchronous mock can't fake by attempt count alone", async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'propagationlag@example.com';
  // 25h ago -- comfortably past the 20h cooldown, so this is genuinely
  // claimable regardless of how any individual read is intercepted below.
  await entitlements.setEntitlement(ev, email, { tokens: { balance: 100, lastClaimAt: Date.now() - (25 * HOUR_MS), streak: 4 } });

  var testStart = Date.now();
  var LAG_MS = 250;
  // Every CAS read against this store, for a real LAG_MS wall-clock
  // window since the test started, comes back with an etag that can
  // never match the record's real current one (as if this attempt's read
  // were still looking at stale, not-yet-propagated state) -- forcing
  // every attempt within that window to lose the CAS race. Once LAG_MS
  // has genuinely elapsed, reads fall through to the real, current state
  // (and its real, matching etag), letting a subsequent attempt succeed.
  // This models propagation lag as a function of genuine wall-clock time,
  // the one thing a synchronous in-memory mock can't otherwise reproduce
  // (nothing here behaves differently just because more *attempts*
  // happened -- only real elapsed time resolves it) -- proving
  // blobsCas.casWrite's own real inter-attempt delay (mirroring blobs-
  // retry.js's identical, already-proven reasoning) is what actually lets
  // this succeed, not merely a lucky attempt count.
  mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key) {
    if (Date.now() - testStart < LAG_MS) {
      return { value: { data: { email: key, tokens: { balance: 100, lastClaimAt: Date.now() - (25 * HOUR_MS), streak: 4 } }, etag: 'stale-etag-will-never-match', metadata: {} } };
    }
    return null; // lag window has passed -- fall through to the real, current state
  });

  try {
    var result = await entitlements.claimDailyTokens(ev, email);
    assert.equal(result.claimed, true, 'the claim must still land once the real inter-attempt delay gives the simulated propagation lag enough wall-clock time to clear');
    assert.equal(result.balance, 120, '100 + 20');
  } finally {
    mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
  }

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 120, 'exactly one credit must have landed');
});

// ----- 2026-08-05 signup-dead-end fix, round 2 (tracker item
// for-product-p1-urgent-fresh-signup-can-d-qhrrqy) — the guarded init
// write. Round 1 (see test/entitlements-tokens.test.js's own "signup-
// dead-end fix" section) closed the IP-slot-burn/permanent-0 holes with a
// once-ever grant marker. What it left standing: syncTokens' init branch
// still finished with a completely UNGUARDED plain `setEntitlement`
// write — a full-object REPLACE of `tokens`, no fresh recheck at all.
// Production probe: a claim seconds after signup reported E5, balance
// stayed at the pre-claim 170 instead of 190, and only "healed" minutes
// later once propagation settled and the claim's own write finally won —
// a straggling SECOND syncTokens init call (e.g. a concurrent get-token-
// status.js read racing the claim, both reaching this exact branch before
// either one's own write was visible to the other yet) landed its plain
// `tokens: fresh` write AFTER the claim's, silently erasing the claim's
// balance AND lastClaimAt/lastClaimAttemptId.
test('a straggling duplicate signup-init write must not clobber a claim that already landed (guarded init write, not a blind full-object replace)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'clobberrace@example.com';

  // The claim lands first and genuinely succeeds, normally.
  var claimResult = await entitlements.claimDailyTokens(ev, email);
  assert.equal(claimResult.claimed, true);
  assert.equal(claimResult.balance, 190);

  // Now simulate a SECOND, straggling caller's own syncTokens init call —
  // e.g. a concurrent get-token-status.js read fired alongside the claim
  // above, whose own very first read of the entitlement record genuinely
  // raced ahead of everything above and still reports "no tokens yet"
  // (as if it had started before any of the writes above landed). This
  // exercises the "outer syncTokens condition still passes for a
  // straggler" case — syncTokens' own outer getEntitlement read is still a
  // PLAIN get() (unmigrated, hence setReadOverride still intercepts it
  // here), which is what routes this call into the init branch at all.
  // What matters downstream is whether the GUARDED init write itself (now
  // blobsCas.casWrite, reading via getWithMetadata — a separate mechanism
  // this override does NOT touch, so it always sees the REAL, already-
  // claimed record directly, no interception needed) still refuses to
  // clobber it. The token-init-grant marker read is stubbed the same way,
  // for the same "straggler sees nothing yet" reasoning.
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function () {
    return { value: undefined }; // outer syncTokens check: "no record yet"
  });
  mockBlobs.setReadOverride('dreamtube-rate-limits', function () { return { value: undefined }; }); // the marker also looks not-yet-written to this straggler

  var status;
  try {
    status = await entitlements.getTokenStatus(ev, email);
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
    mockBlobs.clearReadOverride('dreamtube-rate-limits');
  }
  assert.equal(status.balance, 190, 'must echo the REAL current balance, never fabricate/revert to a fresh 170');

  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 190, 'the persisted record must still reflect the claim');
  assert.ok(record.tokens.lastClaimAt, 'the claim\'s lastClaimAt must survive -- not wiped by the straggling init write');
  assert.equal(record.tokens.streak, 1, 'the claim\'s streak must survive too');
});
// NEGATIVE-PROOFED (per this tracker item's own verification ask):
// `git stash` the entitlements.js change and re-run this file -- the test
// above fails with `170 !== 190` (the straggler's blind `tokens: fresh`
// write reverts the balance and drops lastClaimAt/streak entirely),
// reproducing the exact production incident this fix closes. Confirmed
// manually before this fix was committed; not kept as a permanently
// skipped duplicate test to avoid dead code.

// ============================================================================
// GENUINE END-TO-END CONCURRENCY: signup-seed write racing a claim, for a
// SAME brand-new email, via REAL Promise.all interleaving (not a
// setCasReadOverride-forced scenario) — tracker item
// for-product-p1-urgent-fresh-signup-can-d-qhrrqy's own "claim erasure"
// incident shape: "a daily-claim seconds after signup can be ERASED by the
// signup seed's delayed write landing AFTER the claim's write." This is
// the closest thing to a direct reproduction of the actual production
// incident this whole CAS migration exists to close — two independent
// entry points (a plain balance read that lazily seeds the 170-token
// signup grant, and a claim for the first-ever +20 grant) touching the
// SAME never-before-seen email's entitlement record at genuinely the same
// time, with no coordination between them beyond what entitlements.js
// itself provides.
// ============================================================================

test('a genuinely concurrent signup-seed read (getTokenStatus) and first-ever claim (claimDailyTokens) for the SAME brand-new email both land correctly -- no lost update either way', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var email = 'concurrent-seed-vs-claim@example.com';

  // Promise.all, not two sequential awaits -- both entry points start
  // genuinely concurrently, exactly like home.html's auto-open-claim-sheet
  // firing alongside its own token-status read moments after a fresh
  // signup (the real trigger for the production incident this closes).
  var results = await Promise.all([
    entitlements.getTokenStatus(ev, email),   // lazily seeds the 170-token signup grant
    entitlements.claimDailyTokens(ev, email)  // the account's first-ever claim, +20
  ]);

  var status = results[0];
  var claim = results[1];

  // Whichever ran through first, the FINAL persisted state must reflect
  // BOTH the signup grant and the claim -- 190 total, never a lower number
  // (which would mean one write silently erased the other's effect, the
  // exact "claim erasure" failure mode this migration closes) and never a
  // higher one (which would mean the claim somehow applied twice).
  var record = await entitlements.getEntitlement(ev, email);
  assert.equal(record.tokens.balance, 190, '170 (signup grant) + 20 (first-ever-claim grant) must BOTH have landed -- neither write may silently erase the other');
  assert.ok(record.tokens.lastClaimAt, 'the claim must be durably recorded, not silently discarded by a later signup-seed write');
  assert.ok(record.firstClaimAt, 'firstClaimAt must be stamped -- the claim genuinely happened');

  // The claim's own return value must also be internally consistent with
  // whatever ends up persisted -- claimed:true must always mean the claim
  // really landed, never a phantom success.
  if (claim.claimed) {
    assert.equal(claim.amountClaimed, 20, 'first-ever claim amount');
  }
  // status.balance is a point-in-time read that may legitimately race
  // either write -- not asserted here (its own dedicated marker-echo tests
  // above already cover that projection in isolation); this test's whole
  // point is the FINAL, durably-persisted state, proven above.
});

test('repeated trials of the signup-seed-vs-claim race stay consistent (rules out a lucky single pass)', async function () {
  for (var i = 0; i < 8; i++) {
    var ev = fakeEvent({ ip: nextIp() });
    var email = 'concurrent-seed-vs-claim-loop-' + i + '@example.com';

    await Promise.all([
      entitlements.getTokenStatus(ev, email),
      entitlements.claimDailyTokens(ev, email)
    ]);

    var record = await entitlements.getEntitlement(ev, email);
    assert.equal(record.tokens.balance, 190, 'trial ' + i + ': both the signup grant and the claim must land');
  }
});
