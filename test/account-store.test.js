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

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.2.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY;
  delete process.env.MAX_LOGIN_ATTEMPTS_PER_IP_PER_DAY;
  delete process.env.MAX_LOGIN_ATTEMPTS_PER_IDENTIFIER_PER_DAY;
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

  var result = await accountStore.applyPasswordReset(event, { username: 'frank', email: 'frank@example.com', password: 'newpassword2' });
  assert.equal(result.ok, true);

  var oldFails = await accountStore.verifyLogin(event, 'frank', 'oldpassword1');
  assert.equal(oldFails.ok, false);
  assert.equal(oldFails.error, 'incorrect_password');

  var newWorks = await accountStore.verifyLogin(event, 'frank', 'newpassword2');
  assert.equal(newWorks.ok, true);
});

// ===== concurrency: the two-key write race (review finding #2) =====
//
// The mock Blobs store's operations are still genuinely async (each one
// yields to the microtask queue, just like the real @netlify/blobs client
// would), so two createAccount/applyPasswordReset calls kicked off together
// via Promise.all actually interleave step-by-step, exactly like two
// concurrent Netlify Function invocations racing against the same Blobs
// store would. This is what lets these tests exercise the real race
// end-to-end rather than merely asserting the fixed code "looks" correct.

test('account-store: two concurrent createAccount calls for the SAME username (different emails) -- exactly one wins cleanly, the other gets a clear conflict (never a false ok:true, never a mixed/corrupted record)', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });

  var results = await Promise.all([
    accountStore.createAccount(event, { username: 'racer', password: 'firstpassword1', email: 'racer-first@example.com' }),
    accountStore.createAccount(event, { username: 'RACER', password: 'secondpassword2', email: 'racer-second@example.com' })
  ]);

  var winners = results.filter(function (r) { return r.ok; });
  var losers = results.filter(function (r) { return !r.ok; });
  assert.equal(winners.length, 1, 'exactly one of the two racing signups should end up ok:true');
  assert.equal(losers.length, 1, 'the other must get a clear, safe error -- never silent corruption or a second false ok:true');
  assert.equal(losers[0].error, 'conflict');

  // The stored record must be entirely the winner's -- never a mix of one
  // request's password with the other's email (the exact corruption this
  // fix exists to prevent) -- and the winner's own password must be the
  // one that actually authenticates going forward.
  var stored = await accountStore.getByUsername(event, 'racer');
  assert.equal(stored.password, winners[0].record.password);
  assert.equal(stored.email, winners[0].record.email);
  var loginAsWinner = await accountStore.verifyLogin(event, 'racer', winners[0].record.password);
  assert.equal(loginAsWinner.ok, true);

  // The loser's own client would have cached ITS password locally after
  // seeing a false ok:true -- with this fix it never does, since it got a
  // conflict instead. Confirm the loser's password is NOT what's live
  // server-side (i.e. this scenario no longer produces the lockout
  // described in this file's own header comment).
  var loserPassword = results[0].ok ? 'secondpassword2' : 'firstpassword1';
  var loginAsLoser = await accountStore.verifyLogin(event, 'racer', loserPassword);
  assert.equal(loginAsLoser.ok, false);
});

test('account-store: after two concurrent createAccount calls for the SAME username with DIFFERENT emails, the loser\'s own email is not left permanently pointing at the winner\'s (now differently-emailed) account (review findings ay3nqfz/kd7m3wq)', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });

  var results = await Promise.all([
    accountStore.createAccount(event, { username: 'racer3', password: 'firstpassword1', email: 'racer3-a@example.com' }),
    accountStore.createAccount(event, { username: 'RACER3', password: 'secondpassword2', email: 'racer3-b@example.com' })
  ]);

  var winners = results.filter(function (r) { return r.ok; });
  var losers = results.filter(function (r) { return !r.ok; });
  assert.equal(winners.length, 1, 'exactly one of the two racing signups should end up ok:true');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].error, 'conflict');

  var winnerEmail = winners[0].record.email;
  var loserEmail = winnerEmail === 'racer3-a@example.com' ? 'racer3-b@example.com' : 'racer3-a@example.com';

  // Fix B (defense in depth): getByEmail must never resolve the loser's
  // real email to the winner's live record, which now carries a DIFFERENT
  // email than the one queried -- that mismatch must read as "not found",
  // not as a misresolved account.
  var byLoserEmail = await accountStore.getByEmail(event, loserEmail);
  assert.equal(byLoserEmail, null, 'the loser\'s email must not resolve to the differently-emailed winner record');

  // Fix A: the loser's own "e:" index entry should actually be rolled back
  // (freed), not merely masked by getByEmail's mismatch check -- confirm
  // the real owner of that email can still register a brand-new account
  // under it afterward. This is the "permanent email_taken lockout" this
  // fix exists to close.
  var retry = await accountStore.createAccount(event, { username: 'racer3-retry', password: 'retrypassword1', email: loserEmail });
  assert.equal(retry.ok, true, 'the loser\'s real email must be able to register again -- not permanently locked out by a stale index entry still pointing at the winner\'s account');
  assert.equal(retry.record.email, loserEmail);
});

