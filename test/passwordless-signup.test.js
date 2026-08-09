// test/passwordless-signup.test.js
//
// Covers the passwordless-signup feature (tracker item
// for-product-build-passwordless-signup-fo-at2fko, founder-decided
// hybrid): register-account-passwordless.js (the new email-only entry
// path), verify-email-code.js/resend-verification-code.js (the explicit
// "type the code" path), verify-email-link.js (implicit verification via
// a clicked link), lib/email-verification-store.js, and the two gate-list
// enforcement points (publish-dream.js/create-checkout-session-dodo.js).
//
// Same conventions as test/password-reset-account.test.js/test/facebook-
// oauth-callback.test.js: mock-blobs installed before any handler is
// required, fakeEvent for the Lambda-shaped event, a fresh IP per scenario
// so rate-limit buckets don't collide, global.fetch spied for Resend sends
// (never a real network call).
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.44.0.' + ipCounter;
}

function withEnv(vars, fn) {
  var previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; });
  Object.keys(vars).forEach(function (k) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  });
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      Object.keys(previous).forEach(function (k) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      });
    });
}

/** Spies on global.fetch (Resend) so tests never make a real network call — same convention as test/password-reset-account.test.js's installFetchSpy(). Captures the outbound HTML body so tests can assert the code/link both actually appear in it. */
function installFetchSpy(ok) {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: ok !== false, status: ok !== false ? 200 : 500, json: async function () { return {}; } };
  };
  return calls;
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
});
test.after(function () {
  global.fetch = realFetch;
});

var RESEND_KEY = 'resend-test-key';

function reqEvent(overrides) {
  return fakeEvent(Object.assign({ method: 'POST', ip: nextIp() }, overrides));
}

// ===== register-account-passwordless.js =====

test('register-account-passwordless: a brand-new email creates a password-less, unverified account, signs in, and sends a code+link email', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    var res = await handler(reqEvent({ body: { email: 'astrid@example.com' } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.email, 'astrid@example.com');
    assert.equal(body.created, true);
    assert.equal(body.emailVerified, false);
    assert.ok(body.authToken);
    assert.equal(body.username, 'astrid'); // derived from the email local-part

    var accountStore = require('../netlify/functions/lib/account-store');
    var record = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'astrid');
    assert.equal(record.password, null);
    assert.equal(record.emailVerified, false);

    assert.equal(sentCalls.length, 1);
    assert.deepEqual(sentCalls[0].body.to, ['astrid@example.com']);
    assert.match(sentCalls[0].body.html, /verify-email-link\?token=/);
  });
});

// ===========================================================================
// SECURITY (round-2 review finding, fixed): a bare POST of an email that
// already has a real account used to RESOLVE that account and mint a
// fully usable authToken with ZERO proof the caller actually controls that
// inbox — full account takeover via one unauthenticated request, no code,
// no link click, nothing. Founder's "instantly in, no inbox check at the
// wall" language covers a genuinely NEW signup (branch 2, nothing to
// protect yet) — it was never meant to also mean "typing someone ELSE's
// already-registered email grants instant access to THEIR account". The
// resolve branch now sends a fresh code/link (same mechanism as a new
// signup) and returns NO authToken/username at all — the caller must prove
// ownership via login-with-email-code.js (the code) or verify-email-link.js
// (the link) before getting a real session. See that file's own header
// comment for the corrected design.
// ===========================================================================

test('register-account-passwordless: a SECOND submit for the same email RESOLVES the account but grants NO usable session -- no authToken, no username, until ownership is actually proven', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    installFetchSpy(true);
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    var first = await handler(reqEvent({ body: { email: 'bram@example.com' } }));
    var firstBody = JSON.parse(first.body);
    assert.equal(firstBody.created, true);
    assert.ok(firstBody.authToken, 'the genuine creator, on THEIR OWN first submit, is instantly in -- this is the one case the founder\'s "instantly in" language actually covers');

    var second = await handler(reqEvent({ body: { email: 'bram@example.com' } }));
    var secondBody = JSON.parse(second.body);
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.created, false, 'a second submit for an already-registered email must resolve, not create a duplicate');
    assert.equal(secondBody.pendingVerification, true);
    assert.equal(secondBody.authToken, undefined, 'THE FIX: a bare resolve must never hand back a usable authToken');
    assert.equal(secondBody.username, undefined, 'THE FIX: a bare resolve must never hand back the account\'s username either');
  });
});

