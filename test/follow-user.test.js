// test/follow-user.test.js
//
// Covers Social Layer v2 slice 3 ("follow" — docs/SOCIAL_LAYER_V2_DESIGN.md,
// tracker item for-product-build-social-layer-v2-direct-34047c):
//   - lib/follow-store.js: normalization, follow/unfollow idempotency,
//     follower-count adjustment (only on a REAL membership change, never on
//     a no-op), the two-separate-writes shape.
//   - follow-user.js: POST, VERIFIED-authToken-only identity (mirrors
//     block-user.js's own security shape — see that file's own header
//     comment), the cannot-follow-self guard, validation, invalid/expired
//     token handling.
//   - get-following.js: GET, authToken-only (no `handle` param at all),
//     OWNER-ONLY followerCount — never returns anyone else's.
//   - LOCKED CONSTRAINT: no code path here ever returns one account's
//     follower count in response to a call made with a DIFFERENT account's
//     (or no) token.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/follow-user')];
  delete require.cache[require.resolve('../netlify/functions/get-following')];
  delete require.cache[require.resolve('../netlify/functions/lib/follow-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-auth-token')];
});

/** Mints a real authToken for `username`, same helper shape as test/block-user.test.js. */
function mintToken(username) {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  return accountAuthToken.mintToken(fakeEvent({ method: 'GET' }), username);
}

// ===== follow-user.js: POST =====

test('follow-user POST: follows a handle, and get-following (same token) reads it back with the follower count on the TARGET side', async function () {
  var noraToken = await mintToken('nora');
  var followHandler = require('../netlify/functions/follow-user').handler;
  var getFollowingHandler = require('../netlify/functions/get-following').handler;

  var res = await followHandler(fakeEvent({ method: 'POST', body: { authToken: noraToken, targetHandle: '@luna' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, following: true });

  var noraGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: noraToken } }));
  assert.deepEqual(JSON.parse(noraGet.body), { ok: true, following: ['@luna'], followerCount: 0 });

  var lunaToken = await mintToken('luna');
  var lunaGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: lunaToken } }));
  var lunaBody = JSON.parse(lunaGet.body);
  assert.equal(lunaBody.followerCount, 1, "luna's own followerCount must reflect nora's follow");
  assert.deepEqual(lunaBody.following, [], "luna following nobody herself is unaffected by being followed");
});

test('follow-user POST: default action is "follow" when action is omitted', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/follow-user').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { authToken: token, targetHandle: '@luna' } }));
  assert.equal(JSON.parse(res.body).following, true);
});

test('follow-user POST: following the same handle twice does not double-increment the target follower count', async function () {
  var token = await mintToken('nora');
  var followHandler = require('../netlify/functions/follow-user').handler;
  var getFollowingHandler = require('../netlify/functions/get-following').handler;

  await followHandler(fakeEvent({ method: 'POST', body: { authToken: token, targetHandle: '@luna' } }));
  var res = await followHandler(fakeEvent({ method: 'POST', body: { authToken: token, targetHandle: '@luna' } }));
  assert.equal(JSON.parse(res.body).following, true);

  var lunaToken = await mintToken('luna');
  var lunaGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: lunaToken } }));
  assert.equal(JSON.parse(lunaGet.body).followerCount, 1, 'a duplicate follow request must not double-count');
});

test('follow-user POST: unfollow removes the handle and decrements the target follower count; unfollowing something never followed is a harmless no-op', async function () {
  var noraToken = await mintToken('nora');
  var followHandler = require('../netlify/functions/follow-user').handler;
  var getFollowingHandler = require('../netlify/functions/get-following').handler;

  await followHandler(fakeEvent({ method: 'POST', body: { authToken: noraToken, targetHandle: '@luna' } }));
  await followHandler(fakeEvent({ method: 'POST', body: { authToken: noraToken, targetHandle: '@marco' } }));

  var unfollowRes = await followHandler(fakeEvent({ method: 'POST', body: { authToken: noraToken, targetHandle: '@luna', action: 'unfollow' } }));
  assert.equal(unfollowRes.statusCode, 200);
  assert.deepEqual(JSON.parse(unfollowRes.body), { ok: true, following: false });

  var noraGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: noraToken } }));
  assert.deepEqual(JSON.parse(noraGet.body).following, ['@marco']);

  var lunaToken = await mintToken('luna');
  var lunaGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: lunaToken } }));
  assert.equal(JSON.parse(lunaGet.body).followerCount, 0);

  var noopRes = await followHandler(fakeEvent({ method: 'POST', body: { authToken: noraToken, targetHandle: '@never-followed', action: 'unfollow' } }));
  assert.equal(noopRes.statusCode, 200);
  assert.equal(JSON.parse(noopRes.body).following, false);
});

