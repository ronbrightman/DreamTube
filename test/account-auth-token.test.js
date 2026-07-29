// test/account-auth-token.test.js
//
// Covers the account-login.js/register-account.js half of the
// public-feed-safety security fix (tracker item
// for-product-public-feed-safety-in-app-re-ppuw77): both now mint a real
// lib/account-auth-token.js token on a genuine success and include it in
// their response, so block-user.js (see test/block-user.test.js) never has
// to trust a bare client-supplied username. This file covers the MINTING
// side specifically -- lib/account-auth-token.js's own mint/verify shape is
// covered directly in test/block-user.test.js.
//
// Also covers the ROUND-2 review finding, fixed: neither a password reset
// nor an account deletion used to invalidate previously-minted tokens for
// that username, which was a real, exploitable gap -- see
// lib/account-auth-token.js's own IDENTITY-CUTOFF INVALIDATION header
// comment for the full "why" (a stolen-then-reset-away token surviving its
// full TTL; worse, a deleted+reused username's OLD token still granting
// the original holder access to a brand-new, unrelated account).
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

/** Seeds a valid, unexpired reset token directly into the same Blobs store request-password-reset.js writes to -- same helper test/password-reset-account.test.js already uses. */
function seedResetToken(token, record) {
  mockBlobs.seed('dreamtube-password-resets', token, Object.assign({ expiresAt: Date.now() + 30 * 60 * 1000 }, record));
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/account-login')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/verify-password-reset')];
  delete require.cache[require.resolve('../netlify/functions/delete-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-auth-token')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
});

test('register-account: a successful signup response includes a real authToken that verifies to the new account\'s username', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var res = await registerHandler(fakeEvent({
    method: 'POST',
    ip: '10.0.0.1',
    body: { username: 'newuser', password: 'realpassword1', email: 'newuser@example.com' }
  }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(body.authToken, 'a real authToken must be present on a successful signup');

  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var verified = await accountAuthToken.verifyToken(fakeEvent({ method: 'GET' }), body.authToken);
  assert.equal(verified.ok, true);
  assert.equal(verified.username, 'newuser');
});

test('register-account: a REJECTED signup (username/email taken) carries no authToken at all', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  await registerHandler(fakeEvent({ method: 'POST', ip: '10.0.0.2', body: { username: 'taken', password: 'realpassword1', email: 'taken@example.com' } }));
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: '10.0.0.3', body: { username: 'taken', password: 'anotherpassword', email: 'other@example.com' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'authToken'), false);
});

test('account-login: a successful login response includes a real authToken that verifies to the account\'s username', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  await registerHandler(fakeEvent({ method: 'POST', ip: '10.0.0.4', body: { username: 'loginuser', password: 'realpassword1', email: 'loginuser@example.com' } }));

  var loginHandler = require('../netlify/functions/account-login').handler;
  var res = await loginHandler(fakeEvent({ method: 'POST', ip: '10.0.0.5', body: { usernameOrEmail: 'loginuser', password: 'realpassword1' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(body.authToken, 'a real authToken must be present on a successful login');

  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var verified = await accountAuthToken.verifyToken(fakeEvent({ method: 'GET' }), body.authToken);
  assert.equal(verified.ok, true);
  assert.equal(verified.username, 'loginuser');
});

test('account-login: an incorrect password carries no authToken at all', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  await registerHandler(fakeEvent({ method: 'POST', ip: '10.0.0.6', body: { username: 'wrongpassuser', password: 'realpassword1', email: 'wrongpassuser@example.com' } }));

  var loginHandler = require('../netlify/functions/account-login').handler;
  var res = await loginHandler(fakeEvent({ method: 'POST', ip: '10.0.0.7', body: { usernameOrEmail: 'wrongpassuser', password: 'wrongpassword' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'authToken'), false);
});

test('account-login: two separate logins for the same account each mint their own independent, both-valid token', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  await registerHandler(fakeEvent({ method: 'POST', ip: '10.0.0.8', body: { username: 'multidevice', password: 'realpassword1', email: 'multidevice@example.com' } }));

  var loginHandler = require('../netlify/functions/account-login').handler;
  var res1 = await loginHandler(fakeEvent({ method: 'POST', ip: '10.0.0.9', body: { usernameOrEmail: 'multidevice', password: 'realpassword1' } }));
  var res2 = await loginHandler(fakeEvent({ method: 'POST', ip: '10.0.0.10', body: { usernameOrEmail: 'multidevice', password: 'realpassword1' } }));
  var token1 = JSON.parse(res1.body).authToken;
  var token2 = JSON.parse(res2.body).authToken;
  assert.notEqual(token1, token2, 'each login mints its own distinct token, e.g. for two different devices');

  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });
  assert.equal((await accountAuthToken.verifyToken(event, token1)).ok, true);
  assert.equal((await accountAuthToken.verifyToken(event, token2)).ok, true);
});

// ===== lib/account-auth-token.js: invalidateTokensForUsername (round-2 fix) =====

test('lib/account-auth-token.js: invalidateTokensForUsername invalidates every token minted BEFORE it, but a NEW token minted after is unaffected', async function () {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });

  var oldToken = await accountAuthToken.mintToken(event, 'nora');
  assert.equal((await accountAuthToken.verifyToken(event, oldToken)).ok, true, 'sanity check -- valid before any cutoff');

  await accountAuthToken.invalidateTokensForUsername(event, 'nora');
  assert.equal((await accountAuthToken.verifyToken(event, oldToken)).ok, false, 'must be invalidated by the cutoff');

  var newToken = await accountAuthToken.mintToken(event, 'nora');
  assert.equal((await accountAuthToken.verifyToken(event, newToken)).ok, true, 'a token minted AFTER the cutoff must still verify normally');
});

