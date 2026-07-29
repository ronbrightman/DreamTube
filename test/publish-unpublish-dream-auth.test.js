// test/publish-unpublish-dream-auth.test.js
//
// Covers the server-side authorization fix for tracker item
// publish-dream-js-trusts-client-supplied--lkppcu:
//   - publish-dream.js: now requires a verified authToken (lib/account-
//     auth-token.js), and rejects (E6 owner_mismatch) any request whose
//     claimed ownerHandle doesn't match the token's verified username --
//     an earlier version trusted a bare client-supplied ownerHandle
//     outright, which became a real problem once this record started
//     carrying real legal republish-consent state
//     (channelLicenseGrantedAt/channelLicenseRevokedAt/
//     okToFeatureOnChannels).
//   - unpublish-dream.js: now requires a verified authToken AND that its
//     username matches the TARGET FEED RECORD's own stored ownerHandle
//     (not just any signed-in account's valid token) before deleting --
//     an earlier version accepted a bare `{ id }` with no check at all.
//
// Follows test/block-user.test.js's conventions: mock-blobs +
// account-auth-token.js's own mintToken to obtain real tokens for test
// accounts, same way account-login.js/register-account.js do server-side.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/publish-dream')];
  delete require.cache[require.resolve('../netlify/functions/unpublish-dream')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-auth-token')];
});

/** Mints a real authToken for `username`, exactly the way account-login.js/register-account.js do on a genuine success. */
function mintToken(username) {
  var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
  return accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), username);
}

function samplePublishBody(overrides) {
  return Object.assign({
    id: 'dream-1',
    ownerHandle: '@nora',
    caption: 'A test dream',
    style: 'Cinematic',
    dur: '0:08',
    videoUrl: 'https://example.com/v.mp4',
    mediaType: 'video'
  }, overrides || {});
}

// ===== publish-dream.js =====

test('publish-dream: a legitimate signed-in owner (matching authToken + ownerHandle) publishes successfully', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/publish-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: samplePublishBody({ authToken: token }) }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.dream.ownerHandle, '@nora');
});

