// test/wizard-chips.test.js
//
// Unit tests for js/wizard-chips.js's pure prompt-assembly logic — the
// dream-builder wizard's core "chips only, zero typing" -> a real Veo
// prompt pipeline (see dreamtube-growth/WIZARD_SPEC.md's "Prompt assembly"
// section, and js/wizard-chips.js's own header comment for the
// character-description-duplication rule this also covers).

var test = require('node:test');
var assert = require('node:assert/strict');

var WizardChips = require('../js/wizard-chips');

test('spec worked example: Me (text-described) + Sky + Flying + Dreamy + Cinematic', function () {
  var result = WizardChips.assembleCaption({
    subjectKey: 'me',
    character: { id: 'c1', isSelf: true, name: '', description: 'a man in his 30s in a grey hoodie' },
    placeKey: 'sky',
    actionKey: 'flying',
    moodKey: 'dreamy',
    style: 'Cinematic'
  });
  assert.match(result.caption, /^aerial wide shot of me, a man in his 30s in a grey hoodie, flying through an open sky, dreamy surreal mood, hazy ethereal light, Cinematic style, dreamlike\.$/);
  // Description was baked into the caption text -- must NOT also ride
  // along in characterIdsForGeneration, or generate-video.js's own
  // buildPrompt would append a second, duplicate "Characters -- the
  // dreamer ('me'): ..." clause.
  assert.deepEqual(result.characterIdsForGeneration, []);
});

test('self character WITH a photo: no text description baked in, but the character id IS returned for generation (reference-to-video needs the photo attached)', function () {
  var result = WizardChips.assembleCaption({
    subjectKey: 'me',
    character: { id: 'c2', isSelf: true, name: '', description: '', photoDataUrl: 'data:image/jpeg;base64,xyz' },
    actionKey: 'flying',
    moodKey: 'dreamy',
    style: 'Cinematic'
  });
  assert.equal(result.caption.indexOf('data:image'), -1);
  assert.deepEqual(result.characterIdsForGeneration, ['c2']);
  // Subject phrase is empty for a photo character -- generate-video.js's
  // own reference-to-video path supplies "the dreamer ('me') appears as
  // shown in the reference photo" instead.
  assert.match(result.caption, /^aerial wide shot of the dream,/);
});

test('POV toggle wins over every other camera inference, even Epic mood + Flying action', function () {
  var result = WizardChips.assembleCaption({
    subjectKey: 'none',
    actionKey: 'flying',
    pov: true,
    moodKey: 'epic',
    style: 'Realistic'
  });
  assert.match(result.caption, /^first-person POV shot/);
});

test('Epic mood infers a sweeping crane shot when action is not Flying/Falling and POV is off', function () {
  var result = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'exploring', moodKey: 'epic', style: 'Cinematic' });
  assert.match(result.caption, /^sweeping crane shot/);
});

test('Calm/Meeting actions infer an intimate close-up when mood is not Epic and POV is off', function () {
  var calm = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'calm', moodKey: 'peaceful', style: 'Cinematic' });
  assert.match(calm.caption, /^intimate close-up shot/);
  var meeting = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'meeting', moodKey: 'peaceful', style: 'Cinematic' });
  assert.match(meeting.caption, /^intimate close-up shot/);
});

test('everything else falls back to a medium tracking shot', function () {
  var result = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'running', moodKey: 'joyful', style: 'Anime' });
  assert.match(result.caption, /^medium tracking shot/);
});

test('lighting is inferred from mood by default', function () {
  var result = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'running', moodKey: 'mysterious', style: 'Anime' });
  assert.match(result.caption, /low-key moody light/);
});

test('an explicit Day/Night scenery chip OVERRIDES the mood-inferred lighting', function () {
  var night = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'running', moodKey: 'joyful', sceneryTime: 'Night', style: 'Anime' });
  assert.match(night.caption, /nighttime lighting/);
  assert.doesNotMatch(night.caption, /bright airy/);

  var day = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'running', moodKey: 'mysterious', sceneryTime: 'Day', style: 'Anime' });
  assert.match(day.caption, /bright daylight/);
  assert.doesNotMatch(day.caption, /low-key moody/);
});

