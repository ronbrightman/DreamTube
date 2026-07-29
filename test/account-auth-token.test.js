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
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/account-login')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-auth-token')];
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
