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
//
// Also covers the style-integrity guardrail (tracker item
// for-product-founder-ask-08-04-style-must-ezz8uf): the founder's real
// caption "I am running back and forth to bring some important things for
// my family" with style Anime produced a video where the dreamer was
// rendered AS a flying dragon — nothing in the prompt previously told the
// model the style choice governs rendering only, not the subject's
// species/identity/actions. See styleIntegrityClause's own doc comment in
// generate-video.js for the full root-cause writeup.

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

test('buildPrompt matches the founder\'s exact Anime repro and includes the style-integrity guardrail (for-product-founder-ask-08-04-style-must-ezz8uf)', function () {
  var caption = 'I am running back and forth to bring some important things for my family';
  var prompt = genVideo.buildPrompt(caption, 'Anime', [], null, null, null);

  // The guardrail clause must be present and must name the style so the
  // model can't read "Anime" as license to change what the dreamer IS.
  assert.ok(prompt.indexOf('the dreamer remains a real human being throughout') !== -1,
    'the style-integrity guardrail clause must be present');
  assert.ok(prompt.indexOf('must never change the subject\'s species, identity, or actions') !== -1);
  assert.ok(prompt.indexOf('unless the dream itself explicitly describes a transformation') !== -1,
    'the guardrail must not suppress a dream that genuinely describes a transformation — it only constrains the STYLE CHOICE');
  assert.ok(prompt.indexOf('Anime treatment') !== -1, 'the guardrail should name the actual style being applied');

  // Ordering: the guardrail must appear early — right after the caption —
  // not buried at the very end after several other clauses, since these
  // models weight earlier/more prominent instructions more heavily.
  var captionIdx = prompt.indexOf(caption);
  var guardrailIdx = prompt.indexOf('the dreamer remains a real human being throughout');
  var styleModifierIdx = prompt.indexOf('vibrant Japanese anime animation style');
  assert.ok(captionIdx === 0, 'caption should still lead the prompt');
  assert.ok(guardrailIdx > captionIdx && guardrailIdx < styleModifierIdx,
    'the guardrail clause must come between the caption and the style modifier, not after it');

  // The literal style modifier itself is unchanged.
  assert.ok(prompt.indexOf('vibrant Japanese anime animation style') !== -1);
});

test('buildPrompt applies the style-integrity guardrail for every style, not just Anime/Cartoon', function () {
  ['Cartoon', 'Cinematic', 'Anime', 'Realistic', 'SomeFutureStyle'].forEach(function (style) {
    var prompt = genVideo.buildPrompt('a dream about the beach', style, [], null, null, null);
    assert.ok(prompt.indexOf('the dreamer remains a real human being throughout') !== -1,
      'guardrail missing for style: ' + style);
    assert.ok(prompt.indexOf(style + ' treatment applied below') !== -1,
      'guardrail should name style "' + style + '" specifically');
  });
});

test('buildPrompt guardrail complements (does not duplicate/contradict) the self-photo reference-image pointer line', function () {
  var prompt = genVideo.buildPrompt(
    'a dream about flying',
    'Anime',
    [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA', description: 'I do not have a beard' }],
    'Close-up', 'Night', 'Urban'
  );
  assert.ok(prompt.indexOf('the dreamer remains a real human being throughout') !== -1);
  assert.ok(prompt.indexOf('reference photo') !== -1, 'the photo-pointer line must still be present');
  assert.ok(prompt.indexOf('I do not have a beard') !== -1, 'the description must still not be dropped');
});
