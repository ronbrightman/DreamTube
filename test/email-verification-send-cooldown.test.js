// test/email-verification-send-cooldown.test.js
//
// Covers the SEND COOLDOWN fix (tracker item for-product-bug-founder-
// repro-08-09-veri-g71t7u, founder repro'd): signup
// (register-account-passwordless.js) sends a verification code, and
// SECONDS later js/email-verify-sheet.js's autoSendOnOpen() calls
// resend-verification-code.js -> lib/verification-email-sender.js ->
// lib/email-verification-store.js's createVerification AGAIN for the same
// account. Before this fix, createVerification unconditionally minted a
// fresh code and mailed it every single call, so a genuine second email
// went out with no server-side cooldown at all (resend-verification-
// code.js only ever had a per-IP DAILY cap, nothing shorter).
//
// OPT-IN SCOPE (round-1 self-caught regression, found by running the full
// suite before merging): an earlier version of this fix applied the
// cooldown unconditionally to every createVerification call. That broke
// register-account-passwordless.js's RESOLVE branch (a LOGIN mechanism
// that must mail a fresh code on every submission -- see that file's own
// header comment) and test/passwordless-signup.test.js's pre-existing
// "rolling window" tests (repeated resend-verification-code.js calls
// asserting each mints a genuinely distinct code). The cooldown is now
// opt-in via an `auto` flag threaded from js/email-verify-sheet.js's
// autoSendOnOpen alone -- see verification-email-sender.js's own header
// comment for the full "why opt-in" reasoning. Every other caller (signup
// itself, a manual "Resend" tap, the RESOLVE branch) is completely
// unaffected and keeps its pre-existing "always mint fresh" behavior.
//
// Exercises three layers:
//   - lib/email-verification-store.js's createVerification directly (the
//     cooldown/reuse mechanics themselves, via opts.respectCooldown)
//   - lib/verification-email-sender.js's sendVerificationEmail (translates
//     `reused:true` into "skip the actual Resend call", via opts.auto)
//   - the two real HTTP endpoints that chain into it end-to-end
//     (register-account-passwordless.js's create branch, then
//     resend-verification-code.js with auto:true standing in for the
//     sheet's autoSendOnOpen) — asserting the Resend spy only saw ONE call
//     across both, and that the code the user actually received still
//     verifies. Also proves a genuine manual resend (no `auto`) is NEVER
//     throttled, even seconds after signup -- the regression guard for the
//     round-1 bug this file's own header comment describes.
//
// Same test conventions as test/account-store.test.js /
// test/automatic-first-dream-email.test.js: node:test, mock-blobs for
// @netlify/blobs, a global.fetch double for Resend (see
// test/helpers/fetch-double.js). Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var realFetch = global.fetch;

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.19.0.' + ipCounter;
}

/** Same split-by-URL fetch double every other test file in this suite uses (see test/automatic-first-dream-email.test.js's installFetchSpy) — only Resend matters here. */
function installResendSpy() {
  var resendCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    if (urlStr.indexOf('api.resend.com') !== -1) {
      var body = opts && opts.body ? JSON.parse(opts.body) : null;
      resendCalls.push({ url: urlStr, body: body });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
  return resendCalls;
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  process.env.RESEND_API_KEY = 'resend-test-key';
  delete process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY;
  delete process.env.MAX_VERIFICATION_RESENDS_PER_IP_PER_DAY;
  delete require.cache[require.resolve('../netlify/functions/lib/email-verification-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/verification-email-sender')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-auth-token')];
  delete require.cache[require.resolve('../netlify/functions/register-account-passwordless')];
  delete require.cache[require.resolve('../netlify/functions/resend-verification-code')];
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
});

// ===== lib/email-verification-store.js directly =====

test('email-verification-store: createVerification reuses (no re-mint) when called again within the cooldown window WITH respectCooldown', async function () {
  var store = require('../netlify/functions/lib/email-verification-store');
  var event = fakeEvent({ method: 'POST' });

  var first = await store.createVerification(event, 'signupcooldown1', 'a@example.com', { respectCooldown: true });
  assert.equal(first.ok, true);
  assert.equal(first.reused, undefined);
  assert.ok(first.code);

  var second = await store.createVerification(event, 'signupcooldown1', 'a@example.com', { respectCooldown: true });
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.code, undefined, 'a reused response must not hand back a fresh code -- none was minted');

  // The original code the user actually received must still verify.
  var verified = await store.verifyCode(event, 'signupcooldown1', first.code);
  assert.equal(verified.ok, true);
});

test('email-verification-store: WITHOUT respectCooldown (the default), every call always mints a genuinely fresh code -- the opt-in guarantee every pre-existing caller relies on', async function () {
  var store = require('../netlify/functions/lib/email-verification-store');
  var event = fakeEvent({ method: 'POST' });

  var first = await store.createVerification(event, 'nocooldownuser1', 'z@example.com');
  assert.equal(first.ok, true);
  assert.equal(first.reused, undefined);

  // Called again immediately, no opts at all -- must NOT reuse, matching
  // register-account-passwordless.js's RESOLVE branch and a manual
  // "Resend" tap, both of which never pass respectCooldown.
  var second = await store.createVerification(event, 'nocooldownuser1', 'z@example.com');
  assert.equal(second.ok, true);
  assert.equal(second.reused, undefined, 'no respectCooldown opt-in means always mint fresh, regardless of timing');
  assert.ok(second.code);
});

