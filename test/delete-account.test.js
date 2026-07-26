// test/delete-account.test.js
//
// Covers netlify/functions/delete-account.js (the account-deletion flow —
// see tracker.html's confirm-account-deletion-flow item and AGENT_POLICY.md)
// plus the two lib additions it's built on: lib/account-store.js's
// deleteAccount and lib/entitlements.js's deleteEntitlement. Same test
// conventions as test/account-store.test.js/test/publish-dream.test.js —
// mockBlobs + fakeEvent, direct handler calls simulating two independent
// "devices" the way account-login.js's own cross-device test does. Run
// with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');

var registerHandler = require('../netlify/functions/register-account').handler;
var loginHandler = require('../netlify/functions/account-login').handler;
var publishHandler = require('../netlify/functions/publish-dream').handler;
var deleteAccountHandler = require('../netlify/functions/delete-account').handler;
var accountStore = require('../netlify/functions/lib/account-store');
var entitlements = require('../netlify/functions/lib/entitlements');

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.5.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.MAX_DELETE_ACCOUNT_ATTEMPTS_PER_IP_PER_DAY;
  delete process.env.MAX_DELETE_ACCOUNT_ATTEMPTS_PER_IDENTIFIER_PER_DAY;
});

async function feedIndex() {
  return (await getStore('dreamtube-feed').get('feed-index', { type: 'json' })) || [];
}

async function registerAndLogin(username, password, email) {
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: username, password: password, email: email } }));
  assert.equal(JSON.parse(res.body).ok, true, 'setup: registration must succeed');
}

// ===== happy path: full account, real dreams/characters/tokens, delete, verify gone =====

test('delete-account: full happy path — deletes the account, its published dreams (own profile AND shared feed), and its token balance; login fails afterward', async function () {
  await registerAndLogin('nora', 'realpassword1', 'nora@example.com');

  // A real token balance for this email (mirrors what generate-video.js's
  // gate / get-token-status.js would have lazily materialized).
  await entitlements.getTokenStatus(fakeEvent({ method: 'GET' }), 'nora@example.com');
  var balanceBefore = await entitlements.getEntitlement(fakeEvent({ method: 'GET' }), 'nora@example.com');
  assert.ok(balanceBefore && balanceBefore.tokens.balance > 0, 'setup: a real token balance must exist before deletion');

  // Two published dreams in the shared feed, plus one belonging to a
  // DIFFERENT account — the other account's dream must survive.
  await publishHandler(fakeEvent({ method: 'POST', body: { id: 'dream-1', ownerHandle: '@nora', caption: 'a dream', style: 'Cartoon', videoUrl: 'https://x/v1.mp4' } }));
  await publishHandler(fakeEvent({ method: 'POST', body: { id: 'dream-2', ownerHandle: '@nora', caption: 'another dream', style: 'Anime', videoUrl: 'https://x/v2.mp4' } }));
  await publishHandler(fakeEvent({ method: 'POST', body: { id: 'dream-other', ownerHandle: '@someoneelse', caption: 'not mine', style: 'Cartoon', videoUrl: 'https://x/v3.mp4' } }));

  var feedBefore = await feedIndex();
  assert.equal(feedBefore.length, 3);

  var res = await deleteAccountHandler(fakeEvent({ method: 'POST', body: { username: 'nora', password: 'realpassword1' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);

  // 1. Account is gone — login now fails with not_found (never
  // incorrect_password, which would imply the account still exists).
  var loginAfter = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'nora', password: 'realpassword1' } }));
  var loginAfterBody = JSON.parse(loginAfter.body);
  assert.equal(loginAfterBody.ok, false);
  assert.match(loginAfterBody.error, /^E4: not_found/);

  var byEmailAfter = await accountStore.getByEmail(fakeEvent({ method: 'GET' }), 'nora@example.com');
  assert.equal(byEmailAfter, null, 'the email index must no longer resolve to the deleted account either');

  // 2. Its dreams are gone from the shared feed — this account's own
  // profile view has nothing else to check (dreams live only in that
  // browser's own localStorage, which js/store.js's deleteAccount wipes
  // client-side — see js/store.js's own test coverage) — but the OTHER
  // account's dream must be untouched.
  var feedAfter = await feedIndex();
  assert.equal(feedAfter.length, 1);
  assert.equal(feedAfter[0].id, 'dream-other');

  // 3. Token ledger is gone.
  var entitlementAfter = await entitlements.getEntitlement(fakeEvent({ method: 'GET' }), 'nora@example.com');
  assert.equal(entitlementAfter, null);
});

test('delete-account: an account with no published dreams and no token balance yet still deletes cleanly (nothing to sweep is not an error)', async function () {
  await registerAndLogin('plainuser', 'realpassword1', 'plainuser@example.com');

  var res = await deleteAccountHandler(fakeEvent({ method: 'POST', body: { username: 'plainuser', password: 'realpassword1' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  var loginAfter = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'plainuser', password: 'realpassword1' } }));
  assert.equal(JSON.parse(loginAfter.body).ok, false);
});

// ===== password re-check — the actual security requirement =====