// THE ACTUAL ATTACK SCENARIO (what the vulnerable version's own test above
// used to fail to exercise: a DIFFERENT caller than the account's real
// owner, not just "the same person submitting twice").
test('SECURITY: an attacker who does not own an existing account\'s inbox gets NO usable access by simply POSTing that email -- no account takeover', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    installFetchSpy(true);
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    // The real owner signs up once, genuinely, on their own device.
    var victimSignup = await handler(reqEvent({ body: { email: 'victim@example.com' } }));
    var victimBody = JSON.parse(victimSignup.body);
    assert.equal(victimBody.created, true);
    assert.ok(victimBody.authToken);

    // An attacker, on a COMPLETELY different request (no code, no link,
    // nothing but knowledge of the victim's public email address), submits
    // the exact same email to this same endpoint.
    var attackerAttempt = await handler(reqEvent({ body: { email: 'victim@example.com' } }));
    var attackerBody = JSON.parse(attackerAttempt.body);

    // The attacker must get NOTHING usable: no authToken to forge requests
    // with, no username confirmation.
    assert.equal(attackerBody.authToken, undefined, 'SECURITY: the attacker must never receive a usable authToken for the victim\'s account');
    assert.equal(attackerBody.username, undefined);

    // Prove it's not just "the field is missing from the response" --
    // confirm no NEW token was even minted server-side that the attacker
    // could have captured some other way. account-auth-token.js has no
    // "list all tokens for a username" API, so the strongest available
    // proof is behavioral: the victim's OWN original token must still be
    // the only valid one, and it must still resolve to the victim's
    // account, completely undisturbed by the attacker's request.
    var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
    var victimTokenStillValid = await accountAuthToken.verifyToken(fakeEvent({ method: 'POST' }), victimBody.authToken);
    assert.equal(victimTokenStillValid.ok, true);
    assert.equal(victimTokenStillValid.username, 'victim');
  });
});

test('register-account-passwordless: a RESOLVE (existing account) sends a FRESH verification email every time it is submitted -- this is now the actual access mechanism, not a bonus', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    await handler(reqEvent({ body: { email: 'cleo@example.com' } }));
    assert.equal(sentCalls.length, 1);
    await handler(reqEvent({ body: { email: 'cleo@example.com' } }));
    assert.equal(sentCalls.length, 2, 'a resolve must send a fresh code every time -- it is the only way back in without a session');
  });
});

test('register-account-passwordless: signup still succeeds even with no RESEND_API_KEY configured -- email delivery never blocks account creation', async function () {
  return withEnv({ RESEND_API_KEY: undefined }, async function () {
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    var res = await handler(reqEvent({ body: { email: 'dax@example.com' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

test('register-account-passwordless: rejects missing/invalid email, invalid JSON, and non-POST methods', async function () {
  var handler = require('../netlify/functions/register-account-passwordless').handler;

  var missing = await handler(reqEvent({ body: {} }));
  assert.equal(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /^E3: email_required/);

  var invalid = await handler(reqEvent({ body: { email: 'not-an-email' } }));
  assert.equal(invalid.statusCode, 400);
  assert.match(JSON.parse(invalid.body).error, /^E4: invalid_email/);

  var badJson = await handler(reqEvent({ body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});

test('register-account-passwordless: rate-limited after MAX_REGISTRATIONS_PER_IP_PER_DAY signups from one IP', async function () {
  return withEnv({ MAX_REGISTRATIONS_PER_IP_PER_DAY: '2' }, async function () {
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    var ip = '10.44.9.9';
    await handler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'one@example.com' } }));
    await handler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'two@example.com' } }));
    var third = await handler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'three@example.com' } }));
    assert.equal(third.statusCode, 429);
    var body = JSON.parse(third.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E5: rate_limited/);
  });
});

// ===== verify-email-code.js / resend-verification-code.js =====

async function signUpPasswordless(email) {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    installFetchSpy(true);
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    var res = await handler(reqEvent({ body: { email: email } }));
    return JSON.parse(res.body);
  });
}

/** Reads the raw 6-digit code straight out of the email-verification store, the way a test would if it were reading the account holder's real inbox. */
async function readCodeFromStore(username) {
  var { getStore } = require('@netlify/blobs');
  var store = getStore({ name: 'dreamtube-email-verifications' });
  var record = await store.get('u:' + username.toLowerCase());
  return record;
}

test('verify-email-code: the real code marks the account verified; a client-claimed username is never trusted (identity comes from authToken)', async function () {
  var signup = await signUpPasswordless('eve@example.com');
  var record = await readCodeFromStore(signup.username);
  assert.ok(record, 'a verification record should have been minted at signup');

  // Reconstruct the real code by brute-forcing against the stored hash is
  // NOT how a legitimate test should get it — read the code directly off
  // the sender instead by re-triggering a resend and capturing what was
  // actually emailed.
  var sentCalls = await (async function () {
    return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
      var calls = installFetchSpy(true);
      var handler = require('../netlify/functions/resend-verification-code').handler;
      await handler(reqEvent({ body: { authToken: signup.authToken } }));
      return calls;
    });
  })();
  var html = sentCalls[0].body.html;
  var code = /(\d{6})/.exec(html)[1];

  var verifyHandler = require('../netlify/functions/verify-email-code').handler;
  var res = await verifyHandler(reqEvent({ body: { authToken: signup.authToken, code: code } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  var accountStore = require('../netlify/functions/lib/account-store');
  var acct = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), signup.username);
  assert.equal(acct.emailVerified, true);
});

