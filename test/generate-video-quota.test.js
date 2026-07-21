// test/generate-video-quota.test.js
//
// Covers the usage-quota/credits system's server-side enforcement in
// netlify/functions/generate-video.js: the E111 gate (same
// !isOwner/paywallState.enabled scope as the E108 entitlement check),
// that recordGenerationUsage fires on every successful 200 (mock mode and
// the real fal path) but never on a fal submission rejection (E105/E106),
// and that the OWNER_EMAIL bypass skips the quota check the same way it
// already skips the entitlement check. See test/generate-video-gate.test.js
// for the equivalent E108/owner-bypass coverage this mirrors, and
// test/entitlements-quota.test.js for direct unit coverage of
// getQuotaStatus/recordGenerationUsage themselves.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var paywallSettings = require('../netlify/functions/lib/paywall-settings');
var handler = require('../netlify/functions/generate-video').handler;

var OWNER_EMAIL = 'founder@dreamtube.example';
var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.2.0.' + ipCounter;
}

function currentPeriodKeyUtc() {
  var now = new Date();
  var month = now.getUTCMonth() + 1;
  return now.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month;
}

function stubFetchOk() {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
}

function stubFetchRejected() {
  global.fetch = async function () {
    return { ok: false, status: 422, json: async function () { return { detail: 'nope' }; } };
  };
}

function genEvent(overrides) {
  var base = {
    method: 'POST',
    ip: nextIp(),
    body: Object.assign({ caption: 'a dream about flying', style: 'Cartoon' }, overrides && overrides.body)
  };
  if (overrides && overrides.ip) base.ip = overrides.ip;
  return fakeEvent(base);
}

async function exhaustedEntitlement(email) {
  return entitlements.setEntitlement({}, email, {
    active: true, plan: 'monthly',
    quota: { includedPerMonth: 10, used: 10, periodKey: currentPeriodKeyUtc() },
    bonusCredits: 0
  });
}

async function activeEntitlementWithRemaining(email, used) {
  return entitlements.setEntitlement({}, email, {
    active: true, plan: 'monthly',
    quota: { includedPerMonth: 10, used: used, periodKey: currentPeriodKeyUtc() },
    bonusCredits: 0
  });
}

test.beforeEach(async function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.PAYWALL_ENABLED;
  delete process.env.OWNER_EMAIL;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
  delete process.env.GENERATION_MOCK_MODE;
  await paywallSettings.setOverride({}, true); // most tests here care about the paywall-on scope
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- E111 gate -----

test('paywall on, entitled email, quota exhausted -> E111, fal never called', async function () {
  var calls = 0;
  global.fetch = async function () { calls++; return { ok: true, status: 200, json: async function () { return { request_id: 'x' }; } }; };
  await exhaustedEntitlement('exhausted@example.com');
  var res = await handler(genEvent({ body: { email: 'exhausted@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E111: quota_exceeded/);
  assert.equal(calls, 0);
});

test('paywall on, entitled email, exactly 1 remaining -> proceeds (E111 only fires at 0, not before)', async function () {
  stubFetchOk();
  await activeEntitlementWithRemaining('almost@example.com', 9);
  var res = await handler(genEvent({ body: { email: 'almost@example.com' } }));
  assert.equal(res.statusCode, 200);
});

test('paywall on, entitled email, quota exhausted but bonusCredits > 0 -> effectiveRemaining still positive, proceeds', async function () {
  stubFetchOk();
  await entitlements.setEntitlement({}, 'bonus@example.com', {
    active: true, plan: 'monthly',
    quota: { includedPerMonth: 10, used: 10, periodKey: currentPeriodKeyUtc() },
    bonusCredits: 2
  });
  var res = await handler(genEvent({ body: { email: 'bonus@example.com' } }));
  assert.equal(res.statusCode, 200);
});

test('paywall off (no override, PAYWALL_ENABLED unset) -> quota is never checked at all, even for a fully exhausted record', async function () {
  await paywallSettings.setOverride({}, false);
  stubFetchOk();
  await exhaustedEntitlement('exhausted2@example.com');
  var res = await handler(genEvent({ body: { email: 'exhausted2@example.com' } }));
  assert.equal(res.statusCode, 200, 'quota must be completely inert while the paywall is off');
});

// ----- Owner bypass -----

test('owner bypass skips the quota check too, even with an exhausted record', async function () {
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  stubFetchOk();
  await exhaustedEntitlement(OWNER_EMAIL);
  var res = await handler(genEvent({ body: { email: OWNER_EMAIL } }));
  assert.equal(res.statusCode, 200);
});

// ----- recordGenerationUsage on success -----

test('mock mode success increments quota.used by 1', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  await activeEntitlementWithRemaining('mockuser@example.com', 3);
  var res = await handler(genEvent({ body: { email: 'mockuser@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'mockuser@example.com');
  assert.equal(record.quota.used, 4);
});

test('real fal success increments quota.used by 1', async function () {
  stubFetchOk();
  await activeEntitlementWithRemaining('realuser@example.com', 3);
  var res = await handler(genEvent({ body: { email: 'realuser@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'realuser@example.com');
  assert.equal(record.quota.used, 4);
});

test('a fal submission rejection (E105) does NOT count against quota', async function () {
  stubFetchRejected();
  await activeEntitlementWithRemaining('rejected@example.com', 3);
  var res = await handler(genEvent({ body: { email: 'rejected@example.com' } }));
  assert.match(JSON.parse(res.body).error, /^E105:/);
  var record = await entitlements.getEntitlement({}, 'rejected@example.com');
  assert.equal(record.quota.used, 3, 'used must be unchanged after a rejected submission');
});

test('a network failure reaching fal (E107) does NOT count against quota', async function () {
  global.fetch = async function () { throw new Error('network down'); };
  await activeEntitlementWithRemaining('netfail@example.com', 3);
  var res = await handler(genEvent({ body: { email: 'netfail@example.com' } }));
  assert.match(JSON.parse(res.body).error, /^E107:/);
  var record = await entitlements.getEntitlement({}, 'netfail@example.com');
  assert.equal(record.quota.used, 3);
});

test('success with no email on the request is a safe no-op for quota recording (no crash)', async function () {
  await paywallSettings.setOverride({}, false); // ungated path, no email required to reach fal
  stubFetchOk();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
});
