// test/interp-voice-captions.test.js
//
// Unit coverage for js/interpret-experience.js's Speaking Sage Option D
// PURE (no-DOM) logic — caption-timing (word-index lookup + the sentence-
// level fallback schedule), the bounce-loop math, and the intro-eligibility
// gate — required() directly the same way test/purchase-sheet.test.js
// already does for js/purchase-sheet.js (see that file's own header
// comment for the "export an internal for testability" precedent this
// follows). Real-browser DOM/state-machine behavior (the actual intro ->
// crossfade -> reading flow, autoplay-blocked tap-to-play, instrumentation
// events firing) is covered by test/interp-voice-behavioral.test.js
// instead, since that needs a real browser.

var test = require('node:test');
var assert = require('node:assert/strict');

var InterpretExperience = require('../js/interpret-experience');

var shouldShowIntro = InterpretExperience._shouldShowIntro;
var computeSentenceFallbackCaptions = InterpretExperience._computeSentenceFallbackCaptions;
var currentCaptionIndex = InterpretExperience._currentCaptionIndex;
var nextBounceFrame = InterpretExperience._nextBounceFrame;
var tapOverlayLabel = InterpretExperience._tapOverlayLabel;
var preparingCaptionText = InterpretExperience._preparingCaptionText;

// The old split shape (introClipUrl + introVoiceUrl -- a silent looping
// visual backdrop plus a separate paired voice track) was retired once
// every persona migrated to the one-file talking-head clip below (tracker
// item auto-cleanup-retire-the-now-unused-split-dwea7w) -- shouldShowIntro
// no longer knows that shape exists, so there's nothing left to test for it.
test('shouldShowIntro: true only when the persona has a talking-head intro clip (introTalkingHeadUrl, single self-contained lip-synced clip) AND it hasn\'t been shown yet', function () {
  var withIntro = { introTalkingHeadUrl: 'assets/interpreters/intro/jung-intro.mp4' };
  var withoutIntro = { introTalkingHeadUrl: null };
  assert.equal(shouldShowIntro(withIntro, false), true);
  assert.equal(shouldShowIntro(withIntro, true), false, 'still respects the once-per-dream already-shown gate');
  assert.equal(shouldShowIntro(withoutIntro, false), false);
  assert.equal(shouldShowIntro(withoutIntro, true), false);
  assert.equal(shouldShowIntro(null, false), false);
  assert.equal(shouldShowIntro(undefined, false), false);
});

test('computeSentenceFallbackCaptions: distributes duration across sentences proportional to character length', function () {
  var text = 'Short one. This is a longer sentence with more characters in it.';
  var out = computeSentenceFallbackCaptions(text, 10000);
  assert.equal(out.length, 2);
  assert.equal(out[0].startMs, 0);
  // Sentence 1 ("Short one.", 10 chars) gets a much smaller share than
  // sentence 2 (56 chars) of the same total duration.
  assert.ok(out[0].endMs < out[1].endMs - out[0].endMs, 'the longer second sentence should get proportionally more time than the first');
  // Cues are contiguous (no gaps/overlaps).
  assert.equal(out[1].startMs, out[0].endMs);
  // The LAST cue always reaches the real total duration exactly, regardless of rounding drift.
  assert.equal(out[out.length - 1].endMs, 10000);
});

test('computeSentenceFallbackCaptions: a single-sentence reading gets one cue spanning the whole duration', function () {
  var out = computeSentenceFallbackCaptions('Just one sentence here.', 4000);
  assert.equal(out.length, 1);
  assert.equal(out[0].startMs, 0);
  assert.equal(out[0].endMs, 4000);
  assert.equal(out[0].word, 'Just one sentence here.');
});

test('computeSentenceFallbackCaptions: empty text or a non-positive duration returns no cues (never throws)', function () {
  assert.deepEqual(computeSentenceFallbackCaptions('', 5000), []);
  assert.deepEqual(computeSentenceFallbackCaptions('   ', 5000), []);
  assert.deepEqual(computeSentenceFallbackCaptions('Some text.', 0), []);
  assert.deepEqual(computeSentenceFallbackCaptions('Some text.', null), []);
});

test('currentCaptionIndex: finds the active cue by ms, -1 before the first cue starts', function () {
  var captions = [
    { word: 'Hello', startMs: 0, endMs: 500 },
    { word: 'there', startMs: 500, endMs: 900 },
    { word: 'friend', startMs: 900, endMs: 1400 }
  ];
  assert.equal(currentCaptionIndex(captions, 0), 0);
  assert.equal(currentCaptionIndex(captions, 250), 0);
  assert.equal(currentCaptionIndex(captions, 500), 1);
  assert.equal(currentCaptionIndex(captions, 1399), 2);
  assert.equal(currentCaptionIndex(captions, 5000), 2, 'stays on the last cue past the end rather than going out of range');
  assert.equal(currentCaptionIndex([], 100), -1);
  assert.equal(currentCaptionIndex(null, 100), -1);
});

