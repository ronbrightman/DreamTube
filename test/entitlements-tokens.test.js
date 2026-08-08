// test/entitlements-tokens.test.js
//
// Unit coverage for netlify/functions/lib/entitlements.js's token-economy
// core: getTokenStatus (the 220-token first-ever-read grant, and the
// claimable/nextClaimAt/streak projection off tokens.lastClaimAt/streak),
// spendTokens (deduct on demand, floor at 0, no-op on a missing/empty
// email, and that it preserves lastClaimAt/streak untouched), addTokens
// (manual top-up, same preservation), and claimDailyTokens (the actual
// daily-claim writer — see entitlements-daily-claim.test.js for its own
// dedicated, more thorough coverage of the rolling cooldown/streak logic;
// this file only re-checks that spendTokens/addTokens/getTokenStatus stay
// consistent with whatever claimDailyTokens wrote).
//
// Numbers retuned repeatedly: INITIAL_GRANT 200->290->220 (2026-07-26),
// raised to 220 on 2026-08-01 (tracker xostu6), then pulled back to its
// current 220 on 2026-08-08 (founder-directed economy retune — the +100
// headroom removed, and the first-claim bonus retired to equal the normal
// 20). 220 covers the funnel's free onboarding video (100) + one additional
// day-1 video (100) + 2 images (20). Unaffected by the
// 2026-07-28 daily-claim switch (this file's real subject): that switch
// replaced the OLD lazy +20/24h drip (and its ≥200 GRANT_CEILING) with an
// active daily CLAIM instead — see claim-daily-tokens.js and
// lib/entitlements.js's own doc block for the full mechanism/history. The
// old drip/ceiling tests that used to live in this file are gone; there is
// no more automatic background grant to test, and no more ceiling to hold
// one back.
//
// generate-video-tokens.test.js additionally exercises spendTokens through
// the actual generate-video.js handler (the E112 gate + when spending
// does/doesn't fire).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY;
});

// ----- getTokenStatus: first-ever-read grant -----

test('a never-before-seen email gets the 220-token signup grant on first read, and it is actually persisted', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var status = await entitlements.getTokenStatus(ev, 'brandnew@example.com');
  assert.equal(status.balance, 220);
  // As of the 2026-08-08 retune the first-claim bonus equals the normal
  // daily amount, so a never-claimed account's NEXT claim amount is just 20
  // -- see lib/entitlements.js's FIRST_CLAIM_BONUS_AMOUNT doc comment.
  assert.equal(status.dailyClaimAmount, 20);
  assert.equal(typeof status.nextClaimAt, 'number');

  var record = await entitlements.getEntitlement(ev, 'brandnew@example.com');
  assert.ok(record, 'first read must persist a record (unlike the old quota system, which never wrote one just from being read)');
  assert.equal(record.tokens.balance, 220);
});

test('reading again right away does not re-grant — balance stays at 220', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'repeat@example.com');
  var status = await entitlements.getTokenStatus(ev, 'repeat@example.com');
  assert.equal(status.balance, 220);
});

// ----- getTokenStatus: claimable/streak, off a record with no lastClaimAt -----

test('a brand-new signup grant has no lastClaimAt yet -> claimable immediately (founder-confirmed)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var status = await entitlements.getTokenStatus(ev, 'freshclaim@example.com');
  assert.equal(status.claimable, true);
  assert.equal(status.streak, 0, 'no claim has ever landed yet');
  assert.ok(status.nextClaimAt <= Date.now(), 'a never-claimed account reads as claimable right now, not in the future');
});

test('a pre-existing account with no tokens.lastClaimAt field at all (predates this feature) is also claimable immediately', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  // No lastClaimAt/streak at all -- exactly what a pre-2026-07-28 record
  // looks like.
  await entitlements.setEntitlement(ev, 'legacy@example.com', { tokens: { balance: 55 } });
  var status = await entitlements.getTokenStatus(ev, 'legacy@example.com');
  assert.equal(status.balance, 55, 'no daily-grant machinery silently changed the balance on read');
  assert.equal(status.claimable, true);
});

test('getTokenStatus never itself grants the daily +20 -- reading repeatedly leaves the balance untouched even though claimable is true', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'readonly@example.com'); // -> 220, claimable
  var status = await entitlements.getTokenStatus(ev, 'readonly@example.com');
  var status2 = await entitlements.getTokenStatus(ev, 'readonly@example.com');
  assert.equal(status.balance, 220);
  assert.equal(status2.balance, 220, 'reading is not claiming -- only claimDailyTokens grants');
});