test('lib/account-auth-token.js: invalidateTokensForUsername only affects the named username, not other accounts', async function () {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });

  var noraToken = await accountAuthToken.mintToken(event, 'nora');
  var priyaToken = await accountAuthToken.mintToken(event, 'priya');

  await accountAuthToken.invalidateTokensForUsername(event, 'nora');

  assert.equal((await accountAuthToken.verifyToken(event, noraToken)).ok, false);
  assert.equal((await accountAuthToken.verifyToken(event, priyaToken)).ok, true, "a different account's token must be completely unaffected");
});

test('lib/account-auth-token.js: invalidateTokensForUsername is a harmless no-op for an empty/invalid username', async function () {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });
  await assert.doesNotReject(accountAuthToken.invalidateTokensForUsername(event, ''));
  await assert.doesNotReject(accountAuthToken.invalidateTokensForUsername(event, null));
});

// ===== verify-password-reset.js: invalidates old tokens on a real reset (round-2 fix) =====

test('verify-password-reset: a successful password reset (consume:true + newPassword) invalidates every authToken minted before it; a fresh login after the reset mints a new, valid one', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var registerRes = await registerHandler(fakeEvent({ method: 'POST', ip: '20.0.0.1', body: { username: 'stolen', password: 'oldpassword1', email: 'stolen@example.com' } }));
  var preResetToken = JSON.parse(registerRes.body).authToken;

  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });
  assert.equal((await accountAuthToken.verifyToken(event, preResetToken)).ok, true, 'sanity check -- valid before the reset');

  seedResetToken('reset-token-for-stolen', { username: 'stolen', email: 'stolen@example.com' });
  var resetHandler = require('../netlify/functions/verify-password-reset').handler;
  var resetRes = await resetHandler(fakeEvent({ method: 'POST', body: { token: 'reset-token-for-stolen', consume: true, newPassword: 'brandnewpassword1' } }));
  assert.equal(JSON.parse(resetRes.body).ok, true);

  assert.equal((await accountAuthToken.verifyToken(event, preResetToken)).ok, false, 'a token minted BEFORE the reset (e.g. stolen/leaked) must no longer verify -- the exact gap the round-2 fix closes');

  var loginHandler = require('../netlify/functions/account-login').handler;
  var loginRes = await loginHandler(fakeEvent({ method: 'POST', ip: '20.0.0.2', body: { usernameOrEmail: 'stolen', password: 'brandnewpassword1' } }));
  var postResetToken = JSON.parse(loginRes.body).authToken;
  assert.equal((await accountAuthToken.verifyToken(event, postResetToken)).ok, true, 'a fresh login AFTER the reset must mint a normally-working token');
});