test('follow-user POST: an unfollow no-op does not touch a target it never actually incremented (no negative-drift underflow)', async function () {
  var token = await mintToken('nora');
  var followHandler = require('../netlify/functions/follow-user').handler;
  var getFollowingHandler = require('../netlify/functions/get-following').handler;

  await followHandler(fakeEvent({ method: 'POST', body: { authToken: token, targetHandle: '@luna', action: 'unfollow' } }));
  var lunaToken = await mintToken('luna');
  var lunaGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: lunaToken } }));
  assert.equal(JSON.parse(lunaGet.body).followerCount, 0, 'floored at 0 -- never goes negative');
});

test('follow-user POST: two different accounts following the same target both count, and unrelated accounts keep separate following lists', async function () {
  var noraToken = await mintToken('nora');
  var priyaToken = await mintToken('priya');
  var followHandler = require('../netlify/functions/follow-user').handler;
  var getFollowingHandler = require('../netlify/functions/get-following').handler;

  await followHandler(fakeEvent({ method: 'POST', body: { authToken: noraToken, targetHandle: '@luna' } }));
  await followHandler(fakeEvent({ method: 'POST', body: { authToken: priyaToken, targetHandle: '@luna' } }));
  await followHandler(fakeEvent({ method: 'POST', body: { authToken: priyaToken, targetHandle: '@carlos' } }));

  var lunaToken = await mintToken('luna');
  var lunaGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: lunaToken } }));
  assert.equal(JSON.parse(lunaGet.body).followerCount, 2);

  var noraGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: noraToken } }));
  assert.deepEqual(JSON.parse(noraGet.body).following, ['@luna']);
  var priyaGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: priyaToken } }));
  assert.deepEqual(JSON.parse(priyaGet.body).following, ['@luna', '@carlos']);
});

test('follow-user POST: rejects following yourself (by handle, case-insensitive/"@"-agnostic) with E5, derived from the TOKEN\'s account, not any client-supplied field', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/follow-user').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { authToken: token, targetHandle: '@NORA' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E5: cannot_follow_self/);
});

test('follow-user POST: an attacker who knows a victim\'s public handle cannot follow/unfollow on their behalf without the victim\'s own token', async function () {
  var victimToken = await mintToken('nora');
  var attackerToken = await mintToken('mallory');
  var followHandler = require('../netlify/functions/follow-user').handler;
  var getFollowingHandler = require('../netlify/functions/get-following').handler;

  await followHandler(fakeEvent({ method: 'POST', body: { authToken: victimToken, targetHandle: '@luna' } }));

  // Attacker knows nora's public handle but can only ever act as THEIR OWN
  // account (mallory) -- this must never touch nora's own following list.
  var attackerRes = await followHandler(fakeEvent({ method: 'POST', body: { authToken: attackerToken, targetHandle: '@luna', action: 'unfollow' } }));
  assert.equal(attackerRes.statusCode, 200);
  assert.equal(JSON.parse(attackerRes.body).following, false, "the no-op unfollow only ever touches the CALLER's own (never-following) state");

  var victimGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: victimToken } }));
  assert.deepEqual(JSON.parse(victimGet.body).following, ['@luna'], "the victim's own follow must be completely unaffected by the attacker's call");
});