test('account-store: after two concurrent applyPasswordReset calls for the SAME username with DIFFERENT emails, the loser\'s own email is freed rather than left pointing at the winner\'s account', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });
  await accountStore.createAccount(event, { username: 'racer4', password: 'originalpw1', email: 'racer4-original@example.com' });

  var results = await Promise.all([
    accountStore.applyPasswordReset(event, { username: 'racer4', email: 'racer4-a@example.com', password: 'resetpw-onexx' }),
    accountStore.applyPasswordReset(event, { username: 'RACER4', email: 'racer4-b@example.com', password: 'resetpw-twoyy' })
  ]);

  var winners = results.filter(function (r) { return r.ok; });
  var losers = results.filter(function (r) { return !r.ok; });
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);

  var winnerEmail = winners[0].record.email;
  var loserEmail = winnerEmail === 'racer4-a@example.com' ? 'racer4-b@example.com' : 'racer4-a@example.com';

  var byLoserEmail = await accountStore.getByEmail(event, loserEmail);
  assert.equal(byLoserEmail, null, 'the loser\'s reset email must not resolve to the differently-emailed winner record');

  var retry = await accountStore.createAccount(event, { username: 'racer4-retry', password: 'retrypassword1', email: loserEmail });
  assert.equal(retry.ok, true, 'the loser\'s reset email must not be permanently locked out');
});

test('account-store: two concurrent applyPasswordReset calls for the SAME username -- exactly one wins cleanly, the other gets a clear conflict', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });
  await accountStore.createAccount(event, { username: 'racer2', password: 'originalpw1', email: 'racer2@example.com' });

  var results = await Promise.all([
    accountStore.applyPasswordReset(event, { username: 'racer2', email: 'racer2@example.com', password: 'resetpw-onexx' }),
    accountStore.applyPasswordReset(event, { username: 'RACER2', email: 'racer2@example.com', password: 'resetpw-twoyy' })
  ]);

  var winners = results.filter(function (r) { return r.ok; });
  var losers = results.filter(function (r) { return !r.ok; });
  assert.equal(winners.length, 1, 'exactly one of the two racing resets should end up ok:true');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].error, 'conflict');

  var loginAsWinner = await accountStore.verifyLogin(event, 'racer2', winners[0].record.password);
  assert.equal(loginAsWinner.ok, true);
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

test('register-account: exceeding MAX_REGISTRATIONS_PER_IP_PER_DAY is rejected with E9 rate_limited (429, ok:false)', async function () {
  process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY = '1';
  var handler = require('../netlify/functions/register-account').handler;
  var ip = nextIp();

  var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'quotafirst', password: 'longenoughpw1', email: 'quotafirst@example.com' } }));
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).ok, true);

  var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'quotasecond', password: 'longenoughpw1', email: 'quotasecond@example.com' } }));
  assert.equal(second.statusCode, 429);
  var body = JSON.parse(second.body);
  assert.equal(body.ok, false, 'must be ok:false, not the bare {error} shape -- js/store.js\'s signup() branches on data.ok and would otherwise treat this as a malformed response and fall back to a local-only account');
  assert.match(body.error, /^E9: rate_limited/);
});