test('publish-dream: rejects a request with no authToken at all (E4)', async function () {
  var handler = require('../netlify/functions/publish-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: samplePublishBody() }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: auth_token_required/);
});

test('publish-dream: rejects an invalid/garbage authToken as invalid_or_expired (E5), not trusted as a real account', async function () {
  var handler = require('../netlify/functions/publish-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: samplePublishBody({ authToken: 'not-a-real-token' }) }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E5: invalid_or_expired_token/);
});

test('publish-dream: a forged request -- valid token for one account, but a DIFFERENT account\'s ownerHandle claimed -- is rejected (E6), and never reaches the shared feed', async function () {
  var attackerToken = await mintToken('mallory');
  var handler = require('../netlify/functions/publish-dream').handler;

  // Mallory has a real, valid token, but tries to publish/overwrite a
  // record claiming to be @nora (whose real public dream id she knows).
  var res = await handler(fakeEvent({
    method: 'POST',
    body: samplePublishBody({ id: 'nora-real-dream', ownerHandle: '@nora', authToken: attackerToken })
  }));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /^E6: owner_mismatch/);

  // Confirm nothing was actually written to the shared feed.
  var mockBlobsStore = require('@netlify/blobs').getStore('dreamtube-feed');
  var feed = await mockBlobsStore.get('feed-index', { type: 'json' });
  assert.ok(!feed || feed.length === 0, 'the forged publish must never reach the shared feed-index');
});

test('publish-dream: a forged unpublish/consent-flip attempt cannot overwrite an existing real owner\'s already-published record', async function () {
  var victimToken = await mintToken('nora');
  var attackerToken = await mintToken('mallory');
  var handler = require('../netlify/functions/publish-dream').handler;

  // nora genuinely publishes with the republish license granted and
  // okToFeatureOnChannels on.
  var realPublish = await handler(fakeEvent({
    method: 'POST',
    body: samplePublishBody({
      id: 'nora-licensed-dream', authToken: victimToken,
      channelLicenseGrantedAt: 1700000000000, okToFeatureOnChannels: true
    })
  }));
  assert.equal(realPublish.statusCode, 200);

  // mallory knows nora's public dream id and tries to flip her consent
  // state off, forging nora's ownerHandle but using mallory's OWN token.
  var forged = await handler(fakeEvent({
    method: 'POST',
    body: samplePublishBody({
      id: 'nora-licensed-dream', ownerHandle: '@nora', authToken: attackerToken,
      okToFeatureOnChannels: false
    })
  }));
  assert.equal(forged.statusCode, 403);

  // nora's real consent state must be completely untouched.
  var getResult = await handler(fakeEvent({
    method: 'POST',
    body: samplePublishBody({ id: 'nora-licensed-dream', authToken: victimToken, okToFeatureOnChannels: true })
  }));
  assert.equal(JSON.parse(getResult.body).dream.okToFeatureOnChannels, true);
});

test('publish-dream: ownerHandle comparison is case-insensitive and "@"-agnostic', async function () {
  var token = await mintToken('Nora');
  var handler = require('../netlify/functions/publish-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: samplePublishBody({ ownerHandle: 'NORA', authToken: token }) }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('publish-dream: rejects missing required fields, invalid JSON, and non-POST methods', async function () {
  var handler = require('../netlify/functions/publish-dream').handler;

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var token = await mintToken('nora');
  var missingCaption = await handler(fakeEvent({
    method: 'POST',
    body: Object.assign(samplePublishBody({ authToken: token }), { caption: undefined })
  }));
  assert.equal(missingCaption.statusCode, 400);
  assert.match(JSON.parse(missingCaption.body).error, /^E3: missing_fields/);
});

// ===== unpublish-dream.js =====

/** Publishes a real dream via the (now-fixed) publish-dream.js handler, returning its authToken for convenience. */
async function publishFixture(username, id) {
  var token = await mintToken(username);
  var publishHandler = require('../netlify/functions/publish-dream').handler;
  await publishHandler(fakeEvent({
    method: 'POST',
    body: samplePublishBody({ id: id, ownerHandle: '@' + username, authToken: token })
  }));
  return token;
}

test('unpublish-dream: the real owner (matching authToken) can unpublish their own dream', async function () {
  var token = await publishFixture('nora', 'dream-a');
  var handler = require('../netlify/functions/unpublish-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { id: 'dream-a', authToken: token } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  var store = require('@netlify/blobs').getStore('dreamtube-feed');
  var feed = await store.get('feed-index', { type: 'json' });
  assert.ok(!feed.some(function (d) { return d.id === 'dream-a'; }), 'the dream must actually be removed from the shared feed');
});

test('unpublish-dream: rejects a request with no authToken at all (E4)', async function () {
  await publishFixture('nora', 'dream-b');
  var handler = require('../netlify/functions/unpublish-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { id: 'dream-b' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: auth_token_required/);
});

test('unpublish-dream: rejects an invalid/garbage authToken as invalid_or_expired (E5)', async function () {
  await publishFixture('nora', 'dream-c');
  var handler = require('../netlify/functions/unpublish-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { id: 'dream-c', authToken: 'garbage' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E5: invalid_or_expired_token/);
});

test('unpublish-dream: a DIFFERENT account\'s perfectly valid token cannot unpublish someone else\'s dream (E6 not_owner) -- the exact vulnerability this fix closes', async function () {
  await publishFixture('nora', 'dream-d');
  var attackerToken = await mintToken('mallory');
  var handler = require('../netlify/functions/unpublish-dream').handler;

  var res = await handler(fakeEvent({ method: 'POST', body: { id: 'dream-d', authToken: attackerToken } }));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /^E6: not_owner/);

  // The real dream must still be sitting in the shared feed, untouched.
  var store = require('@netlify/blobs').getStore('dreamtube-feed');
  var feed = await store.get('feed-index', { type: 'json' });
  assert.ok(feed.some(function (d) { return d.id === 'dream-d'; }), 'nora\'s dream must still be in the shared feed after the forged attempt');
});

test('unpublish-dream: unpublishing an id that does not exist in the feed is a harmless no-op even with a valid token', async function () {
  var token = await mintToken('nora');
  var handler = require('../netlify/functions/unpublish-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { id: 'never-published', authToken: token } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('unpublish-dream: rejects missing id, invalid JSON, and non-POST methods', async function () {
  var handler = require('../netlify/functions/unpublish-dream').handler;

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var noId = await handler(fakeEvent({ method: 'POST', body: { authToken: 'whatever' } }));
  assert.equal(noId.statusCode, 400);
  assert.match(JSON.parse(noId.body).error, /^E3: id_required/);
});
