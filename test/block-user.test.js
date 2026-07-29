// test/block-user.test.js
//
// Covers the public-feed-safety block flow (tracker item
// for-product-public-feed-safety-in-app-re-ppuw77), including the
// post-review security fix:
//   - block-user.js: GET/POST now require a VERIFIED authToken (lib/
//     account-auth-token.js) to resolve the acting account, never a bare
//     client-supplied username -- an earlier version of this file trusted
//     a bare `username` string, which review flagged as a real
//     enumeration/unblock-defeat vulnerability (this app's handles are
//     public). Covers: token-gated GET/POST, validation, the
//     cannot-block-self guard, and that an unknown/expired/missing token
//     is rejected rather than silently trusted.
//   - lib/block-store.js: normalization, add/remove idempotency (unchanged
//     by the security fix -- it never saw a client-supplied username
//     either way, only whatever the caller already resolved).
//   - lib/account-auth-token.js: mint/verify shape used by this test file
//     to obtain real tokens for "nora"/"priya", same way account-login.js/
//     register-account.js do server-side.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/block-user')];
  delete require.cache[require.resolve('../netlify/functions/lib/block-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-auth-token')];
});

/** Mints a real authToken for `username`, exactly the way account-login.js/register-account.js do on a genuine success -- this test file is the "already-authenticated caller" account-auth-token.js expects. */
function mintToken(username) {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  return accountAuthToken.mintToken(fakeEvent({ method: 'GET' }), username);
}

// ===== block-user.js: GET =====

test('block-user GET: a valid token for an account with no blocks on file gets an empty list back, not an error', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, blockedHandles: [] });
});

test('block-user GET: rejects a missing authToken with E3', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: auth_token_required/);
});

test('block-user GET: an unknown/garbage authToken is rejected as invalid_or_expired, not trusted as a real account (the exact enumeration vector the security fix closes)', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { authToken: 'not-a-real-token-anyone-could-guess' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E6: invalid_or_expired_token/);
});

test('block-user GET: a bare username query param (the pre-fix contract) no longer has any effect -- it is simply not read', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/block-user').handler;
  // POST a block under nora's real token first.
  await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@alice' } }));
  // A GET naming a DIFFERENT username but no authToken must be rejected,
  // not silently read nora's list.
  var res = await handler(fakeEvent({ method: 'GET', query: { username: 'nora' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: auth_token_required/);
});

// ===== block-user.js: POST block/unblock =====

test('block-user POST: blocking a handle persists it, and GET (with the same token) reads it back', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@alice' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, blockedHandles: ['@alice'] });

  var getRes = await handler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  assert.deepEqual(JSON.parse(getRes.body), { ok: true, blockedHandles: ['@alice'] });
});

test('block-user POST: default action is "block" when action is omitted', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@alice' } }));
  assert.deepEqual(JSON.parse(res.body).blockedHandles, ['@alice']);
});

test('block-user POST: blocking the same handle twice does not duplicate it', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/block-user').handler;
  await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@alice' } }));
  var res = await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@alice' } }));
  assert.deepEqual(JSON.parse(res.body).blockedHandles, ['@alice']);
});

test('block-user POST: unblock removes a handle; unblocking something never blocked is a harmless no-op', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/block-user').handler;
  await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@alice' } }));
  await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@bob' } }));

  var unblockRes = await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@alice', action: 'unblock' } }));
  assert.equal(unblockRes.statusCode, 200);
  assert.deepEqual(JSON.parse(unblockRes.body).blockedHandles, ['@bob']);

  var noopRes = await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@someone-never-blocked', action: 'unblock' } }));
  assert.equal(noopRes.statusCode, 200);
  assert.deepEqual(JSON.parse(noopRes.body).blockedHandles, ['@bob']);
});

test('block-user POST: an attacker who knows a victim\'s public handle cannot unblock on their behalf without the victim\'s own token (the exact vulnerability the security fix closes)', async function () {
  var victimToken = await mintToken('nora');
  var attackerToken = await mintToken('mallory');
  var handler = require('../netlify/functions/block-user').handler;

  // Victim (nora) genuinely blocks an abuser.
  await handler(fakeEvent({ method: 'POST', body: { authToken: victimToken, blockedHandle: '@abuser' } }));

  // Attacker (mallory) knows nora's public handle but tries to "unblock"
  // using THEIR OWN token -- this must only ever affect mallory's own
  // blocklist (which never had @abuser on it), never nora's.
  var attackerRes = await handler(fakeEvent({ method: 'POST', body: { authToken: attackerToken, blockedHandle: '@abuser', action: 'unblock' } }));
  assert.equal(attackerRes.statusCode, 200);
  assert.deepEqual(JSON.parse(attackerRes.body).blockedHandles, [], 'the no-op unblock only ever touches the CALLER\'s own (empty) list');

  // Nora's real block must still be intact.
  var victimGetRes = await handler(fakeEvent({ method: 'GET', query: { authToken: victimToken } }));
  assert.deepEqual(JSON.parse(victimGetRes.body).blockedHandles, ['@abuser'], "the victim's own block must be completely unaffected by the attacker's call");
});