test('claimable is false, and nextClaimAt is in the future, right after a claim', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'justclaimed@example.com'); // -> 220
  await entitlements.claimDailyTokens(ev, 'justclaimed@example.com');
  var status = await entitlements.getTokenStatus(ev, 'justclaimed@example.com');
  assert.equal(status.claimable, false);
  assert.ok(status.nextClaimAt > Date.now(), 'the 20h cooldown has not elapsed yet');
});

// ----- getTokenStatus: dailyClaimAmount projects the REAL next-claim amount
// (2026-07-28 first-claim-bonus amendment) -----

test('getTokenStatus for a not-yet-claimed account returns dailyClaimAmount: 20 (first claim equals the normal amount after the 2026-08-08 retune)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var status = await entitlements.getTokenStatus(ev, 'neverclaimedyet@example.com'); // -> 220, never claimed
  assert.equal(status.dailyClaimAmount, 20);
});

test('getTokenStatus for an already-claimed-once account returns dailyClaimAmount: 20 (the normal amount)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'claimedonce@example.com'); // -> 220
  var claimResult = await entitlements.claimDailyTokens(ev, 'claimedonce@example.com');
  assert.equal(claimResult.amountClaimed, 20, 'sanity: the first claim grants 20 (bonus retired 2026-08-08)');

  var status = await entitlements.getTokenStatus(ev, 'claimedonce@example.com');
  assert.equal(status.dailyClaimAmount, 20, 'the NEXT claim for an account that has already claimed once is also 20');
});

// ----- getTokenStatus: empty/missing email -----

test('empty/missing email resolves to a throwaway zero balance and writes nothing', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var status1 = await entitlements.getTokenStatus(ev, '');
  var status2 = await entitlements.getTokenStatus(ev, null);
  assert.equal(status1.balance, 0);
  assert.equal(status2.balance, 0);
  var record = await entitlements.getEntitlement(ev, '');
  assert.equal(record, null);
});

// ----- spendTokens -----

test('spendTokens deducts the given amount from balance', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'spender@example.com'); // -> 220
  await entitlements.spendTokens(ev, 'spender@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'spender@example.com');
  assert.equal(record.tokens.balance, 120);
});

test('spendTokens floors at 0, never goes negative', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'lowbalance@example.com', { tokens: { balance: 40 } });
  await entitlements.spendTokens(ev, 'lowbalance@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'lowbalance@example.com');
  assert.equal(record.tokens.balance, 0);
});

test('spendTokens preserves lastClaimAt/streak untouched -- a spend must never reset the claim cooldown or streak', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'spendclaim@example.com'); // -> 220
  var claimResult = await entitlements.claimDailyTokens(ev, 'spendclaim@example.com');
  assert.equal(claimResult.claimed, true);

  await entitlements.spendTokens(ev, 'spendclaim@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'spendclaim@example.com');
  assert.equal(record.tokens.balance, 140, '220 + 20 first-ever-claim bonus - 100 spent');
  assert.equal(record.tokens.streak, 1, 'streak untouched by the spend');
  assert.ok(record.tokens.lastClaimAt, 'lastClaimAt untouched by the spend (still set from the earlier claim)');

  var status = await entitlements.getTokenStatus(ev, 'spendclaim@example.com');
  assert.equal(status.claimable, false, 'the spend did not reopen claimability early');
});

test('empty/missing email is a safe no-op for spendTokens, not a thrown error', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var result1 = await entitlements.spendTokens(ev, '', 100);
  var result2 = await entitlements.spendTokens(ev, null, 100);
  var result3 = await entitlements.spendTokens(ev, undefined, 100);
  assert.equal(result1, null);
  assert.equal(result2, null);
  assert.equal(result3, null);
});

// ----- Per-IP daily cap on brand-new-email grants -----

test('the Nth+1 brand-new email from the same IP in one day gets balance 0 instead of the 220 signup grant', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  var status1 = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'first@example.com');
  var status2 = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'second@example.com');
  var status3 = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'third@example.com');
  assert.equal(status1.balance, 220);
  assert.equal(status2.balance, 220);
  assert.equal(status3.balance, 0, 'over the per-IP cap for today');
});

test('a capped-out brand-new email is not permanently blocked -- it can still claim its first-ever bonus immediately (no lastClaimAt was ever stamped, same as any other never-claimed account)', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'allowed@example.com');
  var deniedEvent = fakeEvent({ ip: ip });
  var denied = await entitlements.getTokenStatus(deniedEvent, 'denied@example.com');
  assert.equal(denied.balance, 0);
  assert.equal(denied.claimable, true, 'still claimable -- the IP cap only ever gates the one-time signup grant, not the daily claim');
  assert.equal(denied.dailyClaimAmount, 20, 'a never-claimed account (even one whose signup grant was capped) sees the real claim amount');

  var claimResult = await entitlements.claimDailyTokens(deniedEvent, 'denied@example.com');
  assert.equal(claimResult.claimed, true);
  assert.equal(claimResult.balance, 20, '0 (capped signup grant) + 20 first-ever-claim grant');
});

