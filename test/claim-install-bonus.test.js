// test/claim-install-bonus.test.js
//
// Handler-level coverage for netlify/functions/claim-install-bonus.js —
// tracker item for-product-build-ship-founder-approved--9ta1j0, "Home
// round 4"'s Make-it-yours setup card. Request validation, error codes,
// and its own dedicated rate-limit bucket, same split as test/claim-daily-
// tokens.test.js vs. test/entitlements-daily-claim.test.js: the actual
// once-per-account grant mechanism (lib/entitlements.js's
// applyAchievementGrant) already has its own dedicated coverage in
// test/entitlements-achievements.test.js — this file only checks the thin
// HTTP wrapper around it.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var claimHandler = require('../netlify/functions/claim-install-bonus').handler;

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.13.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.MAX_CLAIMS_PER_IP_PER_DAY;
});

test('non-POST method rejected E1', async function () {
  var res = await claimHandler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1:/);
});

test('invalid JSON body rejected E2', async function () {
  var res = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2:/);
});

test('missing/empty email rejected E3', async function () {
  var res1 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: {} }));
  var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: '   ' } }));
  assert.equal(res1.statusCode, 400);
  assert.match(JSON.parse(res1.body).error, /^E3:/);
  assert.equal(res2.statusCode, 400);
  assert.match(JSON.parse(res2.body).error, /^E3:/);
});

test('a brand-new account claims successfully -- 200, granted:true, real post-grant balance', async function () {
  var email = 'installbonushandler@example.com';
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, email); // materializes the 320-token INITIAL_GRANT record so the +100 has something to add to

  var res = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.granted, true);
  assert.equal(body.balance, 420, '320 + 100 install bonus');
});

test('claiming again for the same account -- 200 (NOT a 4xx/error), granted:false, never double-credits', async function () {
  var email = 'installbonustwice@example.com';
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, email);

  var res1 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  assert.equal(res1.statusCode, 200);
  assert.equal(JSON.parse(res1.body).granted, true);
  assert.equal(res2.statusCode, 200, 'an already-claimed account is a normal outcome, not an error');
  assert.equal(JSON.parse(res2.body).granted, false);

  var record = await entitlements.getEntitlement(fakeEvent({ ip: nextIp() }), email);
  assert.equal(record.tokens.balance, 420, 'the second call must never re-credit the +100');
});

test('email is normalized (trimmed/lowercased) the same way every other entitlements-backed function does', async function () {
  var ip = nextIp();
  var ev = fakeEvent({ ip: ip });
  await entitlements.getTokenStatus(ev, 'mixedcase-install@example.com');

  var res = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: '  MixedCase-Install@Example.com  ' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).granted, true);

  var record = await entitlements.getEntitlement(fakeEvent({ ip: ip }), 'mixedcase-install@example.com');
  assert.ok(record.achievements && record.achievements.home_install_verified, 'the grant ledger entry was written under the normalized key');
});

// ----- Rate limiting: its OWN bucket, separate from claim-daily-tokens.js's/generate-video.js's -----

test('MAX_CLAIMS_PER_IP_PER_DAY exceeded -> 429 E4, distinct from a legitimate granted:false response', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  var res1 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'installratelimit1@example.com' } }));
  var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'installratelimit2@example.com' } }));
  var res3 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'installratelimit3@example.com' } }));
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res3.statusCode, 429);
  assert.match(JSON.parse(res3.body).error, /^E4:/);
});

test('the per-email rate-limit bucket also applies -- repeated attempts on the SAME email from DIFFERENT IPs still hit the cap', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '2';
  var email = 'installsameemail-diffip@example.com';
  var res1 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  var res3 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res3.statusCode, 429, 'same email, third attempt today, even from a fresh IP each time');
});

test('this bucket is scoped separately from claim-daily-tokens.js -- hitting THAT limit does not affect this endpoint from the same IP', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  var claimDailyHandler = require('../netlify/functions/claim-daily-tokens').handler;
  await claimDailyHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'installseparatebucket-daily@example.com' } }));
  var dailyBlocked = await claimDailyHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'installseparatebucket-daily2@example.com' } }));
  assert.equal(dailyBlocked.statusCode, 429, 'sanity check: the daily-claim bucket really is exhausted for this IP');

  var installRes = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'installseparatebucket@example.com' } }));
  assert.equal(installRes.statusCode, 200, 'the install-bonus bucket must be unaffected by the daily-claim bucket being exhausted');
});