test('verify-password-reset: a plain peek or a consume-only reset (no newPassword) does NOT invalidate any existing token -- only a REAL password change does', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var registerRes = await registerHandler(fakeEvent({ method: 'POST', ip: '20.0.0.3', body: { username: 'untouched', password: 'password1', email: 'untouched@example.com' } }));
  var token = JSON.parse(registerRes.body).authToken;

  seedResetToken('peek-only-token', { username: 'untouched', email: 'untouched@example.com' });
  var resetHandler = require('../netlify/functions/verify-password-reset').handler;
  await resetHandler(fakeEvent({ method: 'POST', body: { token: 'peek-only-token' } }));

  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });
  assert.equal((await accountAuthToken.verifyToken(event, token)).ok, true, 'a mere peek (no newPassword) must not invalidate anything');
});

// ===== delete-account.js: invalidates old tokens on a real deletion, closing the identity-reuse gap (round-2 fix) =====

test('delete-account: a successful deletion invalidates every authToken minted for that username -- the token cannot be reused even after a DIFFERENT person later registers the same freed username', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var loginHandler = require('../netlify/functions/account-login').handler;
  var deleteHandler = require('../netlify/functions/delete-account').handler;
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });

  // The original holder registers a desirable username and keeps the token.
  var firstRegisterRes = await registerHandler(fakeEvent({ method: 'POST', ip: '20.0.0.4', body: { username: 'desirable', password: 'password1', email: 'original@example.com' } }));
  var originalToken = JSON.parse(firstRegisterRes.body).authToken;
  assert.equal((await accountAuthToken.verifyToken(event, originalToken)).ok, true);

  // They delete the account (but keep the token they minted earlier).
  var deleteRes = await deleteHandler(fakeEvent({ method: 'POST', ip: '20.0.0.5', body: { username: 'desirable', password: 'password1' } }));
  assert.equal(JSON.parse(deleteRes.body).ok, true);

  // The old token must be dead immediately, even before anyone else re-registers the name.
  assert.equal((await accountAuthToken.verifyToken(event, originalToken)).ok, false, 'a token from a deleted account must not verify');

  // A completely different real person later registers the SAME freed username.
  var secondRegisterRes = await registerHandler(fakeEvent({ method: 'POST', ip: '20.0.0.6', body: { username: 'desirable', password: 'differentpassword1', email: 'newowner@example.com' } }));
  assert.equal(JSON.parse(secondRegisterRes.body).ok, true, 'account-store.js has no cooldown on reusing a freed username');
  var newOwnerToken = JSON.parse(secondRegisterRes.body).authToken;

  // The ORIGINAL holder's old token must still be dead -- this is the exact
  // identity-reuse exploit the round-2 fix closes: without it, this old
  // token would still verify to "desirable" and silently grant the
  // original holder access to the NEW, unrelated account's blocklist.
  assert.equal((await accountAuthToken.verifyToken(event, originalToken)).ok, false, "the original holder's stale token must NOT grant access to the new account");
  // The new owner's own freshly-minted token works normally.
  assert.equal((await accountAuthToken.verifyToken(event, newOwnerToken)).ok, true);

  // Concretely, through block-user.js itself: the original holder's stale
  // token must be rejected as invalid, not silently resolve to the new
  // account.
  var blockUserHandler = require('../netlify/functions/block-user').handler;
  var blockRes = await blockUserHandler(fakeEvent({ method: 'GET', query: { authToken: originalToken } }));
  var blockBody = JSON.parse(blockRes.body);
  assert.equal(blockBody.ok, false);
  assert.match(blockBody.error, /^E6: invalid_or_expired_token/);
});

test('delete-account: an incorrect password never deletes anything and never invalidates the real account\'s token', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var deleteHandler = require('../netlify/functions/delete-account').handler;
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });

  var registerRes = await registerHandler(fakeEvent({ method: 'POST', ip: '20.0.0.7', body: { username: 'safeuser', password: 'realpassword1', email: 'safeuser@example.com' } }));
  var token = JSON.parse(registerRes.body).authToken;

  var deleteRes = await deleteHandler(fakeEvent({ method: 'POST', ip: '20.0.0.8', body: { username: 'safeuser', password: 'wrongpassword' } }));
  assert.equal(JSON.parse(deleteRes.body).ok, false);

  assert.equal((await accountAuthToken.verifyToken(event, token)).ok, true, "a failed deletion attempt must not touch the real account's token");
});
