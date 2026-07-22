// test/password-reset-account.test.js
//
// Covers the account-store side of the password-reset flow:
//   - request-password-reset.js's new server-side account lookup (it used
//     to have no account database at all, and blindly emailed whatever it
//     was given — see that file's header comment) and its anti-
//     enumeration property (same ok:true response, found or not).
//   - verify-password-reset.js's new `newPassword` parameter, which now
//     really does write the new password to lib/account-store.js in the
//     same call that consumes the token — the second half of the
//     "forgot-password doesn't work cross-device" bug (see
//     tracker.html's now-resolved accounts-dont-sync-across-devices item).
// Neither function had test coverage before this change; this file adds
// baseline coverage for both alongside the new behavior. Same patterns as
// test/admin-paywall-toggle.test.js / test/account-store.test.js.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var realFetch = global.fetch;

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

/** Spies on global.fetch (Resend) so tests never make a real network call — same convention as test/meta-capi.test.js's installFetchSpy(). */
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
  delete require.cache[require.resolve('../netlify/functions/request-password-reset')];
  delete require.cache[require.resolve('../netlify/functions/verify-password-reset')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
});
test.after(function () {
  global.fetch = realFetch;
});

var RESEND_KEY = 'resend-test-key';

// ===== request-password-reset.js =====

test('request-password-reset: a registered email gets a real Resend send + a stored token; response is a plain ok:true either way', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var registerHandler = require('../netlify/functions/register-account').handler;
    await registerHandler(fakeEvent({ method: 'POST', body: { username: 'nora', password: 'realpassword1', email: 'nora@example.com' } }));

    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/request-password-reset').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: 'Nora@Example.com' } }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(sentCalls.length, 1, 'expected exactly one Resend send for a real account');
    assert.deepEqual(sentCalls[0].body.to, ['nora@example.com']);
  });
});

test('request-password-reset: an email with no matching account sends nothing, but returns the exact same ok:true response (anti-enumeration)', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/request-password-reset').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: 'nobody-has-this@example.com' } }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(sentCalls.length, 0, 'no account matched -- nothing should be sent');
  });
});

test('request-password-reset: still returns ok:true even if the Resend send itself fails for a real account (never leaks existence via a different response)', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var registerHandler = require('../netlify/functions/register-account').handler;
    await registerHandler(fakeEvent({ method: 'POST', body: { username: 'oscar', password: 'realpassword1', email: 'oscar@example.com' } }));

    installFetchSpy(false); // Resend rejects the send
    var handler = require('../netlify/functions/request-password-reset').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: 'oscar@example.com' } }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  });
});

test('request-password-reset: rejects missing email, invalid JSON, and non-POST methods', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    var handler = require('../netlify/functions/request-password-reset').handler;

    var missingEmail = await handler(fakeEvent({ method: 'POST', body: {} }));
    assert.equal(missingEmail.statusCode, 400);
    assert.match(JSON.parse(missingEmail.body).error, /^E3: email_required/);

    var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);
    assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
  });
});

test('request-password-reset: rejects every request with a 500 when RESEND_API_KEY is not configured, regardless of email', async function () {
  return withEnv({ RESEND_API_KEY: undefined }, async function () {
    var handler = require('../netlify/functions/request-password-reset').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: 'anyone@example.com' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E4: missing_api_key/);
  });
});

// ===== verify-password-reset.js =====

/** Seeds a valid, unexpired reset token directly into the same Blobs store request-password-reset.js writes to. */
function seedResetToken(token, record) {
  mockBlobs.seed('dreamtube-password-resets', token, Object.assign({ expiresAt: Date.now() + 30 * 60 * 1000 }, record));
}

test('verify-password-reset: a plain peek (no consume, no newPassword) neither consumes the token nor touches the account store', async function () {
  seedResetToken('peek-token', { username: 'petra', email: 'petra@example.com' });
  var handler = require('../netlify/functions/verify-password-reset').handler;

  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'peek-token' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.username, 'petra');

  // Token still usable -- a peek must not have consumed it.
  var secondPeek = await handler(fakeEvent({ method: 'POST', body: { token: 'peek-token' } }));
  assert.equal(JSON.parse(secondPeek.body).ok, true);

  // No account was ever created server-side by a mere peek.
  var accountStore = require('../netlify/functions/lib/account-store');
  var record = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'petra');
  assert.equal(record, null);
});

test('verify-password-reset: consume:true with no newPassword behaves exactly as before -- consumes the token, no account-store write', async function () {
  seedResetToken('consume-only-token', { username: 'quinn', email: 'quinn@example.com' });
  var handler = require('../netlify/functions/verify-password-reset').handler;

  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'consume-only-token', consume: true } }));
  assert.equal(JSON.parse(res.body).ok, true);

  var reused = await handler(fakeEvent({ method: 'POST', body: { token: 'consume-only-token', consume: true } }));
  assert.equal(JSON.parse(reused.body).ok, false, 'token must not be reusable after being consumed');

  var accountStore = require('../netlify/functions/lib/account-store');
  var record = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'quinn');
  assert.equal(record, null, 'no newPassword was given -- nothing should have been written server-side');
});

