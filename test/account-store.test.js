// test/account-store.test.js
//
// Covers netlify/functions/lib/account-store.js and the two Netlify
// Functions built on it: register-account.js (server-side signup, the
// authoritative username/email uniqueness check) and account-login.js
// (server-side login check). Together these are the fix for "accounts
// only work on the device they were created on" — see tracker.html's
// now-resolved accounts-dont-sync-across-devices item and
// AGENT_POLICY.md. Same patterns as test/admin-paywall-toggle.test.js /
// test/tracker.test.js. Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/account-login')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
});

// ===== lib/account-store.js directly =====

test('account-store: createAccount rejects a second account under the same username, even with a different email', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });

  var first = await accountStore.createAccount(event, { username: 'Alice', password: 'hunter22', email: 'alice@example.com' });
  assert.equal(first.ok, true);

  var second = await accountStore.createAccount(event, { username: 'ALICE', password: 'differentpw1', email: 'alice2@example.com' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'username_taken');
});

test('account-store: createAccount rejects a second account under the same email, even with a different username', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });

  var first = await accountStore.createAccount(event, { username: 'bob', password: 'hunter22', email: 'bob@example.com' });
  assert.equal(first.ok, true);

  var second = await accountStore.createAccount(event, { username: 'bobby', password: 'differentpw1', email: 'Bob@Example.com' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'email_taken');
});

test('account-store: getByUsername and getByEmail both resolve the same record after creation, case-insensitively', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });

  await accountStore.createAccount(event, { username: 'Carol', password: 'hunter22', email: 'Carol@Example.com' });

  var byUsername = await accountStore.getByUsername(event, 'CAROL');
  assert.ok(byUsername);
  assert.equal(byUsername.username, 'carol');
  assert.equal(byUsername.email, 'carol@example.com');

  var byEmail = await accountStore.getByEmail(event, ' carol@example.com ');
  assert.ok(byEmail);
  assert.equal(byEmail.username, 'carol');
});

test('account-store: verifyLogin distinguishes not_found from incorrect_password', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });
  await accountStore.createAccount(event, { username: 'dave', password: 'correctpw1', email: 'dave@example.com' });

  var noSuchAccount = await accountStore.verifyLogin(event, 'nobody', 'whatever1');
  assert.equal(noSuchAccount.ok, false);
  assert.equal(noSuchAccount.error, 'not_found');

  var wrongPassword = await accountStore.verifyLogin(event, 'dave', 'wrongpw123');
  assert.equal(wrongPassword.ok, false);
  assert.equal(wrongPassword.error, 'incorrect_password');

  var viaEmail = await accountStore.verifyLogin(event, 'Dave@Example.com', 'correctpw1');
  assert.equal(viaEmail.ok, true);
  assert.equal(viaEmail.record.username, 'dave');
});

test('account-store: applyPasswordReset upserts a brand-new record when the username was never registered before', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });

  var noneYet = await accountStore.getByUsername(event, 'erin');
  assert.equal(noneYet, null);

  await accountStore.applyPasswordReset(event, { username: 'erin', email: 'erin@example.com', password: 'brandnewpw1' });

  var login = await accountStore.verifyLogin(event, 'erin', 'brandnewpw1');
  assert.equal(login.ok, true);
});

test('account-store: applyPasswordReset overwrites the password on an existing account without touching its uniqueness elsewhere', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });
  await accountStore.createAccount(event, { username: 'frank', password: 'oldpassword1', email: 'frank@example.com' });

  await accountStore.applyPasswordReset(event, { username: 'frank', email: 'frank@example.com', password: 'newpassword2' });

  var oldFails = await accountStore.verifyLogin(event, 'frank', 'oldpassword1');
  assert.equal(oldFails.ok, false);
  assert.equal(oldFails.error, 'incorrect_password');

  var newWorks = await accountStore.verifyLogin(event, 'frank', 'newpassword2');
  assert.equal(newWorks.ok, true);
});

// ===== register-account.js =====

test('register-account: creates an account and returns ok:true with username/email', async function () {
  var handler = require('../netlify/functions/register-account').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { username: 'grace', password: 'longenoughpw1', email: 'grace@example.com' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.username, 'grace');
  assert.equal(body.email, 'grace@example.com');
});

