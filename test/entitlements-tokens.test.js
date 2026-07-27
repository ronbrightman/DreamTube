// test/entitlements-tokens.test.js
//
// Unit coverage for the token-economy rewrite of
// netlify/functions/lib/entitlements.js: getTokenStatus (the 220-token
// first-ever-read grant, the lazy +20/24h drip, the ≥200 ceiling that
// holds the drip back without compounding, and the per-IP daily cap on
// brand-new-email grants) and spendTokens (deduct on demand, floor at 0,
// no-op on a missing/empty email, and that it applies any pending lazy
// grant before deducting).
//
// Numbers retuned 2026-07-24 (docs/IMAGE_GENERATION_SPEC.md §2b-revised):
// INITIAL_GRANT 200->290, DAILY_GRANT_AMOUNT 100->10 (GRANT_CEILING stays
// 500) — a new signup nets exactly 190 tokens after the wizard's one free
// onboarding video (290-100), and the free tier tightens meaningfully over
// time via a much smaller daily trickle.
//
// DAILY_GRANT_AMOUNT retuned again 2026-07-26 morning (tracker item
// for-product-raise-daily-token-award-to-2-7rf8ut, founder-directed):
// 10->200, because the 10/day trickle left new users stuck for days once
// the 290-token signup grant ran out after ~2 videos.
//
// Retuned a THIRD time 2026-07-26 night ("Token Economy C", founder-
// approved, tracker item for-product-build-token-economy-c-founde-i5i5pu):
// INITIAL_GRANT 290->220, DAILY_GRANT_AMOUNT 200->20, GRANT_CEILING
// 500->200. 220 covers the funnel's free onboarding video (100) + one
// additional day-1 video (100) + 2 images (20); the daily drip was cut
// back down to +20 now that real token packs (3-pack lineup, see
// create-checkout-session-dodo.js) are the actual "need more" path. 220 >
// the new 200 ceiling is intentional (see entitlements.js's own doc
// comment) — the drip simply resumes once balance actually drops below
// 200.
//
// generate-video-tokens.test.js additionally exercises both of these
// through the actual generate-video.js handler (the E112 gate + when
// spending does/doesn't fire).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');

var DAY_MS = 24 * 60 * 60 * 1000;
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
  assert.equal(status.dailyGrantAmount, 20);
  assert.equal(typeof status.nextGrantAt, 'number');

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

test('nextGrantAt is exactly lastGrantAt + 24h', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var before = Date.now();
  var status = await entitlements.getTokenStatus(ev, 'timing@example.com');
  var record = await entitlements.getEntitlement(ev, 'timing@example.com');
  assert.equal(status.nextGrantAt, record.tokens.lastGrantAt + DAY_MS);
  assert.ok(record.tokens.lastGrantAt >= before);
});

// ----- getTokenStatus: lazy +20/24h drip -----

test('24h+ elapsed since lastGrantAt, balance under the ceiling -> +20 grant, lastGrantAt bumped to now', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'due@example.com', {
    tokens: { balance: 50, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  var status = await entitlements.getTokenStatus(ev, 'due@example.com');
  assert.equal(status.balance, 70);

  var record = await entitlements.getEntitlement(ev, 'due@example.com');
  assert.ok(Date.now() - record.tokens.lastGrantAt < 5000, 'lastGrantAt should have snapped to "now"');
});

test('a user who spent down low receives the current 20/day amount on the next accrual', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'nearzero@example.com', {
    tokens: { balance: 8, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  var status = await entitlements.getTokenStatus(ev, 'nearzero@example.com');
  assert.equal(status.balance, 28, '8 + the 20/day grant');
  assert.equal(status.dailyGrantAmount, 20);
});

test('under 24h elapsed -> no grant yet, balance unchanged', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'notyet@example.com', {
    tokens: { balance: 50, lastGrantAt: Date.now() - (DAY_MS - 60000) }
  });
  var status = await entitlements.getTokenStatus(ev, 'notyet@example.com');
  assert.equal(status.balance, 50);
});

test('a single lazy read only ever grants one +20, regardless of how many days actually elapsed (no compounding, same precedent as the old monthly quota reset)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'stale@example.com', {
    tokens: { balance: 50, lastGrantAt: Date.now() - 5 * DAY_MS }
  });
  var status = await entitlements.getTokenStatus(ev, 'stale@example.com');
  assert.equal(status.balance, 70, 'exactly one +20 grant, not 5x20');
});

// ----- getTokenStatus: ≥200 ceiling -----

test('balance already at the ≥200 ceiling -> grant skipped even though 24h elapsed, lastGrantAt left untouched', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var staleTime = Date.now() - DAY_MS - 60000;
  await entitlements.setEntitlement(ev, 'maxed@example.com', {
    tokens: { balance: 200, lastGrantAt: staleTime }
  });
  var status = await entitlements.getTokenStatus(ev, 'maxed@example.com');
  assert.equal(status.balance, 200, 'ceiling holds the grant back');

  var record = await entitlements.getEntitlement(ev, 'maxed@example.com');
  assert.equal(record.tokens.lastGrantAt, staleTime, 'lastGrantAt must NOT advance while the grant is being held back');
});

