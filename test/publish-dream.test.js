// test/publish-dream.test.js
//
// Covers netlify/functions/publish-dream.js — in particular the
// image-generation-feature fix (docs/IMAGE_GENERATION_SPEC.md): a dream
// needs EITHER a videoUrl or an imageUrl to publish, not specifically a
// videoUrl. The old `!videoUrl` requirement silently blocked every
// image-type dream from ever reaching the shared feed at all (since
// js/store.js's syncPublishedDreamToFeed is fire-and-forget) — this locks
// in the fix and the pre-existing videoUrl-only behavior it must not break.
//
// AUTH (tracker item publish-dream-js-trusts-client-supplied--lkppcu): this
// file's requests all now need a real authToken minted for the SAME
// account as their ownerHandle (postEvent below mints one for 'x' whenever
// ownerHandle is left at its default '@x') — publish-dream.js rejects
// anything else post-fix. See test/publish-unpublish-dream-auth.test.js
// for the actual security-fix coverage (forged ownerHandle, missing/
// invalid token, etc.) — this file stays focused on payload shape/media
// type/license-field behavior, unchanged by the auth fix except for the
// error code format (bare 'missing_fields' -> 'E3: missing_fields', see
// that file's own error-code doc block).

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

/** Mints a real authToken for the username implied by `body.ownerHandle` (defaulting to '@x' -> 'x'), then builds the POST event -- every test below publishes as its own matching owner unless it's deliberately testing a missing/invalid token. */
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

test('wrong method -> 405', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('invalid JSON -> 400', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
});

