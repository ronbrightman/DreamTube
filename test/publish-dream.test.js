// test/publish-dream.test.js
//
// Covers netlify/functions/publish-dream.js — in particular the
// image-generation-feature fix (docs/IMAGE_GENERATION_SPEC.md): a dream
// needs EITHER a videoUrl or an imageUrl to publish, not specifically a
// videoUrl. The old `!videoUrl` requirement silently blocked every
// image-type dream from ever reaching the shared feed at all (since
// js/store.js's syncPublishedDreamToFeed is fire-and-forget) — this locks
// in the fix and the pre-existing videoUrl-only behavior it must not break.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var handler = require('../netlify/functions/publish-dream').handler;

test.beforeEach(function () {
  mockBlobs.reset();
});

function postEvent(body) {
  return fakeEvent({ method: 'POST', body: body });
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
  var res = await handler(postEvent({ ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'missing_fields');
});

test('neither videoUrl nor imageUrl present -> 400 missing_fields (a dream needs at least one)', async function () {
  var res = await handler(postEvent({ id: 'd1', ownerHandle: '@x', caption: 'c', style: 'Cartoon' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'missing_fields');
  assert.deepEqual(await feedIndex(), []);
});

test('a video-type dream (videoUrl, no imageUrl) publishes successfully — pre-existing behavior, unchanged', async function () {
  var res = await handler(postEvent({ id: 'd-video', ownerHandle: '@x', caption: 'c', style: 'Cartoon', dur: '0:08', videoUrl: 'https://x/v.mp4' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.dream.videoUrl, 'https://x/v.mp4');
  assert.equal(body.dream.imageUrl, null);
  assert.equal(body.dream.mediaType, 'video');
});

test('an image-type dream (imageUrl, no videoUrl) now publishes successfully — the actual fix', async function () {
  var res = await handler(postEvent({ id: 'd-image', ownerHandle: '@x', caption: 'c', style: 'Cartoon', imageUrl: 'https://x/i.png', mediaType: 'image' }));
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
  var res = await handler(postEvent({ id: 'd-default', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.mediaType, 'video');
});

test('upserts by id — publishing the same id twice updates the record in place, preserving likes/publishedAt', async function () {
  var first = await handler(postEvent({ id: 'd-upsert', ownerHandle: '@x', caption: 'v1', style: 'Cartoon', videoUrl: 'https://x/v1.mp4' }));
  var firstBody = JSON.parse(first.body);

  var second = await handler(postEvent({ id: 'd-upsert', ownerHandle: '@x', caption: 'v2', style: 'Cinematic', videoUrl: 'https://x/v2.mp4' }));
  var secondBody = JSON.parse(second.body);

  assert.equal(secondBody.dream.caption, 'v2');
  assert.equal(secondBody.dream.publishedAt, firstBody.dream.publishedAt, 'publishedAt must survive an upsert');

  var feed = await feedIndex();
  assert.equal(feed.length, 1, 'must not create a duplicate entry');
  assert.equal(feed[0].caption, 'v2');
});

test('a dream with BOTH videoUrl and imageUrl (post "Turn this into a video") publishes with both fields intact', async function () {
  var res = await handler(postEvent({
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
  var res = await handler(postEvent({ id: 'd-no-license', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.channelLicenseGrantedAt, null);
});

test('channelLicenseGrantedAt passed through verbatim when a real publish supplies it', async function () {
  var stamp = 1780000000000;
  var res = await handler(postEvent({ id: 'd-licensed', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', channelLicenseGrantedAt: stamp }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.channelLicenseGrantedAt, stamp);
});

test('okToFeatureOnChannels omitted -> defaults true (zero-click default-on opt-out)', async function () {
  var res = await handler(postEvent({ id: 'd-default-opt', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.okToFeatureOnChannels, true);
});

test('okToFeatureOnChannels:false is honored and stored', async function () {
  var res = await handler(postEvent({ id: 'd-opted-out', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', okToFeatureOnChannels: false }));
  var body = JSON.parse(res.body);
  assert.equal(body.dream.okToFeatureOnChannels, false);

  var feed = await feedIndex();
  assert.equal(feed[0].okToFeatureOnChannels, false);
});

test('an upsert can flip okToFeatureOnChannels on an already-published dream (the settings-sheet opt-out re-syncing immediately)', async function () {
  var first = await handler(postEvent({ id: 'd-flip', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4' }));
  assert.equal(JSON.parse(first.body).dream.okToFeatureOnChannels, true);

  var second = await handler(postEvent({ id: 'd-flip', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: 'https://x/v.mp4', okToFeatureOnChannels: false }));
  assert.equal(JSON.parse(second.body).dream.okToFeatureOnChannels, false);

  var feed = await feedIndex();
  assert.equal(feed.length, 1);
  assert.equal(feed[0].okToFeatureOnChannels, false);
});