test('register-account: a concurrent write conflict from lib/account-store.js surfaces as E10 conflict (200, ok:false), never a false ok:true', async function () {
  var handler = require('../netlify/functions/register-account').handler;

  var results = await Promise.all([
    handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'concurrentuser', password: 'firstpassword1', email: 'concurrent-a@example.com' } })),
    handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'CONCURRENTUSER', password: 'secondpassword2', email: 'concurrent-b@example.com' } }))
  ]);
  var bodies = results.map(function (r) { return JSON.parse(r.body); });
  var winners = bodies.filter(function (b) { return b.ok; });
  var losers = bodies.filter(function (b) { return !b.ok; });

  assert.equal(winners.length, 1, 'exactly one concurrent signup should succeed');
  assert.equal(losers.length, 1);
  assert.match(losers[0].error, /^E10: conflict/);
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

test('account-login: exceeding MAX_LOGIN_ATTEMPTS_PER_IP_PER_DAY is rejected with E6 rate_limited (429, ok:false), independent of whether the account/password are even valid', async function () {
  process.env.MAX_LOGIN_ATTEMPTS_PER_IP_PER_DAY = '1';
  var registerHandler = require('../netlify/functions/register-account').handler;
  var loginHandler = require('../netlify/functions/account-login').handler;
  var ip = nextIp();
  await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'ipcapuser', password: 'realpassword1', email: 'ipcapuser@example.com' } }));

  var first = await loginHandler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'ipcapuser', password: 'wrongpassword1' } }));
  assert.equal(first.statusCode, 200); // the one allowed attempt still reaches verifyLogin (E5 incorrect_password)

  var second = await loginHandler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'ipcapuser', password: 'realpassword1' } }));
  assert.equal(second.statusCode, 429);
  var body = JSON.parse(second.body);
  assert.equal(body.ok, false, 'must be ok:false -- js/store.js\'s login() branches on data.ok and must never fall back to a local-only login check on a deliberate rate-limit rejection');
  assert.match(body.error, /^E6: rate_limited/);
});

test('account-login: exceeding MAX_LOGIN_ATTEMPTS_PER_IDENTIFIER_PER_DAY throttles repeated guesses against ONE account even from rotating IPs', async function () {
  process.env.MAX_LOGIN_ATTEMPTS_PER_IDENTIFIER_PER_DAY = '2';
  var registerHandler = require('../netlify/functions/register-account').handler;
  var loginHandler = require('../netlify/functions/account-login').handler;
  await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'guesstarget', password: 'realpassword1', email: 'guesstarget@example.com' } }));

  var first = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'guesstarget', password: 'guess-one1' } }));
  assert.equal(first.statusCode, 200); // 1st of 2 allowed identifier attempts (E5 incorrect_password)
  var second = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'guesstarget', password: 'guess-two2' } }));
  assert.equal(second.statusCode, 200); // still under the per-identifier cap, even from a brand-new IP each time

  var third = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'GuessTarget', password: 'guess-three3' } }));
  assert.equal(third.statusCode, 429, 'a different IP does not bypass the per-identifier cap');
  assert.match(JSON.parse(third.body).error, /^E6: rate_limited/);
});

test('account-login: the per-identifier rate limit is one shared bucket per ACCOUNT, not one per raw identifier string -- guessing by username then by email against the same account doesn\'t double the allowed attempts (non-blocking review item)', async function () {
  process.env.MAX_LOGIN_ATTEMPTS_PER_IDENTIFIER_PER_DAY = '2';
  var registerHandler = require('../netlify/functions/register-account').handler;
  var loginHandler = require('../netlify/functions/account-login').handler;
  await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'dualidtarget', password: 'realpassword1', email: 'dualidtarget@example.com' } }));

  // Two allowed attempts -- one by username, one by email -- both against
  // the SAME account, must share the one bucket, not get two independent
  // ones (which would let an attacker who knows both effectively double
  // their guesses).
  var first = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'dualidtarget', password: 'guess-one1' } }));
  assert.equal(first.statusCode, 200);
  var second = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'DualIdTarget@Example.com', password: 'guess-two2' } }));
  assert.equal(second.statusCode, 200);

  var third = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'dualidtarget', password: 'guess-three3' } }));
  assert.equal(third.statusCode, 429, 'username and email attempts against the same account must share one identifier bucket');
  assert.match(JSON.parse(third.body).error, /^E6: rate_limited/);

  var fourthByEmail = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'dualidtarget@example.com', password: 'guess-four4' } }));
  assert.equal(fourthByEmail.statusCode, 429, 'the shared bucket is enforced regardless of which identifier form is used to hit it');
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
