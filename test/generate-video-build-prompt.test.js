// test/generate-video-build-prompt.test.js
//
// Covers netlify/functions/generate-video.js's exported buildPrompt directly
// (same style as test/generate-image.test.js's buildImagePrompt tests) —
// specifically the self-character-with-a-reference-photo case. The video
// model (fal's reference-to-video) genuinely receives the photo as an
// image-conditioning input alongside the prompt (see callFalReferenceToVideo
// and buildPrompt's own header comment), but a text description on that
// same character must NOT be silently dropped just because a photo is also
// present — the description is often a corrective/clarifying instruction
// (e.g. "I do not have a beard") the photo alone can't convey to the model.
// Both signals — the reference-photo pointer line and the description —
// must reach the resulting prompt string when both are present.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var genVideo = require('../netlify/functions/generate-video');

test('buildPrompt includes both the reference-photo pointer and the text description for a self character with both', function () {
  var prompt = genVideo.buildPrompt(
    'a dream about flying',
    'Cartoon',
    [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA', description: 'I do not have a beard' }],
    'Close-up', 'Night', 'Urban'
  );
  assert.ok(prompt.indexOf('a dream about flying') !== -1);
  assert.ok(prompt.indexOf('reference photo') !== -1, 'the photo-pointer line must still be present — the video model genuinely receives the photo as conditioning');
  assert.ok(prompt.indexOf('I do not have a beard') !== -1, 'the description must not be silently dropped just because a photo is also present');
});

test('buildPrompt still emits just the plain reference-photo pointer line for a photo-only self character (no description)', function () {
  var prompt = genVideo.buildPrompt(
    'a dream about flying',
    'Cartoon',
    [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }],
    'Close-up', 'Night', 'Urban'
  );
  assert.ok(prompt.indexOf('reference photo') !== -1);
  assert.ok(prompt.indexOf('with these specific details') === -1, 'no description means no "with these specific details" clause should be appended');
});

test('buildPrompt includes a text-described character with no photo (non-self)', function () {
  var prompt = genVideo.buildPrompt(
    'a dream',
    'Anime',
    [{ name: 'Alex', isSelf: false, description: 'tall with a red hat' }],
    null, null, null
  );
  assert.ok(prompt.indexOf('Alex') !== -1);
  assert.ok(prompt.indexOf('tall with a red hat') !== -1);
  assert.ok(prompt.indexOf('reference photo') === -1);
});