test('subject "a stranger" / "an animal or creature" / "no people" produce plain literal phrases with no character id', function () {
  assert.match(WizardChips.assembleCaption({ subjectKey: 'stranger', actionKey: 'exploring', moodKey: 'peaceful', style: 'Cinematic' }).caption, /of a stranger,/);
  assert.match(WizardChips.assembleCaption({ subjectKey: 'animal', actionKey: 'exploring', moodKey: 'peaceful', style: 'Cinematic' }).caption, /of an animal or creature,/);
  var none = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'exploring', moodKey: 'peaceful', style: 'Cinematic' });
  assert.match(none.caption, /of the dream,/);
});

test('"+ Something else" free-text escape hatches are honored for subject/place/action/mood', function () {
  var result = WizardChips.assembleCaption({
    subjectKey: 'other', subjectOtherText: 'my grandmother',
    placeKey: 'other', placeOtherText: 'a floating library',
    actionKey: 'other', actionOtherText: 'reading an impossible book',
    moodKey: 'other', moodOtherText: 'bittersweet',
    style: 'Cinematic'
  });
  assert.match(result.caption, /of my grandmother,/);
  assert.match(result.caption, /reading an impossible book a floating library,/);
  assert.match(result.caption, /bittersweet mood,/);
});

test('optional free-text (Step 6) is appended verbatim after the assembled sentence', function () {
  var result = WizardChips.assembleCaption({
    subjectKey: 'none', actionKey: 'flying', moodKey: 'dreamy', style: 'Cinematic',
    freeText: 'There was also a talking cat.'
  });
  assert.match(result.caption, /dreamlike\. There was also a talking cat\.$/);
});

test('unset action/mood/style fall back to the documented defaults (Flying, Dreamy/surreal, Cinematic)', function () {
  var result = WizardChips.assembleCaption({ subjectKey: 'none' });
  assert.match(result.caption, /^aerial wide shot/); // default action is flying
  assert.match(result.caption, /dreamy surreal mood/);
  assert.match(result.caption, /Cinematic style/);
});

test('a non-self "someone I know" character with a description bakes the name + description into the subject phrase', function () {
  var result = WizardChips.assembleCaption({
    subjectKey: 'someone',
    character: { id: 'c3', isSelf: false, name: 'Alex', description: 'tall with curly red hair' },
    actionKey: 'meeting', moodKey: 'joyful', style: 'Realistic'
  });
  assert.match(result.caption, /of Alex, tall with curly red hair,/);
  assert.deepEqual(result.characterIdsForGeneration, []);
});

test('style: null explicitly omits the style clause entirely (create.html\'s "Build it" retrofit, which hands off to style.html for the real choice — review finding, replacing a fragile literal string .replace())', function () {
  var result = WizardChips.assembleCaption({
    subjectKey: 'none', actionKey: 'flying', moodKey: 'dreamy', style: null
  });
  assert.doesNotMatch(result.caption, /style,/);
  assert.doesNotMatch(result.caption, /Cinematic/);
  assert.match(result.caption, /hazy ethereal light, dreamlike\.$/);
});

test('style omitted entirely (not explicitly null) still defaults to Cinematic, unchanged', function () {
  var result = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'flying', moodKey: 'dreamy' });
  assert.match(result.caption, /Cinematic style, dreamlike\.$/);
});

// ── buildDeterministicStory — tracker item split-prompttext-storytext ──
// The zero-cost, always-available, non-LLM storyText fallback for "chips
// selected, no free text typed". Must never contain camera/lighting/
// style language (that's promptText's job, tested above via
// assembleCaption) and must always read as a plain first-person sentence.

test('deterministic story: subject "none" + defaults reads as a plain first-person sentence with no camera/lighting/style words', function () {
  var story = WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'flying', placeKey: 'sky', moodKey: 'dreamy' });
  assert.match(story, /^I was flying in an open sky, feeling dreamy and surreal\.$/);
  assert.doesNotMatch(story, /shot|light|style|dreamlike/i);
});

test('deterministic story: "a stranger" subject reads "I was a stranger, ..." (spec\'s own worked example shape)', function () {
  var story = WizardChips.buildDeterministicStory({
    subjectKey: 'stranger', actionKey: 'exploring', placeKey: 'nature', sceneryTime: 'Night', moodKey: 'mysterious'
  });
  assert.equal(story, 'I was a stranger, exploring somewhere new in a natural outdoor landscape at night, feeling mysterious.');
});

test('deterministic story: "someone I know" subject uses the character\'s name', function () {
  var story = WizardChips.buildDeterministicStory({
    subjectKey: 'someone', character: { name: 'Alex' }, actionKey: 'meeting', placeKey: 'house', moodKey: 'joyful'
  });
  assert.equal(story, 'I was with Alex, meeting someone new inside a house, feeling joyful.');
});

