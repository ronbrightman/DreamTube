// test/generate-video-gate.test.js
//
// Covers the paywall-related gating logic in
// netlify/functions/generate-video.js: the override-vs-env-var precedence
// (via lib/paywall-settings.js) and the owner bypass — including that the
// bypass only ever skips the *entitlement* check, never the rate-limit
// (E109) or spend-guard (E110) safety nets. Rate-limit and spend-guard are
// each given their own dedicated Blobs store + key per test (unique IPs/
// emails, or a pre-seeded counter) so tests can't bleed into each other
// even though generate-video.js's module itself isn't re-required each
// time.
//
// fal.ai itself is stubbed via a fake global.fetch — these tests exercise
// the gate, not the fal integration (see the header comment in
// generate-video.js for that).

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
  return '10.0.0.' + ipCounter;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function stubFetchOk() {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
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

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.PAYWALL_ENABLED;
  delete process.env.OWNER_EMAIL;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- Precedence: override vs. PAYWALL_ENABLED env var -----

test('no override set, PAYWALL_ENABLED unset -> ungated, request proceeds', async function () {
  stubFetchOk();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
});

test('no override set, PAYWALL_ENABLED="true" -> gated, non-entitled email is rejected E108', async function () {
  process.env.PAYWALL_ENABLED = 'true';
  var res = await handler(genEvent({ body: { email: 'nobody@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E108: payment_required/);
});

test('override enabled=true wins even though PAYWALL_ENABLED is unset', async function () {
  await paywallSettings.setOverride({}, true);
  var res = await handler(genEvent({ body: { email: 'nobody@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E108: payment_required/);
});

test('override enabled=false wins even though PAYWALL_ENABLED="true"', async function () {
  stubFetchOk();
  process.env.PAYWALL_ENABLED = 'true';
  await paywallSettings.setOverride({}, false);
  var res = await handler(genEvent({ body: { email: 'nobody@example.com' } }));
  assert.equal(res.statusCode, 200);
});

test('override enabled=true + an entitled email proceeds normally', async function () {
  stubFetchOk();
  await paywallSettings.setOverride({}, true);
  await entitlements.setEntitlement({}, 'paying@example.com', { active: true, plan: 'monthly' });
  var res = await handler(genEvent({ body: { email: 'paying@example.com' } }));
  assert.equal(res.statusCode, 200);
});

// ----- Owner bypass -----

test('owner email skips the entitlement check even with the paywall on and no entitlement record', async function () {
  stubFetchOk();
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  await paywallSettings.setOverride({}, true);
  var res = await handler(genEvent({ body: { email: OWNER_EMAIL } }));
  assert.equal(res.statusCode, 200);
});

test('a non-owner email with the paywall on is still rejected E108, even with OWNER_EMAIL configured', async function () {
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  await paywallSettings.setOverride({}, true);
  var res = await handler(genEvent({ body: { email: 'not-the-owner@example.com' } }));
  assert.equal(res.statusCode, 402);
});

test('owner bypass is case/whitespace-insensitive, matching normalizeEmail everywhere else', async function () {
  stubFetchOk();
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  await paywallSettings.setOverride({}, true);
  var res = await handler(genEvent({ body: { email: '  Founder@DreamTube.EXAMPLE  ' } }));
  assert.equal(res.statusCode, 200);
});

test('owner bypass does NOT skip the rate limit (E109) — a pre-tripped counter still blocks the owner', async function () {
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  await paywallSettings.setOverride({}, true); // paywall on, so the bypass is actually doing something for the entitlement check
  var ip = nextIp();
  // Pre-seed today's per-IP counter at the default cap (20) so the very
  // next request from this IP is over the limit.
  mockBlobs.seed('dreamtube-rate-limits', 'ip:' + todayUtc() + ':' + ip, 20);

  var res = await handler(genEvent({ ip: ip, body: { email: OWNER_EMAIL } }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E109: rate_limited/);
});

test('owner bypass does NOT skip the spend guard (E110) — a pre-tripped daily cap still blocks the owner', async function () {
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.DAILY_SPEND_CAP_USD = '1';
  await paywallSettings.setOverride({}, true);
  // Pre-seed today's spend counter at (or above) the cap so the reservation check fails immediately.
  mockBlobs.seed('dreamtube-spend-guard', 'spend:' + todayUtc(), 1);

  var res = await handler(genEvent({ body: { email: OWNER_EMAIL } }));
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /^E110: daily_spend_cap_exceeded/);
});

test('with the paywall off, the owner bypass is simply a no-op (request already proceeds for everyone)', async function () {
  stubFetchOk();
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  // No override, PAYWALL_ENABLED unset -> ungated for everyone already.
  var res = await handler(genEvent({ body: { email: 'anyone@example.com' } }));
  assert.equal(res.statusCode, 200);
});
