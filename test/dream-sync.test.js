// test/dream-sync.test.js
//
// Covers netlify/functions/dream-sync.js end-to-end, including its real
// dependency on lib/account-auth-token.js (minted by account-login.js/
// register-account.js) and lib/dream-store.js — tracker item
// for-product-build-p0-server-side-dream-p-zl3rb2 (server-side private
// dream persistence). Same conventions as test/delete-account.test.js
// (mockBlobs + fakeEvent, direct handler calls simulating real
// register/login round trips to get a genuine authToken, not a hand-typed
// one) and test/password-reset-account.test.js (password-reset-triggered
// token invalidation). Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var registerHandler = require('../netlify/functions/register-account').handler;
var loginHandler = require('../netlify/functions/account-login').handler;
var deleteAccountHandler = require('../netlify/functions/delete-account').handler;
var verifyPasswordResetHandler = require('../netlify/functions/verify-password-reset').handler;
var dreamSyncHandler = require('../netlify/functions/dream-sync').handler;
var dreamStore = require('../netlify/functions/lib/dream-store');

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.6.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

/** Registers a brand-new real account and returns its freshly-minted authToken (register-account.js's own real response field). */
async function registerAndGetToken(username, password, email) {
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: username, password: password, email: email } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true, 'setup: registration must succeed');
  assert.ok(body.authToken, 'setup: register-account.js must mint a real authToken');
  return body.authToken;
}

function dreamPayload(id, extra) {
  return Object.assign({
    id: id, caption: 'a dream', promptText: 'a dream', storyText: 'a dream',
    style: 'Cartoon', mediaType: 'video', videoUrl: 'https://x/v.mp4',
    dur: '0:08', updatedAt: Date.now()
  }, extra || {});
}

// ===== GET (fetch for reconcile) =====

test('GET: rejects a request with no authToken', async function () {
  var res = await dreamSyncHandler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: auth_token_required/);
});

test('GET: rejects an invalid/unknown authToken with a 200 ok:false (a normal business outcome, not a 4xx/5xx)', async function () {
  var res = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: 'not-a-real-token' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E4: invalid_or_expired_token/);
});

test('GET: returns [] for a real, verified account that has never synced any dreams', async function () {
  var token = await registerAndGetToken('alice', 'realpassword1', 'alice@example.com');
  var res = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.deepEqual(body.dreams, []);
});

test('GET: returns exactly the dreams previously upserted for that account', async function () {
  var token = await registerAndGetToken('bob', 'realpassword1', 'bob@example.com');
  await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'upsert', dream: dreamPayload('d1') } }));

  var res = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.dreams.length, 1);
  assert.equal(body.dreams[0].id, 'd1');
  assert.equal(body.dreams[0].ownerHandle, '@bob');
});

// ===== POST upsert / delete =====

test('POST upsert: rejects missing authToken, invalid JSON, invalid action, and a missing/malformed dream', async function () {
  var missingToken = await dreamSyncHandler(fakeEvent({ method: 'POST', body: { action: 'upsert', dream: dreamPayload('d1') } }));
  assert.equal(missingToken.statusCode, 400);
  assert.match(JSON.parse(missingToken.body).error, /^E3: auth_token_required/);

  var badJson = await dreamSyncHandler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var token = await registerAndGetToken('carol', 'realpassword1', 'carol@example.com');

  var badAction = await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'explode', dream: dreamPayload('d1') } }));
  assert.equal(badAction.statusCode, 400);
  assert.match(JSON.parse(badAction.body).error, /^E5: invalid_action/);

  var noDream = await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'upsert' } }));
  assert.equal(noDream.statusCode, 400);
  assert.match(JSON.parse(noDream.body).error, /^E6: dream_required/);

  var noIdDream = await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'upsert', dream: { caption: 'no id' } } }));
  assert.equal(noIdDream.statusCode, 400);
  assert.match(JSON.parse(noIdDream.body).error, /^E6: dream_required/);
});

test('POST delete: rejects a missing dreamId', async function () {
  var token = await registerAndGetToken('dana', 'realpassword1', 'dana@example.com');
  var res = await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'delete' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E7: dream_id_required/);
});

test('POST upsert then GET: a synced dream round-trips with its real content intact', async function () {
  var token = await registerAndGetToken('erin', 'realpassword1', 'erin@example.com');
  var res = await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d1', { caption: 'a very specific dream', style: 'Anime' }) }
  }));
  assert.equal(JSON.parse(res.body).ok, true);

  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].caption, 'a very specific dream');
  assert.equal(dreams[0].style, 'Anime');
  assert.equal(dreams[0].isPublished, false, 'must always be stored as false — this store is private-dreams-only');
});