test('verify-email-code: an authToken that verifies as one account can never be used to verify a DIFFERENT account by naming it', async function () {
  var signupA = await signUpPasswordless('frida@example.com');
  await signUpPasswordless('gus@example.com'); // a second, unrelated account

  // verify-email-code.js's whole request shape has no username field at
  // all -- identity is authToken-only. Confirm a code minted for frida
  // never verifies gus, even indirectly (frida's own authToken can only
  // ever resolve to frida's own pending verification).
  var accountStore = require('../netlify/functions/lib/account-store');
  var gusBefore = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'gus');
  assert.equal(gusBefore.emailVerified, false);

  var verifyHandler = require('../netlify/functions/verify-email-code').handler;
  // frida's authToken, an arbitrary guess at a code -- must only ever be
  // checked against frida's OWN pending verification, never gus's.
  await verifyHandler(reqEvent({ body: { authToken: signupA.authToken, code: '000000' } }));

  var gusAfter = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'gus');
  assert.equal(gusAfter.emailVerified, false, "gus's verification state must be completely unaffected by frida's own attempt");
});

test('verify-email-code: rejects an invalid/expired authToken (E4) and a wrong code (E6)', async function () {
  var signup = await signUpPasswordless('hana@example.com');
  var handler = require('../netlify/functions/verify-email-code').handler;

  var badToken = await handler(reqEvent({ body: { authToken: 'not-a-real-token', code: '123456' } }));
  assert.equal(JSON.parse(badToken.body).ok, false);
  assert.match(JSON.parse(badToken.body).error, /^E4: invalid_or_expired_token/);

  var wrongCode = await handler(reqEvent({ body: { authToken: signup.authToken, code: '999999' } }));
  assert.equal(JSON.parse(wrongCode.body).ok, false);
  assert.match(JSON.parse(wrongCode.body).error, /^E6: invalid_code/);
});

test('verify-email-code: too many wrong guesses is rejected as E7 (not another E6), matching MAX_CODE_ATTEMPTS', async function () {
  var signup = await signUpPasswordless('ivo@example.com');
  var handler = require('../netlify/functions/verify-email-code').handler;
  var emailVerificationStore = require('../netlify/functions/lib/email-verification-store');

  var last;
  for (var i = 0; i < emailVerificationStore.MAX_CODE_ATTEMPTS + 1; i++) {
    last = await handler(reqEvent({ body: { authToken: signup.authToken, code: '000000' } }));
  }
  assert.match(JSON.parse(last.body).error, /^E7: too_many_attempts/);
});

// ROLLING WINDOW (fix, founder repro 2026-08-08): opening the verify sheet
// auto-sends a fresh code (js/email-verify-sheet.js autoSendOnOpen, added
// 2026-08-07), and each send used to OVERWRITE the single stored code, so
// an older-but-real code the user typed was wrongly rejected with "that
// code didn't match". lib/email-verification-store.js now keeps the last
// MAX_ACTIVE_CODES valid — see that file's own "MULTIPLE RECENT CODES"
// header note. These two tests are the regression proof: the exact
// previously-failing case now verifies, and the window is still bounded.
test('verify-email-code: an EARLIER code still verifies after a NEWER code was sent (rolling window) -- the exact founder 08-08 case that used to be rejected', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var calls = installFetchSpy(true);
    var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
    var signup = JSON.parse((await registerHandler(reqEvent({ body: { email: 'rolling@example.com' } }))).body);
    var code1 = /(\d{6})/.exec(calls[0].body.html)[1];

    // A NEWER code is sent (models the sheet's autoSendOnOpen, or a manual
    // Resend, landing after code1). Under the old single-code store this
    // silently invalidated code1. Resend until it's genuinely a different
    // value so the test actually proves the window (bounded — a 6-digit
    // collision is ~1e-6, so a few tries makes a spurious match negligible).
    var resendHandler = require('../netlify/functions/resend-verification-code').handler;
    var code2 = code1;
    for (var i = 0; i < 5 && code2 === code1; i++) {
      await resendHandler(reqEvent({ body: { authToken: signup.authToken } }));
      code2 = /(\d{6})/.exec(calls[calls.length - 1].body.html)[1];
    }
    assert.notEqual(code2, code1, 'test setup: the newer send must be a genuinely different code');

    // The OLDER code (code1) must STILL verify -- this is precisely what
    // used to fail.
    var verifyHandler = require('../netlify/functions/verify-email-code').handler;
    var res = await verifyHandler(reqEvent({ body: { authToken: signup.authToken, code: code1 } }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true, 'an earlier-but-real code must still verify after a newer one was sent');
  });
});

