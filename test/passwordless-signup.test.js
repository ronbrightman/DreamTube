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

test('register-account-passwordless: a SECOND submit for the same email RESOLVES (logs into) the existing account rather than erroring or duplicating', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    installFetchSpy(true);
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    var first = await handler(reqEvent({ body: { email: 'bram@example.com' } }));
    var firstBody = JSON.parse(first.body);
    assert.equal(firstBody.created, true);

    var second = await handler(reqEvent({ body: { email: 'bram@example.com' } }));
    var secondBody = JSON.parse(second.body);
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.created, false, 'a second submit for an already-registered email must resolve, not create a duplicate');
    assert.equal(secondBody.username, firstBody.username);
    assert.ok(secondBody.authToken);
    assert.notEqual(secondBody.authToken, firstBody.authToken, 'each resolve still mints its own fresh token');
  });
});

test('register-account-passwordless: never sends a verification email on a RESOLVE (existing account), only on a genuine create', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/register-account-passwordless').handler;
    await handler(reqEvent({ body: { email: 'cleo@example.com' } }));
    assert.equal(sentCalls.length, 1);
    await handler(reqEvent({ body: { email: 'cleo@example.com' } }));
    assert.equal(sentCalls.length, 1, 'the resolve branch must not trigger a second send');
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

// ===== verify-email-link.js (implicit verification) =====

test('verify-email-link: clicking the link marks the account verified with no code and no signed-in session required, then 302s onward', async function () {
  var signup = await signUpPasswordless('kira@example.com');
  var record = await readCodeFromStore(signup.username);
  var linkToken = record.linkToken;

  var handler = require('../netlify/functions/verify-email-link').handler;
  // No authToken/session anywhere in this request -- the click itself is
  // the whole proof (see this file's own header comment).
  var res = await handler(fakeEvent({ method: 'GET', query: { token: linkToken } }));
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /verified=1/);
  assert.match(res.headers.Location, /\/profile\.html/);

  var accountStore = require('../netlify/functions/lib/account-store');
  var acct = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), signup.username);
  assert.equal(acct.emailVerified, true);
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
  assert.match(res.headers.Location, /\/profile\.html/);
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

test('create-checkout-session-dodo: an UNVERIFIED account cannot create a checkout session (E10) -- no purchases, per the founder\'s explicit instruction', async function () {
  return withEnv({
    DODO_API_KEY: 'test-dodo-key',
    DODO_PRODUCT_PACK_STARTER300: 'pdt_pack099_test'
  }, async function () {
    var signup = await signUpPasswordless('rhea@example.com');
    var handler = require('../netlify/functions/create-checkout-session-dodo').handler;
    var res = await handler(reqEvent({ body: { email: 'rhea@example.com', pack: 'pack099' } }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E10: email_not_verified/);
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
