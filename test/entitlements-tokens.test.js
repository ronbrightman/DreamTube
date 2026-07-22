// test/entitlements-tokens.test.js
//
// Unit coverage for the token-economy rewrite of
// netlify/functions/lib/entitlements.js: getTokenStatus (the 200-token
// first-ever-read grant, the lazy +100/24h drip, the ≥500 ceiling that
// holds the drip back without compounding, and the per-IP daily cap on
// brand-new-email grants) and spendTokens (deduct on demand, floor at 0,
// no-op on a missing/empty email, and that it applies any pending lazy
// grant before deducting).
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

test('a never-before-seen email gets the 200-token signup grant on first read, and it is actually persisted', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var status = await entitlements.getTokenStatus(ev, 'brandnew@example.com');
  assert.equal(status.balance, 200);
  assert.equal(status.dailyGrantAmount, 100);
  assert.equal(typeof status.nextGrantAt, 'number');

  var record = await entitlements.getEntitlement(ev, 'brandnew@example.com');
  assert.ok(record, 'first read must persist a record (unlike the old quota system, which never wrote one just from being read)');
  assert.equal(record.tokens.balance, 200);
});

test('reading again right away does not re-grant — balance stays at 200', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, 'repeat@example.com');
  var status = await entitlements.getTokenStatus(ev, 'repeat@example.com');
  assert.equal(status.balance, 200);
});

test('nextGrantAt is exactly lastGrantAt + 24h', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var before = Date.now();
  var status = await entitlements.getTokenStatus(ev, 'timing@example.com');
  var record = await entitlements.getEntitlement(ev, 'timing@example.com');
  assert.equal(status.nextGrantAt, record.tokens.lastGrantAt + DAY_MS);
  assert.ok(record.tokens.lastGrantAt >= before);
});

// ----- getTokenStatus: lazy +100/24h drip -----

test('24h+ elapsed since lastGrantAt, balance under the ceiling -> +100 grant, lastGrantAt bumped to now', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'due@example.com', {
    tokens: { balance: 50, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  var status = await entitlements.getTokenStatus(ev, 'due@example.com');
  assert.equal(status.balance, 150);

  var record = await entitlements.getEntitlement(ev, 'due@example.com');
  assert.ok(Date.now() - record.tokens.lastGrantAt < 5000, 'lastGrantAt should have snapped to "now"');
});

test('under 24h elapsed -> no grant yet, balance unchanged', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'notyet@example.com', {
    tokens: { balance: 50, lastGrantAt: Date.now() - (DAY_MS - 60000) }
  });
  var status = await entitlements.getTokenStatus(ev, 'notyet@example.com');
  assert.equal(status.balance, 50);
});

test('a single lazy read only ever grants one +100, regardless of how many days actually elapsed (no compounding, same precedent as the old monthly quota reset)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'stale@example.com', {
    tokens: { balance: 50, lastGrantAt: Date.now() - 5 * DAY_MS }
  });
  var status = await entitlements.getTokenStatus(ev, 'stale@example.com');
  assert.equal(status.balance, 150, 'exactly one +100 grant, not 5x100');
});

// ----- getTokenStatus: ≥500 ceiling -----

test('balance already at the ≥500 ceiling -> grant skipped even though 24h elapsed, lastGrantAt left untouched', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var staleTime = Date.now() - DAY_MS - 60000;
  await entitlements.setEntitlement(ev, 'maxed@example.com', {
    tokens: { balance: 500, lastGrantAt: staleTime }
  });
  var status = await entitlements.getTokenStatus(ev, 'maxed@example.com');
  assert.equal(status.balance, 500, 'ceiling holds the grant back');

  var record = await entitlements.getEntitlement(ev, 'maxed@example.com');
  assert.equal(record.tokens.lastGrantAt, staleTime, 'lastGrantAt must NOT advance while the grant is being held back');
});

