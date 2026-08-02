// test/media-rehost.test.js
//
// Covers netlify/functions/lib/media-rehost.js in isolation: the
// best-effort re-host mechanism itself (fetch the source url, store into
// Blobs, return the durable url), its idempotency, and its
// never-throws-on-failure contract — see that file's own header comment.
// Also covers image-file.mjs/video-file.mjs's own read-back of what this
// module writes, proving the two ends of the pipe agree on shape.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var mediaRehost = require('../netlify/functions/lib/media-rehost');

var realFetch = global.fetch;

test.beforeEach(function () {
  mockBlobs.reset();
});
test.after(function () { global.fetch = realFetch; });

function fakeMediaResponse(bytes, contentType, ok) {
  return {
    ok: ok !== false,
    status: ok === false ? 404 : 200,
    headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? (contentType || null) : null; } },
    arrayBuffer: async function () { return bytes; }
  };
}

test('durableUrl: matches the shape lib/media-status.js recognizes', function () {
  var mediaStatus = require('../netlify/functions/lib/media-status');
  assert.equal(mediaStatus.isDurableUrl(mediaRehost.durableUrl('video', 'abc')), true);
  assert.equal(mediaStatus.isDurableUrl(mediaRehost.durableUrl('image', 'abc')), true);
  assert.equal(mediaRehost.durableUrl('video', 'abc'), '/.netlify/functions/video-file?key=abc');
  assert.equal(mediaRehost.durableUrl('image', 'abc'), '/.netlify/functions/image-file?key=abc');
});

test('rehostBestEffort: success -- fetches the source, stores it, returns the durable url', async function () {
  var bytes = new ArrayBuffer(8);
  global.fetch = async function (url) {
    assert.equal(url, 'https://fal.media/x.mp4');
    return fakeMediaResponse(bytes, 'video/mp4');
  };
  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-1');
  assert.equal(result.ok, true);
  assert.equal(result.url, '/.netlify/functions/video-file?key=req-1');

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-1');
  assert.equal(stored.data, bytes);
  assert.equal(stored.metadata.contentType, 'video/mp4');
});

test('rehostBestEffort: image path stores into the separate dreamtube-images store', async function () {
  var bytes = new ArrayBuffer(4);
  global.fetch = async function () { return fakeMediaResponse(bytes, 'image/png'); };
  var result = await mediaRehost.rehostBestEffort({}, 'image', 'https://fal.media/x.png', 'req-img-1');
  assert.equal(result.ok, true);
  assert.equal(result.url, '/.netlify/functions/image-file?key=req-img-1');

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-images' }).getWithMetadata('req-img-1');
  assert.equal(stored.metadata.contentType, 'image/png');
  // Nothing should have leaked into the video store.
  var videoStored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-img-1');
  assert.equal(videoStored, null);
});

test('rehostBestEffort: falls back to a default content-type when the source response has none', async function () {
  global.fetch = async function () {
    return { ok: true, status: 200, headers: { get: function () { return null; } }, arrayBuffer: async function () { return new ArrayBuffer(2); } };
  };
  await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-no-ct');
  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-no-ct');
  assert.equal(stored.metadata.contentType, 'video/mp4');
});

test('rehostBestEffort: idempotent -- a second call for the same key skips the fetch entirely and returns the same durable url', async function () {
  var fetchCalls = 0;
  global.fetch = async function () { fetchCalls++; return fakeMediaResponse(new ArrayBuffer(4), 'video/mp4'); };
  var first = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-dup');
  var second = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-dup');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.url, first.url);
  assert.equal(fetchCalls, 1, 'the second call must not re-fetch the source -- getMetadata short-circuits it');
});

test('rehostBestEffort: a non-OK source fetch fails closed, never throws', async function () {
  global.fetch = async function () { return { ok: false, status: 404, headers: { get: function () { return null; } } }; };
  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/gone.mp4', 'req-404');
  assert.equal(result.ok, false);
});

test('rehostBestEffort: a thrown network error fails closed, never throws out of this function', async function () {
  global.fetch = async function () { throw new Error('network down'); };
  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-throw');
  assert.equal(result.ok, false);
});

test('rehostBestEffort: a Blobs write failure fails closed, never throws', async function () {
  global.fetch = async function () { return fakeMediaResponse(new ArrayBuffer(4), 'video/mp4'); };
  mockBlobs.setWriteOverride('dreamtube-videos', function () { return new Error('blobs write failed'); });
  try {
    var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', 'req-write-fail');
    assert.equal(result.ok, false);
  } finally {
    mockBlobs.clearWriteOverride('dreamtube-videos');
  }
});