test('deterministic story: "+ Something else" free-text escape hatches are honored for subject/place/action/mood, with a grammatical preposition prepended to a custom place (review finding: was missing "in", producing "...book a floating library")', function () {
  var story = WizardChips.buildDeterministicStory({
    subjectKey: 'other', subjectOtherText: 'my grandmother',
    placeKey: 'other', placeOtherText: 'a floating library',
    actionKey: 'other', actionOtherText: 'reading an impossible book',
    moodKey: 'other', moodOtherText: 'bittersweet'
  });
  assert.equal(story, 'I was my grandmother, reading an impossible book in a floating library, feeling bittersweet.');
});

test('deterministic story: unset action/mood fall back to the same documented defaults as assembleCaption (Flying, Dreamy/surreal)', function () {
  var story = WizardChips.buildDeterministicStory({ subjectKey: 'none' });
  assert.match(story, /^I was flying/);
  assert.match(story, /dreamy and surreal\.$/);
});

test('deterministic story: Day/Night scenery adds a plain time clause, no lighting jargon', function () {
  var day = WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'running', placeKey: 'urban', sceneryTime: 'Day', moodKey: 'joyful' });
  assert.match(day.toLowerCase(), /during the day/);
  var night = WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'running', placeKey: 'urban', sceneryTime: 'Night', moodKey: 'joyful' });
  assert.match(night.toLowerCase(), /at night/);
});

test('deterministic story: never throws and always returns a non-empty sentence, even with no input at all', function () {
  var story = WizardChips.buildDeterministicStory();
  assert.ok(story.length > 0);
  assert.match(story, /^I was/);
});

// ── Research-backed archetype chips — tracker item
// for-product-quiz-wizard-add-the-scientif-ffgf8l, citing Nielsen/Zadra
// 2003 (Dreaming 13(4), N=1181, replicated by Schredl 2004). 'chased' and
// 'falling' were already covered by the pre-existing 'running'/'falling'
// ACTION_CHIPS entries -- only the remaining five needed new chips.

test('deterministic story: "Back in school, taking a test" (exam) reads as a plain grammatical sentence', function () {
  var story = WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'exam', moodKey: 'tense' });
  assert.equal(story, 'I was taking an exam I never studied for, back in school, feeling tense.');
});

test('deterministic story: "Arriving too late" reads as a plain grammatical sentence, with a place appended', function () {
  var story = WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'late', placeKey: 'urban', moodKey: 'tense' });
  assert.equal(story, 'I was rushing to get somewhere, but arriving too late in a city, feeling tense.');
});

test('deterministic story: "Trying again and again" reads as a plain grammatical sentence', function () {
  var story = WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'trying', moodKey: 'tense' });
  assert.equal(story, 'I was trying to do the same thing again and again without success, feeling tense.');
});

test('deterministic story: "Discovering a new room" reads as a plain grammatical sentence, with a place appended', function () {
  var story = WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'newroom', placeKey: 'house', moodKey: 'mysterious' });
  assert.equal(story, 'I was discovering a hidden room that was never there before inside a house, feeling mysterious.');
});

test('deterministic story: "Being a child again" reads as a plain grammatical sentence ("I was a child again," not "I was being")', function () {
  var story = WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'child', moodKey: 'joyful' });
  assert.equal(story, 'I was a child again, feeling joyful.');
});

test('all five new research-backed action chips exist in ACTION_CHIPS with a label and prompt phrase', function () {
  ['exam', 'late', 'trying', 'newroom', 'child'].forEach(function (key) {
    var chip = WizardChips.ACTION_CHIPS.filter(function (c) { return c.key === key; })[0];
    assert.ok(chip, 'expected an ACTION_CHIPS entry for key ' + key);
    assert.ok(chip.label && chip.label.length > 0);
    assert.ok(chip.phrase && chip.phrase.length > 0);
  });
});

test('assembleCaption produces a sane, non-empty prompt caption for each of the five new action chips', function () {
  ['exam', 'late', 'trying', 'newroom', 'child'].forEach(function (key) {
    var result = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: key, moodKey: 'dreamy', style: 'Cinematic' });
    assert.match(result.caption, /style, dreamlike\.$/);
    assert.ok(result.caption.length > 0);
  });
});
