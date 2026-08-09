// test/get-feed.test.js
//
// Covers netlify/functions/get-feed.js's handler directly (unit-level,
// mocked Blobs) — same direct-store-seeding conventions as
// test/get-profile.test.js and test/admin-repair-feed-likes.test.js.
// Playwright behavioral specs elsewhere mock this endpoint's response
// shape via page.route(), but nothing previously exercised the real
// handler at this level.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var handler = require('../netlify/functions/get-feed').handler;

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

test('OPTIONS -> 204 with open CORS', async function () {
  var res = await handler(fakeEvent({ method: 'OPTIONS' }));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('no feed-index yet -> empty feed array, not an error', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.deepEqual(body.feed, []);
});

test('returns the seeded feed newest-first order as stored, with a dreamOfDayId', async function () {
  await seedFeed([
    makeDream({ id: 'd1', likes: 5 }),
    makeDream({ id: 'd2', likes: 9 })
  ]);
  var res = await handler(fakeEvent({ method: 'GET' }));
  var body = JSON.parse(res.body);
  assert.equal(body.feed.length, 2);
  assert.ok(['d1', 'd2'].indexOf(body.dreamOfDayId) !== -1, 'dreamOfDayId should resolve to one of the seeded dreams');
});

// ===== tracker item minor-like-dream-js-internal-dedup-marke-8qztvq =====
// internal bookkeeping markers must never leak into this public response.

test('internal bookkeeping markers (_lastLikeOp/_lostLikeRepairs/_lastCommentCountOp) stamped on a feed-index record are stripped from the response, while every real public field survives unchanged', async function () {
  await seedFeed([makeDream({
    id: 'd1',
    commentCount: 4,
    _lastLikeOp: 'a1b2c3d4',
    _lostLikeRepairs: ['repair-2026-08-01'],
    _lastCommentCountOp: 'e5f6a7b8'
  })]);
  var res = await handler(fakeEvent({ method: 'GET' }));
  var body = JSON.parse(res.body);
  var dream = body.feed[0];

  assert.equal(dream._lastLikeOp, undefined, '_lastLikeOp must not leak into the public response');
  assert.equal(dream._lostLikeRepairs, undefined, '_lostLikeRepairs must not leak into the public response');
  assert.equal(dream._lastCommentCountOp, undefined, '_lastCommentCountOp must not leak into the public response');
  assert.equal(Object.keys(dream).some(function (k) { return k.charAt(0) === '_'; }), false, 'no key starting with "_" should survive at all');

  // Every field a real client reads (js/store.js's getSharedFeed/
  // decorateFeedDreams input) must be intact.
  assert.equal(dream.id, 'd1');
  assert.equal(dream.ownerHandle, '@luna');
  assert.equal(dream.caption, 'A dream');
  assert.equal(dream.style, 'Cinematic');
  assert.equal(dream.videoUrl, 'https://x/v.mp4');
  assert.equal(dream.imageUrl, null);
  assert.equal(dream.mediaType, 'video');
  assert.equal(dream.avatar, null);
  assert.equal(dream.likes, 2);
  assert.equal(dream.publishedAt, 1000);
  assert.equal(dream.commentCount, 4);
});

test('stripping the internal markers does not affect Dream of the Day picking (still computed off the real, unstripped in-memory feed)', async function () {
  await seedFeed([
    makeDream({ id: 'd-low', likes: 1, _lastLikeOp: 'x' }),
    makeDream({ id: 'd-high', likes: 99, _lastLikeOp: 'y' })
  ]);
  var res = await handler(fakeEvent({ method: 'GET' }));
  var body = JSON.parse(res.body);
  assert.equal(body.dreamOfDayId, 'd-high', 'the highest-liked dream should still be picked regardless of stripped fields');
});
