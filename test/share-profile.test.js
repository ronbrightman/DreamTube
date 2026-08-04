// test/share-profile.test.js
//
// Unit coverage for netlify/functions/share-profile.js — the og:-preview
// half of Social Layer v2 slice 1's Share flow (docs/
// SOCIAL_LAYER_V2_DESIGN.md §F, tracker item
// for-product-build-social-layer-v2-direct-34047c). Mirrors
// test/share-dream.test.js's own conventions almost exactly — this file
// deliberately doesn't re-test the shared CRLF/hostname-injection defenses
// share-dream.js's own suite already exercises in depth (this file's
// implementation is a straight copy of that same logic), just the
// profile-specific behavior (og:title/description, avatar-vs-fallback
// image, the exists:false redirect target).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var profileStore = require('../netlify/functions/lib/profile-store');
var handler = require('../netlify/functions/share-profile').handler;

test.beforeEach(function () {
  mockBlobs.reset();
});

function getEvent(query, host) {
  return fakeEvent({ method: 'GET', query: query, headers: { host: host || 'dreamtube1.netlify.app' } });
}

function seedFeed(dreams) {
  return getStore('dreamtube-feed').setJSON('feed-index', dreams);
}

function makeDream(overrides) {
  return Object.assign({
    id: 'd1', ownerHandle: '@luna', caption: 'A dream', style: 'Cinematic',
    videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video', likes: 0
  }, overrides || {});
}

test('wrong method -> 405', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
});

test('missing handle -> 302 redirect to explore.html', async function () {
  var res = await handler(getEvent(null));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/explore.html');
});

test('a handle with neither a profile record nor any published dreams -> 302 redirect straight to u.html?handle=... (which renders its own not-found state)', async function () {
  var res = await handler(getEvent({ handle: 'nobody' }));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/u.html?handle=nobody');
});

test('a synced profile with published dreams -> real og:title/description/image, canonical og:url points at u.html', async function () {
  await profileStore.upsertProfile(getEvent(null), 'luna', { handle: '@Luna', displayName: 'Luna', avatarDataUrl: 'data:image/jpeg;base64,AAA=', bio: '' });
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@Luna' }), makeDream({ id: 'd2', ownerHandle: '@Luna' })]);

  var res = await handler(getEvent({ handle: 'Luna' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(res.body, /<meta property="og:title" content="@Luna&#39;s dreams on DreamTube">/);
  assert.match(res.body, /<meta property="og:description" content="2 dreams, turned into video\. Watch them — or create your own\.">/);
  assert.match(res.body, /<meta property="og:image" content="data:image\/jpeg;base64,AAA=">/);
  assert.match(res.body, /<meta property="og:url" content="https:\/\/dreamtube1\.netlify\.app\/u\.html\?handle=Luna">/);
});

test('singular "1 dream" phrasing when exactly one dream is published', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@x' })]);
  var res = await handler(getEvent({ handle: 'x' }));
  assert.match(res.body, /1 dream, turned into video/);
});

test('a dreamer with published dreams but no synced profile record falls back to the bare handle as displayName and the static branded image, not the dreamer\'s data', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@nobio' })]);
  var res = await handler(getEvent({ handle: 'nobio' }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<meta property="og:title" content="@nobio&#39;s dreams on DreamTube">/);
  assert.match(res.body, /<meta property="og:image" content="https:\/\/dreamtube1\.netlify\.app\/assets\/logo-v4\.png">/);
});

test('a synced profile with no avatar set (and no published dreams yet) still renders — profile-record-only counts as "something to show" — with the static branded fallback image', async function () {
  await profileStore.upsertProfile(getEvent(null), 'noavatar', { handle: '@noavatar', displayName: 'No Avatar', avatarDataUrl: null, bio: '' });
  var res = await handler(getEvent({ handle: 'noavatar' }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<meta property="og:image" content="https:\/\/dreamtube1\.netlify\.app\/assets\/logo-v4\.png">/);
  assert.match(res.body, /0 dreams, turned into video/);
});

test('a displayName containing HTML is escaped in og:title/og:description, never rendered as raw markup (defense in depth — profile records are attacker-writable via sync-profile.js, whose own DISPLAY_NAME_MAX_CHARS cap does not forbid angle brackets)', async function () {
  await profileStore.upsertProfile(getEvent(null), 'x', { handle: '@x', displayName: '<script>alert(1)</script>', avatarDataUrl: null, bio: '' });
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@x' })]);
  var res = await handler(getEvent({ handle: 'x' }));
  assert.equal(res.statusCode, 200);
  // og:title/description are always built from the HANDLE, never
  // displayName (see renderPreviewPage) -- so the real assertion here is
  // that the malicious displayName never leaks into the response AT ALL,
  // escaped or otherwise, and the legitimate handle-derived title still
  // renders normally.
  assert.doesNotMatch(res.body, /alert\(1\)/);
  assert.match(res.body, /<meta property="og:title" content="@x&#39;s dreams on DreamTube">/);
});


test('human-visitor redirect: meta-refresh + JS location.replace both point at u.html?handle=...', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@x' })]);
  var res = await handler(getEvent({ handle: 'x' }));
  assert.match(res.body, /<meta http-equiv="refresh" content="0;url=https:\/\/dreamtube1\.netlify\.app\/u\.html\?handle=x">/);
  assert.match(res.body, /location\.replace\("https:\/\/dreamtube1\.netlify\.app\/u\.html\?handle=x"\)/);
});

test('host header respected via x-forwarded-host, same pattern share-dream.js already established', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@x' })]);
  var event = fakeEvent({ method: 'GET', query: { handle: 'x' }, headers: { host: 'wrong.example', 'x-forwarded-host': 'dreamtube1.netlify.app' } });
  var res = await handler(event);
  assert.match(res.body, /<meta property="og:url" content="https:\/\/dreamtube1\.netlify\.app\/u\.html\?handle=x">/);
});

test('a Blobs read failure degrades to a gentle redirect, never a raw 500', async function () {
  mockBlobs.setReadOverride('dreamtube-feed', function () { throw new Error('boom'); });
  var res = await handler(getEvent({ handle: 'whatever' }));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/u.html?handle=whatever');
  mockBlobs.clearReadOverride('dreamtube-feed');
});