test('each IP gets its own daily cap bucket — a different IP is unaffected by another IP already being over the limit', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ipA = nextIp();
  var ipB = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ipA }), 'a1@example.com');
  var overCapOnA = await entitlements.getTokenStatus(fakeEvent({ ip: ipA }), 'a2@example.com');
  var freshOnB = await entitlements.getTokenStatus(fakeEvent({ ip: ipB }), 'b1@example.com');
  assert.equal(overCapOnA.balance, 0);
  assert.equal(freshOnB.balance, 220);
});

test('the per-IP cap only ever applies to the first-ever read for an email — an already-initialized account is never re-checked against it', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'already-init@example.com'); // uses up today's cap of 1 for this IP
  // Reading the SAME already-initialized email again from the same
  // (now over-cap) IP must not be treated as a new grant attempt.
  var status = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'already-init@example.com');
  assert.equal(status.balance, 220, 'unaffected by the IP being over its new-signup cap');
});

test('unset/invalid MAX_TOKEN_GRANTS_PER_IP_PER_DAY falls back to a sane default rather than granting unlimited', async function () {
  delete process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY;
  var ip = nextIp();
  var results = [];
  for (var i = 0; i < 7; i++) {
    var status = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'bulk' + i + '@example.com');
    results.push(status.balance);
  }
  assert.ok(results.indexOf(0) !== -1, 'the default cap must eventually kick in within 7 brand-new emails from one IP');
});

// ----- addTokens (manual top-up, see owner-topup-tokens.js for the only caller) -----

test('addTokens credits the given amount onto the existing balance', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'topup@example.com'); // -> 220
  await entitlements.addTokens(ev, 'topup@example.com', 500);
  var record = await entitlements.getEntitlement(ev, 'topup@example.com');
  assert.equal(record.tokens.balance, 720);
});

test('addTokens on a never-before-seen email materializes the record starting from the usual signup grant, then adds on top', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.addTokens(ev, 'brandnew-topup@example.com', 300);
  var record = await entitlements.getEntitlement(ev, 'brandnew-topup@example.com');
  assert.equal(record.tokens.balance, 520, '220 signup grant + 300 top-up');
});

test('addTokens does not change lastClaimAt/streak (purely additive to balance, never resets or delays the next daily claim)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'timing-topup@example.com'); // -> 220
  var claimResult = await entitlements.claimDailyTokens(ev, 'timing-topup@example.com');
  var claimedAt = claimResult.nextClaimAt - entitlements.CLAIM_COOLDOWN_MS;

  await entitlements.addTokens(ev, 'timing-topup@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'timing-topup@example.com');
  assert.equal(record.tokens.balance, 340, '220 + 20 first-ever-claim bonus + 100 top-up');
  assert.equal(record.tokens.lastClaimAt, claimedAt, 'lastClaimAt must be unchanged by a manual top-up');
  assert.equal(record.tokens.streak, 1, 'streak must be unchanged by a manual top-up');
});

test('addTokens caps the resulting balance at a sane ceiling rather than growing without bound', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'huge-topup@example.com', {
    tokens: { balance: 999900 }
  });
  await entitlements.addTokens(ev, 'huge-topup@example.com', 5000);
  var record = await entitlements.getEntitlement(ev, 'huge-topup@example.com');
  assert.equal(record.tokens.balance, 1000000, 'held at the MAX_TOKEN_BALANCE ceiling, not 1004900');
});

test('addTokens is a safe no-op for an empty/missing email, same as spendTokens', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var result1 = await entitlements.addTokens(ev, '', 100);
  var result2 = await entitlements.addTokens(ev, null, 100);
  var result3 = await entitlements.addTokens(ev, undefined, 100);
  assert.equal(result1, null);
  assert.equal(result2, null);
  assert.equal(result3, null);
});

// ----- 2026-08-05 signup-dead-end fix (replay guard + non-persisted cap) -----
// See syncTokens' REPLAY GUARD comment block for the production incident
// these lock in: one signup's burst of first reads burned the whole per-IP
// init cap and then clobbered its own 220 grant with a capped 0.