test('delete-account: rejects a WRONG password with E5 incorrect_password, and performs NO deletion at all (account, dreams, and tokens all untouched)', async function () {
  await registerAndLogin('oscar', 'realpassword1', 'oscar@example.com');
  await entitlements.getTokenStatus(fakeEvent({ method: 'GET' }), 'oscar@example.com');
  await publishHandler(fakeEvent({ method: 'POST', body: { id: 'oscar-dream', ownerHandle: '@oscar', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' } }));

  var res = await deleteAccountHandler(fakeEvent({ method: 'POST', body: { username: 'oscar', password: 'totally-wrong-password' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E5: incorrect_password/);

  // Nothing was deleted: the account still logs in with its real password,
  // its dream is still in the shared feed, and its token balance is intact.
  var loginStillWorks = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'oscar', password: 'realpassword1' } }));
  assert.equal(JSON.parse(loginStillWorks.body).ok, true, 'a wrong-password delete attempt must not touch the real account at all');

  var feed = await feedIndex();
  assert.equal(feed.length, 1, 'the dream must still be published — no deletion occurred');

  var entitlement = await entitlements.getEntitlement(fakeEvent({ method: 'GET' }), 'oscar@example.com');
  assert.ok(entitlement, 'the token record must still exist — no deletion occurred');
});

test('delete-account: an unregistered/unknown username is rejected with E4 not_found', async function () {
  var res = await deleteAccountHandler(fakeEvent({ method: 'POST', body: { username: 'nobody-here', password: 'whatever1' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E4: not_found/);
});

test('delete-account: also accepts the account\'s email as the identifier (same verifyLogin resolution as account-login.js)', async function () {
  await registerAndLogin('petra', 'realpassword1', 'petra@example.com');

  var res = await deleteAccountHandler(fakeEvent({ method: 'POST', body: { username: 'petra@example.com', password: 'realpassword1' } }));
  assert.equal(JSON.parse(res.body).ok, true);

  var loginAfter = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'petra', password: 'realpassword1' } }));
  assert.equal(JSON.parse(loginAfter.body).ok, false);
});

// ===== request shape / rate limiting =====

test('delete-account: rejects missing fields, invalid JSON, and non-POST methods', async function () {
  var missing = await deleteAccountHandler(fakeEvent({ method: 'POST', body: { username: 'someone' } }));
  assert.equal(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /^E3: missing_fields/);

  var badJson = await deleteAccountHandler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await deleteAccountHandler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});

test('delete-account: exceeding MAX_DELETE_ACCOUNT_ATTEMPTS_PER_IDENTIFIER_PER_DAY throttles repeated password guesses against ONE account, and no deletion ever occurs on a throttled request', async function () {
  process.env.MAX_DELETE_ACCOUNT_ATTEMPTS_PER_IDENTIFIER_PER_DAY = '2';
  await registerAndLogin('quinn', 'realpassword1', 'quinn@example.com');

  var first = await deleteAccountHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'quinn', password: 'guess-one1' } }));
  assert.equal(first.statusCode, 200); // 1st of 2 allowed attempts (E5 incorrect_password)
  var second = await deleteAccountHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'quinn', password: 'guess-two2' } }));
  assert.equal(second.statusCode, 200);

  var third = await deleteAccountHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'quinn', password: 'realpassword1' } }));
  assert.equal(third.statusCode, 429, 'a different IP does not bypass the per-identifier cap');
  assert.match(JSON.parse(third.body).error, /^E6: rate_limited/);

  // Confirm the account is genuinely still alive after being throttled —
  // even the CORRECT password on the throttled 3rd attempt must not have
  // deleted anything.
  var loginStillWorks = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'quinn', password: 'realpassword1' } }));
  assert.equal(JSON.parse(loginStillWorks.body).ok, true);
});

// ===== lib/account-store.js's deleteAccount directly =====

test('account-store: deleteAccount removes both the "u:" record and the "e:" index, and is a safe no-op for a username that never existed', async function () {
  var event = fakeEvent({ method: 'POST' });
  await accountStore.createAccount(event, { username: 'ruby', password: 'realpassword1', email: 'ruby@example.com' });

  var result = await accountStore.deleteAccount(event, 'RUBY');
  assert.equal(result.ok, true);

  assert.equal(await accountStore.getByUsername(event, 'ruby'), null);
  assert.equal(await accountStore.getByEmail(event, 'ruby@example.com'), null);

  var noop = await accountStore.deleteAccount(event, 'never-existed-at-all');
  assert.equal(noop.ok, true);
});

test('account-store: deleteAccount never deletes a DIFFERENT account\'s still-valid "e:" index entry just because a stale computation happens to collide', async function () {
  var event = fakeEvent({ method: 'POST' });
  await accountStore.createAccount(event, { username: 'sam', password: 'pw1realpass', email: 'shared@example.com' });

  // Simulate the email having been reassigned to a different account since
  // (e.g. via a password reset backfill) — the "e:" index no longer points
  // at 'sam' at all.
  await accountStore.applyPasswordReset(event, { username: 'terry', email: 'shared@example.com', password: 'pw2realpass' });

  await accountStore.deleteAccount(event, 'sam');

  // 'sam's own "u:" record is gone, but the email index (now correctly
  // pointing at 'terry') must be untouched.
  assert.equal(await accountStore.getByUsername(event, 'sam'), null);
  var terryByEmail = await accountStore.getByEmail(event, 'shared@example.com');
  assert.ok(terryByEmail);
  assert.equal(terryByEmail.username, 'terry');
});

// ===== lib/entitlements.js's deleteEntitlement directly =====

test('entitlements: deleteEntitlement wipes the whole record (balance, grant timing, everything), and is a safe no-op for an email with no record yet', async function () {
  var event = fakeEvent({ method: 'GET' });
  await entitlements.getTokenStatus(event, 'uma@example.com');
  assert.ok(await entitlements.getEntitlement(event, 'uma@example.com'));

  var result = await entitlements.deleteEntitlement(event, 'UMA@Example.com');
  assert.equal(result.ok, true);
  assert.equal(await entitlements.getEntitlement(event, 'uma@example.com'), null);

  var noop = await entitlements.deleteEntitlement(event, 'never-had-one@example.com');
  assert.equal(noop.ok, true);
});
