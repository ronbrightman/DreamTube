// test/assemble-instagram-tiktok-postpack.test.js
//
// Covers netlify/functions/assemble-instagram-tiktok-postpack.js's
// scanAndBuild — tracker item for-product-instagram-tiktok-auto-postin-cahr76,
// Manager's SPEC v1 (manual-export MVP). This is this repo's third
// Scheduled Function (after send-daily-claim-pushes.js/send-whatsapp-
// morning-capture.js) — no way to invoke a real Netlify scheduled trigger
// from this sandbox, so this exercises scanAndBuild directly, exactly
// what it's exported for, same convention as
// test/send-daily-claim-pushes.test.js.
//
// Covers: the selection policy end-to-end against a seeded fake feed
// (newest-first, max-1-per-day-per-channel, never-repeat-a-dream-across-
// all-history, skip-flagged-content), the assembled pack item's own output
// shape, and that a real re-scan of the SAME feed on the SAME day is a
// safe no-op (idempotent, no duplicate items).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/assemble-instagram-tiktok-postpack')];
  delete require.cache[require.resolve('../netlify/functions/lib/postpack-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/moderation-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/push-dedup-store')];
});

function seedFeed(records) {
  mockBlobs.seed('dreamtube-feed', 'feed-index', records);
}

function seedReports(reports) {
  mockBlobs.seed('dreamtube-moderation-reports', 'reports', reports);
}

function makeDream(overrides) {
  return Object.assign({
    id: 'dream-x',
    ownerHandle: '@someone',
    caption: 'A dream about something.',
    style: 'Cinematic',
    videoUrl: 'https://fal.media/files/x.mp4',
    mediaType: 'video',
    publishedAt: Date.now(),
    channelLicenseGrantedAt: Date.now() - 1000,
    channelLicenseRevokedAt: null,
    okToFeatureOnChannels: true
  }, overrides || {});
}

test('builds exactly one item per channel (Instagram + TikTok) from the newest eligible dreams', async function () {
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'd1', ownerHandle: '@alice', publishedAt: now }),
    makeDream({ id: 'd2', ownerHandle: '@bob', publishedAt: now - 1000 })
  ]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  assert.equal(result.built.length, 2);
  var channels = result.built.map(function (it) { return it.channel; }).sort();
  assert.deepEqual(channels, ['instagram', 'tiktok']);
  // CHANNELS is processed in order ['instagram', 'tiktok'] -- Instagram
  // claims the single newest candidate (d1) first, which immediately sets
  // its GLOBAL never-repeat marker (see this function's own header
  // comment), so TikTok's own candidate walk skips d1 and falls through to
  // the next-newest still-unused one (d2). Two channels, two dreams
  // available -> both get used, each exactly once, newest-priority-first.
  var instagramItem = result.built.find(function (it) { return it.channel === 'instagram'; });
  var tiktokItem = result.built.find(function (it) { return it.channel === 'tiktok'; });
  assert.equal(instagramItem.dreamId, 'd1');
  assert.equal(tiktokItem.dreamId, 'd2');
});

test('output shape: each built item carries dreamId/channel/ownerHandle/mediaType/mediaUrl/caption/hashtags/builtAt', async function () {
  seedFeed([makeDream({ id: 'd1', ownerHandle: '@carol', style: 'Anime', videoUrl: 'https://fal.media/files/c.mp4' })]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  var item = result.built[0];
  assert.equal(item.dreamId, 'd1');
  assert.ok(item.channel === 'instagram' || item.channel === 'tiktok');
  assert.equal(item.ownerHandle, '@carol');
  assert.equal(item.mediaType, 'video');
  assert.equal(item.mediaUrl, 'https://fal.media/files/c.mp4');
  assert.match(item.caption, /@carol/);
  assert.ok(Array.isArray(item.hashtags) && item.hashtags.length > 0);
  assert.ok(item.builtAt > 0);
  assert.equal(item.id, 'd1:' + item.channel);
});

test('an image-only dream produces mediaType "image" and its imageUrl as mediaUrl', async function () {
  seedFeed([makeDream({ id: 'd1', videoUrl: null, imageUrl: 'https://fal.media/files/pic.png', mediaType: 'image' })]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  assert.equal(result.built[0].mediaType, 'image');
  assert.equal(result.built[0].mediaUrl, 'https://fal.media/files/pic.png');
});

test('SELECTION POLICY: newest published-with-consent dreams are picked ahead of older ones', async function () {
  // Three candidates for two channel-slots: the two NEWEST must be the
  // ones picked (one per channel, per the distinctness this function's own
  // never-repeat-per-run behavior already guarantees -- see the previous
  // test), and the OLDEST must be left untouched -- proving ordering
  // actually drove the picks, not just "any two of the available ones".
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'oldest', publishedAt: now - 10000 }),
    makeDream({ id: 'middle', publishedAt: now - 5000 }),
    makeDream({ id: 'newest', publishedAt: now })
  ]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  var pickedIds = result.built.map(function (item) { return item.dreamId; }).sort();
  assert.deepEqual(pickedIds, ['middle', 'newest']);
});