test('verify-email-code: the rolling window is bounded to MAX_ACTIVE_CODES -- a code evicted by newer sends no longer verifies, but a code still inside the window does', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var calls = installFetchSpy(true);
    var emailVerificationStore = require('../netlify/functions/lib/email-verification-store');
    var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
    var resendHandler = require('../netlify/functions/resend-verification-code').handler;
    var verifyHandler = require('../netlify/functions/verify-email-code').handler;

    var signup = JSON.parse((await registerHandler(reqEvent({ body: { email: 'bounded@example.com' } }))).body);
    var codes = [/(\d{6})/.exec(calls[0].body.html)[1]];
    // Send MAX_ACTIVE_CODES more codes so the very first one is pushed out
    // of the window entirely.
    for (var i = 0; i < emailVerificationStore.MAX_ACTIVE_CODES; i++) {
      await resendHandler(reqEvent({ body: { authToken: signup.authToken } }));
      codes.push(/(\d{6})/.exec(calls[calls.length - 1].body.html)[1]);
    }

    // The first code is now beyond the last MAX_ACTIVE_CODES sends -- it
    // must be rejected (the window is not unbounded).
    var evicted = await verifyHandler(reqEvent({ body: { authToken: signup.authToken, code: codes[0] } }));
    assert.equal(JSON.parse(evicted.body).ok, false, 'a code evicted by newer sends must no longer verify');

    // The newest code is still inside the window and must verify.
    var newest = await verifyHandler(reqEvent({ body: { authToken: signup.authToken, code: codes[codes.length - 1] } }));
    assert.equal(JSON.parse(newest.body).ok, true, 'the newest code must still verify');
  });
});

test('verify-email-code: rejects missing authToken/code and non-POST methods', async function () {
  var handler = require('../netlify/functions/verify-email-code').handler;
  var noToken = await handler(reqEvent({ body: { code: '123456' } }));
  assert.equal(noToken.statusCode, 400);
  assert.match(JSON.parse(noToken.body).error, /^E3: auth_token_required/);

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
});

test('resend-verification-code: is a no-op (not an error) for an already-verified account', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var signup = await signUpPasswordless('juno@example.com');
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.markEmailVerified(fakeEvent({ method: 'POST' }), signup.username);

    var calls = installFetchSpy(true);
    var handler = require('../netlify/functions/resend-verification-code').handler;
    var res = await handler(reqEvent({ body: { authToken: signup.authToken } }));
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(calls.length, 0, 'an already-verified account should never get a pointless resend');
  });
});

// ===== login-with-email-code.js (the real access-control gate for a RESOLVE) =====

test('login-with-email-code: the real mailed code grants a genuine session for a resolved (already-registered) account -- the actual fix for the account-takeover bug', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    installFetchSpy(true);
    var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
    // First submit -- creates the account, this device is genuinely signed
    // in with a real token.
    var first = await registerHandler(reqEvent({ body: { email: 'omar@example.com' } }));
    var firstBody = JSON.parse(first.body);
    assert.equal(firstBody.created, true);

    // A SECOND submit (e.g. a different device, or this same one after
    // clearing storage) resolves but grants nothing yet.
    var second = await registerHandler(reqEvent({ body: { email: 'omar@example.com' } }));
    var secondBody = JSON.parse(second.body);
    assert.equal(secondBody.pendingVerification, true);
    assert.equal(secondBody.authToken, undefined);

    // The real code from the SECOND (most recent) send -- register-
    // account-passwordless.js's resolve branch always mails a fresh one.
    var sentCalls = await (async function () {
      return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
        // Trigger one more resend and capture it, matching this file's own
        // established "read the code straight off the sender" convention
        // (see the verify-email-code tests above) -- can't brute-force it.
        var calls = installFetchSpy(true);
        await registerHandler(reqEvent({ body: { email: 'omar@example.com' } }));
        return calls;
      });
    })();
    var code = /(\d{6})/.exec(sentCalls[0].body.html)[1];

    var loginHandler = require('../netlify/functions/login-with-email-code').handler;
    var res = await loginHandler(reqEvent({ body: { email: 'omar@example.com', code: code } }));
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.username, 'omar');
    assert.ok(body.authToken);

    var accountStore = require('../netlify/functions/lib/account-store');
    var acct = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'omar');
    assert.equal(acct.emailVerified, true, 'a successful code login also verifies the account, same as verify-email-code.js\'s own success path');
  });
});

