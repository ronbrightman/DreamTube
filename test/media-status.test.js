// test/media-status.test.js
//
// Covers netlify/functions/lib/media-status.js — the pure classification
// logic shared by admin-backfill-media-rehost.js and
// admin-media-library-data.js (tracker item
// for-product-owner-media-library-page-fou-1fwxaw). No Blobs/network
// involved at all — this is a pure function of (url, createdAt).

var test = require('node:test');
var assert = require('node:assert/strict');

var mediaStatus = require('../netlify/functions/lib/media-status');

var CUTOFF = mediaStatus.NO_EXPIRY_HEADER_SHIP_AT;
var DAY_MS = 24 * 60 * 60 * 1000;

test('isDurableUrl: true for our own video-file/image-file URLs', function () {
  assert.equal(mediaStatus.isDurableUrl('/.netlify/functions/video-file?key=abc'), true);
  assert.equal(mediaStatus.isDurableUrl('/.netlify/functions/image-file?key=abc'), true);
});

test('isDurableUrl: false for a fal URL, a relative path that merely contains the prefix later, or a non-string', function () {
  assert.equal(mediaStatus.isDurableUrl('https://v3.fal.media/files/abc.mp4'), false);
  assert.equal(mediaStatus.isDurableUrl('https://example.com/redirect?to=/.netlify/functions/video-file?key=x'), false, 'must match at the START of the string, not anywhere in it');
  assert.equal(mediaStatus.isDurableUrl(null), false);
  assert.equal(mediaStatus.isDurableUrl(undefined), false);
  assert.equal(mediaStatus.isDurableUrl(42), false);
});

test('classifyMediaUrl: a durable url is always re-hosted-durable regardless of createdAt', function () {
  var result = mediaStatus.classifyMediaUrl('/.netlify/functions/video-file?key=abc', 1);
  assert.equal(result.status, 're-hosted-durable');
  var resultNoDate = mediaStatus.classifyMediaUrl('/.netlify/functions/video-file?key=abc', null);
  assert.equal(resultNoDate.status, 're-hosted-durable');
});

test('classifyMediaUrl: a fal url created AFTER the no-expiry-header cutoff is still-on-fal with no known expiry', function () {
  var result = mediaStatus.classifyMediaUrl('https://fal.media/x.mp4', CUTOFF + DAY_MS);
  assert.equal(result.status, 'still-on-fal');
  assert.equal(result.protectedByNoExpiryHeader, true);
  assert.equal(result.daysUntilExpiry, null);
});

test('classifyMediaUrl: a fal url created exactly AT the cutoff counts as protected (inclusive boundary)', function () {
  var result = mediaStatus.classifyMediaUrl('https://fal.media/x.mp4', CUTOFF);
  assert.equal(result.status, 'still-on-fal');
  assert.equal(result.protectedByNoExpiryHeader, true);
});

test('classifyMediaUrl: a fal url created BEFORE the cutoff and within 7 days is still-on-fal with a real countdown', function () {
  var createdAt = CUTOFF - 100 * DAY_MS; // old dream, well before the header shipped
  var now = createdAt + 2 * DAY_MS; // 2 days old right now
  var realNow = Date.now;
  Date.now = function () { return now; };
  try {
    var result = mediaStatus.classifyMediaUrl('https://fal.media/x.mp4', createdAt);
    assert.equal(result.status, 'still-on-fal');
    assert.equal(result.protectedByNoExpiryHeader, false);
    assert.equal(result.daysUntilExpiry, 5, '7 days total minus 2 elapsed = 5 left');
  } finally {
    Date.now = realNow;
  }
});

test('classifyMediaUrl: a fal url created BEFORE the cutoff and past 7 days is lost-expired', function () {
  var createdAt = CUTOFF - 100 * DAY_MS;
  var now = createdAt + 10 * DAY_MS; // 10 days old -- past the 7-day window
  var realNow = Date.now;
  Date.now = function () { return now; };
  try {
    var result = mediaStatus.classifyMediaUrl('https://fal.media/x.mp4', createdAt);
    assert.equal(result.status, 'lost-expired');
    assert.equal(result.protectedByNoExpiryHeader, false);
  } finally {
    Date.now = realNow;
  }
});

test('classifyMediaUrl: exactly at the 7-day boundary is still still-on-fal (not yet expired), one moment later is lost-expired', function () {
  var createdAt = CUTOFF - 100 * DAY_MS;
  var realNow = Date.now;
  try {
    Date.now = function () { return createdAt + mediaStatus.FAL_RETENTION_MS; };
    var atBoundary = mediaStatus.classifyMediaUrl('https://fal.media/x.mp4', createdAt);
    assert.equal(atBoundary.status, 'still-on-fal');
    assert.equal(atBoundary.daysUntilExpiry, 0);

    Date.now = function () { return createdAt + mediaStatus.FAL_RETENTION_MS + 1; };
    var pastBoundary = mediaStatus.classifyMediaUrl('https://fal.media/x.mp4', createdAt);
    assert.equal(pastBoundary.status, 'lost-expired');
  } finally {
    Date.now = realNow;
  }
});

test('classifyMediaUrl: a fal url with NO createdAt at all (predates that field) degrades to lost-expired -- unknown age is treated as the worst case, not the best', function () {
  var result = mediaStatus.classifyMediaUrl('https://fal.media/x.mp4', null);
  assert.equal(result.status, 'lost-expired');
  var resultUndefined = mediaStatus.classifyMediaUrl('https://fal.media/x.mp4', undefined);
  assert.equal(resultUndefined.status, 'lost-expired');
});
