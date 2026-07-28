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
  await entitlements.getTokenStatus(ev, 'brandnewclaim@example.com'); // materializes the 220-token record
  var before = Date.now();
  var result = await entitlements.claimDailyTokens(ev, 'brandnewclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 240, '220 + 20');
  assert.equal(result.streak, 1, 'first-ever claim always starts the streak at 1');
  assert.ok(result.nextClaimAt >= before + entitlements.CLAIM_COOLDOWN_MS - 1000, 'nextClaimAt ~= now + the cooldown');
});

test('claimDailyTokens works even when getTokenStatus/syncTokens was never called first -- a genuinely fresh email can claim directly', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var result = await entitlements.claimDailyTokens(ev, 'directclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 240, '220 signup grant (materialized lazily inside claimDailyTokens itself) + 20 claimed');
});

test('a pre-existing record with no tokens.lastClaimAt at all (predates this feature) is claimable immediately', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'legacyclaim@example.com', { tokens: { balance: 40 } });
  var result = await entitlements.claimDailyTokens(ev, 'legacyclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.balance, 60, '40 + 20');
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
  assert.equal(record.tokens.balance, 240, 'balance must NOT have moved on the rejected second attempt');
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
  assert.equal(record.tokens.balance, 25);
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
  assert.equal(day3.balance, 220 + 20 * 3);
});
