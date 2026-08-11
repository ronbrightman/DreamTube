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
// Also covers the style-integrity guardrail, in two generations:
//
// 1. Original fix (tracker item for-product-founder-ask-08-04-style-must-
//    ezz8uf, commit 0500852): the founder's real caption "I am running back
//    and forth to bring some important things for my family" with style
//    Anime produced a video where the dreamer was rendered AS a flying
//    dragon — nothing in the prompt previously told the model the style
//    choice governs rendering only, not the subject's species/identity/
//    actions. That fix phrased the guardrail around "the dreamer".
//
// 2. Generalization (tracker item for-product-bug-founder-recurring-style--
//    srehi9, 2026-08-11, SAME bug, BROADER trigger): a wizard free-text
//    caption whose only content was "a woman" (no "I", no first-person
//    framing) + an anime/specific style again produced a flying dragon, no
//    woman at all. "The dreamer" reads as a stand-in for a first-person
//    "I" and doesn't reliably bind onto a bare third-person subject like "a
//    woman", and a 2-word caption has almost no descriptive content of its
//    own to compete with a vivid style descriptor. The clause was reworded
//    to bind onto "the subject this dream describes" (explicitly covering
//    both first-person and third-person/generic phrasing) and gained a
//    short-caption reinforcement sentence for captions at/under
//    SHORT_CAPTION_MAX_WORDS words. See styleIntegrityClause's own doc
//    comment in generate-video.js for the full root-cause writeup of both
//    generations.
//
// IMPORTANT — these tests can only verify the ASSEMBLED PROMPT TEXT
// structurally (right clause, right wording, right position for the right
// inputs). Nothing in this sandbox can call the real fal.ai/Veo API (no
// FAL_KEY here, same limitation the original fix had) to confirm the
// generated VIDEO actually keeps the subject human — that still needs a
// real generation, eyeballed by someone with fal.ai access.

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

test('buildPrompt matches the founder\'s original Anime repro (for-product-founder-ask-08-04-style-must-ezz8uf) — guardrail still present, still correctly positioned, no short-caption reinforcement (caption has enough of its own content)', function () {
  var caption = 'I am running back and forth to bring some important things for my family';
  var prompt = genVideo.buildPrompt(caption, 'Anime', [], null, null, null);

  // The guardrail clause must be present and must name the style so the
  // model can't read "Anime" as license to change what the subject IS.
  // Wording changed by the 08-11 generalization (see file header) — this
  // asserts the CURRENT anchor text, not the original literal string.
  assert.ok(prompt.indexOf('the subject this dream describes') !== -1,
    'the style-integrity guardrail clause must be present');
  assert.ok(prompt.indexOf('must never change the subject\'s species, identity, or actions') !== -1);
  assert.ok(prompt.indexOf('unless the dream itself explicitly describes a transformation') !== -1,
    'the guardrail must not suppress a dream that genuinely describes a transformation — it only constrains the STYLE CHOICE');
  assert.ok(prompt.indexOf('Anime treatment') !== -1, 'the guardrail should name the actual style being applied');

  // This caption is 14 words — comfortably above SHORT_CAPTION_MAX_WORDS
  // (10) — so the short-caption reinforcement sentence must NOT fire here.
  // No regression: this is exactly the guardrail behavior the original
  // fix shipped for this caption, still true after the generalization.
  assert.ok(prompt.indexOf('caption is short') === -1,
    'a 14-word caption with its own descriptive content should not trigger the short-caption reinforcement');

  // Ordering: the guardrail must appear early — right after the caption —
  // not buried at the very end after several other clauses, since these
  // models weight earlier/more prominent instructions more heavily.
  var captionIdx = prompt.indexOf(caption);
  var guardrailIdx = prompt.indexOf('the subject this dream describes');
  var styleModifierIdx = prompt.indexOf('vibrant Japanese anime animation style');
  assert.ok(captionIdx === 0, 'caption should still lead the prompt');
  assert.ok(guardrailIdx > captionIdx && guardrailIdx < styleModifierIdx,
    'the guardrail clause must come between the caption and the style modifier, not after it');

  // The literal style modifier itself is unchanged.
  assert.ok(prompt.indexOf('vibrant Japanese anime animation style') !== -1);
});

test('buildPrompt applies the style-integrity guardrail for every style, not just Anime/Cartoon', function () {
  ['Cartoon', 'Cinematic', 'Anime', 'Realistic', 'SomeFutureStyle'].forEach(function (style) {
    var prompt = genVideo.buildPrompt('a dream about the beach and the tide coming in', style, [], null, null, null);
    assert.ok(prompt.indexOf('the subject this dream describes') !== -1,
      'guardrail missing for style: ' + style);
    assert.ok(prompt.indexOf(style + ' treatment applied below') !== -1,
      'guardrail should name style "' + style + '" specifically');
  });
});

