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
// Numbers retuned 2026-07-24 (docs/IMAGE_GENERATION_SPEC.md §2b-revised):
// INITIAL_GRANT 200->290, then 2026-07-26 morning 290->220 morning retune,
// then retuned a third time 2026-07-26 night ("Token Economy C") to its
// current 220 — 220 covers the funnel's free onboarding video (100) + one
// additional day-1 video (100) + 2 images (20). Unaffected by the
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
  assert.equal(record.tokens.balance, 140, '220 + 20 claimed - 100 spent');
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

test('a capped-out brand-new email is not permanently blocked -- it can still claim its first +20 immediately (no lastClaimAt was ever stamped, same as any other never-claimed account)', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'allowed@example.com');
  var deniedEvent = fakeEvent({ ip: ip });
  var denied = await entitlements.getTokenStatus(deniedEvent, 'denied@example.com');
  assert.equal(denied.balance, 0);
  assert.equal(denied.claimable, true, 'still claimable -- the IP cap only ever gates the one-time signup grant, not the daily claim');

  var claimResult = await entitlements.claimDailyTokens(deniedEvent, 'denied@example.com');
  assert.equal(claimResult.claimed, true);
  assert.equal(claimResult.balance, 20, '0 (capped signup grant) + 20 claimed');
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
  assert.equal(record.tokens.balance, 340, '220 + 20 claimed + 100 top-up');
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
