// test/email-login-behavioral.test.js
//
// Behavioral coverage for the one-tap-login-from-email feature (founder
// decision 2026-08-15: "make the recovery/return emails auto-login").
//
// The chain under test: a retention/recovery email carries a single-use,
// 7-day lib/email-login-token.js token pointed at netlify/functions/email-
// login.js (?elt=). Tapping it must (1) 302-redirect to the requested (allow-
// listed) destination carrying a FRESH lib/session-transfer-token.js ?bt=
// token, (2) consume the email-login token so a second tap no longer logs in,
// and (3) refuse a forged/absent token gracefully (redirect signed-out, no
// ?bt=) rather than erroring. This is the server half; js/store.js's
// consumeSessionTransferTokenFromUrlSync (covered elsewhere) turns the ?bt=
// into the actual local session on the landing page.
//
// Mirrors the sibling email/token tests: test/helpers/mock-blobs.js stands in
// for Netlify Blobs, so this exercises the real token store + redirect logic.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var emailLoginToken = require('../netlify/functions/lib/email-login-token');
var sessionTransferToken = require('../netlify/functions/lib/session-transfer-token');
var accountStore = require('../netlify/functions/lib/account-store');
var emailLogin = require('../netlify/functions/email-login');

function q(query) {
  return fakeEvent({ method: 'GET', headers: { host: 'dreamtube.life' }, query: query });
}

function locationOf(res) {
  return (res.headers && res.headers.Location) || '';
}

test('a valid email-login token 302-redirects to the requested allow-listed dest carrying a fresh ?bt= session-transfer token', async function () {
  var evt = q(null);
  await accountStore.createAccount(evt, { username: 'recoveruser', email: 'recover@real-user.com' });
  var token = await emailLoginToken.createToken(evt, 'recoveruser', 'recover@real-user.com');

  var res = await emailLogin.handler(q({ elt: token, dest: '/profile.html' }));

  assert.equal(res.statusCode, 302);
  var loc = new URL(locationOf(res));
  assert.equal(loc.pathname, '/profile.html', 'lands on the requested destination');
  var bt = loc.searchParams.get('bt');
  assert.ok(bt, 'carries a fresh ?bt= session-transfer token');

  // The bt token must be a REAL, consumable session-transfer token for the
  // right identity — the actual client login credential.
  var consumed = await sessionTransferToken.verifyAndConsumeToken(evt, bt);
  assert.equal(consumed.ok, true);
  assert.equal(consumed.username, 'recoveruser');
  assert.equal(consumed.email, 'recover@real-user.com');
});

test('the email-login token is single-use — a second tap redirects signed-out (no ?bt=)', async function () {
  var evt = q(null);
  await accountStore.createAccount(evt, { username: 'onceuser', email: 'once@real-user.com' });
  var token = await emailLoginToken.createToken(evt, 'onceuser', 'once@real-user.com');

  var first = await emailLogin.handler(q({ elt: token, dest: '/profile.html' }));
  assert.ok(new URL(locationOf(first)).searchParams.get('bt'), 'first tap logs in');

  var second = await emailLogin.handler(q({ elt: token, dest: '/profile.html' }));
  assert.equal(second.statusCode, 302, 'still a graceful redirect, never an error page');
  var loc = new URL(locationOf(second));
  assert.equal(loc.pathname, '/profile.html', 'still lands on the destination');
  assert.equal(loc.searchParams.get('bt'), null, 'but no ?bt= the second time — the token is spent');
});

test('an unknown/forged token redirects signed-out (no ?bt=), never errors', async function () {
  var res = await emailLogin.handler(q({ elt: 'deadbeef-not-a-real-token', dest: '/create.html' }));
  assert.equal(res.statusCode, 302);
  var loc = new URL(locationOf(res));
  assert.equal(loc.pathname, '/create.html');
  assert.equal(loc.searchParams.get('bt'), null);
});