test('POST upsert then POST delete: the dream is genuinely gone', async function () {
  var token = await registerAndGetToken('frank', 'realpassword1', 'frank@example.com');
  await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'upsert', dream: dreamPayload('d1') } }));

  var deleteRes = await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'delete', dreamId: 'd1' } }));
  assert.equal(JSON.parse(deleteRes.body).ok, true);

  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  assert.deepEqual(JSON.parse(getRes.body).dreams, []);
});

test('re-upserting the SAME dream id updates it in place, not a duplicate', async function () {
  var token = await registerAndGetToken('grace', 'realpassword1', 'grace@example.com');
  await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'upsert', dream: dreamPayload('d1', { caption: 'v1' }) } }));
  await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'upsert', dream: dreamPayload('d1', { caption: 'v2' }) } }));

  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].caption, 'v2');
});

// ===== SECURITY: identity binding =====

test('SECURITY: dream-sync.js accepts no bare username/ownerHandle field at all as the acting identity — only authToken resolves it', async function () {
  var tokenA = await registerAndGetToken('alice2', 'realpassword1', 'alice2@example.com');
  await registerAndGetToken('bob2', 'realpassword1', 'bob2@example.com');

  // Attempting to read bob2's dreams by just naming them in the query
  // string (no such param exists) must not work -- only a verified token
  // for bob2's OWN account could ever return bob2's dreams.
  var res = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: tokenA, username: 'bob2' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.deepEqual(body.dreams, [], 'alice2\'s own (empty) dream list must be returned, never bob2\'s, regardless of any other field sent');
});

test('SECURITY: a client cannot claim a different account\'s ownerHandle on upsert -- it is silently corrected to the verified account\'s own handle', async function () {
  var tokenA = await registerAndGetToken('hank', 'realpassword1', 'hank@example.com');
  await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: tokenA, action: 'upsert', dream: dreamPayload('spoofed', { ownerHandle: '@totallydifferentaccount' }) }
  }));

  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: tokenA } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].ownerHandle, '@hank', 'ownerHandle must be forced to the token-verified account, never a client-claimed different one');
});

test('a client\'s own display-casing IS preserved when it case-insensitively matches the verified account', async function () {
  var token = await registerAndGetToken('IreneCase', 'realpassword1', 'irene@example.com');
  await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d1', { ownerHandle: '@IreneCase' }) }
  }));

  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams[0].ownerHandle, '@IreneCase', 'the account\'s own real display casing must survive the round trip');
});

test('SECURITY: two different accounts\' private dreams never leak into each other\'s GET', async function () {
  var tokenA = await registerAndGetToken('jack', 'realpassword1', 'jack@example.com');
  var tokenB = await registerAndGetToken('kara', 'realpassword1', 'kara@example.com');

  await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: tokenA, action: 'upsert', dream: dreamPayload('jacks-dream') } }));
  await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: tokenB, action: 'upsert', dream: dreamPayload('karas-dream') } }));

  var jackDreams = JSON.parse((await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: tokenA } }))).body).dreams;
  var karaDreams = JSON.parse((await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: tokenB } }))).body).dreams;

  assert.equal(jackDreams.length, 1);
  assert.equal(jackDreams[0].id, 'jacks-dream');
  assert.equal(karaDreams.length, 1);
  assert.equal(karaDreams[0].id, 'karas-dream');
});

test('SECURITY: a WRONG password at login never yields a usable authToken -- dream-sync stays unreachable for that attempt', async function () {
  await registerAndGetToken('liam', 'realpassword1', 'liam@example.com');
  var badLogin = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'liam', password: 'wrong-password-at-all' } }));
  var badLoginBody = JSON.parse(badLogin.body);
  assert.equal(badLoginBody.ok, false);
  assert.equal(badLoginBody.authToken, undefined);
});

// ===== IDENTITY-CUTOFF INVALIDATION integration (round-2 finding on the
// originating branch — invalidation must actually cut off dream-sync
// access, not just the lib-level mechanism in isolation) =====

