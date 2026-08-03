// test/postpack-selector.test.js
//
// Covers netlify/functions/lib/postpack-selector.js — the pure eligibility
// + ordering logic for the Instagram/TikTok post pack MVP (tracker item
// for-product-instagram-tiktok-auto-postin-cahr76). No Blobs, no mocking
// — a fake seeded feed array + a plain Set of reported ids, straight
// through the module's own exported functions. See that module's own
// header comment for the exact eligibility rules this pins.

var test = require('node:test');
var assert = require('node:assert/strict');

var postpackSelector = require('../netlify/functions/lib/postpack-selector');

function makeRecord(overrides) {
  return Object.assign({
    id: 'dream-1',
    ownerHandle: '@someone',
    caption: 'A dream about flying.',
    style: 'Cinematic',
    videoUrl: 'https://fal.media/files/x.mp4',
    mediaType: 'video',
    publishedAt: Date.now(),
    channelLicenseGrantedAt: Date.now() - 1000,
    channelLicenseRevokedAt: null,
    okToFeatureOnChannels: true
  }, overrides || {});
}

test('isEligible: a fully-consented, unreported, un-revoked record is eligible', function () {
  var record = makeRecord({});
  assert.equal(postpackSelector.isEligible(record, new Set()), true);
});

test('isEligible: a record with no channelLicenseGrantedAt at all is NOT eligible (published before the clause shipped, deliberately never backfilled)', function () {
  var record = makeRecord({ channelLicenseGrantedAt: null });
  assert.equal(postpackSelector.isEligible(record, new Set()), false);
});

test('isEligible: a record whose license has since been revoked is NOT eligible', function () {
  var record = makeRecord({ channelLicenseRevokedAt: Date.now() });
  assert.equal(postpackSelector.isEligible(record, new Set()), false);
});

test('isEligible: okToFeatureOnChannels === false (explicit per-dream opt-out) excludes it', function () {
  var record = makeRecord({ okToFeatureOnChannels: false });
  assert.equal(postpackSelector.isEligible(record, new Set()), false);
});

test('isEligible: okToFeatureOnChannels absent/undefined defaults to eligible (on), never treated as off', function () {
  var record = makeRecord({});
  delete record.okToFeatureOnChannels;
  assert.equal(postpackSelector.isEligible(record, new Set()), true);
});

test('isEligible: a dream with ANY report on file (founder or user-filed) is excluded, regardless of reason', function () {
  var record = makeRecord({ id: 'reported-dream' });
  var reported = new Set(['reported-dream']);
  assert.equal(postpackSelector.isEligible(record, reported), false);
});

test('isEligible: a record with neither videoUrl nor imageUrl is NOT eligible (nothing to post)', function () {
  var record = makeRecord({ videoUrl: null, imageUrl: null });
  assert.equal(postpackSelector.isEligible(record, new Set()), false);
});

test('isEligible: an image-only record (no videoUrl) is still eligible', function () {
  var record = makeRecord({ videoUrl: null, imageUrl: 'https://fal.media/files/y.png' });
  assert.equal(postpackSelector.isEligible(record, new Set()), true);
});

test('isEligible: a null/malformed record or one with no id is never eligible', function () {
  assert.equal(postpackSelector.isEligible(null, new Set()), false);
  assert.equal(postpackSelector.isEligible({}, new Set()), false);
});

test('getEligibleCandidatesNewestFirst: sorts eligible records by publishedAt descending (newest first)', function () {
  var now = Date.now();
  var oldest = makeRecord({ id: 'oldest', publishedAt: now - 3000 });
  var newest = makeRecord({ id: 'newest', publishedAt: now });
  var middle = makeRecord({ id: 'middle', publishedAt: now - 1000 });

  var result = postpackSelector.getEligibleCandidatesNewestFirst([oldest, newest, middle], new Set());
  assert.deepEqual(result.map(function (r) { return r.id; }), ['newest', 'middle', 'oldest']);
});

test('getEligibleCandidatesNewestFirst: filters out ineligible records entirely, keeping only the eligible ones in order', function () {
  var now = Date.now();
  var eligible1 = makeRecord({ id: 'e1', publishedAt: now });
  var noConsent = makeRecord({ id: 'no-consent', publishedAt: now - 500, channelLicenseGrantedAt: null });
  var revoked = makeRecord({ id: 'revoked', publishedAt: now - 800, channelLicenseRevokedAt: now });
  var optedOut = makeRecord({ id: 'opted-out', publishedAt: now - 900, okToFeatureOnChannels: false });
  var reportedDream = makeRecord({ id: 'reported', publishedAt: now - 200 });
  var eligible2 = makeRecord({ id: 'e2', publishedAt: now - 1500 });

  var reported = new Set(['reported']);
  var result = postpackSelector.getEligibleCandidatesNewestFirst(
    [eligible1, noConsent, revoked, optedOut, reportedDream, eligible2],
    reported
  );

  assert.deepEqual(result.map(function (r) { return r.id; }), ['e1', 'e2']);
});

test('getEligibleCandidatesNewestFirst: a record with no publishedAt at all sorts last, not crashing', function () {
  var now = Date.now();
  var withDate = makeRecord({ id: 'has-date', publishedAt: now });
  var noDate = makeRecord({ id: 'no-date', publishedAt: undefined });

  var result = postpackSelector.getEligibleCandidatesNewestFirst([noDate, withDate], new Set());
  assert.deepEqual(result.map(function (r) { return r.id; }), ['has-date', 'no-date']);
});

test('getEligibleCandidatesNewestFirst: an empty feed, or no reported-id set at all, never throws', function () {
  assert.deepEqual(postpackSelector.getEligibleCandidatesNewestFirst([], new Set()), []);
  assert.deepEqual(postpackSelector.getEligibleCandidatesNewestFirst([], undefined), []);
  assert.deepEqual(postpackSelector.getEligibleCandidatesNewestFirst(undefined, undefined), []);
});