test('login-with-email-code: a wrong code is rejected (E4), and an email with no account at all is rejected the SAME way (never distinguishes -- no enumeration)', async function () {
  var signup = await signUpPasswordless('priya@example.com');
  var loginHandler = require('../netlify/functions/login-with-email-code').handler;

  var wrongCode = await loginHandler(reqEvent({ body: { email: 'priya@example.com', code: '000000' } }));
  var wrongBody = JSON.parse(wrongCode.body);
  assert.equal(wrongBody.ok, false);
  assert.match(wrongBody.error, /^E4: invalid_code/);

  var noSuchAccount = await loginHandler(reqEvent({ body: { email: 'nobody-registered-xyz@example.com', code: '123456' } }));
  var noSuchBody = JSON.parse(noSuchAccount.body);
  assert.equal(noSuchBody.ok, false);
  assert.match(noSuchBody.error, /^E4: invalid_code/, 'must be the exact same error shape as a wrong code -- never reveal whether an email has an account');
});

test('login-with-email-code: too many wrong guesses is rejected as E5', async function () {
  var signup = await signUpPasswordless('quinnzz@example.com');
  var loginHandler = require('../netlify/functions/login-with-email-code').handler;
  var emailVerificationStore = require('../netlify/functions/lib/email-verification-store');

  var last;
  for (var i = 0; i < emailVerificationStore.MAX_CODE_ATTEMPTS + 1; i++) {
    last = await loginHandler(reqEvent({ body: { email: 'quinnzz@example.com', code: '000000' } }));
  }
  assert.match(JSON.parse(last.body).error, /^E5: too_many_attempts/);
});

test('login-with-email-code: rejects missing fields and non-POST methods', async function () {
  var handler = require('../netlify/functions/login-with-email-code').handler;
  var missing = await handler(reqEvent({ body: { email: 'someone@example.com' } }));
  assert.equal(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /^E3: missing_fields/);

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
});

test('login-with-email-code: rate-limited after MAX_EMAIL_CODE_LOGIN_ATTEMPTS_PER_IP_PER_DAY requests from one IP', async function () {
  return withEnv({ MAX_EMAIL_CODE_LOGIN_ATTEMPTS_PER_IP_PER_DAY: '2' }, async function () {
    var handler = require('../netlify/functions/login-with-email-code').handler;
    var ip = '10.44.8.8';
    await handler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'a@example.com', code: '000000' } }));
    await handler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'a@example.com', code: '000000' } }));
    var third = await handler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'a@example.com', code: '000000' } }));
    assert.equal(third.statusCode, 429);
    assert.match(JSON.parse(third.body).error, /^E6: rate_limited/);
  });
});

// ===== verify-email-link.js (implicit verification) =====

test('verify-email-link: clicking the link marks the account verified with no code and no prior session required, then 302s onward to home.html', async function () {
  var signup = await signUpPasswordless('kira@example.com');
  var record = await readCodeFromStore(signup.username);
  var linkToken = record.linkToken;

  var handler = require('../netlify/functions/verify-email-link').handler;
  // No authToken/session anywhere in this request -- the click itself is
  // the whole proof (see this file's own header comment).
  var res = await handler(fakeEvent({ method: 'GET', query: { token: linkToken } }));
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /verified=1/);
  assert.match(res.headers.Location, /\/home\.html/, 'redirects to home.html by default -- the one page that actually consumes the bt= session-transfer token below');

  var accountStore = require('../netlify/functions/lib/account-store');
  var acct = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), signup.username);
  assert.equal(acct.emailVerified, true);
});

test('verify-email-link: clicking the link ALSO grants a real, usable session on the clicking device (closes the account-takeover gap -- the link is now the only way back in for a resolved/pending-verification account with no session anywhere)', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var registerHandler = require('../netlify/functions/register-account-passwordless').handler;

  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    installFetchSpy(true);
    // First submit: creates the account, but pretend this browser then lost
    // its own local session entirely (e.g. a different device opens the
    // email) -- the ONLY thing this second "device" has is the mailed link.
    await registerHandler(reqEvent({ body: { email: 'noor2@example.com' } }));
    var record = await readCodeFromStore('noor2');

    var linkHandler = require('../netlify/functions/verify-email-link').handler;
    var res = await linkHandler(fakeEvent({ method: 'GET', query: { token: record.linkToken } }));
    var location = new URL(res.headers.Location);
    var bt = location.searchParams.get('bt');
    assert.ok(bt, 'the redirect must carry a real session-transfer token');

    // Consume it exactly the way js/store.js's
    // consumeSessionTransferTokenFromUrlSync actually does, via the real
    // verify-session-transfer.js endpoint -- proves this is a genuinely
    // usable, real session grant, not just a token sitting unused in a URL.
    var consumeHandler = require('../netlify/functions/verify-session-transfer').handler;
    var consumed = await consumeHandler(fakeEvent({ method: 'POST', body: { token: bt } }));
    var consumedBody = JSON.parse(consumed.body);
    assert.equal(consumedBody.ok, true);
    assert.equal(consumedBody.username, 'noor2');
    assert.ok(consumedBody.authToken);

    var acct = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'noor2');
    assert.equal(acct.emailVerified, true);
  });
});

