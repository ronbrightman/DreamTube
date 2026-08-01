// test/claim-daily-tokens.test.js
//
// Handler-level coverage for netlify/functions/claim-daily-tokens.js —
// request validation, error codes, and its own dedicated rate-limit
// bucket. The actual claim/streak/cooldown logic is
// lib/entitlements.js's claimDailyTokens, exercised in depth by
// test/entitlements-daily-claim.test.js; this file only checks the thin
// HTTP wrapper around it (same split as test/token-functions.test.js vs.
// test/entitlements-tokens.test.js for get-token-status.js).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var claimHandler = require('../netlify/functions/claim-daily-tokens').handler;

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.12.0.' + ipCounter;
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

test('a brand-new email claims successfully -- 200, claimed:true, real balance/streak/nextClaimAt', async function () {
  var email = 'claimhandler@example.com';
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.getTokenStatus(ev, email); // materializes the 320-token record so the claim has something to add to

  var res = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.claimed, true);
  // 2026-07-28 first-claim-bonus amendment: this account's very first-ever
  // claim grants 100, not the normal 20.
  assert.equal(body.balance, 420, '320 + 100 first-ever-claim bonus');
  assert.equal(body.amountClaimed, 100);
  assert.equal(body.streak, 1);
  assert.equal(typeof body.nextClaimAt, 'number');
});

test('claiming again immediately -- 200 (NOT a 4xx/error), { claimed:false, nextClaimAt }', async function () {
  var email = 'claimtwice-handler@example.com';
  var ip = nextIp();
  await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: email } }));
  var res = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  assert.equal(res.statusCode, 200, 'not-yet-claimable is a normal outcome, not an error -- see this function\'s own doc comment');
  var body = JSON.parse(res.body);
  assert.equal(body.claimed, false);
  assert.equal(typeof body.nextClaimAt, 'number');
});

test('email is normalized (trimmed/lowercased) the same way every other entitlements-backed function does', async function () {
  var ip = nextIp();
  var res = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: '  MixedCase@Example.com  ' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).claimed, true);

  var record = await entitlements.getEntitlement(fakeEvent({ ip: ip }), 'mixedcase@example.com');
  assert.ok(record, 'the record was written under the normalized key');
});

// ----- Rate limiting: its OWN bucket, separate from generate-video.js's/generate-image.js's/register-account.js's -----

test('MAX_CLAIMS_PER_IP_PER_DAY exceeded -> 429 E4, distinct from a legitimate claimed:false response', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  var res1 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'ratelimit1@example.com' } }));
  var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'ratelimit2@example.com' } }));
  var res3 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'ratelimit3@example.com' } }));
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res3.statusCode, 429);
  assert.match(JSON.parse(res3.body).error, /^E4:/);
});

test('the per-email rate-limit bucket also applies -- repeated attempts on the SAME email from DIFFERENT IPs still hit the cap', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '2';
  var email = 'sameemail-diffip@example.com';
  var res1 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  var res3 = await claimHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: email } }));
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res3.statusCode, 429, 'same email, third attempt today, even from a fresh IP each time');
});

test('this bucket is scoped separately from generate-video.js/generate-image.js/register-account.js -- hitting THEIR limits does not affect claims from the same IP', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '1';
  process.env.MAX_GENERATIONS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  var rateLimit = require('../netlify/functions/lib/rate-limit');
  // Exhaust the (unrelated) 'ip' generation bucket for this IP directly.
  await rateLimit.checkAndIncrement(fakeEvent({ ip: ip }), 'ip', ip, 1);
  var exhausted = await rateLimit.checkAndIncrement(fakeEvent({ ip: ip }), 'ip', ip, 1);
  assert.equal(exhausted.allowed, false, 'sanity: the generation bucket really is exhausted for this IP');

  var res = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'ownbucket@example.com' } }));
  assert.equal(res.statusCode, 200, 'the claim endpoint has its own bucket ("claim-ip"), untouched by the generation endpoint\'s "ip" bucket');
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
});

test('unset/invalid MAX_CLAIMS_PER_IP_PER_DAY falls back to a sane default rather than allowing unlimited attempts', async function () {
  delete process.env.MAX_CLAIMS_PER_IP_PER_DAY;
  var ip = nextIp();
  var results = [];
  for (var i = 0; i < 25; i++) {
    var res = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'burst' + i + '@example.com' } }));
    results.push(res.statusCode);
  }
  assert.ok(results.indexOf(429) !== -1, 'the default cap must eventually kick in within 25 rapid attempts from one IP');
});
