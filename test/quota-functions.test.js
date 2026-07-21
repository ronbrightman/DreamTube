// test/quota-functions.test.js
//
// Covers the two new standalone Netlify Functions the usage-quota/credits
// system adds: get-quota-status.js (thin read-only wrapper around
// entitlements.getQuotaStatus) and grant-topup-bonus.js (the TEMPORARY
// PAYWALL BYPASS that grants bonusCredits with no real charge — see that
// file's own header for why). Both are exercised at the handler level, same
// pattern as test/admin-paywall-toggle.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var getQuotaStatusHandler = require('../netlify/functions/get-quota-status').handler;
var grantTopupBonusHandler = require('../netlify/functions/grant-topup-bonus').handler;

function currentPeriodKeyUtc() {
  var now = new Date();
  var month = now.getUTCMonth() + 1;
  return now.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

// ----- get-quota-status.js -----

test('GET with no email -> { active:false }, no Blobs touched', async function () {
  var res = await getQuotaStatusHandler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { active: false });
});

test('GET with an email that has no entitlement record -> { active:false }', async function () {
  var res = await getQuotaStatusHandler(fakeEvent({ method: 'GET', query: { email: 'nobody@example.com' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).active, false);
});

test('GET with an active, entitled email -> full quota status', async function () {
  await entitlements.setEntitlement({}, 'active@example.com', {
    active: true, plan: 'yearly',
    quota: { includedPerMonth: 10, used: 3, periodKey: currentPeriodKeyUtc() },
    bonusCredits: 2
  });
  var res = await getQuotaStatusHandler(fakeEvent({ method: 'GET', query: { email: 'active@example.com' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.active, true);
  assert.equal(body.plan, 'yearly');
  assert.equal(body.used, 3);
  assert.equal(body.remaining, 7);
  assert.equal(body.bonusCredits, 2);
  assert.equal(body.effectiveRemaining, 9);
});

test('non-GET method rejected E1', async function () {
  var res = await getQuotaStatusHandler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1:/);
});

// ----- grant-topup-bonus.js -----

test('grants bundleSize onto a fresh (no prior record) email, creating one', async function () {
  var res = await grantTopupBonusHandler(fakeEvent({ method: 'POST', body: { email: 'fresh@example.com', bundleSize: 10 } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.bonusCredits, 10);
  var record = await entitlements.getEntitlement({}, 'fresh@example.com');
  assert.equal(record.bonusCredits, 10);
});

test('grants bundleSize additively onto an existing bonusCredits balance', async function () {
  await entitlements.setEntitlement({}, 'existing@example.com', { active: true, bonusCredits: 5 });
  var res = await grantTopupBonusHandler(fakeEvent({ method: 'POST', body: { email: 'existing@example.com', bundleSize: 10 } }));
  var body = JSON.parse(res.body);
  assert.equal(body.bonusCredits, 15);
});

test('response is the account\'s refreshed full quota status, not just the bonus number', async function () {
  await entitlements.setEntitlement({}, 'refreshed@example.com', {
    active: true, plan: 'monthly', quota: { includedPerMonth: 10, used: 10, periodKey: currentPeriodKeyUtc() }
  });
  var res = await grantTopupBonusHandler(fakeEvent({ method: 'POST', body: { email: 'refreshed@example.com', bundleSize: 10 } }));
  var body = JSON.parse(res.body);
  assert.equal(body.active, true);
  assert.equal(body.remaining, 0);
  assert.equal(body.bonusCredits, 10);
  assert.equal(body.effectiveRemaining, 10);
});

test('missing email rejected E3, no write', async function () {
  var res = await grantTopupBonusHandler(fakeEvent({ method: 'POST', body: { bundleSize: 10 } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3:/);
});

test('missing/zero/negative bundleSize rejected E4', async function () {
  var res1 = await grantTopupBonusHandler(fakeEvent({ method: 'POST', body: { email: 'a@example.com' } }));
  var res2 = await grantTopupBonusHandler(fakeEvent({ method: 'POST', body: { email: 'a@example.com', bundleSize: 0 } }));
  var res3 = await grantTopupBonusHandler(fakeEvent({ method: 'POST', body: { email: 'a@example.com', bundleSize: -5 } }));
  [res1, res2, res3].forEach(function (res) {
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4:/);
  });
});

test('invalid JSON body rejected E2', async function () {
  var res = await grantTopupBonusHandler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2:/);
});

test('non-POST method rejected E1', async function () {
  var res = await grantTopupBonusHandler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1:/);
});