test('buildPrompt guardrail complements (does not duplicate/contradict) the self-photo reference-image pointer line', function () {
  var prompt = genVideo.buildPrompt(
    'a dream about flying over the mountains at sunset',
    'Anime',
    [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA', description: 'I do not have a beard' }],
    'Close-up', 'Night', 'Urban'
  );
  assert.ok(prompt.indexOf('the subject this dream describes') !== -1);
  assert.ok(prompt.indexOf('reference photo') !== -1, 'the photo-pointer line must still be present');
  assert.ok(prompt.indexOf('I do not have a beard') !== -1, 'the description must still not be dropped');
});

// --- Generalization coverage (08-11, for-product-bug-founder-recurring-style--srehi9) ---

test('buildPrompt: bare third-person short caption "a woman" + Anime gets a guardrail that explicitly binds to a non-first-person subject and reinforces it against a strong style', function () {
  var caption = 'a woman';
  var prompt = genVideo.buildPrompt(caption, 'Anime', [], null, null, null);

  // The base guardrail must generalize beyond "the dreamer"/first-person
  // framing — it must explicitly say it covers third-person/generic
  // descriptions like "a woman", not just "I".
  assert.ok(prompt.indexOf('third-person/generic description like "a woman"') !== -1,
    'the guardrail must explicitly name third-person/generic subject phrasing, not just first-person "I"');
  assert.ok(prompt.indexOf('whether the caption phrases it in first person ("I")') !== -1,
    'the guardrail must still explicitly cover first-person framing too (no regression on the original case)');

  // The short-caption reinforcement sentence must fire for this 2-word
  // caption, and must quote the caption back verbatim so the binding is
  // unambiguous, and must explicitly rule out an animal/creature subject
  // (the actual failure mode: a flying dragon instead of a woman).
  assert.ok(prompt.indexOf('this dream\'s caption is short') !== -1,
    'the short-caption reinforcement sentence must fire for a 2-word caption');
  assert.ok(prompt.indexOf('"a woman"') !== -1,
    'the reinforcement sentence must quote the caption verbatim to unambiguously bind the guardrail to it');
  assert.ok(prompt.indexOf('never as an animal, mythical creature, or any other non-human entity') !== -1,
    'the reinforcement must explicitly rule out the actual observed failure mode (a flying dragon)');

  // Still must not suppress genuine transformation content, and must still
  // name the style being applied.
  assert.ok(prompt.indexOf('unless the dream itself explicitly describes a transformation') !== -1);
  assert.ok(prompt.indexOf('Anime treatment') !== -1);

  // Ordering unchanged: guardrail (incl. its reinforcement) still sits
  // between the caption and the style modifier.
  var captionIdx = prompt.indexOf(caption);
  var guardrailIdx = prompt.indexOf('the subject this dream describes');
  var reinforcementIdx = prompt.indexOf('this dream\'s caption is short');
  var styleModifierIdx = prompt.indexOf('vibrant Japanese anime animation style');
  assert.ok(captionIdx === 0);
  assert.ok(guardrailIdx > captionIdx);
  assert.ok(reinforcementIdx > guardrailIdx);
  assert.ok(reinforcementIdx < styleModifierIdx,
    'the reinforcement sentence must still land before the style modifier itself');
});

test('buildPrompt: short-caption reinforcement fires consistently across other bare third-person subjects, not just "a woman"', function () {
  ['a man', 'a child', 'a dog running'].forEach(function (caption) {
    var prompt = genVideo.buildPrompt(caption, 'Cartoon', [], null, null, null);
    assert.ok(prompt.indexOf('this dream\'s caption is short') !== -1,
      'reinforcement should fire for short caption: ' + caption);
    assert.ok(prompt.indexOf('"' + caption + '"') !== -1,
      'reinforcement should quote the exact caption: ' + caption);
  });
});

test('buildPrompt: short-caption reinforcement does NOT fire once a caption has enough of its own descriptive content (word-count boundary)', function () {
  // 11 words — one over SHORT_CAPTION_MAX_WORDS (10).
  var longerCaption = 'a woman walking slowly through a quiet foggy forest at dawn';
  var prompt = genVideo.buildPrompt(longerCaption, 'Anime', [], null, null, null);
  assert.ok(prompt.indexOf('caption is short') === -1,
    'an 11-word caption should be treated as having enough of its own content and not get the reinforcement sentence');
  // The base (non-reinforced) guardrail must still be present.
  assert.ok(prompt.indexOf('the subject this dream describes') !== -1);
});

test('buildPrompt: short-caption reinforcement composes correctly with a self-photo character (does not conflict with charTextParts/photoSelf logic)', function () {
  var prompt = genVideo.buildPrompt(
    'a woman',
    'Anime',
    [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA', description: 'wearing a red scarf' }],
    'Wide shot', 'Day', 'Nature'
  );
  // Guardrail + its reinforcement still present.
  assert.ok(prompt.indexOf('the subject this dream describes') !== -1);
  assert.ok(prompt.indexOf('this dream\'s caption is short') !== -1);
  assert.ok(prompt.indexOf('"a woman"') !== -1);
  // The self-photo pointer line and description are still intact —
  // this clause complements, not conflicts with, that logic.
  assert.ok(prompt.indexOf('reference photo') !== -1);
  assert.ok(prompt.indexOf('wearing a red scarf') !== -1);
  // Camera/scenery clauses still present and still ordered after the
  // guardrail (guardrail stays the early, prominent clause).
  var guardrailIdx = prompt.indexOf('the subject this dream describes');
  var cameraIdx = prompt.indexOf('wide shot');
  assert.ok(guardrailIdx !== -1 && cameraIdx !== -1 && guardrailIdx < cameraIdx);
});

test('buildPrompt: short-caption reinforcement does not fire for an empty/whitespace caption (no subject text to quote)', function () {
  var prompt = genVideo.buildPrompt('', 'Anime', [], null, null, null);
  assert.ok(prompt.indexOf('caption is short') === -1,
    'an empty caption has nothing to quote and must not produce a reinforcement sentence referencing ""');
  assert.ok(prompt.indexOf('the subject this dream describes') !== -1,
    'the base guardrail should still be present even for an empty caption');
});