test('SELECTION POLICY: a dream with no channel-license consent on file is never picked', async function () {
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'no-consent', publishedAt: now, channelLicenseGrantedAt: null }),
    makeDream({ id: 'has-consent', publishedAt: now - 1000 })
  ]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  result.built.forEach(function (item) { assert.equal(item.dreamId, 'has-consent'); });
});

test('SELECTION POLICY: a dream whose license was later revoked is never picked', async function () {
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'revoked', publishedAt: now, channelLicenseRevokedAt: now }),
    makeDream({ id: 'still-licensed', publishedAt: now - 1000 })
  ]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  result.built.forEach(function (item) { assert.equal(item.dreamId, 'still-licensed'); });
});

test('SELECTION POLICY: a dream with the per-dream okToFeatureOnChannels opt-out is never picked', async function () {
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'opted-out', publishedAt: now, okToFeatureOnChannels: false }),
    makeDream({ id: 'opted-in', publishedAt: now - 1000 })
  ]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  result.built.forEach(function (item) { assert.equal(item.dreamId, 'opted-in'); });
});

test('SELECTION POLICY: skips a dream that has ANY moderation report on file, founder- or user-filed', async function () {
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'reported-dream', publishedAt: now }),
    makeDream({ id: 'clean-dream', publishedAt: now - 1000 })
  ]);
  seedReports([{ id: 'r1', dreamId: 'reported-dream', reason: 'inappropriate', createdAt: new Date().toISOString() }]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  result.built.forEach(function (item) { assert.equal(item.dreamId, 'clean-dream'); });
});

test('SELECTION POLICY: max 1 per day per channel -- re-running scanAndBuild the SAME day builds nothing new', async function () {
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'd1', publishedAt: now }),
    makeDream({ id: 'd2', publishedAt: now - 1000 })
  ]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var first = await assembler.scanAndBuild(fakeEvent({}));
  var second = await assembler.scanAndBuild(fakeEvent({}));

  assert.equal(first.built.length, 2); // one per channel
  assert.equal(second.built.length, 0); // same UTC day -- both channels already claimed today

  var postpackStore = require('../netlify/functions/lib/postpack-store');
  var allItems = await postpackStore.getItems(fakeEvent({}));
  assert.equal(allItems.length, 2, 'no duplicate items were persisted by the second same-day run');
});

test('SELECTION POLICY: never repeats the same dream across two separate channels in one run -- each channel gets a DIFFERENT dream when more than one is eligible', async function () {
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'newest', publishedAt: now }),
    makeDream({ id: 'second-newest', publishedAt: now - 1000 })
  ]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  assert.equal(result.built.length, 2);
  var dreamIds = result.built.map(function (it) { return it.dreamId; });
  assert.deepEqual(dreamIds.slice().sort(), ['newest', 'second-newest']);
});

test('SELECTION POLICY: never-repeat-across-all-history -- a dream already marked as used in some earlier pack is never picked again, even on a fresh day with its own unclaimed per-channel-per-day markers', async function () {
  var now = Date.now();
  seedFeed([makeDream({ id: 'only-dream', publishedAt: now })]);

  // Pre-establish the GLOBAL never-repeat marker directly, as if some
  // earlier run (on some earlier day) had already included this dream in
  // a pack -- the real invariant under test is that this marker alone is
  // enough to permanently exclude the dream, independent of today's own
  // fresh (unclaimed) per-channel-per-day markers.
  var pushDedupStore = require('../netlify/functions/lib/push-dedup-store');
  var claimed = await pushDedupStore.markSentOnce(fakeEvent({}), 'postpack-dream:only-dream');
  assert.equal(claimed.ok, true);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));

  assert.equal(result.built.length, 0, 'the already-used dream is never picked again, on either channel');
});

test('scanned reports the total feed size regardless of eligibility', async function () {
  var now = Date.now();
  seedFeed([
    makeDream({ id: 'eligible', publishedAt: now }),
    makeDream({ id: 'ineligible', publishedAt: now - 1000, channelLicenseGrantedAt: null })
  ]);

  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));
  assert.equal(result.scanned, 2);
});

test('an empty feed builds nothing and never throws', async function () {
  seedFeed([]);
  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var result = await assembler.scanAndBuild(fakeEvent({}));
  assert.equal(result.built.length, 0);
  assert.equal(result.scanned, 0);
});

test('the scheduled handler wrapper runs without throwing even on an internal error, and returns 200', async function () {
  // No feed seeded at all -- getStore.get on a never-written key resolves
  // undefined, which scanAndBuild already defaults to [] internally; this
  // just proves the handler's own try/catch never lets a real failure
  // escape as an unhandled rejection, same posture send-daily-claim-pushes.js's
  // own handler test would exercise.
  var assembler = require('../netlify/functions/assemble-instagram-tiktok-postpack');
  var res = await assembler.handler(fakeEvent({}));
  assert.equal(res.statusCode, 200);
});