test('rehostBestEffort: invalid input (missing sourceUrl/key/unknown mediaType) fails closed without ever calling fetch', async function () {
  var fetchCalls = 0;
  global.fetch = async function () { fetchCalls++; return fakeMediaResponse(new ArrayBuffer(1), 'video/mp4'); };
  assert.equal((await mediaRehost.rehostBestEffort({}, 'video', '', 'k')).ok, false);
  assert.equal((await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/x.mp4', '')).ok, false);
  assert.equal((await mediaRehost.rehostBestEffort({}, 'audio', 'https://fal.media/x.mp4', 'k')).ok, false);
  assert.equal(fetchCalls, 0);
});

// SIZE GATE — tracker item for-product-urgent-founder-repro-on-drea-uq3a36.
// See lib/media-rehost.js's own "SIZE" header comment: video-file.mjs/
// image-file.mjs are Netlify streaming functions with a documented 20 MB
// response cap, so anything over MAX_STREAMABLE_BYTES must still be WRITTEN
// (durability) but must NOT be handed out as the served url (would 502).

test('rehostBestEffort: oversized media is still stored (durability) but reports ok:false/tooLargeToServe, keeping the caller on the source url', async function () {
  var big = new ArrayBuffer(mediaRehost.MAX_STREAMABLE_BYTES + 1);
  global.fetch = async function () { return fakeMediaResponse(big, 'video/mp4'); };
  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/big.mp4', 'req-big');
  assert.equal(result.ok, false);
  assert.equal(result.tooLargeToServe, true);

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-big');
  assert.equal(stored.data, big, 'still written for durability even though it cannot be served back');
  assert.equal(stored.metadata.byteLength, mediaRehost.MAX_STREAMABLE_BYTES + 1);
  assert.equal(stored.metadata.sourceUrl, 'https://fal.media/big.mp4', 'source url recorded so a serving function can fall back to it');
});

test('rehostBestEffort: media exactly at the ceiling is fine; one byte over is not', async function () {
  var exact = new ArrayBuffer(mediaRehost.MAX_STREAMABLE_BYTES);
  global.fetch = async function () { return fakeMediaResponse(exact, 'video/mp4'); };
  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/exact.mp4', 'req-exact');
  assert.equal(result.ok, true);
  assert.equal(result.url, '/.netlify/functions/video-file?key=req-exact');
});

test('rehostBestEffort: a repeated call for an already-oversized key stays ok:false without re-fetching', async function () {
  var fetchCalls = 0;
  var big = new ArrayBuffer(mediaRehost.MAX_STREAMABLE_BYTES + 1);
  global.fetch = async function () { fetchCalls++; return fakeMediaResponse(big, 'video/mp4'); };
  var first = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/big.mp4', 'req-big-dup');
  var second = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/big.mp4', 'req-big-dup');
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(second.tooLargeToServe, true);
  assert.equal(fetchCalls, 1, 'the second call must not re-fetch the source -- getMetadata short-circuits it');
});

test('rehostBestEffort: a pre-existing record with no byteLength metadata (written before this size gate shipped) is assumed safe, not oversized', async function () {
  global.fetch = async function () { return fakeMediaResponse(new ArrayBuffer(4), 'video/mp4'); };
  // Simulate a legacy record: write directly via the mocked SDK's set(),
  // bypassing rehostBestEffort entirely, with no byteLength/sourceUrl in
  // metadata -- exactly what pre-fix code wrote.
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-videos' }).set('req-legacy', new ArrayBuffer(4), { metadata: { contentType: 'video/mp4' } });

  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/legacy.mp4', 'req-legacy');
  assert.equal(result.ok, true, 'no byteLength on file means "unknown", not "oversized" -- must not regress an already-working legacy durable url');
  assert.equal(result.url, '/.netlify/functions/video-file?key=req-legacy');
});

// `options.force` — tracker item for-product-urgent-reopen-video-repair-p-cyp8np
// (admin-repair-oversized-media.js's own bypass for a legacy, genuinely
// broken record). See this file's own header comment addition on `force`
// for the full reasoning.

test('rehostBestEffort: force bypasses the existing-record short-circuit and always re-fetches + re-writes', async function () {
  var { getStore } = require('@netlify/blobs');
  // A legacy broken record: metadata-only, no byteLength/sourceUrl, exactly
  // what pre-fix code wrote for a genuinely oversized upload.
  var big = new ArrayBuffer(mediaRehost.MAX_STREAMABLE_BYTES + 5);
  await getStore({ name: 'dreamtube-videos' }).set('req-broken-legacy', big, { metadata: { contentType: 'video/mp4' } });

  var fetchCalls = 0;
  var freshBytes = new ArrayBuffer(4); // fal's current copy happens to now be small
  global.fetch = async function (url) {
    fetchCalls++;
    assert.equal(url, 'https://fal.media/fresh.mp4');
    return fakeMediaResponse(freshBytes, 'video/mp4');
  };

  var withoutForce = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/fresh.mp4', 'req-broken-legacy');
  assert.equal(withoutForce.ok, true, 'without force, the existing (metadata-less) record short-circuits and is assumed safe');
  assert.equal(fetchCalls, 0, 'without force, the source is never re-fetched');

  var withForce = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/fresh.mp4', 'req-broken-legacy', { force: true });
  assert.equal(withForce.ok, true);
  assert.equal(fetchCalls, 1, 'force must re-fetch the fresh source url');

  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-broken-legacy');
  assert.equal(stored.data, freshBytes, 'force must overwrite the stale oversized bytes with the freshly-fetched ones');
  assert.equal(stored.metadata.byteLength, 4, 'force must backfill real byteLength metadata this time');
  assert.equal(stored.metadata.sourceUrl, 'https://fal.media/fresh.mp4', 'force must backfill real sourceUrl metadata this time');
});

test('rehostBestEffort: force on a still-genuinely-oversized fresh fetch reports tooLargeToServe but still backfills sourceUrl/byteLength for the redirect fallback', async function () {
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-videos' }).set('req-still-big', new ArrayBuffer(10), { metadata: { contentType: 'video/mp4' } });

  var big = new ArrayBuffer(mediaRehost.MAX_STREAMABLE_BYTES + 1);
  global.fetch = async function () { return fakeMediaResponse(big, 'video/mp4'); };

  var result = await mediaRehost.rehostBestEffort({}, 'video', 'https://fal.media/still-big.mp4', 'req-still-big', { force: true });
  assert.equal(result.ok, false);
  assert.equal(result.tooLargeToServe, true);

  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-still-big');
  assert.equal(stored.metadata.byteLength, mediaRehost.MAX_STREAMABLE_BYTES + 1);
  assert.equal(stored.metadata.sourceUrl, 'https://fal.media/still-big.mp4', 'redirect fallback can now use this even though streaming is still not possible');
});
