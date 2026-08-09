// test/entitlements-dreamer-pass.test.js
//
// Unit coverage for the Dreamer Pass subscription pieces of
// lib/entitlements.js: the trial-window 100/day daily-claim boost
// (claimDailyTokens + getTokenStatus projection), the updateSubscription CAS
// writer (state transitions, trial-window fallback cap, no-extend-on-
// redelivery), and the public subscription projection getTokenStatus exposes.
// See that file's DREAMER PASS constants doc block for the mechanism.
//
// Same mock-Blobs + fakeEvent style as entitlements-daily-claim.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');

var HOUR_MS = 60 * 60 * 1000;
var DAY_MS = 24 * HOUR_MS;

var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.14.0.' + ipCounter; }

test.beforeEach(function () { mockBlobs.reset(); });

/** Seeds a zero-balance record (so no INITIAL_GRANT noise) with a given subscription sub-object and optional past lastClaimAt. */
async function seed(email, subscription, lastClaimAt) {
  var tokens = { balance: 0 };
  if (lastClaimAt != null) tokens.lastClaimAt = lastClaimAt;
  await entitlements.setEntitlement({}, email, { tokens: tokens, subscription: subscription });
}

// ---------- claimDailyTokens trial boost ----------

test('claimDailyTokens grants 100 during an ACTIVE trial (status trialing, now < trialEnd)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await seed('trialclaim@example.com', { status: 'trialing', trialEnd: Date.now() + 2 * DAY_MS });
  var result = await entitlements.claimDailyTokens(ev, 'trialclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.amountClaimed, 100, 'a live-trial claim is boosted to 100');
  assert.equal(result.balance, 100, '0 + 100');
});

test('claimDailyTokens reverts to 20 once the trial has EXPIRED (status still trialing but trialEnd passed)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await seed('trialexpired@example.com', { status: 'trialing', trialEnd: Date.now() - HOUR_MS });
  var result = await entitlements.claimDailyTokens(ev, 'trialexpired@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.amountClaimed, 20, 'an elapsed trialEnd is no longer boosted, even before a webhook flips the status');
  assert.equal(result.balance, 20);
});

test('claimDailyTokens for a PAID (status active) subscriber stays 20 — the 3000 lump is their value, not a boosted claim', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await seed('paidclaim@example.com', { status: 'active', trialEnd: null });
  var result = await entitlements.claimDailyTokens(ev, 'paidclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.amountClaimed, 20, 'a paid subscriber is not trialing -> normal claim');
});

test('claimDailyTokens for a CANCELLED subscriber grants 20 (boost reverted)', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await seed('cancelledclaim@example.com', { status: 'cancelled', trialEnd: Date.now() + DAY_MS });
  var result = await entitlements.claimDailyTokens(ev, 'cancelledclaim@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.amountClaimed, 20, 'a terminal status is never trialing, even with a future trialEnd still on the record');
});

test('a second trial-day claim (after the cooldown) is still 100 while the trial is active', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  // A claim that happened ~21h ago (past the 20h cooldown), trial still live.
  await seed('trialsecond@example.com', { status: 'trialing', trialEnd: Date.now() + 2 * DAY_MS }, Date.now() - 21 * HOUR_MS);
  var result = await entitlements.claimDailyTokens(ev, 'trialsecond@example.com');
  assert.equal(result.claimed, true);
  assert.equal(result.amountClaimed, 100, 'every trial-window claim is boosted, not just the first');
});

test('claimDailyTokens leaves the tokens sub-object as exactly {balance,lastClaimAt,streak} — no subscription leak into tokens', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await seed('notokleak@example.com', { status: 'trialing', trialEnd: Date.now() + DAY_MS });
  await entitlements.claimDailyTokens(ev, 'notokleak@example.com');
  var record = await entitlements.getEntitlement(ev, 'notokleak@example.com');
  assert.deepEqual(Object.keys(record.tokens).sort(), ['balance', 'lastClaimAt', 'streak']);
  assert.ok(record.subscription, 'subscription stays a top-level sibling of tokens, untouched by the claim');
  assert.equal(record.subscription.status, 'trialing');
});

// ---------- getTokenStatus projection ----------

test('getTokenStatus.dailyClaimAmount projects 100 during a trial and 20 otherwise, and exposes the subscription shape', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var trialEnd = Date.now() + 2 * DAY_MS;
  await seed('statustrial@example.com', { status: 'trialing', subscriptionId: 'sub_1', trialEnd: trialEnd, nextBillingAt: trialEnd });
  var status = await entitlements.getTokenStatus(ev, 'statustrial@example.com');
  assert.equal(status.dailyClaimAmount, 100, 'UI must show the boosted upcoming amount during a trial');
  assert.ok(status.subscription, 'subscription projection present');
  assert.equal(status.subscription.status, 'trialing');
  assert.equal(status.subscription.subscribed, true);
  assert.equal(status.subscription.trialing, true);
  assert.equal(status.subscription.trialEnd, trialEnd);

  await seed('statuspaid@example.com', { status: 'active', trialEnd: null });
  var paid = await entitlements.getTokenStatus(ev, 'statuspaid@example.com');
  assert.equal(paid.dailyClaimAmount, 20);
  assert.equal(paid.subscription.subscribed, true);
  assert.equal(paid.subscription.trialing, false);
});