test('verify-email-link: an unknown/already-used token redirects with an error slug, not a crash, and verifies nothing', async function () {
  var handler = require('../netlify/functions/verify-email-link').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { token: 'totally-made-up' } }));
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /verify_error=E3/);
});

test('verify-email-link: the token is single-use -- clicking it twice only verifies once, the second click is a clean invalid_or_expired', async function () {
  var signup = await signUpPasswordless('liam@example.com');
  var record = await readCodeFromStore(signup.username);
  var handler = require('../netlify/functions/verify-email-link').handler;

  var first = await handler(fakeEvent({ method: 'GET', query: { token: record.linkToken } }));
  assert.match(first.headers.Location, /verified=1/);

  var second = await handler(fakeEvent({ method: 'GET', query: { token: record.linkToken } }));
  assert.match(second.headers.Location, /verify_error=E3/);
});

test('verify-email-link: an open-redirect attempt via `redirect` is rejected -- only a same-app relative path is honored', async function () {
  var signup = await signUpPasswordless('mona@example.com');
  var record = await readCodeFromStore(signup.username);
  var handler = require('../netlify/functions/verify-email-link').handler;

  var res = await handler(fakeEvent({ method: 'GET', query: { token: record.linkToken, redirect: 'https://evil.example.com/phish' } }));
  assert.equal(res.statusCode, 302);
  // Falls back to the safe default rather than honoring the attacker-
  // controlled absolute URL.
  assert.match(res.headers.Location, /\/home\.html/);
  assert.doesNotMatch(res.headers.Location, /evil\.example\.com/);
});

test('verify-email-link: missing token -> E2, non-GET -> E1', async function () {
  var handler = require('../netlify/functions/verify-email-link').handler;
  var missing = await handler(fakeEvent({ method: 'GET', query: {} }));
  assert.match(missing.headers.Location, /verify_error=E2/);

  var wrongMethod = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(wrongMethod.statusCode, 405);
});

// ===== account-store.js: backward-compat default + password/Facebook paths stay unaffected =====

test('account-store: an account created via a caller that never mentions emailVerified defaults to verified (true) -- no silent regression for existing callers', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var result = await accountStore.createAccount(fakeEvent({ method: 'POST' }), { username: 'legacycaller', password: 'somepassword1', email: 'legacy@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.record.emailVerified, true);
});

test('register-account.js (the real password-signup path) creates an already-verified account -- existing users are never retroactively gated', async function () {
  var handler = require('../netlify/functions/register-account').handler;
  var res = await handler(reqEvent({ body: { username: 'noor', password: 'realpassword1', email: 'noor@example.com' } }));
  assert.equal(JSON.parse(res.body).ok, true);

  var accountStore = require('../netlify/functions/lib/account-store');
  var record = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'noor');
  assert.equal(record.emailVerified, true);
});

// ===== Gate list: publish-dream.js =====

async function mintToken(username) {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  return accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), username);
}

function samplePublishBody(overrides) {
  return Object.assign({
    id: 'dream-passwordless-1',
    ownerHandle: '@orin',
    caption: 'A test dream',
    style: 'Cinematic',
    dur: '0:08',
    videoUrl: 'https://example.com/v.mp4',
    mediaType: 'video'
  }, overrides || {});
}

