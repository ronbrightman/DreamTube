// test/profile-store.test.js
//
// Covers netlify/functions/lib/profile-store.js — the durable per-username
// public-profile record backing Social Layer v2 slice 1 (docs/
// SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Same shape as
// test/block-user.test.js's own coverage of block-store.js's lib.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var profileStore = require('../netlify/functions/lib/profile-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('getProfile returns null for a handle that has never synced a profile', async function () {
  var profile = await profileStore.getProfile(fakeEvent({ method: 'GET' }), 'nobody');
  assert.equal(profile, null);
});

test('upsertProfile then getProfile round-trips the full record, "@"-agnostic and case-insensitive on read', async function () {
  var event = fakeEvent({ method: 'POST' });
  var stored = await profileStore.upsertProfile(event, 'Luna', {
    handle: '@Luna', displayName: 'Luna ✦', avatarDataUrl: 'data:image/jpeg;base64,AAA=', bio: 'I dream in blue.'
  });
  assert.equal(stored.handle, '@Luna');
  assert.equal(stored.displayName, 'Luna ✦');
  assert.equal(stored.bio, 'I dream in blue.');
  assert.ok(typeof stored.updatedAt === 'number');

  var byBareLowercase = await profileStore.getProfile(event, 'luna');
  assert.deepEqual(byBareLowercase, stored);

  var byAtUppercase = await profileStore.getProfile(event, '@LUNA');
  assert.deepEqual(byAtUppercase, stored);
});

test('upsertProfile is a full overwrite, not a partial patch — a second call with a different shape replaces the first entirely', async function () {
  var event = fakeEvent({ method: 'POST' });
  await profileStore.upsertProfile(event, 'luna', { handle: '@luna', displayName: 'Luna', avatarDataUrl: 'data:image/jpeg;base64,AAA=', bio: 'old bio' });
  var second = await profileStore.upsertProfile(event, 'luna', { handle: '@luna', displayName: 'Luna V2', avatarDataUrl: null, bio: '' });

  assert.equal(second.displayName, 'Luna V2');
  assert.equal(second.avatarDataUrl, null, 'a later save with no avatar must clear the old one, not silently keep it');
  assert.equal(second.bio, '', 'a later save with an empty bio must clear the old one');

  var reread = await profileStore.getProfile(event, 'luna');
  assert.deepEqual(reread, second);
});

test('normalizeUsername trims and lowercases a bare username (no "@" stripping — same contract as lib/account-auth-token.js/lib/block-store.js\'s own normalizeUsername; "@"-stripping is getProfile\'s own job, tested above via the "@Luna" round-trip)', function () {
  assert.equal(profileStore.normalizeUsername('  Luna  '), 'luna');
  assert.equal(profileStore.normalizeUsername('LUNA'), 'luna');
  assert.equal(profileStore.normalizeUsername(''), '');
  assert.equal(profileStore.normalizeUsername(null), '');
});

test('getProfile never throws on a read failure — degrades to null', async function () {
  mockBlobs.setReadOverride('dreamtube-profiles', function () { throw new Error('simulated blobs outage'); });
  var profile = await profileStore.getProfile(fakeEvent({ method: 'GET' }), 'luna');
  assert.equal(profile, null);
  mockBlobs.clearReadOverride('dreamtube-profiles');
});