test('a missing token redirects signed-out, never errors', async function () {
  var res = await emailLogin.handler(q({ dest: '/profile.html' }));
  assert.equal(res.statusCode, 302);
  assert.equal(new URL(locationOf(res)).searchParams.get('bt'), null);
});

test('a non-allow-listed dest is ignored — falls back to /home.html (no open-redirect off the allow-list)', async function () {
  var evt = q(null);
  await accountStore.createAccount(evt, { username: 'destuser', email: 'dest@real-user.com' });
  var token = await emailLoginToken.createToken(evt, 'destuser', 'dest@real-user.com');

  var res = await emailLogin.handler(q({ elt: token, dest: 'https://evil.example.com/phish' }));
  assert.equal(res.statusCode, 302);
  var loc = new URL(locationOf(res));
  assert.equal(loc.host, 'dreamtube.life', 'stays same-origin');
  assert.equal(loc.pathname, '/home.html', 'a non-allow-listed dest falls back to the safe default');
});

test('POST is rejected (405) — this is a GET redirect target only', async function () {
  var res = await emailLogin.handler(fakeEvent({ method: 'POST', headers: { host: 'dreamtube.life' } }));
  assert.equal(res.statusCode, 405);
});

test('an expired email-login token redirects signed-out (no ?bt=)', async function () {
  var evt = q(null);
  await accountStore.createAccount(evt, { username: 'expireduser', email: 'expired@real-user.com' });
  var token = await emailLoginToken.createToken(evt, 'expireduser', 'expired@real-user.com');

  // Force the stored record past its TTL, then confirm consume + endpoint both
  // treat it as invalid.
  var { getStore } = require('@netlify/blobs');
  var store = getStore({ name: emailLoginToken.STORE_NAME });
  var rec = await store.get(token, { type: 'json' });
  rec.expiresAt = Date.now() - 1000;
  await store.setJSON(token, rec);

  var res = await emailLogin.handler(q({ elt: token, dest: '/profile.html' }));
  assert.equal(res.statusCode, 302);
  assert.equal(new URL(locationOf(res)).searchParams.get('bt'), null, 'expired token grants no session');
});

test('email-click tracking: a valid login forwards ?ec= onto the redirect so the landing page can fire email_link_clicked', async function () {
  var evt = q(null);
  await accountStore.createAccount(evt, { username: 'ecuser', email: 'ec@real-user.com' });
  var token = await emailLoginToken.createToken(evt, 'ecuser', 'ec@real-user.com');

  var res = await emailLogin.handler(q({ elt: token, dest: '/home.html', ec: 'recovery_nudge' }));
  var url = new URL(locationOf(res));
  assert.equal(res.statusCode, 302);
  assert.equal(url.pathname, '/home.html');
  assert.ok(url.searchParams.get('bt'), 'still mints the session token');
  assert.equal(url.searchParams.get('ec'), 'recovery_nudge', 'the email-click marker is forwarded to the landing page');
});

test('email-click tracking: ?ec= is forwarded even when the token is missing/invalid (a click is a click)', async function () {
  var res = await emailLogin.handler(q({ dest: '/home.html', ec: 'recovery_nudge' }));
  var url = new URL(locationOf(res));
  assert.equal(res.statusCode, 302);
  assert.equal(url.searchParams.get('ec'), 'recovery_nudge', 'ec forwarded on the missing-token path too');
  assert.equal(url.searchParams.get('bt'), null, 'but no session is granted without a valid token');
});

test('email-click tracking: an ordinary login with no ?ec= carries no ec param (no pollution)', async function () {
  var evt = q(null);
  await accountStore.createAccount(evt, { username: 'noecuser', email: 'noec@real-user.com' });
  var token = await emailLoginToken.createToken(evt, 'noecuser', 'noec@real-user.com');

  var res = await emailLogin.handler(q({ elt: token, dest: '/home.html' }));
  var url = new URL(locationOf(res));
  assert.equal(url.searchParams.get('ec'), null, 'no ec param when the link did not carry one');
});
