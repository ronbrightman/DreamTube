// test/sync-profile.test.js
//
// Covers netlify/functions/sync-profile.js — the token-gated write half of
// Social Layer v2 slice 1 (docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Mirrors
// test/publish-dream.test.js's / test/publish-unpublish-dream-auth.test.js's
// own conventions for a lib/account-auth-token.js-gated endpoint.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
var profileStore = require('../netlify/functions/lib/profile-store');
var handler = require('../netlify/functions/sync-profile').handler;

test.beforeEach(function () {
  mockBlobs.reset();
});

/** Mints a real authToken for the username implied by `body.handle` (defaulting to '@x' -> 'x'), then builds the POST event -- mirrors publish-dream.test.js's own postEvent helper. */
async function postEvent(body) {
  body = body || {};
  var handle = body.handle || '@x';
  var username = handle.charAt(0) === '@' ? handle.slice(1) : handle;
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), username);
  return fakeEvent({ method: 'POST', body: Object.assign({ handle: handle }, body, { authToken: token }) });
}

test('wrong method -> 405', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('invalid JSON -> 400', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
});

test('missing handle -> 400 E3', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: { displayName: 'x' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E3: handle_required');
});

test('missing authToken -> 400 E4', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: { handle: '@x', displayName: 'x' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E4: auth_token_required');
});

test('bio over 150 chars -> 400 E8, before ever touching the token/store', async function () {
  var longBio = 'a'.repeat(151);
  var res = await handler(await postEvent({ handle: '@x', bio: longBio }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E8: bio_too_long');
  var stored = await profileStore.getProfile(fakeEvent({ method: 'GET' }), 'x');
  assert.equal(stored, null, 'a rejected request must never write anything');
});

test('bio exactly 150 chars is accepted (boundary)', async function () {
  var bio150 = 'a'.repeat(150);
  var res = await handler(await postEvent({ handle: '@x', bio: bio150 }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.profile.bio, bio150);
});

test('invalid avatarDataUrl (not an image data URL) -> 400 E7', async function () {
  var res = await handler(await postEvent({ handle: '@x', avatarDataUrl: 'not-a-data-url' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E7: invalid_avatar');
});

test('avatarDataUrl over the size cap -> 400 E7', async function () {
  // ~200KB of base64 payload, comfortably over AVATAR_MAX_BYTES (150KB).
  var hugeBase64 = 'A'.repeat(280000);
  var res = await handler(await postEvent({ handle: '@x', avatarDataUrl: 'data:image/jpeg;base64,' + hugeBase64 }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E7: invalid_avatar');
});

test('avatarDataUrl omitted -> stored as null, not rejected', async function () {
  var res = await handler(await postEvent({ handle: '@x', displayName: 'X' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.profile.avatarDataUrl, null);
});

test('invalid/expired token -> 200 ok:false E5 (business outcome, not a 4xx)', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: { handle: '@x', authToken: 'not-a-real-token' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'E5: invalid_or_expired_token');
});

test('SECURITY: a verified token for one username cannot sync a DIFFERENT handle -> 403 E6, and nothing is written', async function () {
  var attackerToken = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'attacker');
  var res = await handler(fakeEvent({
    method: 'POST',
    body: { handle: '@victim', displayName: 'Fake Victim Bio', authToken: attackerToken }
  }));
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'E6: owner_mismatch');
  var victimProfile = await profileStore.getProfile(fakeEvent({ method: 'GET' }), 'victim');
  assert.equal(victimProfile, null, "the attacker's forged request must not have written the victim's profile");
});

test('handle case mismatch against the verified token is tolerated (case-insensitive match), and the CLIENT-SUPPLIED case is what gets stored', async function () {
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'luna');
  var res = await handler(fakeEvent({ method: 'POST', body: { handle: '@Luna', displayName: 'Luna', authToken: token } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.profile.handle, '@Luna', 'the real-cased handle the client sent must be preserved, since the token itself only carries a normalized lowercase username');
});

test('a full, valid sync stores handle/displayName/avatarDataUrl/bio and returns them back', async function () {
  var res = await handler(await postEvent({
    handle: '@luna', displayName: 'Luna ✦', avatarDataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD//2Q==', bio: 'I dream in cinematic blue.'
  }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.profile.handle, '@luna');
  assert.equal(body.profile.displayName, 'Luna ✦');
  assert.equal(body.profile.bio, 'I dream in cinematic blue.');
  assert.ok(body.profile.avatarDataUrl.indexOf('data:image/jpeg;base64,') === 0);

  var reread = await profileStore.getProfile(fakeEvent({ method: 'GET' }), 'luna');
  assert.deepEqual(reread, body.profile);
});

test('a second sync overwrites the first (Edit-profile save re-syncing) — old bio does not survive an empty-bio save', async function () {
  await handler(await postEvent({ handle: '@luna', displayName: 'Luna', bio: 'first bio' }));
  var second = await handler(await postEvent({ handle: '@luna', displayName: 'Luna', bio: '' }));
  var body = JSON.parse(second.body);
  assert.equal(body.profile.bio, '');
});

test('displayName is trimmed and defaults to empty string when omitted', async function () {
  var res = await handler(await postEvent({ handle: '@x' }));
  var body = JSON.parse(res.body);
  assert.equal(body.profile.displayName, '');
});