test('a real login mints a FRESH, working authToken that dream-sync accepts', async function () {
  await registerAndGetToken('mia', 'realpassword1', 'mia@example.com');
  var loginRes = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'mia', password: 'realpassword1' } }));
  var loginBody = JSON.parse(loginRes.body);
  assert.equal(loginBody.ok, true);
  assert.ok(loginBody.authToken);

  var res = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: loginBody.authToken } }));
  assert.equal(JSON.parse(res.body).ok, true);
});

test('a password reset invalidates the OLD authToken -- dream-sync rejects it afterward', async function () {
  var oldToken = await registerAndGetToken('nina', 'realpassword1', 'nina@example.com');

  // Sanity: the old token works before the reset.
  var before = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: oldToken } }));
  assert.equal(JSON.parse(before.body).ok, true);

  mockBlobs.seed('dreamtube-password-resets', 'reset-tok', { username: 'nina', email: 'nina@example.com', expiresAt: Date.now() + 30 * 60 * 1000 });
  var resetRes = await verifyPasswordResetHandler(fakeEvent({ method: 'POST', body: { token: 'reset-tok', consume: true, newPassword: 'brandnewpassword1' } }));
  assert.equal(JSON.parse(resetRes.body).ok, true);

  var after = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: oldToken } }));
  var afterBody = JSON.parse(after.body);
  assert.equal(afterBody.ok, false);
  assert.match(afterBody.error, /^E4: invalid_or_expired_token/);
});

test('a fresh login AFTER a password reset works normally against dream-sync', async function () {
  await registerAndGetToken('oscar2', 'realpassword1', 'oscar2@example.com');
  mockBlobs.seed('dreamtube-password-resets', 'reset-tok-2', { username: 'oscar2', email: 'oscar2@example.com', expiresAt: Date.now() + 30 * 60 * 1000 });
  await verifyPasswordResetHandler(fakeEvent({ method: 'POST', body: { token: 'reset-tok-2', consume: true, newPassword: 'brandnewpassword2' } }));

  var loginRes = await loginHandler(fakeEvent({ method: 'POST', body: { usernameOrEmail: 'oscar2', password: 'brandnewpassword2' } }));
  var loginBody = JSON.parse(loginRes.body);
  assert.equal(loginBody.ok, true);

  var res = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: loginBody.authToken } }));
  assert.equal(JSON.parse(res.body).ok, true, 'a token minted AFTER the reset must be unaffected by the invalidation cutoff');
});

test('account deletion invalidates the authToken AND wipes the account\'s entire private-dream record server-side', async function () {
  var token = await registerAndGetToken('paula', 'realpassword1', 'paula@example.com');
  await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: token, action: 'upsert', dream: dreamPayload('d1') } }));

  var dreamsBefore = await dreamStore.getPrivateDreams(fakeEvent({}), 'paula');
  assert.equal(dreamsBefore.length, 1, 'setup: the dream must actually be there before deletion');

  var deleteRes = await deleteAccountHandler(fakeEvent({ method: 'POST', body: { username: 'paula', password: 'realpassword1' } }));
  assert.equal(JSON.parse(deleteRes.body).ok, true);

  // The old token no longer verifies at all...
  var res = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  assert.equal(JSON.parse(res.body).ok, false);

  // ...and the private-dream record itself is gone server-side, not just
  // unreachable via the now-dead token (defense in depth — see
  // delete-account.js's own header comment).
  var dreamsAfter = await dreamStore.getPrivateDreams(fakeEvent({}), 'paula');
  assert.deepEqual(dreamsAfter, []);
});

test('IDENTITY REUSE: a new account registered under a freed username gets a private-dream record independent of the old (deleted) holder\'s data and dead token', async function () {
  var oldToken = await registerAndGetToken('reused_handle', 'oldpassword1', 'old@example.com');
  await dreamSyncHandler(fakeEvent({ method: 'POST', body: { authToken: oldToken, action: 'upsert', dream: dreamPayload('old-owners-dream') } }));
  await deleteAccountHandler(fakeEvent({ method: 'POST', body: { username: 'reused_handle', password: 'oldpassword1' } }));

  // A different person registers the exact same (now-freed) username.
  var newToken = await registerAndGetToken('reused_handle', 'newpassword1', 'new@example.com');

  // The old token must still be dead.
  var oldStillDead = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: oldToken } }));
  assert.equal(JSON.parse(oldStillDead.body).ok, false, 'the OLD holder\'s token must never grant access to the NEW account, even though the username is identical');

  // The new account's own fresh token works, and sees a clean (empty)
  // private-dream slate — not the old holder's leftover data.
  var newRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: newToken } }));
  var newBody = JSON.parse(newRes.body);
  assert.equal(newBody.ok, true);
  assert.deepEqual(newBody.dreams, [], 'the new registrant must not inherit the old holder\'s private dreams');
});