test('email-verification-store: createVerification mints a genuinely fresh code once the cooldown window has elapsed', async function () {
  var store = require('../netlify/functions/lib/email-verification-store');
  var event = fakeEvent({ method: 'POST' });

  var first = await store.createVerification(event, 'signupcooldown2', 'b@example.com', { respectCooldown: true });
  assert.equal(first.ok, true);

  // Simulate the cooldown having elapsed by rewriting the record's
  // lastSentAt into the past -- same "seed prior state directly" pattern
  // mock-blobs.js's own header comment documents (account-store.test.js's
  // rate-limit tests do the equivalent via mockBlobs.seed).
  var raw = await require('@netlify/blobs').getStore({ name: store.STORE_NAME }).get('u:signupcooldown2', { type: 'json' });
  raw.lastSentAt = Date.now() - (store.SEND_COOLDOWN_MS + 1000);
  await require('@netlify/blobs').getStore({ name: store.STORE_NAME }).setJSON('u:signupcooldown2', raw);

  var second = await store.createVerification(event, 'signupcooldown2', 'b@example.com', { respectCooldown: true });
  assert.equal(second.ok, true);
  assert.equal(second.reused, undefined, 'past the cooldown window, this must be a genuine fresh mint');
  assert.ok(second.code);

  // Both the original and the fresh code still verify (rolling window).
  var verifiedOriginal = await store.verifyCode(event, 'signupcooldown2', first.code);
  assert.equal(verifiedOriginal.ok, true);
});

test('email-verification-store: a legacy record with no lastSentAt is never treated as recently-sent, even WITH respectCooldown', async function () {
  var store = require('../netlify/functions/lib/email-verification-store');
  var event = fakeEvent({ method: 'POST' });
  var blobs = require('@netlify/blobs').getStore({ name: store.STORE_NAME });

  // Seed a pre-fix-shaped record (no lastSentAt field at all).
  await blobs.setJSON('u:legacyuser1', {
    email: 'legacy@example.com',
    codeHash: 'deadbeef',
    linkToken: 'legacy-token',
    createdAt: Date.now(),
    expiresAt: Date.now() + store.TTL_MS,
    attempts: 0
  });

  var result = await store.createVerification(event, 'legacyuser1', 'legacy@example.com', { respectCooldown: true });
  assert.equal(result.ok, true);
  assert.equal(result.reused, undefined, 'a record with no lastSentAt must always mint fresh, never be treated as a recent send');
  assert.ok(result.code);
});

// ===== lib/verification-email-sender.js =====

test('verification-email-sender: opts.auto:true reuses within the cooldown, sends nothing, but still reports ok:true', async function () {
  var resendCalls = installResendSpy();
  var sender = require('../netlify/functions/lib/verification-email-sender');
  var event = fakeEvent({ method: 'POST' });

  var first = await sender.sendVerificationEmail(event, { username: 'sendercooldown1', email: 'c@example.com', auto: true });
  assert.equal(first.ok, true);
  assert.equal(first.sent, true);
  assert.equal(resendCalls.length, 1);

  var second = await sender.sendVerificationEmail(event, { username: 'sendercooldown1', email: 'c@example.com', auto: true });
  assert.equal(second.ok, true, 'the client-observable contract must stay ok:true even when the send is skipped');
  assert.equal(second.sent, false);
  assert.equal(second.skipped, 'recently_sent');
  assert.equal(resendCalls.length, 1, 'no second Resend call within the cooldown window');
});

test('verification-email-sender: WITHOUT opts.auto, back-to-back calls always send a genuine fresh email -- unaffected by the cooldown', async function () {
  var resendCalls = installResendSpy();
  var sender = require('../netlify/functions/lib/verification-email-sender');
  var event = fakeEvent({ method: 'POST' });

  await sender.sendVerificationEmail(event, { username: 'sendernocooldown1', email: 'd@example.com' });
  var second = await sender.sendVerificationEmail(event, { username: 'sendernocooldown1', email: 'd@example.com' });
  assert.equal(second.sent, true, 'no auto:true means no cooldown -- every call is a genuine send');
  assert.equal(resendCalls.length, 2);
});

// ===== End-to-end: signup send + the sheet's auto-send-on-open, chained =====