test('nextBounceFrame: plays forward, reverses at the end, plays backward, reverses again at the start', function () {
  var duration = 10;
  var state = { currentTime: 0, direction: 1 };
  // Forward for a while.
  state = nextBounceFrame(state.currentTime, duration, state.direction, 4);
  assert.equal(state.currentTime, 4);
  assert.equal(state.direction, 1);
  // Overshoots the end -- clamps to duration and reverses direction.
  state = nextBounceFrame(state.currentTime, duration, state.direction, 8);
  assert.equal(state.currentTime, duration);
  assert.equal(state.direction, -1);
  // Now plays backward.
  state = nextBounceFrame(state.currentTime, duration, state.direction, 3);
  assert.equal(state.currentTime, 7);
  assert.equal(state.direction, -1);
  // Overshoots the start -- clamps to 0 and reverses direction again.
  state = nextBounceFrame(state.currentTime, duration, state.direction, 20);
  assert.equal(state.currentTime, 0);
  assert.equal(state.direction, 1);
});

test('nextBounceFrame: a zero/missing duration or delta is a safe no-op (never throws, never produces NaN)', function () {
  assert.deepEqual(nextBounceFrame(2, 0, 1, 0.5), { currentTime: 2, direction: 1 });
  assert.deepEqual(nextBounceFrame(2, 10, 1, 0), { currentTime: 2, direction: 1 });
  assert.deepEqual(nextBounceFrame(undefined, 10, undefined, 0.5), { currentTime: 0.5, direction: 1 });
});

// ── Tracker item for-product-p1-bug-founder-repro-sage-re-cbdj3d ──
// (founder walk 2026-08-03 23:31: dream video looped silently ~3x with no
// indication a voice reading was coming, then only an unlabeled bare
// play-triangle appeared once audio was ready). Both functions below are
// the pure string logic behind that fix set's items 1 and 2.

test('preparingCaptionText: persona-named "preparing" copy, with a generic fallback if the persona name is missing', function () {
  assert.equal(preparingCaptionText('The Sage'), 'The Sage is preparing to read your dream…');
  assert.equal(preparingCaptionText('The Depth Analyst'), 'The Depth Analyst is preparing to read your dream…');
  assert.equal(preparingCaptionText(null), 'Your reader is preparing to read your dream…');
  assert.equal(preparingCaptionText(''), 'Your reader is preparing to read your dream…');
  assert.equal(preparingCaptionText(undefined), 'Your reader is preparing to read your dream…');
});

test('tapOverlayLabel: persona-named, distinct copy per reuse of the same tap overlay (intro / first reading play / resume / replay)', function () {
  assert.equal(tapOverlayLabel('The Sage', 'first'), 'Hear The Sage read your dream');
  assert.equal(tapOverlayLabel('The Sage', 'replay'), 'Hear it again');
  assert.equal(tapOverlayLabel('The Sage', 'resume'), 'Resume');
  assert.equal(tapOverlayLabel('The Sage', 'intro'), 'Tap to hear The Sage');
  // Never hardcoded "Sage" -- driven entirely by whatever persona name is
  // passed in, so a future second voice-eligible persona (docs/
  // SPEAKING_SAGE_SPEC.md §12 item 2, still a founder-ears decision) gets
  // correct copy for free.
  assert.equal(tapOverlayLabel('The Depth Analyst', 'first'), 'Hear The Depth Analyst read your dream');
  assert.equal(tapOverlayLabel('The Depth Analyst', 'intro'), 'Tap to hear The Depth Analyst');
  // "replay"/"resume" never mention a name at all -- verify a different
  // persona name doesn't leak into them either.
  assert.equal(tapOverlayLabel('The Depth Analyst', 'replay'), 'Hear it again');
  assert.equal(tapOverlayLabel('The Depth Analyst', 'resume'), 'Resume');
  // Missing/falsy persona name never throws or renders "undefined"/"null".
  assert.equal(tapOverlayLabel(null, 'first'), 'Hear this reader read your dream');
  assert.equal(tapOverlayLabel(undefined, 'intro'), 'Tap to hear this reader');
  // An unrecognized `kind` falls back to the "first play" copy rather than
  // rendering blank/undefined -- defensive only, every real call site
  // always passes one of the four known kinds.
  assert.equal(tapOverlayLabel('The Sage', 'something_unexpected'), 'Hear The Sage read your dream');
});