// ===== method / shape guards =====

test('rejects a non-GET/POST method', async function () {
  var res = await dreamSyncHandler(fakeEvent({ method: 'DELETE' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('a dream\'s `mood` round-trips through the private-dream sync -- without it in DREAM_FIELDS a dream restored on a NEW DEVICE would come back moodless and quietly fall back to its visual-style bed, i.e. the same dream sounding different on two devices (tracker item for-product-founder-08-04-evening-music--jfjco0)', async function () {
  var token = await registerAndGetToken('moodsyncer', 'realpassword1', 'moodsyncer@example.com');
  var res = await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d-mood', { caption: 'a tense dream', style: 'Cartoon', mood: 'tense' }) }
  }));
  assert.equal(JSON.parse(res.body).ok, true);

  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].mood, 'tense', 'mood must survive the upsert/GET round trip');
  assert.equal(dreams[0].style, 'Cartoon', 'and must not disturb the style it coexists with');
});

test('a dream with NO mood syncs exactly as it always did -- the new field is additive, never fabricated for the many dreams (Write it / Record it / anything predating this) that legitimately have none', async function () {
  var token = await registerAndGetToken('moodlesssyncer', 'realpassword1', 'moodlesssyncer@example.com');
  await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d-nomood', { caption: 'a plain dream', style: 'Anime' }) }
  }));
  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.ok(dreams[0].mood === undefined || dreams[0].mood === null, 'no mood must stay no mood, never a guessed default');
});

// ===== createdAt (tracker item for-product-media-library-stamp-durable--
// u4oju3, root-cause fix): a real, finite-number createdAt off the client's
// dream object round-trips through this private-dream sync -- before this
// fix DREAM_FIELDS silently dropped it, so the owner media-library page
// (admin-media-library-data.js) saw no timestamp at all for any private
// dream and it sank to "unknown time" at the end of the newest-first sort,
// regardless of when it was actually made. =====

test('a dream\'s real createdAt round-trips through the private-dream sync -- the actual root-cause fix', async function () {
  var token = await registerAndGetToken('createdatsyncer', 'realpassword1', 'createdatsyncer@example.com');
  var realCreatedAt = 1780000000000;
  var res = await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d-created', { caption: 'a timestamped dream', createdAt: realCreatedAt }) }
  }));
  assert.equal(JSON.parse(res.body).ok, true);

  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].createdAt, realCreatedAt, 'createdAt must survive the upsert/GET round trip, not be silently dropped');
});

test('a dream with NO createdAt (a legacy dream from before the field existed) syncs with no createdAt at all -- never a fabricated value', async function () {
  var token = await registerAndGetToken('nocreatedatsyncer', 'realpassword1', 'nocreatedatsyncer@example.com');
  await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d-nocreated', { caption: 'an untimestamped dream' }) }
  }));
  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.ok(dreams[0].createdAt === undefined || dreams[0].createdAt === null, 'no createdAt must stay no createdAt, never a guessed Date.now() default');
});

test('a malformed createdAt (a string, NaN) is silently dropped, never stored as a bad value that would corrupt the media library\'s newest-first sort', async function () {
  var token = await registerAndGetToken('badcreatedatsyncer', 'realpassword1', 'badcreatedatsyncer@example.com');
  await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d-badcreated', { caption: 'x', createdAt: 'not-a-real-timestamp' }) }
  }));
  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.ok(dreams[0].createdAt === undefined || dreams[0].createdAt === null, 'a non-numeric createdAt must be dropped, not stored verbatim');
});

test('re-upserting the same dream with a NEW createdAt updates it (this store is not a special case -- upsert-by-id updates every whitelisted field)', async function () {
  var token = await registerAndGetToken('updatedatsyncer', 'realpassword1', 'updatedatsyncer@example.com');
  await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d-update-created', { createdAt: 1000 }) }
  }));
  await dreamSyncHandler(fakeEvent({
    method: 'POST',
    body: { authToken: token, action: 'upsert', dream: dreamPayload('d-update-created', { createdAt: 2000 }) }
  }));
  var getRes = await dreamSyncHandler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  var dreams = JSON.parse(getRes.body).dreams;
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].createdAt, 2000);
});