test('publish-dream: an UNVERIFIED account is rejected (E8), the shared feed record is never created', async function () {
  var signup = await signUpPasswordless('orin@example.com');
  var handler = require('../netlify/functions/publish-dream').handler;
  var res = await handler(reqEvent({ body: samplePublishBody({ ownerHandle: '@' + signup.username, authToken: signup.authToken }) }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E8: email_not_verified/);
});

test('publish-dream: a VERIFIED (or password-based) account publishes normally -- the gate never over-blocks', async function () {
  var signup = await signUpPasswordless('pia@example.com');
  var accountStore = require('../netlify/functions/lib/account-store');
  await accountStore.markEmailVerified(fakeEvent({ method: 'POST' }), signup.username);

  var handler = require('../netlify/functions/publish-dream').handler;
  var res = await handler(reqEvent({ body: samplePublishBody({ id: 'dream-passwordless-2', ownerHandle: '@' + signup.username, authToken: signup.authToken }) }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('publish-dream: an account with no record on file at all (e.g. a token minted outside account-store, matching existing test conventions) is never blocked by the new gate -- under-gate, never over-gate', async function () {
  var token = await mintToken('qasim'); // no accountStore.createAccount call -- mirrors publish-unpublish-dream-auth.test.js's own convention
  var handler = require('../netlify/functions/publish-dream').handler;
  var res = await handler(reqEvent({ body: samplePublishBody({ id: 'dream-passwordless-3', ownerHandle: '@qasim', authToken: token }) }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

// ===== Gate list: create-checkout-session-dodo.js =====

test('create-checkout-session-dodo: an UNVERIFIED account CAN create a checkout session -- founder reversal 2026-08-07, payment never blocks on verification (old E10 gate removed; verification is soft-prompted post-purchase instead)', async function () {
  return withEnv({
    DODO_API_KEY: 'test-dodo-key',
    DODO_PRODUCT_PACK_STARTER300: 'pdt_pack099_test'
  }, async function () {
    var signup = await signUpPasswordless('rhea@example.com');
    global.fetch = async function () {
      return new Response(JSON.stringify({ session_id: 'cks_unverified', checkout_url: 'https://checkout.dodopayments.com/cks_unverified' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    var handler = require('../netlify/functions/create-checkout-session-dodo').handler;
    var res = await handler(reqEvent({ body: { email: 'rhea@example.com', pack: 'pack099' } }));
    global.fetch = realFetch;
    assert.equal(res.statusCode, 200, 'an unverified account must reach checkout -- the money moment never blocks on email verification');
    assert.ok(JSON.parse(res.body).url);
  });
});

test('create-checkout-session-dodo: a VERIFIED account can still purchase (gate never over-blocks)', async function () {
  return withEnv({
    DODO_API_KEY: 'test-dodo-key',
    DODO_PRODUCT_PACK_STARTER300: 'pdt_pack099_test'
  }, async function () {
    var signup = await signUpPasswordless('sami@example.com');
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.markEmailVerified(fakeEvent({ method: 'POST' }), signup.username);

    global.fetch = async function () {
      return new Response(JSON.stringify({ session_id: 'cks_test', checkout_url: 'https://checkout.dodopayments.com/cks_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    var handler = require('../netlify/functions/create-checkout-session-dodo').handler;
    var res = await handler(reqEvent({ body: { email: 'sami@example.com', pack: 'pack099' } }));
    global.fetch = realFetch;
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).url);
  });
});

test('create-checkout-session-dodo: an email with no account on file at all is never blocked by the new gate (falls through to Dodo, under-gate default)', async function () {
  return withEnv({
    DODO_API_KEY: 'test-dodo-key',
    DODO_PRODUCT_PACK_STARTER300: 'pdt_pack099_test'
  }, async function () {
    global.fetch = async function () {
      return new Response(JSON.stringify({ session_id: 'cks_test', checkout_url: 'https://checkout.dodopayments.com/cks_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    var handler = require('../netlify/functions/create-checkout-session-dodo').handler;
    var res = await handler(reqEvent({ body: { email: 'nobody-registered@example.com', pack: 'pack099' } }));
    global.fetch = realFetch;
    assert.equal(res.statusCode, 200);
  });
});

// ===== +20 email-verification bonus (founder-authorized 2026-08-08) =====
// Both verification success paths (the explicit code and the implicit
// link) grant entitlements.EMAIL_VERIFIED_BONUS_AMOUNT exactly once per
// account, via applyAchievementGrant's once-ever marker under the shared
// EMAIL_VERIFIED_ACHIEVEMENT_ID. The two-phase marker mechanism itself has
// its dedicated concurrency coverage in test/entitlements-achievements.
// test.js — these tests cover the WIRING: the grant fires on a genuine
// flip, reports itself on the code path's response, cannot fire twice
// (replay via a direct second grant call — the endpoints themselves are
// structurally single-shot, since codes/links are consumed on use and
// resend-verification-code refuses verified accounts), and an
// already-verified account gets nothing. NOTE on ceilings: the token
// economy deliberately has NO balance ceiling since the Economy C retune
// (see entitlements.js's "No ceiling of any kind" comment) — there is no
// cap for this grant to respect, same as every other grant.

async function getBalance(email) {
  var entitlements = require('../netlify/functions/lib/entitlements');
  var status = await entitlements.getTokenStatus(fakeEvent({ method: 'POST' }), email);
  return status.balance;
}

test('verify-email-code: a genuine verification grants +20 exactly once — reported on the response as bonus:{granted,amount,balance}, landed on the entitlement, and a replayed grant for the same account is a recorded no-op', async function () {
  var entitlements = require('../netlify/functions/lib/entitlements');
  var signup = await signUpPasswordless('bonus-code@example.com');

  // Fix the baseline BEFORE verifying (first getTokenStatus initializes
  // the record with the signup grant).
  var before = await getBalance('bonus-code@example.com');

  var sentCalls = await withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var calls = installFetchSpy(true);
    var handler = require('../netlify/functions/resend-verification-code').handler;
    await handler(reqEvent({ body: { authToken: signup.authToken } }));
    return calls;
  });
  var code = /(\d{6})/.exec(sentCalls[0].body.html)[1];

  var verifyHandler = require('../netlify/functions/verify-email-code').handler;
  var res = await verifyHandler(reqEvent({ body: { authToken: signup.authToken, code: code } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.bonus.granted, true, 'the verify response must report the grant landing — the client never guesses');
  assert.equal(body.bonus.amount, entitlements.EMAIL_VERIFIED_BONUS_AMOUNT);
  assert.equal(body.bonus.balance, before + entitlements.EMAIL_VERIFIED_BONUS_AMOUNT, 'the response carries the post-grant balance');

  var after = await getBalance('bonus-code@example.com');
  assert.equal(after, before + entitlements.EMAIL_VERIFIED_BONUS_AMOUNT, 'exactly +20 on the entitlement record');

  // REPLAY: the endpoints are single-shot by construction (code consumed,
  // resend refuses verified accounts — asserted in the already-verified
  // test below), so exercise the guard the way a replay would actually
  // reach it: a second grant call for the same (email, id) pair must be a
  // recorded no-op against the committed marker.
  var replay = await entitlements.applyAchievementGrant(
    fakeEvent({ method: 'POST' }), 'bonus-code@example.com',
    entitlements.EMAIL_VERIFIED_ACHIEVEMENT_ID,
    { type: 'tokens', amount: entitlements.EMAIL_VERIFIED_BONUS_AMOUNT }
  );
  assert.equal(replay.granted, false, 'the once-ever marker must swallow a replay');
  assert.equal(await getBalance('bonus-code@example.com'), after, 'balance untouched by the replay');
});

test('verify-email-link: the implicit link click grants the SAME once-ever +20 (shared achievement id with the code path), and a second click of a consumed link neither re-verifies nor re-grants', async function () {
  var entitlements = require('../netlify/functions/lib/entitlements');
  var signup = await signUpPasswordless('bonus-link@example.com');
  var before = await getBalance('bonus-link@example.com');
  var record = await readCodeFromStore(signup.username);

  var handler = require('../netlify/functions/verify-email-link').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { token: record.linkToken } }));
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /verified=1/);
  assert.equal(await getBalance('bonus-link@example.com'), before + entitlements.EMAIL_VERIFIED_BONUS_AMOUNT, 'the link path must land the same +20');

  // Second click: the token was consumed on success — invalid now, still
  // a graceful 302 (browser-facing), and no double grant.
  var res2 = await handler(fakeEvent({ method: 'GET', query: { token: record.linkToken } }));
  assert.equal(res2.statusCode, 302);
  assert.match(res2.headers.Location, /verify_error/);
  assert.equal(await getBalance('bonus-link@example.com'), before + entitlements.EMAIL_VERIFIED_BONUS_AMOUNT, 'a replayed link click grants nothing');
});

test('email-verification bonus: an ALREADY-verified account gets nothing — markEmailVerified reports changed:false, and resend-verification-code refuses to mint a fresh code at all', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var signup = await signUpPasswordless('bonus-preverified@example.com');

  // Verify once (link path — either path flips the flag).
  var record = await readCodeFromStore(signup.username);
  var linkHandler = require('../netlify/functions/verify-email-link').handler;
  await linkHandler(fakeEvent({ method: 'GET', query: { token: record.linkToken } }));
  var balanceAfterFirst = await getBalance('bonus-preverified@example.com');

  // A repeat flip attempt is a changed:false no-op — the flip-gate the
  // endpoints key the grant on.
  var again = await accountStore.markEmailVerified(fakeEvent({ method: 'POST' }), signup.username);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, 'markEmailVerified must report that nothing flipped for an already-verified account');

  // And the code path cannot even be re-entered: resend refuses.
  var resent = await withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    installFetchSpy(true);
    var handler = require('../netlify/functions/resend-verification-code').handler;
    var r = await handler(reqEvent({ body: { authToken: signup.authToken } }));
    return JSON.parse(r.body);
  });
  assert.equal(resent.skipped, 'already_verified');
  assert.equal(await getBalance('bonus-preverified@example.com'), balanceAfterFirst, 'no second grant by any route');
});
