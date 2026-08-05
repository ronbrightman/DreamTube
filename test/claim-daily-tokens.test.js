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
  delete process.env.MAX_FIRST_CLAIMS_PER_IP_PER_DAY;
});

/** Seeds `email` as an account that has ALREADY completed its first-ever
 * claim (firstClaimAt stamped, tokens.lastClaimAt far enough in the past
 * to be immediately claimable again) -- so a subsequent claim attempt
 * against it is a genuine REPEAT, routed to the general "claim-ip"/
 * "claim-email" buckets rather than the separate first-ever-claim ones.
 * Used by tests that specifically want to exercise the general buckets
 * without a first claim's own separate, more generous bucket interfering
 * -- see claim-daily-tokens.js's own "FIRST-EVER-CLAIM EXEMPTION" doc
 * comment for why the two are scoped apart. */
function seedAlreadyClaimedOnce(ip, email) {
  return entitlements.setEntitlement(fakeEvent({ ip: ip }), email, {
    firstClaimAt: Date.now() - (48 * 60 * 60 * 1000),
    tokens: { balance: 100, lastClaimAt: Date.now() - (25 * 60 * 60 * 1000), streak: 3 }
  });
}

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
//
// The three tests below all pre-seed their emails as already-claimed-once
// (seedAlreadyClaimedOnce) SPECIFICALLY to exercise the general "claim-ip"/
// "claim-email" repeat buckets -- a genuinely first-ever claim now routes
// to its OWN separate, more generous bucket instead (see this file's own
// "FIRST-EVER-CLAIM EXEMPTION" doc comment, and the dedicated tests
// further below that exercise THAT bucket specifically).

test('MAX_CLAIMS_PER_IP_PER_DAY exceeded -> 429 E4, distinct from a legitimate claimed:false response', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  var emails = ['ratelimit1@example.com', 'ratelimit2@example.com', 'ratelimit3@example.com'];
  for (var i = 0; i < emails.length; i++) await seedAlreadyClaimedOnce(ip, emails[i]);
  var res1 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: emails[0] } }));
  var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: emails[1] } }));
  var res3 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: emails[2] } }));
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res3.statusCode, 429);
  assert.match(JSON.parse(res3.body).error, /^E4:/);
});

test('the per-email rate-limit bucket also applies -- repeated attempts on the SAME email from DIFFERENT IPs still hit the cap', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '2';
  var email = 'sameemail-diffip@example.com';
  await seedAlreadyClaimedOnce(nextIp(), email);
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

test('unset/invalid MAX_CLAIMS_PER_IP_PER_DAY falls back to a sane default rather than allowing unlimited REPEAT attempts', async function () {
  delete process.env.MAX_CLAIMS_PER_IP_PER_DAY;
  var ip = nextIp();
  var email = 'burstrepeat@example.com';
  await seedAlreadyClaimedOnce(ip, email);
  var results = [];
  for (var i = 0; i < 25; i++) {
    var res = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: email } }));
    results.push(res.statusCode);
  }
  assert.ok(results.indexOf(429) !== -1, 'the default cap must eventually kick in within 25 rapid repeat attempts from one IP');
});

// ----- FIRST-EVER-CLAIM EXEMPTION (2026-08-05, tracker item for-product-p1-urgent-fresh-signup-can-d-qhrrqy round 2) -----
// See this file's header comment for the full mechanism and abuse-surface
// reasoning: a genuinely first-ever claim is checked against separate
// "claim-ip-first"/"claim-email-first" buckets instead of the general
// "claim-ip"/"claim-email" ones, so a shared/CGNAT/founder-test-heavy IP's
// unrelated REPEAT-claim activity can never block a brand-new account's
// own rescue claim.

test('a fresh account whose IP already exhausted the general claim-ip bucket via OTHER accounts\' REPEAT claims still lands its own first-ever claim', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  var other1 = 'other1@example.com';
  var other2 = 'other2@example.com';
  var other3 = 'other3@example.com';
  await seedAlreadyClaimedOnce(ip, other1);
  await seedAlreadyClaimedOnce(ip, other2);
  await seedAlreadyClaimedOnce(ip, other3);
  await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: other1 } }));
  await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: other2 } }));
  var exhausted = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: other3 } }));
  assert.equal(exhausted.statusCode, 429, 'sanity: the general claim-ip bucket really is exhausted for this IP now');

  // A genuinely brand-new, never-claimed account on the SAME IP must
  // still be able to claim its own first-ever grant -- this is the exact
  // founder-hit dead end (many same-day test signups on one IP exhaust
  // the shared claim-ip bucket, blocking the ONE claim meant to rescue an
  // IP-capped signup).
  var res = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'freshvictim@example.com' } }));
  assert.equal(res.statusCode, 200, 'a genuinely first-ever claim must not be blocked by an unrelated exhausted claim-ip bucket');
  var body = JSON.parse(res.body);
  assert.equal(body.claimed, true);
  assert.equal(body.amountClaimed, 100, 'still just the normal first-claim amount -- this exemption never grants more than a first claim always would');
});