test('verify-password-reset: consume:true + newPassword actually changes the password server-side, in the account store (the core fix)', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var registerHandler = require('../netlify/functions/register-account').handler;
  await registerHandler(fakeEvent({ method: 'POST', body: { username: 'ruth', password: 'oldpassword1', email: 'ruth@example.com' } }));

  seedResetToken('reset-with-password-token', { username: 'ruth', email: 'ruth@example.com' });
  var handler = require('../netlify/functions/verify-password-reset').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'reset-with-password-token', consume: true, newPassword: 'brandnewpassword1' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.username, 'ruth');

  var event = fakeEvent({ method: 'POST' });
  var oldFails = await accountStore.verifyLogin(event, 'ruth', 'oldpassword1');
  assert.equal(oldFails.ok, false);
  var newWorks = await accountStore.verifyLogin(event, 'ruth', 'brandnewpassword1');
  assert.equal(newWorks.ok, true);
});

test('verify-password-reset: newPassword also backfills a username that was never registered server-side before (a pre-fix, local-only account)', async function () {
  seedResetToken('backfill-token', { username: 'sam', email: 'sam@example.com' });
  var handler = require('../netlify/functions/verify-password-reset').handler;

  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });
  assert.equal(await accountStore.getByUsername(event, 'sam'), null, 'sanity check: nothing registered for sam yet');

  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'backfill-token', consume: true, newPassword: 'freshpassword1' } }));
  assert.equal(JSON.parse(res.body).ok, true);

  var login = await accountStore.verifyLogin(event, 'sam', 'freshpassword1');
  assert.equal(login.ok, true, 'sam should now be a real, server-side account, usable from any device');
});

test('verify-password-reset: two concurrent resets for the SAME account (e.g. two valid links open on two devices) -- exactly one applies cleanly, the loser gets E6 conflict with its own token left unconsumed and safe to retry', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  await registerHandler(fakeEvent({ method: 'POST', body: { username: 'tara', password: 'originalpw1', email: 'tara@example.com' } }));

  // Two independently-seeded tokens for the same account, same as two
  // different reset emails/links both still being valid at once.
  seedResetToken('tara-token-one', { username: 'tara', email: 'tara@example.com' });
  seedResetToken('tara-token-two', { username: 'tara', email: 'tara@example.com' });

  var handler = require('../netlify/functions/verify-password-reset').handler;
  var results = await Promise.all([
    handler(fakeEvent({ method: 'POST', body: { token: 'tara-token-one', consume: true, newPassword: 'devicepw-onexx' } })),
    handler(fakeEvent({ method: 'POST', body: { token: 'tara-token-two', consume: true, newPassword: 'devicepw-twoyy' } }))
  ]);
  var bodies = results.map(function (r) { return JSON.parse(r.body); });
  var winners = bodies.filter(function (b) { return b.ok; });
  var losers = bodies.filter(function (b) { return !b.ok; });

  assert.equal(winners.length, 1, 'exactly one of the two concurrent resets should apply');
  assert.equal(losers.length, 1);
  assert.match(losers[0].error, /^E6: conflict/);

  // The account must actually be usable with the WINNER's password --
  // never left in a broken/mixed state.
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });
  var winningIndex = bodies.indexOf(winners[0]);
  var winningPasswordActual = winningIndex === 0 ? 'devicepw-onexx' : 'devicepw-twoyy';
  var login = await accountStore.verifyLogin(event, 'tara', winningPasswordActual);
  assert.equal(login.ok, true);

  // The loser's own token was NOT consumed on a conflict -- safe to retry
  // the exact same request.
  var loserIndex = winningIndex === 0 ? 1 : 0;
  var loserToken = loserIndex === 0 ? 'tara-token-one' : 'tara-token-two';
  var retryRes = await handler(fakeEvent({ method: 'POST', body: { token: loserToken, consume: true, newPassword: 'retriedpw123' } }));
  assert.equal(JSON.parse(retryRes.body).ok, true, 'the conflicted request\'s own token must still be valid and usable on retry');
});

test('verify-password-reset: an invalid/expired token is rejected the same way regardless of whether newPassword was also sent', async function () {
  var handler = require('../netlify/functions/verify-password-reset').handler;

  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'never-existed', consume: true, newPassword: 'wouldbevalid1' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E4: invalid_or_expired/);
});

test('verify-password-reset: newPassword shorter than 8 characters is rejected with E5 before the token is even looked up', async function () {
  // Deliberately no token seeded at all -- if this reached the token
  // lookup it would hit E4 instead, so E5 proves the shape check runs first.
  var handler = require('../netlify/functions/verify-password-reset').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'irrelevant-token', consume: true, newPassword: 'short1' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E5: invalid_new_password/);
});

test('verify-password-reset: rejects missing token, invalid JSON, and non-POST methods', async function () {
  var handler = require('../netlify/functions/verify-password-reset').handler;

  var missingToken = await handler(fakeEvent({ method: 'POST', body: {} }));
  assert.equal(missingToken.statusCode, 400);
  assert.match(JSON.parse(missingToken.body).error, /^E3: token_required/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'DELETE' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});