test('getTokenStatus.subscription is null for a never-subscribed account', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var status = await entitlements.getTokenStatus(ev, 'neversub@example.com');
  assert.equal(status.subscription, null);
  assert.equal(status.dailyClaimAmount, 20, 'no subscription -> normal claim amount');
});

// ---------- updateSubscription ----------

test('updateSubscription sets status/trialEnd and flips the top-level active flag + plan', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var trialEnd = Date.now() + 3 * DAY_MS;
  await entitlements.updateSubscription(ev, 'upd1@example.com', {
    status: 'trialing', subscriptionId: 'sub_x', productId: 'pdt_pass', trialEnd: trialEnd
  });
  var record = await entitlements.getEntitlement(ev, 'upd1@example.com');
  assert.equal(record.subscription.status, 'trialing');
  assert.equal(record.subscription.trialEnd, trialEnd);
  assert.equal(record.subscription.subscriptionId, 'sub_x');
  assert.equal(record.active, true, 'a trialing/active subscription sets the dormant active flag');
  assert.equal(record.plan, 'dreamer_pass');
});

test('updateSubscription to a terminal status (cancelled) clears active and the trial boost, leaving tokens intact', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.updateSubscription(ev, 'upd2@example.com', { status: 'trialing', trialEnd: Date.now() + DAY_MS });
  await entitlements.getTokenStatus(ev, 'upd2@example.com'); // materialize balance
  await entitlements.updateSubscription(ev, 'upd2@example.com', { status: 'cancelled', trialEnd: null });
  var record = await entitlements.getEntitlement(ev, 'upd2@example.com');
  assert.equal(record.subscription.status, 'cancelled');
  assert.equal(record.subscription.trialEnd, null);
  assert.equal(record.active, false);
  assert.equal(entitlements.isTrialActive(record.subscription, Date.now()), false);
  assert.deepEqual(Object.keys(record.tokens).sort(), ['balance', 'lastClaimAt', 'streak']);
});

test('updateSubscription trial-window fallback: trialing with NO resolvable trialEnd caps the boost to ~now+3 days', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  var before = Date.now();
  await entitlements.updateSubscription(ev, 'upd3@example.com', { status: 'trialing', subscriptionId: 'sub_no_end' });
  var record = await entitlements.getEntitlement(ev, 'upd3@example.com');
  assert.ok(record.subscription.trialEnd, 'a trialing sub with no known end still gets a capped trialEnd');
  assert.ok(record.subscription.trialEnd >= before + entitlements.TRIAL_WINDOW_MS - 5000, 'capped to ~now + the 3-day trial window');
  assert.ok(record.subscription.trialEnd <= Date.now() + entitlements.TRIAL_WINDOW_MS + 5000);
});

test('updateSubscription redelivery of a trialing event does NOT extend an already-set fallback trialEnd', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.updateSubscription(ev, 'upd4@example.com', { status: 'trialing', subscriptionId: 'sub_r' });
  var first = await entitlements.getEntitlement(ev, 'upd4@example.com');
  var firstTrialEnd = first.subscription.trialEnd;
  // A later (redelivered) trialing event with still no trial end must reuse the stored one.
  await entitlements.updateSubscription(ev, 'upd4@example.com', { status: 'trialing', subscriptionId: 'sub_r' });
  var second = await entitlements.getEntitlement(ev, 'upd4@example.com');
  assert.equal(second.subscription.trialEnd, firstTrialEnd, 'trialEnd must not creep forward on redelivery');
});

test('updateSubscription undefined keys are dropped (do not blank a prior value); null clears', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.updateSubscription(ev, 'upd5@example.com', { status: 'trialing', subscriptionId: 'sub_keep', trialEnd: Date.now() + DAY_MS });
  // A later event that doesn't know subscriptionId must not blank it.
  await entitlements.updateSubscription(ev, 'upd5@example.com', { status: 'active', subscriptionId: undefined, trialEnd: null });
  var record = await entitlements.getEntitlement(ev, 'upd5@example.com');
  assert.equal(record.subscription.subscriptionId, 'sub_keep', 'undefined patch key must not blank the prior subscriptionId');
  assert.equal(record.subscription.status, 'active');
  assert.equal(record.subscription.trialEnd, null, 'explicit null clears trialEnd');
});