test('a replayed init (grant marker present, entitlement write not yet visible) echoes the grant and burns no IP slot', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  var ev = fakeEvent({ ip: ip });
  // Exhaust the IP's only slot with a different email.
  await entitlements.getTokenStatus(ev, 'slot-eater@example.com');
  // Simulate the incident's replay window: the marker write landed, the
  // entitlement write is not visible yet (no record exists at all).
  mockBlobs.seed('dreamtube-rate-limits', 'token-init-grant:replayed@example.com', { balance: 220, at: 1 });
  var status = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'replayed@example.com');
  // Echo, not a capped 0 — even though this IP's cap is exhausted.
  assert.equal(status.balance, 220);
});

test('a capped init persists NOTHING - the same email gets its full grant once the cap clears', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'first@example.com');
  var capped = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'second@example.com');
  assert.equal(capped.balance, 0);
  // Cap "clears" (tomorrow's reset, modeled by raising the limit): the
  // capped email must now get the REAL grant - the old code had persisted
  // {balance:0}, making the cap silently permanent for that email.
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '5';
  var recovered = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'second@example.com');
  assert.equal(recovered.balance, 220);
});

test('a capped account that claims still ends at exactly the claim amount, and later reads keep it (no 0-clobber)', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'eats-the-slot@example.com');
  var email = 'capped-claimer@example.com';
  var capped = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), email);
  assert.equal(capped.balance, 0);
  var claim = await entitlements.claimDailyTokens(fakeEvent({ ip: ip }), email);
  assert.equal(claim.claimed, true);
  assert.equal(claim.balance, 20); // first-claim grant (now 20) on a genuinely-capped 0 base
  var after = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), email);
  assert.equal(after.balance, 20);
});

// ----- 2026-08-05 signup-dead-end fix, round 3 (review finding on round 2's
// REPLAY GUARD) -- the marker-echo staleness narrowing. The test above at
// line 304 ("a replayed init... echoes the grant") deliberately covers the
// case where the entitlement write is NOT visible to the straggler at all
// (no record exists yet) -- the marker's frozen value is the only thing
// available, so echoing it is correct there. This test covers the DIFFERENT
// case review flagged: the straggler's marker read has propagated, but
// SEPARATELY a claim's own credit step already landed on TOP of the init in
// the meantime, so the real balance is now higher than the marker's frozen
// snapshot -- and the fix must not hand back that stale, understated number
// once it has the chance to see the real one.
test('a straggling reader whose init marker HAS propagated but whose OWN entitlement read is still stale must not echo the marker\'s frozen balance once a claim already landed on top of it', async function () {
  var ip = nextIp();
  var email = 'marker-echo-stale@example.com';
  var ev = fakeEvent({ ip: ip });

  // Real, already-committed state: the 220-token init grant landed, and a
  // claim's own separate credit step already bumped it to 240 -- e.g. the
  // exact incident this branch targets, where a claim's own internal
  // syncTokens call writes the init marker (220, frozen) synchronously
  // BEFORE the claim's separate credit step bumps the real balance to 240.
  await entitlements.setEntitlement(ev, email, {
    tokens: { balance: 240, lastClaimAt: Date.now(), streak: 1 }
  });
  mockBlobs.seed('dreamtube-rate-limits', 'token-init-grant:' + email, { balance: 220, at: Date.now() });

  // The straggler: its OWN first entitlement read (syncTokens' very first
  // read, callIndex 1) is still stale and sees no record/tokens at all --
  // exactly what routes it into the `!record.tokens` branch and its
  // marker-echo check. Every LATER entitlement read (callIndex 2+ -- this
  // fix's own re-derive read) sees the real, already-committed 420:
  // propagation caught up in the beat of wall-clock time between the two
  // reads (the marker-store round trip in between).
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) return { value: undefined };
    return null; // fall through to the real stored value from here on
  });

  var status;
  try {
    status = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), email);
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }

  assert.equal(status.balance, 240, 'must re-derive the real, already-credited balance from a fresh read -- not echo the marker\'s frozen 220 and understate a claim that already landed on top of it');
});

test('the marker-echo path still falls back to the marker\'s frozen value when a re-derive read ALSO still shows no tokens (propagation still lagging both reads)', async function () {
  var ip = nextIp();
  var email = 'marker-echo-still-stale@example.com';

  mockBlobs.seed('dreamtube-rate-limits', 'token-init-grant:' + email, { balance: 220, at: Date.now() });
  // No entitlement record written at all -- both the straggler's own first
  // read AND this fix's re-derive read genuinely see nothing yet, same as
  // the pre-existing "replayed init" test above.
  var status = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), email);
  assert.equal(status.balance, 220, 'falls back to the marker\'s frozen value when a fresh re-derive read still shows no tokens either -- the narrowing reduces the stale window, it does not require the real value to always be available');
});