test('block-user POST: two different accounts keep entirely separate blocklists', async function () {
  var noraToken = await mintToken('nora');
  var priyaToken = await mintToken('priya');
  var handler = require('../netlify/functions/block-user').handler;
  await handler(fakeEvent({ method: 'POST', body: { authToken: noraToken, blockedHandle: '@alice' } }));
  await handler(fakeEvent({ method: 'POST', body: { authToken: priyaToken, blockedHandle: '@carlos' } }));

  var noraRes = await handler(fakeEvent({ method: 'GET', query: { authToken: noraToken } }));
  assert.deepEqual(JSON.parse(noraRes.body).blockedHandles, ['@alice']);
  var priyaRes = await handler(fakeEvent({ method: 'GET', query: { authToken: priyaToken } }));
  assert.deepEqual(JSON.parse(priyaRes.body).blockedHandles, ['@carlos']);
});

test('block-user POST: rejects blocking yourself (by handle, case-insensitive) with E5, derived from the TOKEN\'s account, not any client-supplied field', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { authToken: token, blockedHandle: '@NORA' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E5: cannot_block_self/);
});

test('block-user POST: rejects missing authToken/blockedHandle, invalid JSON, non-GET/POST methods, and an invalid/expired token', async function () {
  var handler = require('../netlify/functions/block-user').handler;

  var noToken = await handler(fakeEvent({ method: 'POST', body: { blockedHandle: '@alice' } }));
  assert.equal(noToken.statusCode, 400);
  assert.match(JSON.parse(noToken.body).error, /^E3: auth_token_required/);

  var validToken = await mintToken('nora');
  var noHandle = await handler(fakeEvent({ method: 'POST', body: { authToken: validToken } }));
  assert.equal(noHandle.statusCode, 400);
  assert.match(JSON.parse(noHandle.body).error, /^E4: blocked_handle_required/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'DELETE' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);

  var badToken = await handler(fakeEvent({ method: 'POST', body: { authToken: 'garbage-token', blockedHandle: '@alice' } }));
  assert.equal(badToken.statusCode, 200);
  var badTokenBody = JSON.parse(badToken.body);
  assert.equal(badTokenBody.ok, false);
  assert.match(badTokenBody.error, /^E6: invalid_or_expired_token/);
});

// ===== lib/block-store.js directly (unchanged by the security fix) =====

test('lib/block-store.js: getBlockedHandles returns [] for a username that has never blocked anyone', async function () {
  var blockStore = require('../netlify/functions/lib/block-store');
  var handles = await blockStore.getBlockedHandles(fakeEvent({ method: 'GET' }), 'brand-new-user');
  assert.deepEqual(handles, []);
});

test('lib/block-store.js: addBlockedHandle/removeBlockedHandle reject an invalid/empty handle', async function () {
  var blockStore = require('../netlify/functions/lib/block-store');
  var event = fakeEvent({ method: 'GET' });
  var addRes = await blockStore.addBlockedHandle(event, 'nora', '   ');
  assert.equal(addRes.ok, false);
  assert.equal(addRes.error, 'invalid_handle');
  var removeRes = await blockStore.removeBlockedHandle(event, 'nora', '');
  assert.equal(removeRes.ok, false);
  assert.equal(removeRes.error, 'invalid_handle');
});

// ===== lib/account-auth-token.js directly =====

test('lib/account-auth-token.js: mintToken + verifyToken round-trips the normalized username; an unknown token fails verification', async function () {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });
  var token = await accountAuthToken.mintToken(event, '  Nora  ');
  var verified = await accountAuthToken.verifyToken(event, token);
  assert.equal(verified.ok, true);
  assert.equal(verified.username, 'nora');

  var unknown = await accountAuthToken.verifyToken(event, 'some-other-random-token');
  assert.equal(unknown.ok, false);

  var empty = await accountAuthToken.verifyToken(event, '');
  assert.equal(empty.ok, false);
});

test('lib/account-auth-token.js: verifyToken is non-consuming -- the same token verifies successfully more than once', async function () {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  var event = fakeEvent({ method: 'GET' });
  var token = await accountAuthToken.mintToken(event, 'nora');
  var first = await accountAuthToken.verifyToken(event, token);
  var second = await accountAuthToken.verifyToken(event, token);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});
