// test/entitlements-quota.test.js
//
// Unit coverage for the usage-quota/credits additions to
// netlify/functions/lib/entitlements.js: getQuotaStatus (including the
// lazy monthly reset-on-read, its "don't create a phantom record just from
// being read" guard, and effectiveRemaining folding in bonusCredits) and
// recordGenerationUsage (spend included quota first, then bonusCredits,
// floor bonusCredits at 0, no-op on a missing/empty email).
//
// generate-video-quota.test.js additionally exercises both of these through
// the actual generate-video.js handler (the E111 gate + when recording
// does/doesn't fire).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var entitlements = require('../netlify/functions/lib/entitlements');
var fakeEvent = {};

function currentPeriodKeyUtc() {
  var now = new Date();
  var month = now.getUTCMonth() + 1;
  return now.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

// ----- getQuotaStatus -----

test('no entitlement record at all -> active:false, a full default month, no record ever written', async function () {
  var status = await entitlements.getQuotaStatus(fakeEvent, 'nobody@example.com');
  assert.deepEqual(status, {
    active: false, plan: null, includedPerMonth: 10, used: 0,
    remaining: 10, bonusCredits: 0, effectiveRemaining: 10
  });
  var record = await entitlements.getEntitlement(fakeEvent, 'nobody@example.com');
  assert.equal(record, null, 'reading quota status for an email with no record must not create one');
});

test('active record with quota already in the current period -> reads used/remaining straight through', async function () {
  await entitlements.setEntitlement(fakeEvent, 'paying@example.com', {
    active: true, plan: 'monthly',
    quota: { includedPerMonth: 10, used: 4, periodKey: currentPeriodKeyUtc() }
  });
  var status = await entitlements.getQuotaStatus(fakeEvent, 'paying@example.com');
  assert.equal(status.active, true);
  assert.equal(status.plan, 'monthly');
  assert.equal(status.used, 4);
  assert.equal(status.remaining, 6);
  assert.equal(status.effectiveRemaining, 6);
});

test('quota.periodKey from a previous month lazily resets used to 0 and persists the new periodKey', async function () {
  await entitlements.setEntitlement(fakeEvent, 'stale@example.com', {
    active: true, quota: { includedPerMonth: 10, used: 9, periodKey: '2020-01' }
  });
  var status = await entitlements.getQuotaStatus(fakeEvent, 'stale@example.com');
  assert.equal(status.used, 0);
  assert.equal(status.remaining, 10);

  var record = await entitlements.getEntitlement(fakeEvent, 'stale@example.com');
  assert.equal(record.quota.used, 0);
  assert.equal(record.quota.periodKey, currentPeriodKeyUtc());
});

test('bonusCredits fold into effectiveRemaining but not remaining', async function () {
  await entitlements.setEntitlement(fakeEvent, 'topped-up@example.com', {
    active: true,
    quota: { includedPerMonth: 10, used: 10, periodKey: currentPeriodKeyUtc() },
    bonusCredits: 3
  });
  var status = await entitlements.getQuotaStatus(fakeEvent, 'topped-up@example.com');
  assert.equal(status.remaining, 0);
  assert.equal(status.bonusCredits, 3);
  assert.equal(status.effectiveRemaining, 3);
});

test('remaining floors at 0, never goes negative even if used somehow exceeds includedPerMonth', async function () {
  await entitlements.setEntitlement(fakeEvent, 'overused@example.com', {
    active: true, quota: { includedPerMonth: 10, used: 15, periodKey: currentPeriodKeyUtc() }
  });
  var status = await entitlements.getQuotaStatus(fakeEvent, 'overused@example.com');
  assert.equal(status.remaining, 0);
  assert.equal(status.effectiveRemaining, 0);
});

// ----- recordGenerationUsage -----

test('spends included quota first: used < includedPerMonth increments used, leaves bonusCredits untouched', async function () {
  await entitlements.setEntitlement(fakeEvent, 'user1@example.com', {
    active: true, quota: { includedPerMonth: 10, used: 2, periodKey: currentPeriodKeyUtc() }, bonusCredits: 5
  });
  await entitlements.recordGenerationUsage(fakeEvent, 'user1@example.com');
  var record = await entitlements.getEntitlement(fakeEvent, 'user1@example.com');
  assert.equal(record.quota.used, 3);
  assert.equal(record.bonusCredits, 5);
});

test('once included quota is exhausted, spends bonusCredits instead, leaving quota.used untouched', async function () {
  await entitlements.setEntitlement(fakeEvent, 'user2@example.com', {
    active: true, quota: { includedPerMonth: 10, used: 10, periodKey: currentPeriodKeyUtc() }, bonusCredits: 5
  });
  await entitlements.recordGenerationUsage(fakeEvent, 'user2@example.com');
  var record = await entitlements.getEntitlement(fakeEvent, 'user2@example.com');
  assert.equal(record.quota.used, 10);
  assert.equal(record.bonusCredits, 4);
});

test('bonusCredits never goes negative, even if recorded past zero', async function () {
  await entitlements.setEntitlement(fakeEvent, 'user3@example.com', {
    active: true, quota: { includedPerMonth: 10, used: 10, periodKey: currentPeriodKeyUtc() }, bonusCredits: 0
  });
  await entitlements.recordGenerationUsage(fakeEvent, 'user3@example.com');
  var record = await entitlements.getEntitlement(fakeEvent, 'user3@example.com');
  assert.equal(record.bonusCredits, 0);
});

test('a stale periodKey is respected/reset by recordGenerationUsage too (it reads via getQuotaStatus internally)', async function () {
  await entitlements.setEntitlement(fakeEvent, 'user4@example.com', {
    active: true, quota: { includedPerMonth: 10, used: 9, periodKey: '2020-01' }, bonusCredits: 0
  });
  await entitlements.recordGenerationUsage(fakeEvent, 'user4@example.com');
  var record = await entitlements.getEntitlement(fakeEvent, 'user4@example.com');
  // The stale 9-used count from 2020-01 is gone (reset to 0), then this
  // generation records as the *first* one of the new period -> used:1, not 10.
  assert.equal(record.quota.used, 1);
  assert.equal(record.quota.periodKey, currentPeriodKeyUtc());
});

test('empty/missing email is a safe no-op, not a thrown error', async function () {
  var result1 = await entitlements.recordGenerationUsage(fakeEvent, '');
  var result2 = await entitlements.recordGenerationUsage(fakeEvent, null);
  var result3 = await entitlements.recordGenerationUsage(fakeEvent, undefined);
  assert.equal(result1, null);
  assert.equal(result2, null);
  assert.equal(result3, null);
});