test('end-to-end: signup followed by the verify sheet auto-opening (auto:true) within the cooldown window results in exactly ONE email, and the code the user received still verifies', async function () {
  var resendCalls = installResendSpy();
  var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
  var resendHandler = require('../netlify/functions/resend-verification-code').handler;
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var ip = nextIp();

  // Signup: register-account-passwordless.js's CREATE branch sends the
  // first code (mirrors the real flow -- see that file's own header
  // comment "Branch 2 -- CREATE"). This call never sets `auto`.
  var signupRes = await registerHandler(fakeEvent({
    method: 'POST', ip: ip, body: { email: 'e2e-verify@example.com' }
  }));
  var signupBody = JSON.parse(signupRes.body);
  assert.equal(signupBody.ok, true);
  assert.equal(signupBody.created, true);
  assert.equal(resendCalls.length, 1, 'signup itself sends exactly one email');

  // Seconds later: the verify sheet auto-opens on the very next page
  // (home.html/shop.html's post-purchase trigger, etc. -- see js/email-
  // verify-sheet.js's autoSendOnOpen, which sets auto:true) and calls the
  // SAME endpoint the sheet's "Resend code" affordance uses.
  var sheetAuthToken = await accountAuthToken.mintToken(fakeEvent({ method: 'POST', ip: ip }), signupBody.username);
  var sheetRes = await resendHandler(fakeEvent({
    method: 'POST', ip: ip, body: { authToken: sheetAuthToken, auto: true }
  }));
  var sheetBody = JSON.parse(sheetRes.body);
  assert.equal(sheetBody.ok, true, 'the endpoint must still report ok:true so the sheet shows "code sent" regardless');

  assert.equal(resendCalls.length, 1, 'the sheet auto-open must NOT trigger a second real email within the cooldown window');

  // The code from the ORIGINAL signup email is the one the user actually
  // has -- it must still verify correctly, since no second code was ever
  // minted to replace it.
  var mintedCode = resendCalls[0].body.subject.split(': ')[1];
  var verifyStore = require('../netlify/functions/lib/email-verification-store');
  var verified = await verifyStore.verifyCode(fakeEvent({ method: 'POST' }), signupBody.username, mintedCode);
  assert.equal(verified.ok, true);
});

test('end-to-end: an auto:true sheet-open past the cooldown window results in a genuine fresh email', async function () {
  var resendCalls = installResendSpy();
  var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
  var resendHandler = require('../netlify/functions/resend-verification-code').handler;
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var verifyStore = require('../netlify/functions/lib/email-verification-store');
  var ip = nextIp();

  var signupRes = await registerHandler(fakeEvent({
    method: 'POST', ip: ip, body: { email: 'e2e-late-resend@example.com' }
  }));
  var signupBody = JSON.parse(signupRes.body);
  assert.equal(resendCalls.length, 1);

  // Fast-forward past the cooldown by rewriting the stored record's
  // lastSentAt directly (same technique as the store-level "elapsed"
  // test above) -- simulates a genuinely later auto sheet-open rather
  // than waiting a real 60s in the test.
  var blobs = require('@netlify/blobs').getStore({ name: verifyStore.STORE_NAME });
  var raw = await blobs.get('u:' + signupBody.username, { type: 'json' });
  raw.lastSentAt = Date.now() - (verifyStore.SEND_COOLDOWN_MS + 1000);
  await blobs.setJSON('u:' + signupBody.username, raw);

  var authToken = await accountAuthToken.mintToken(fakeEvent({ method: 'POST', ip: ip }), signupBody.username);
  var resendRes = await resendHandler(fakeEvent({
    method: 'POST', ip: ip, body: { authToken: authToken, auto: true }
  }));
  var resendBody = JSON.parse(resendRes.body);
  assert.equal(resendBody.ok, true);

  assert.equal(resendCalls.length, 2, 'past the cooldown window, an auto sheet-open must send a genuine fresh email');

  // The FRESH code (the one actually mailed on the second send) must
  // verify -- the original code is still in the rolling window too (both
  // are "real" codes the user might have received), but this specifically
  // checks the new send's own code works.
  var freshCode = resendCalls[1].body.subject.split(': ')[1];
  var verified = await verifyStore.verifyCode(fakeEvent({ method: 'POST' }), signupBody.username, freshCode);
  assert.equal(verified.ok, true);
});

test('end-to-end regression guard: a genuine manual "Resend" tap (no auto) right after signup is NEVER throttled -- it always sends a fresh email immediately', async function () {
  var resendCalls = installResendSpy();
  var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
  var resendHandler = require('../netlify/functions/resend-verification-code').handler;
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var ip = nextIp();

  var signupRes = await registerHandler(fakeEvent({
    method: 'POST', ip: ip, body: { email: 'e2e-manual-resend@example.com' }
  }));
  var signupBody = JSON.parse(signupRes.body);
  assert.equal(resendCalls.length, 1);

  // A manual "Resend" tap, seconds after signup, with NO auto field at
  // all (matching js/email-verify-sheet.js's manual link handler) -- this
  // is the exact call shape the round-1 regression broke (see this file's
  // own header comment) and must NEVER be silently absorbed.
  var authToken = await accountAuthToken.mintToken(fakeEvent({ method: 'POST', ip: ip }), signupBody.username);
  var manualRes = await resendHandler(fakeEvent({
    method: 'POST', ip: ip, body: { authToken: authToken }
  }));
  assert.equal(JSON.parse(manualRes.body).ok, true);
  assert.equal(resendCalls.length, 2, 'a manual resend must always send a genuine fresh email, with no cooldown, regardless of how soon after signup it happens');
});