test('missing id/ownerHandle/caption/style -> 400 missing_fields', async function () {
  var res = await handler(await postEvent({ ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E3: missing_fields');
});

test('neither videoUrl nor imageUrl present -> 400 missing_fields (a dream needs at least one)', async function () {
  var res = await handler(await postEvent({ id: 'd1', ownerHandle: '@x', caption: 'c', style: 'Cartoon' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E3: missing_fields');
  assert.deepEqual(await feedIndex(), []);
});

test('missing authToken -> 400 auth_token_required', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: { id: 'd-no-token', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E4: auth_token_required');
});

test('a video-type dream (videoUrl, no imageUrl) publishes successfully — pre-existing behavior, unchanged', async function () {
  var res = await handler(await postEvent({ id: 'd-video', ownerHandle: '@x', caption: 'c', style: 'Cartoon', dur: '0:08', videoUrl: 'https://x/v.mp4' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.dream.videoUrl, 'https://x/v.mp4');
  assert.equal(body.dream.imageUrl, null);
  assert.equal(body.dream.mediaType, 'video');
});

test('an image-type dream (imageUrl, no videoUrl) now publishes successfully — the actual fix', async function () {
  var res = await handler(await postEvent({ id: 'd-image', ownerHandle: '@x', caption: 'c', style: 'Cartoon', imageUrl: 'https://x/i.png', mediaType: 'image' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.dream.imageUrl, 'https://x/i.png');
  assert.equal(body.dream.videoUrl, null);
  assert.equal(body.dream.mediaType, 'image');

  var feed = await feedIndex();
  assert.equal(feed.length, 1);
  assert.equal(feed[0].id, 'd-image');
});

test('mediaType omitted defaults to "video" (backward compatible with every existing caller)', async function () {
  var res = await handler(await postEvent({ id: 'd-default', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.mediaType, 'video');
});

test('upserts by id — publishing the same id twice updates the record in place, preserving likes/publishedAt', async function () {
  var first = await handler(await postEvent({ id: 'd-upsert', ownerHandle: '@x', caption: 'v1', style: 'Cartoon', videoUrl: 'https://x/v1.mp4' }));
  var firstBody = JSON.parse(first.body);

  var second = await handler(await postEvent({ id: 'd-upsert', ownerHandle: '@x', caption: 'v2', style: 'Cinematic', videoUrl: 'https://x/v2.mp4' }));
  var secondBody = JSON.parse(second.body);

  assert.equal(secondBody.dream.caption, 'v2');
  assert.equal(secondBody.dream.publishedAt, firstBody.dream.publishedAt, 'publishedAt must survive an upsert');

  var feed = await feedIndex();
  assert.equal(feed.length, 1, 'must not create a duplicate entry');
  assert.equal(feed[0].caption, 'v2');
});

test('a dream with BOTH videoUrl and imageUrl (post "Turn this into a video") publishes with both fields intact', async function () {
  var res = await handler(await postEvent({
    id: 'd-both', ownerHandle: '@x', caption: 'c', style: 'Cartoon',
    videoUrl: 'https://x/v.mp4', imageUrl: 'https://x/i.png', mediaType: 'video'
  }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.dream.videoUrl, 'https://x/v.mp4');
  assert.equal(body.dream.imageUrl, 'https://x/i.png');
});

// ===== Republish-license consent fields (tracker item for-product-terms-
// republish-license-per--fhpcxk) — carried into the shared feed-index
// record so a real cross-device auto-posting engine (not built here)
// could ever actually read curation eligibility. See js/store.js's
// syncPublishedDreamToFeed / publishDream for the client-side half. =====

test('channelLicenseGrantedAt omitted -> stored as null, NOT defaulted to "now" (a dream published before the clause shipped must never look licensed)', async function () {
  var res = await handler(await postEvent({ id: 'd-no-license', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.channelLicenseGrantedAt, null);
});

test('channelLicenseGrantedAt passed through verbatim when a real publish supplies it', async function () {
  var stamp = 1780000000000;
  var res = await handler(await postEvent({ id: 'd-licensed', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', channelLicenseGrantedAt: stamp }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.channelLicenseGrantedAt, stamp);
});

test('okToFeatureOnChannels omitted -> defaults true (zero-click default-on opt-out)', async function () {
  var res = await handler(await postEvent({ id: 'd-default-opt', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.okToFeatureOnChannels, true);
});

test('okToFeatureOnChannels:false is honored and stored', async function () {
  var res = await handler(await postEvent({ id: 'd-opted-out', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', okToFeatureOnChannels: false }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.okToFeatureOnChannels, false);

  var feed = await feedIndex();
  assert.equal(feed[0].okToFeatureOnChannels, false);
});

test('an upsert can flip okToFeatureOnChannels on an already-published dream (the settings-sheet opt-out re-syncing immediately)', async function () {
  var first = await handler(await postEvent({ id: 'd-flip', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  assert.equal(JSON.parse(first.body).dream.okToFeatureOnChannels, true);

  var second = await handler(await postEvent({ id: 'd-flip', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', okToFeatureOnChannels: false }));
  assert.equal(JSON.parse(second.body).dream.okToFeatureOnChannels, false);

  var feed = await feedIndex();
  assert.equal(feed.length, 1);
  assert.equal(feed[0].okToFeatureOnChannels, false);
});

// ===== createdAt (tracker item for-product-media-library-stamp-durable--
// u4oju3, root-cause fix): the shared feed record now carries a real,
// durably-stamped createdAt instead of no createdAt at all -- see this
// file's own header comment ("createdAt" paragraph) for the full "stamp at
// first-create, preserve immutably, opportunistically backfill" design. =====

test('createdAt: a client-supplied real generation-time value is stamped on first publish', async function () {
  var realCreatedAt = 1780000000000;
  var res = await handler(await postEvent({ id: 'd-createdat-1', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', createdAt: realCreatedAt }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.createdAt, realCreatedAt);

  var feed = await feedIndex();
  assert.equal(feed[0].createdAt, realCreatedAt);
});

test('createdAt: omitted on first publish falls back to Date.now() (never left null/missing the way publishedAt never was either)', async function () {
  var before = Date.now();
  var res = await handler(await postEvent({ id: 'd-createdat-2', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  var after = Date.now();
  var body = JSON.parse(res.body);
  assert.ok(typeof body.dream.createdAt === 'number' && body.dream.createdAt >= before && body.dream.createdAt <= after, 'createdAt must be a real, current timestamp, never null, on a fresh publish with no client value');
});

test('createdAt: a malformed value (a string, NaN) is dropped, not stored -- falls back to Date.now() exactly like omitting it', async function () {
  var before = Date.now();
  var res = await handler(await postEvent({ id: 'd-createdat-bad', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', createdAt: 'not-a-timestamp' }));
  var after = Date.now();
  var body = JSON.parse(res.body);
  assert.ok(typeof body.dream.createdAt === 'number' && body.dream.createdAt >= before && body.dream.createdAt <= after);
});

test('createdAt: preserved immutably across a republish/edit -- a dream\'s real creation time never moves just because its content changed', async function () {
  var realCreatedAt = 1780000000000;
  var first = await handler(await postEvent({ id: 'd-createdat-3', ownerHandle: '@x', caption: 'v1', style: 'Cartoon', videoUrl: 'https://x/v1.mp4', createdAt: realCreatedAt }));
  assert.equal(JSON.parse(first.body).dream.createdAt, realCreatedAt);

  // Republish with a DIFFERENT client-supplied createdAt -- must be ignored;
  // the original stamped value is the true one.
  var second = await handler(await postEvent({ id: 'd-createdat-3', ownerHandle: '@x', caption: 'v2', style: 'Cinematic', videoUrl: 'https://x/v2.mp4', createdAt: realCreatedAt + 999999 }));
  var secondBody = JSON.parse(second.body);
  assert.equal(secondBody.dream.createdAt, realCreatedAt, 'createdAt must survive an upsert unchanged, exactly like publishedAt');

  var feed = await feedIndex();
  assert.equal(feed.length, 1);
  assert.equal(feed[0].createdAt, realCreatedAt);
});

test('createdAt: a pre-fix legacy record with no createdAt of its own opportunistically backfills from the client on its next republish', async function () {
  // Seed a feed record shaped exactly like one written before this fix --
  // publishedAt but no createdAt at all.
  var store = getStore('dreamtube-feed');
  var legacyPublishedAt = 1750000000000;
  await store.setJSON('feed-index', [{
    id: 'd-legacy', ownerHandle: '@x', caption: 'old', style: 'Cartoon', videoUrl: 'https://x/old.mp4',
    mediaType: 'video', likes: 0, publishedAt: legacyPublishedAt,
    channelLicenseGrantedAt: null, channelLicenseRevokedAt: null, okToFeatureOnChannels: true, mood: null
  }]);

  var realCreatedAt = 1751111111111;
  var res = await handler(await postEvent({ id: 'd-legacy', ownerHandle: '@x', caption: 'new', style: 'Cartoon', videoUrl: 'https://x/new.mp4', createdAt: realCreatedAt }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.createdAt, realCreatedAt, 'a legacy record with no createdAt of its own must backfill from a real client-supplied value on its next republish');
  assert.equal(body.dream.publishedAt, legacyPublishedAt, 'publishedAt itself must stay untouched by this backfill');
});

test('createdAt: a pre-fix legacy record republished with NO client createdAt falls back to its own publishedAt (the same approximation used before this fix, not Date.now())', async function () {
  var store = getStore('dreamtube-feed');
  var legacyPublishedAt = 1750000000000;
  await store.setJSON('feed-index', [{
    id: 'd-legacy-2', ownerHandle: '@x', caption: 'old', style: 'Cartoon', videoUrl: 'https://x/old.mp4',
    mediaType: 'video', likes: 0, publishedAt: legacyPublishedAt,
    channelLicenseGrantedAt: null, channelLicenseRevokedAt: null, okToFeatureOnChannels: true, mood: null
  }]);

  var res = await handler(await postEvent({ id: 'd-legacy-2', ownerHandle: '@x', caption: 'new', style: 'Cartoon', videoUrl: 'https://x/new.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.createdAt, legacyPublishedAt, 'with no client value to backfill from, publishedAt is the correct honest stand-in, not a fresh Date.now()');
});