test('follow-user POST: rejects missing authToken/targetHandle, invalid JSON, non-POST methods, and an invalid/expired token', async function () {
  var handler = require('../netlify/functions/follow-user').handler;

  var noToken = await handler(fakeEvent({ method: 'POST', body: { targetHandle: '@luna' } }));
  assert.equal(noToken.statusCode, 400);
  assert.match(JSON.parse(noToken.body).error, /^E3: auth_token_required/);

  var validToken = await mintToken('nora');
  var noTarget = await handler(fakeEvent({ method: 'POST', body: { authToken: validToken } }));
  assert.equal(noTarget.statusCode, 400);
  assert.match(JSON.parse(noTarget.body).error, /^E4: target_handle_required/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);

  var badToken = await handler(fakeEvent({ method: 'POST', body: { authToken: 'garbage-token', targetHandle: '@luna' } }));
  assert.equal(badToken.statusCode, 200);
  var badTokenBody = JSON.parse(badToken.body);
  assert.equal(badTokenBody.ok, false);
  assert.match(badTokenBody.error, /^E6: invalid_or_expired_token/);
});

// ===== get-following.js: GET =====

test('get-following GET: a valid token for an account that follows nobody gets an empty list + 0 followerCount back, not an error', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/get-following').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { authToken: token } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, following: [], followerCount: 0 });
});

test('get-following GET: rejects a missing authToken with E2, and there is no `handle` param that could substitute for it', async function () {
  var handler = require('../netlify/functions/get-following').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { handle: 'nora' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2: auth_token_required/);
});

test('get-following GET: an unknown/garbage authToken is rejected as invalid_or_expired, not trusted as a real account', async function () {
  var handler = require('../netlify/functions/get-following').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { authToken: 'not-a-real-token-anyone-could-guess' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E3: invalid_or_expired_token/);
});

test('get-following GET: rejects non-GET methods', async function () {
  var handler = require('../netlify/functions/get-following').handler;
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('get-following GET: LOCKED CONSTRAINT -- a caller can never read another account\'s follower count; each token only ever sees its OWN', async function () {
  var noraToken = await mintToken('nora');
  var lunaToken = await mintToken('luna');
  var followHandler = require('../netlify/functions/follow-user').handler;
  var getFollowingHandler = require('../netlify/functions/get-following').handler;

  // Give luna two followers.
  await followHandler(fakeEvent({ method: 'POST', body: { authToken: noraToken, targetHandle: '@luna' } }));
  var marcoToken = await mintToken('marco');
  await followHandler(fakeEvent({ method: 'POST', body: { authToken: marcoToken, targetHandle: '@luna' } }));

  // nora's own GET (her own token) never sees luna's followerCount -- only
  // her own (0, she has no followers herself).
  var noraGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: noraToken } }));
  assert.equal(JSON.parse(noraGet.body).followerCount, 0);

  // Only luna's OWN token sees her real count.
  var lunaGet = await getFollowingHandler(fakeEvent({ method: 'GET', query: { authToken: lunaToken } }));
  assert.equal(JSON.parse(lunaGet.body).followerCount, 2);
});

// ===== lib/follow-store.js directly =====

test('lib/follow-store.js: getFollowing/getFollowerCount return [] / 0 for a username that has never followed or been followed', async function () {
  var followStore = require('../netlify/functions/lib/follow-store');
  var event = fakeEvent({ method: 'GET' });
  assert.deepEqual(await followStore.getFollowing(event, 'brand-new-user'), []);
  assert.equal(await followStore.getFollowerCount(event, 'brand-new-user'), 0);
});

test('lib/follow-store.js: isFollowing is case/"@"-insensitive', async function () {
  var followStore = require('../netlify/functions/lib/follow-store');
  var event = fakeEvent({ method: 'GET' });
  await followStore.setFollowing(event, 'nora', '@Luna', true);
  assert.equal(await followStore.isFollowing(event, 'nora', 'luna'), true);
  assert.equal(await followStore.isFollowing(event, 'NORA', '@LUNA'), true);
  assert.equal(await followStore.isFollowing(event, 'nora', 'marco'), false);
});

test('lib/follow-store.js: setFollowing(follow:false) on a genuinely-following pair only decrements once even if called concurrently-in-sequence twice', async function () {
  var followStore = require('../netlify/functions/lib/follow-store');
  var event = fakeEvent({ method: 'GET' });
  await followStore.setFollowing(event, 'nora', '@luna', true);
  await followStore.setFollowing(event, 'nora', '@luna', false);
  var second = await followStore.setFollowing(event, 'nora', '@luna', false);
  assert.equal(second.following, false);
  assert.equal(await followStore.getFollowerCount(event, 'luna'), 0);
});
