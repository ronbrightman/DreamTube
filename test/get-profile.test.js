// test/get-profile.test.js
//
// Covers netlify/functions/get-profile.js — the public, no-auth read half
// of Social Layer v2 slice 1 (docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Mirrors
// test/publish-dream.test.js's direct-store-seeding conventions.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var profileStore = require('../netlify/functions/lib/profile-store');
var handler = require('../netlify/functions/get-profile').handler;

test.beforeEach(function () {
  mockBlobs.reset();
});

function seedFeed(dreams) {
  return getStore('dreamtube-feed').setJSON('feed-index', dreams);
}

function makeDream(overrides) {
  return Object.assign({
    id: 'd1', ownerHandle: '@luna', caption: 'A dream', style: 'Cinematic',
    videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video',
    avatar: null, likes: 2, publishedAt: 1000
  }, overrides || {});
}

test('wrong method -> 405', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
});

test('missing handle -> 400 E2', async function () {
  var res = await handler(fakeEvent({ method: 'GET', query: {} }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E2: handle_required');
});

test('a handle with neither a profile record nor any published dreams -> exists:false, empty everything', async function () {
  var res = await handler(fakeEvent({ method: 'GET', query: { handle: 'nobody' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.exists, false);
  assert.equal(body.profile, null);
  assert.deepEqual(body.dreams, []);
  assert.equal(body.publishedCount, 0);
  assert.deepEqual(body.commentCounts, {}, 'slice-2 seam: an empty placeholder, present in the response shape but unfilled');
});

test('a synced profile record with zero published dreams still resolves exists:true', async function () {
  await profileStore.upsertProfile(fakeEvent({ method: 'POST' }), 'luna', { handle: '@luna', displayName: 'Luna', avatarDataUrl: null, bio: 'hi' });
  var res = await handler(fakeEvent({ method: 'GET', query: { handle: 'luna' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.exists, true);
  assert.equal(body.profile.displayName, 'Luna');
  assert.equal(body.publishedCount, 0);
  assert.deepEqual(body.dreams, []);
});

test('a dreamer who published without ever syncing a profile record still resolves exists:true with profile:null', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@luna' })]);
  var res = await handler(fakeEvent({ method: 'GET', query: { handle: 'luna' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.exists, true);
  assert.equal(body.profile, null);
  assert.equal(body.publishedCount, 1);
  assert.equal(body.dreams[0].id, 'd1');
});

test('dreams are filtered to the requested handle only, newest-first order preserved from the feed-index', async function () {
  await seedFeed([
    makeDream({ id: 'd-newest', ownerHandle: '@luna', publishedAt: 3000 }),
    makeDream({ id: 'd-other-user', ownerHandle: '@someoneelse', publishedAt: 2500 }),
    makeDream({ id: 'd-older', ownerHandle: '@luna', publishedAt: 1000 })
  ]);
  var res = await handler(fakeEvent({ method: 'GET', query: { handle: 'luna' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.publishedCount, 2);
  assert.deepEqual(body.dreams.map(function (d) { return d.id; }), ['d-newest', 'd-older']);
});

test('handle matching is case-insensitive and "@"-agnostic against both the profile store and the feed', async function () {
  await profileStore.upsertProfile(fakeEvent({ method: 'POST' }), 'luna', { handle: '@Luna', displayName: 'Luna', avatarDataUrl: null, bio: '' });
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@Luna' })]);

  var variants = ['luna', 'LUNA', '@luna', '@LUNA', 'Luna'];
  for (var i = 0; i < variants.length; i++) {
    var res = await handler(fakeEvent({ method: 'GET', query: { handle: variants[i] } }));
    var body = JSON.parse(res.body);
    assert.equal(body.exists, true, 'variant "' + variants[i] + '" should resolve');
    assert.equal(body.publishedCount, 1, 'variant "' + variants[i] + '" should find the published dream');
  }
});

test('response never includes viewer-relative flags (likedByMe/mine/blockedByMe) — this is a bare public GET with no viewer identity', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@luna' })]);
  var res = await handler(fakeEvent({ method: 'GET', query: { handle: 'luna' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.dreams[0].likedByMe, undefined);
  assert.equal(body.dreams[0].mine, undefined);
  assert.equal(body.dreams[0].blockedByMe, undefined);
});

test('CORS headers present on both GET and OPTIONS, matching get-feed.js', async function () {
  var res = await handler(fakeEvent({ method: 'OPTIONS' }));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');

  var getRes = await handler(fakeEvent({ method: 'GET', query: { handle: 'luna' } }));
  assert.equal(getRes.headers['Access-Control-Allow-Origin'], '*');
});