test('balance just under the ceiling (499) still grants normally', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'almostmaxed@example.com', {
    tokens: { balance: 499, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  var status = await entitlements.getTokenStatus(ev, 'almostmaxed@example.com');
  assert.equal(status.balance, 599);
});

test('once balance drops back under the ceiling (e.g. from spending), the very next read grants immediately — lastGrantAt was never advanced while held back', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var staleTime = Date.now() - DAY_MS - 60000;
  await entitlements.setEntitlement(ev, 'recovered@example.com', {
    tokens: { balance: 500, lastGrantAt: staleTime }
  });
  await entitlements.getTokenStatus(ev, 'recovered@example.com'); // held back, still 500

  await entitlements.spendTokens(ev, 'recovered@example.com', 100); // -> 400, under the ceiling now
  var status = await entitlements.getTokenStatus(ev, 'recovered@example.com');
  assert.equal(status.balance, 500, '400 + the now-unblocked +100 grant');
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
  await entitlements.getTokenStatus(ev, 'spender@example.com'); // -> 200
  await entitlements.spendTokens(ev, 'spender@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'spender@example.com');
  assert.equal(record.tokens.balance, 100);
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
  await entitlements.setEntitlement(ev, 'graceperiod@example.com', {
    tokens: { balance: 50, lastGrantAt: Date.now() - DAY_MS - 60000 }
  });
  await entitlements.spendTokens(ev, 'graceperiod@example.com', 100);
  var record = await entitlements.getEntitlement(ev, 'graceperiod@example.com');
  assert.equal(record.tokens.balance, 50, '50 + 100 granted - 100 spent = 50');
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

test('the Nth+1 brand-new email from the same IP in one day gets balance 0 instead of the 200 signup grant', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  var status1 = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'first@example.com');
  var status2 = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'second@example.com');
  var status3 = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'third@example.com');
  assert.equal(status1.balance, 200);
  assert.equal(status2.balance, 200);
  assert.equal(status3.balance, 0, 'over the per-IP cap for today');
});

test('a capped-out brand-new email is not permanently blocked — it still gets folded into the normal +100/24h drip starting from its (denied) grant time', async function () {
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
  assert.equal(nextDay.balance, 100, 'picks up the normal daily drip the next day, same as any other account');
});

test('each IP gets its own daily cap bucket — a different IP is unaffected by another IP already being over the limit', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ipA = nextIp();
  var ipB = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ipA }), 'a1@example.com');
  var overCapOnA = await entitlements.getTokenStatus(fakeEvent({ ip: ipA }), 'a2@example.com');
  var freshOnB = await entitlements.getTokenStatus(fakeEvent({ ip: ipB }), 'b1@example.com');
  assert.equal(overCapOnA.balance, 0);
  assert.equal(freshOnB.balance, 200);
});

test('the per-IP cap only ever applies to the first-ever read for an email — an already-initialized account is never re-checked against it', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'already-init@example.com'); // uses up today's cap of 1 for this IP
  // Reading the SAME already-initialized email again from the same
  // (now over-cap) IP must not be treated as a new grant attempt.
  var status = await entitlements.getTokenStatus(fakeEvent({ ip: ip }), 'already-init@example.com');
  assert.equal(status.balance, 200, 'unaffected by the IP being over its new-signup cap');
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
  await entitlements.getTokenStatus(ev, 'topup@example.com'); // -> 200
  await entitlements.addTokens(ev, 'topup@example.com', 500);
  var record = await entitlements.getEntitlement(ev, 'topup@example.com');
  assert.equal(record.tokens.balance, 700);
});

test('addTokens on a never-before-seen email materializes the record starting from the usual signup grant, then adds on top', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.addTokens(ev, 'brandnew-topup@example.com', 300);
  var record = await entitlements.getEntitlement(ev, 'brandnew-topup@example.com');
  assert.equal(record.tokens.balance, 500, '200 signup grant + 300 top-up');
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
