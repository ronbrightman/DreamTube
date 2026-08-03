// test/postpack-caption.test.js
//
// Covers netlify/functions/lib/postpack-caption.js — the caption/hashtag
// builder for the Instagram/TikTok post pack MVP (tracker item
// for-product-instagram-tiktok-auto-postin-cahr76). Pure functions, no I/O.

var test = require('node:test');
var assert = require('node:assert/strict');

var postpackCaption = require('../netlify/functions/lib/postpack-caption');

test('buildCaption includes the dream\'s own caption/storyText verbatim', function () {
  var text = postpackCaption.buildCaption({ caption: 'I was flying over a purple ocean.', style: 'Cinematic', ownerHandle: '@dreamer1' });
  assert.match(text, /I was flying over a purple ocean\./);
});

test('buildCaption includes the style', function () {
  var text = postpackCaption.buildCaption({ caption: 'x', style: 'Anime', ownerHandle: '@a' });
  assert.match(text, /Anime/);
});

test('buildCaption includes an @-credit to the publishing user\'s handle, without a double @', function () {
  var text = postpackCaption.buildCaption({ caption: 'x', style: 'Cartoon', ownerHandle: '@dreamer5' });
  assert.match(text, /@dreamer5/);
  assert.doesNotMatch(text, /@@dreamer5/);
});

test('buildCaption tolerates a handle with no leading @ already on file', function () {
  var text = postpackCaption.buildCaption({ caption: 'x', style: 'Cartoon', ownerHandle: 'dreamer6' });
  assert.match(text, /@dreamer6/);
});

test('buildCaption falls back to a generic line when caption/style/ownerHandle are all missing, never throwing', function () {
  var text = postpackCaption.buildCaption({});
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
});

test('buildCaption handles a null record without throwing', function () {
  var text = postpackCaption.buildCaption(null);
  assert.equal(typeof text, 'string');
});

test('buildHashtags returns a per-style hashtag set for each of this app\'s four real styles', function () {
  ['Cartoon', 'Cinematic', 'Anime', 'Realistic'].forEach(function (style) {
    var tags = postpackCaption.buildHashtags(style);
    assert.ok(Array.isArray(tags));
    assert.ok(tags.length > 0);
    tags.forEach(function (t) { assert.match(t, /^#/); });
  });
});

test('buildHashtags always includes the generic app/brand tags', function () {
  var tags = postpackCaption.buildHashtags('Cinematic');
  assert.ok(tags.indexOf('#DreamTube') !== -1);
});

test('buildHashtags falls back to just the generic set for an unrecognized/missing style', function () {
  var unknownStyleTags = postpackCaption.buildHashtags('SomeFutureStyle');
  var noStyleTags = postpackCaption.buildHashtags(undefined);
  assert.deepEqual(unknownStyleTags, postpackCaption.GENERIC_HASHTAGS);
  assert.deepEqual(noStyleTags, postpackCaption.GENERIC_HASHTAGS);
});

test('buildHashtags never returns duplicate tags and stays within a sensible cap', function () {
  var tags = postpackCaption.buildHashtags('Cinematic');
  var unique = Array.from(new Set(tags));
  assert.equal(tags.length, unique.length);
  assert.ok(tags.length <= 8);
});

test('buildHashtags is deterministic — same style always yields the exact same tag list', function () {
  var first = postpackCaption.buildHashtags('Realistic');
  var second = postpackCaption.buildHashtags('Realistic');
  assert.deepEqual(first, second);
});