test('register-account: a second signup with the same username is rejected with E7 username_taken (200, not a 4xx)', async function () {
  var handler = require('../netlify/functions/register-account').handler;
  await handler(fakeEvent({ method: 'POST', body: { username: 'henry', password: 'longenoughpw1', email: 'henry@example.com' } }));

  var res = await handler(fakeEvent({ method: 'POST', body: { username: 'Henry', password: 'anotherpw123', email: 'henry2@example.com' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E7: username_taken/);
});

test('register-account: a second signup with the same email (different username) is rejected with E8 email_taken', async function () {
  var handler = require('../netlify/functions/register-account').handler;
  await handler(fakeEvent({ method: 'POST', body: { username: 'iris', password: 'longenoughpw1', email: 'iris@example.com' } }));

  var res = await handler(fakeEvent({ method: 'POST', body: { username: 'iris2', password: 'anotherpw123', email: 'Iris@Example.com' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E8: email_taken/);
});

test('register-account: validates shape before ever touching the account store (missing fields, short username/password, bad email)', async function () {
  var handler = require('../netlify/functions/register-account').handler;

  var missing = await handler(fakeEvent({ method: 'POST', body: { username: 'jack' } }));
  assert.equal(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /^E3: missing_fields/);

  var shortUsername = await handler(fakeEvent({ method: 'POST', body: { username: 'jk', password: 'longenoughpw1', email: 'jk@example.com' } }));
  assert.equal(shortUsername.statusCode, 400);
  assert.match(JSON.parse(shortUsername.body).error, /^E4: invalid_username/);

  var shortPassword = await handler(fakeEvent({ method: 'POST', body: { username: 'jack', password: 'short1', email: 'jack@example.com' } }));
  assert.equal(shortPassword.statusCode, 400);
  assert.match(JSON.parse(shortPassword.body).error, /^E5: invalid_password/);

  var badEmail = await handler(fakeEvent({ method: 'POST', body: { username: 'jack', password: 'longenoughpw1', email: 'not-an-email' } }));
  assert.equal(badEmail.statusCode, 400);
  assert.match(JSON.parse(badEmail.body).error, /^E6: invalid_email/);
});

test('register-account: rejects invalid JSON and non-POST methods', async function () {
  var handler = require('../netlify/functions/register-account').handler;

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});

// ===== account-login.js =====

test('account-login: logs in successfully by username or by email, case-insensitively', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var loginHandler = require('../netlify/functions/account-login').handler;
  await registerHandler(fakeEvent({ method: 'POST', body: { username: 'karen', password: 'realpassword1', email: 'karen@example.com' } }));

  var byUsername = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'KAREN', password: 'realpassword1' } }));
  assert.equal(byUsername.statusCode, 200);
  var byUsernameBody = JSON.parse(byUsername.body);
  assert.equal(byUsernameBody.ok, true);
  assert.equal(byUsernameBody.username, 'karen');

  var byEmail = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'Karen@Example.com', password: 'realpassword1' } }));
  assert.equal(JSON.parse(byEmail.body).ok, true);
});

test('account-login: E4 not_found for an unregistered identifier, E5 incorrect_password for a real one with the wrong password', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var loginHandler = require('../netlify/functions/account-login').handler;
  await registerHandler(fakeEvent({ method: 'POST', body: { username: 'liam', password: 'realpassword1', email: 'liam@example.com' } }));

  var notFound = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'nobody-here', password: 'whatever1' } }));
  assert.equal(notFound.statusCode, 200);
  var notFoundBody = JSON.parse(notFound.body);
  assert.equal(notFoundBody.ok, false);
  assert.match(notFoundBody.error, /^E4: not_found/);

  var wrongPassword = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'liam', password: 'totallywrong1' } }));
  var wrongPasswordBody = JSON.parse(wrongPassword.body);
  assert.equal(wrongPasswordBody.ok, false);
  assert.match(wrongPasswordBody.error, /^E5: incorrect_password/);
});

test('account-login: rejects missing fields, invalid JSON, and non-POST methods', async function () {
  var handler = require('../netlify/functions/account-login').handler;

  var missing = await handler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'someone' } }));
  assert.equal(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /^E3: missing_fields/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'DELETE' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});

test('account-login: a real cross-device flow — register via one "device" call, then log in from a totally separate call with no shared local state', async function () {
  // There's no browser/localStorage involved on this side of the fence at
  // all (these are direct handler calls, mimicking two different devices
  // both only ever talking to the same server-side store) — this is the
  // actual bug this whole change fixes: register-account.js's write and
  // account-login.js's read share nothing but lib/account-store.js's
  // Blobs-backed store, exactly as two different physical devices would.
  var registerHandler = require('../netlify/functions/register-account').handler;
  var loginHandler = require('../netlify/functions/account-login').handler;

  var registerRes = await registerHandler(fakeEvent({ method: 'POST', body: { username: 'mona', password: 'crossdevicepw1', email: 'mona@example.com' } }));
  assert.equal(JSON.parse(registerRes.body).ok, true);

  var loginRes = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'mona@example.com', password: 'crossdevicepw1' } }));
  var loginBody = JSON.parse(loginRes.body);
  assert.equal(loginBody.ok, true);
  assert.equal(loginBody.username, 'mona');
});