test('balance just under the ceiling (199) still grants normally', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'almostmaxed@example.com', {
    tokens: { balance: 199, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  var status = await entitlements.getTokenStatus(ev, 'almostmaxed@example.com');
  assert.equal(status.balance, 219);
});

test('once balance drops back under the ceiling (e.g. from spending), the very next read grants immediately — lastGrantAt was never advanced while held back', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var staleTime = Date.now() - DAY_MS - 60000;
  await entitlements.setEntitlement(ev, 'recovered@example.com', {
    tokens: { balance: 200, lastGrantAt: staleTime }
  });
  await entitlements.getTokenStatus(ev, 'recovered@example.com'); // held back, still 200

  await entitlements.spendTokens(ev, 'recovered@example.com', 100); // -> 100, under the ceiling now
  var status = await entitlements.getTokenStatus(ev, 'recovered@example.com');
  assert.equal(status.balance, 120, '100 + the now-unblocked +20 grant');
});

// ----- getTokenStatus: atCeiling / grantCeiling (tracker item
// for-product-bug-founder-high-token-chip--kn1v8t — the founder's own
// profile, sitting at the 200 ceiling, showed a permanent "+20 in now" in
// the UI because every renderer inferred "at ceiling" from a stale, past
// nextGrantAt instead of an explicit flag) -----

test('atCeiling is true and grantCeiling is 200 when balance sits exactly at the ceiling', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'atceiling@example.com', {
    tokens: { balance: 200, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  var status = await entitlements.getTokenStatus(ev, 'atceiling@example.com');
  assert.equal(status.atCeiling, true);
  assert.equal(status.grantCeiling, 200);
  // The exact bug: nextGrantAt is already in the past while atCeiling is
  // true, since lastGrantAt is deliberately never bumped while held back.
  // Callers must branch on atCeiling, not on nextGrantAt <= now.
  assert.ok(status.nextGrantAt <= Date.now(), 'sanity: nextGrantAt really is in the past here, which is exactly what used to render "in now" forever');
});

test('atCeiling is true for a balance well above the ceiling too (e.g. the 220-token signup grant, or a manual top-up)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'wellabove@example.com', {
    tokens: { balance: 1500, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  var status = await entitlements.getTokenStatus(ev, 'wellabove@example.com');
  assert.equal(status.balance, 1500);
  assert.equal(status.atCeiling, true, 'the founder\'s own reported balance (1500) must read as at-ceiling');
  assert.equal(status.grantCeiling, 200);
});

test('atCeiling is false just under the ceiling (199)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'undertheceiling@example.com', {
    tokens: { balance: 199, lastGrantAt: Date.now() - 60000 } // not due for a grant either, isolates atCeiling from the drip
  });
  var status = await entitlements.getTokenStatus(ev, 'undertheceiling@example.com');
  assert.equal(status.balance, 199);
  assert.equal(status.atCeiling, false);
});

test('atCeiling flips to false the moment spending drops balance below the ceiling', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'flips@example.com', {
    tokens: { balance: 200, lastGrantAt: Date.now() - 60000 }
  });
  var before = await entitlements.getTokenStatus(ev, 'flips@example.com');
  assert.equal(before.atCeiling, true);

  await entitlements.spendTokens(ev, 'flips@example.com', 100); // -> 100
  var after = await entitlements.getTokenStatus(ev, 'flips@example.com');
  assert.equal(after.atCeiling, false);
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
  await entitlements.setEntitlement(ev, 'lowbalance@example.com', { tokens: { balance: 40, lastGrantAt: Date.now() } });
  await entitlements.spendTokens(ev, 'lowbalance@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'lowbalance@example.com');
  assert.equal(record.tokens.balance, 0);
});

test('spendTokens applies a pending lazy grant before deducting', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  // Seeded under the 200 ceiling (so the lazy grant actually fires) and far
  // enough above the 100-token spend that the grant's effect is clearly
  // visible in the result rather than masked by spendTokens' own
  // floor-at-0 — that's the whole point of this test: without the +20
  // grant firing first, 100 - 100 would floor to 0, indistinguishable from
  // a bug that skipped the grant entirely.
  await entitlements.setEntitlement(ev, 'graceperiod@example.com', {
    tokens: { balance: 100, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  await entitlements.spendTokens(ev, 'graceperiod@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'graceperiod@example.com');
  assert.equal(record.tokens.balance, 20, '100 + 20 granted - 100 spent = 20 (not floored to 0, proving the grant fired)');
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

test('a capped-out brand-new email is not permanently blocked — it still gets folded into the normal +20/24h drip starting from its (denied) grant time', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'allowed@example.com');
  var deniedEvent = fakeEvent({ ip: ip });
  var denied = await entitlements.getTokenStatus(deniedEvent, 'denied@example.com');
  assert.equal(denied.balance, 0);

  // Roll its lastGrantAt into the past to simulate 24h passing, then read again.
  await entitlements.setEntitlement(deniedEvent, 'denied@example.com', {
    tokens: { balance: 0, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  var nextDay = await entitlements.getTokenStatus(deniedEvent, 'denied@example.com');
  assert.equal(nextDay.balance, 20, 'picks up the normal daily drip the next day, same as any other account');
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

test('addTokens does not change lastGrantAt (purely additive to balance, never resets or delays the automatic daily drip)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var staleTime = Date.now() - 1000; // recent, not due for a lazy grant
  await entitlements.setEntitlement(ev, 'timing-topup@example.com', {
    tokens: { balance: 50, lastGrantAt: staleTime }
  });
  await entitlements.addTokens(ev, 'timing-topup@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'timing-topup@example.com');
  assert.equal(record.tokens.balance, 150);
  assert.equal(record.tokens.lastGrantAt, staleTime, 'lastGrantAt must be untouched by a manual top-up');
});

test('addTokens caps the resulting balance at a sane ceiling rather than growing without bound', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'huge-topup@example.com', {
    tokens: { balance: 999900, lastGrantAt: Date.now() }
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
