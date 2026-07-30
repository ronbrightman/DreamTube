// test/publish-dream-avatar-validation.test.js
//
// Covers the `avatar` field added to netlify/functions/publish-dream.js
// (tracker item for-product-ui-founder-directed-2026-07--djgjn0): a small
// avatar thumbnail carried alongside the rest of the published-dream
// record so OTHER visitors' devices have something real to render for
// Explore's feed-user-row circle (see explore.html's avatarHTML and
// js/store.js's syncPublishedDreamToFeed/currentUserAvatarThumbnail for
// the client-side half).
//
// This field is genuinely attacker-controllable free-form data (unlike
// the rest of this endpoint's short strings/URLs/booleans — see that
// file's own "SECURITY"/"avatar" header comments), so it gets the same
// validate-don't-trust rigor as the rest of this file's hardening
// (tracker item publish-dream-js-trusts-client-supplied--lkppcu, covered
// by test/publish-unpublish-dream-auth.test.js) — must be a real, small,
// correctly-typed image data URL or absent entirely, never trusted
// blindly. Follows test/publish-dream.test.js's own conventions exactly
// (same mock-blobs/fake-event/postEvent helper shape) — kept as a
// separate file rather than appended to that one, since this is a
// distinct field with its own validation story worth reading on its own.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
var handler = require('../netlify/functions/publish-dream').handler;

test.beforeEach(function () {
  mockBlobs.reset();
});

/** Mints a real authToken for the username implied by `body.ownerHandle` (defaulting to '@x' -> 'x'), then builds the POST event -- same helper as test/publish-dream.test.js. */
async function postEvent(body) {
  body = body || {};
  var ownerHandle = body.ownerHandle || '@x';
  var username = ownerHandle.charAt(0) === '@' ? ownerHandle.slice(1) : ownerHandle;
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), username);
  return fakeEvent({ method: 'POST', body: Object.assign({ ownerHandle: ownerHandle }, body, { authToken: token }) });
}

async function feedIndex() {
  return (await getStore('dreamtube-feed').get('feed-index')) || [];
}

/** A real small, valid JPEG data URL -- a 1x1 pixel, well under any size cap, structurally identical to what js/store.js's resizeDataUrlForAvatarThumb actually produces (a base64 JPEG data URL). */
var VALID_AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

test('valid small avatar data URL is accepted and stored on the record', async function () {
  var res = await handler(await postEvent({ id: 'd-avatar-ok', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: VALID_AVATAR }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.dream.avatar, VALID_AVATAR);

  var feed = await feedIndex();
  assert.equal(feed[0].avatar, VALID_AVATAR);
});

test('avatar omitted entirely -> stored as null (no Me photo set, or a client that predates this field)', async function () {
  var res = await handler(await postEvent({ id: 'd-avatar-omitted', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.avatar, null);
});

test('avatar explicitly null -> stored as null', async function () {
  var res = await handler(await postEvent({ id: 'd-avatar-null', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: null }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.avatar, null);
});

test('oversized avatar payload -> 400 E7 invalid_avatar, nothing written to the feed', async function () {
  // Comfortably over AVATAR_MAX_BYTES (20KB decoded) -- ~30KB of base64 characters decodes to ~22.5KB.
  var hugeBase64 = 'A'.repeat(30 * 1024);
  var res = await handler(await postEvent({ id: 'd-avatar-huge', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: 'data:image/jpeg;base64,' + hugeBase64 }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E7: invalid_avatar');
  assert.deepEqual(await feedIndex(), []);
});

test('wrong-type avatar (not an image data URL at all) -> 400 E7 invalid_avatar', async function () {
  var res = await handler(await postEvent({ id: 'd-avatar-wrong-type', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: 'not a data url at all' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E7: invalid_avatar');
});

test('wrong-type avatar (a non-image MIME type data URL, e.g. text/html) -> 400 E7 invalid_avatar', async function () {
  var res = await handler(await postEvent({ id: 'd-avatar-html', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E7: invalid_avatar');
});

test('avatar that is not a string (e.g. an object) -> 400 E7 invalid_avatar', async function () {
  var res = await handler(await postEvent({ id: 'd-avatar-object', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: { not: 'a string' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E7: invalid_avatar');
});

test('malformed base64 body in an otherwise correctly-typed data URL -> 400 E7 invalid_avatar', async function () {
  var res = await handler(await postEvent({ id: 'd-avatar-malformed', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: 'data:image/jpeg;base64,not!!valid$$base64%%' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E7: invalid_avatar');
});

test('an invalid avatar rejects the WHOLE request -- not just silently dropped -- same reject-don\'t-degrade posture as this file\'s other hardening (E3/E6)', async function () {
  var res = await handler(await postEvent({ id: 'd-avatar-reject-whole', ownerHandle: '@x', caption: 'a real caption', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: 'garbage' }));
  assert.equal(res.statusCode, 400);
  var feed = await feedIndex();
  assert.deepEqual(feed, [], 'the dream itself must not be published at all off the back of an invalid avatar field');
});

test('an upsert can attach an avatar to a dream that was originally published without one', async function () {
  var first = await handler(await postEvent({ id: 'd-avatar-added-later', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  assert.equal(JSON.parse(first.body).dream.avatar, null);

  var second = await handler(await postEvent({ id: 'd-avatar-added-later', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: VALID_AVATAR }));
  assert.equal(JSON.parse(second.body).dream.avatar, VALID_AVATAR);

  var feed = await feedIndex();
  assert.equal(feed.length, 1);
  assert.equal(feed[0].avatar, VALID_AVATAR);
});

test('png and webp avatar data URLs are accepted too, not just jpeg', async function () {
  var pngAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  var res = await handler(await postEvent({ id: 'd-avatar-png', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', avatar: pngAvatar }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).dream.avatar, pngAvatar);
});