test('MAX_FIRST_CLAIMS_PER_IP_PER_DAY env override is honored and still caps first-ever claims (not an unconditional exemption)', async function () {
  process.env.MAX_FIRST_CLAIMS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  var res1 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'firstburst1@example.com' } }));
  var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'firstburst2@example.com' } }));
  var res3 = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'firstburst3@example.com' } }));
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res3.statusCode, 429, 'the first-claim bucket is still a finite cap, just a separate and more generous one than the general claim-ip bucket');
  assert.match(JSON.parse(res3.body).error, /^E4:/);
});

test('unset/invalid MAX_FIRST_CLAIMS_PER_IP_PER_DAY falls back to a sane, finite default', async function () {
  delete process.env.MAX_FIRST_CLAIMS_PER_IP_PER_DAY;
  var ip = nextIp();
  var results = [];
  for (var i = 0; i < 25; i++) {
    var res = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'firstdefaultburst' + i + '@example.com' } }));
    results.push(res.statusCode);
  }
  assert.ok(results.indexOf(429) !== -1, 'the default first-claim cap must eventually kick in within 25 rapid brand-new-email attempts from one IP -- it is isolated from repeat-claim traffic, not unlimited');
});

// ----- CEILING REGRESSION (2026-08-05, round 3 -- review finding on round
// 2). Round 2 originally shipped the dedicated first-claim bucket's default
// ABOVE the general claim-ip bucket's default (50 vs 20), reasoning it was
// "already bounded by the init cap" -- shown by review to be false (see
// claim-daily-tokens.js's own header comment and entitlements.js's
// FIRST_CLAIM_BONUS_AMOUNT doc comment for the corrected reasoning). The
// fix keeps the isolation (a first-claim burst no longer shares a bucket
// with repeat-claim traffic) while guaranteeing the dedicated bucket's
// ceiling never exceeds the general one -- i.e. this branch's net effect on
// the worst-case exploitable tokens/IP/day through this endpoint is <= 0,
// never a real increase.

test('the default first-claim bucket ceiling is never higher than the default general claim-ip bucket ceiling (isolation, not a raised ceiling)', async function () {
  // Empirically probes each bucket's real effective ceiling by exhausting
  // it through the actual handler, rather than hardcoding two literals
  // here that could silently drift out of sync with the real source
  // defaults in claim-daily-tokens.js.
  delete process.env.MAX_CLAIMS_PER_IP_PER_DAY;
  delete process.env.MAX_FIRST_CLAIMS_PER_IP_PER_DAY;

  var ip = nextIp();
  // Exhaust the GENERAL bucket first, via genuine repeats (never touches
  // the first-claim bucket -- see seedAlreadyClaimedOnce's own doc
  // comment), to find its real effective ceiling empirically.
  var generalCap = 0;
  for (var i = 0; i < 200; i++) {
    var email = 'generalcap-probe@example.com';
    if (i === 0) await seedAlreadyClaimedOnce(ip, email);
    var res = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: email } }));
    if (res.statusCode === 429) { generalCap = i; break; }
  }
  assert.ok(generalCap > 0, 'sanity: the general bucket must have a real, finite default ceiling');

  // Now do the same for the FIRST-claim bucket on a fresh IP, via genuine
  // first-ever claims (a fresh email every time, so every attempt is
  // routed to claim-ip-first, never claim-ip).
  var ip2 = nextIp();
  var firstCap = 0;
  for (var j = 0; j < 200; j++) {
    var res2 = await claimHandler(fakeEvent({ method: 'POST', ip: ip2, body: { email: 'firstcap-probe-' + j + '@example.com' } }));
    if (res2.statusCode === 429) { firstCap = j; break; }
  }
  assert.ok(firstCap > 0, 'sanity: the first-claim bucket must have a real, finite default ceiling');

  assert.ok(firstCap <= generalCap, 'the dedicated first-claim bucket\'s default ceiling (' + firstCap + ') must never exceed the general claim-ip bucket\'s default ceiling (' + generalCap + ') -- isolating first-claim traffic must not raise the worst-case exploitable ceiling on this endpoint');
});

test('a SECOND claim attempt for the same email is never treated as first-ever again, even moments after landing (exempts exactly one claim per account, not the account forever)', async function () {
  process.env.MAX_CLAIMS_PER_IP_PER_DAY = '1';
  process.env.MAX_FIRST_CLAIMS_PER_IP_PER_DAY = '50';
  var ip = nextIp();
  var email = 'onlyonceexempt@example.com';
  var first = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: email } }));
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).claimed, true);

  // MAX_CLAIMS_PER_IP_PER_DAY is 1 -- the general claim-ip bucket for this
  // IP should now already be at its cap from THIS second (repeat) call
  // alone landing on it, proving the first call did NOT consume it.
  var second = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: email } }));
  assert.equal(second.statusCode, 200, 'the repeat attempt itself is the FIRST thing to touch the general claim-ip bucket, so it is still under its cap of 1');
  assert.equal(JSON.parse(second.body).claimed, false, 'genuinely not yet claimable again so soon');

  var third = await claimHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: email } }));
  assert.equal(third.statusCode, 429, 'now the general claim-ip bucket (cap 1) is exhausted by repeat attempts, proving those -- and only those -- count against it');
});
