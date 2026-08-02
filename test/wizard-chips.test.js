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

// ── Review finding: dangling ", in," / ", through," when the Setting/
// place step is skipped ──
// The Setting/place step is skippable in both wizard.html (fn-setting-skip)
// and create.html's "Build it" retrofit (build-setting-skip), leaving
// placeKey unset and placePhrase === ''. Every ACTION_CHIPS entry whose
// phrase relied on a trailing preposition to connect to a place that might
// never come produced a broken caption fragment in that case (e.g.
// "...taking an exam back in school, in, dreamy..."). Fixed by splitting
// each such phrase from its connecting preposition (`connector`), only
// ever appended alongside an actual placePhrase. Covers all affected
// chips: the pre-existing flying/running/falling/calm/magical/meeting
// (broken the same way, not introduced by this branch) plus the 5 new
// exam/late/trying/newroom/child chips this branch added. 'exploring' and
// 'other' never had a trailing preposition and are intentionally excluded.
test('assembleCaption: every trailing-preposition action chip reads as a grammatically complete sentence when the place step is skipped entirely (no placeKey at all)', function () {
  var expectedActionClause = {
    flying: 'flying,',
    running: 'running, chasing and being chased,',
    falling: 'falling,',
    calm: 'sitting in a calm, still moment,',
    magical: 'witnessing something magical happen,',
    meeting: 'meeting someone,',
    exam: 'taking an exam back in school,',
    late: 'rushing to get somewhere but arriving too late,',
    trying: 'trying to do the same thing again and again without success,',
    newroom: 'discovering a hidden room that was never there before,',
    child: 'being a child again, playing,'
  };
  Object.keys(expectedActionClause).forEach(function (key) {
    var result = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: key, moodKey: 'dreamy', style: 'Cinematic' });
    assert.ok(
      result.caption.indexOf(expectedActionClause[key]) !== -1,
      key + ': expected to find "' + expectedActionClause[key] + '" in "' + result.caption + '"'
    );
    // No dangling connector left stranded right before a comma (the bug:
    // "...school, in, dreamy..." / "...flying through, dreamy...").
    assert.doesNotMatch(result.caption, /\b(in|through)\s*,/, key + ': dangling preposition before a comma');
    // No double-comma artifact from the join either.
    assert.doesNotMatch(result.caption, /,\s*,/, key + ': double comma');
  });
});

// ── Step 3 default-visible chip curation — tracker item
// for-product-wizard-step-3-has-too-many-c-lrg1ct (founder live test:
// "Too many options to choose from" against all 13 ACTION_CHIPS + POV).
// wizard.html/create.html now render only ACTION_DEFAULT_VISIBLE_KEYS by
// default, with the rest reachable behind a "+N more" expander -- these
// are UI-visibility-only tests; see test/wizard-action-chip-curation-
// behavioral.test.js for the actual browser-driven expand/select coverage.

test('ACTION_DEFAULT_VISIBLE_KEYS is a real subset of ACTION_CHIPS, curated down to roughly 6, and always includes "other" (the free-entry escape hatch must never be hidden)', function () {
  var allKeys = WizardChips.ACTION_CHIPS.map(function (c) { return c.key; });
  var defaultKeys = WizardChips.ACTION_DEFAULT_VISIBLE_KEYS;
  assert.ok(Array.isArray(defaultKeys) && defaultKeys.length > 0);
  assert.ok(defaultKeys.length <= 7 && defaultKeys.length >= 5, 'expected "roughly 6" default-visible chips, got ' + defaultKeys.length);
  defaultKeys.forEach(function (key) {
    assert.ok(allKeys.indexOf(key) !== -1, 'default-visible key "' + key + '" must be a real ACTION_CHIPS key');
  });
  // No duplicates.
  assert.equal(new Set(defaultKeys).size, defaultKeys.length);
  assert.ok(defaultKeys.indexOf('other') !== -1, '"+ Something else" must always stay default-visible, never behind the expander');
});

test('ACTION_DEFAULT_VISIBLE_KEYS still leaves every other chip in ACTION_CHIPS reachable (nothing was deleted, only hidden by default) -- curation changes VISIBILITY only, never the chip list, key/label/phrase/connector, or assembleCaption\'s output for any key', function () {
  var defaultKeys = WizardChips.ACTION_DEFAULT_VISIBLE_KEYS;
  var hiddenChips = WizardChips.ACTION_CHIPS.filter(function (c) { return defaultKeys.indexOf(c.key) === -1; });
  assert.ok(hiddenChips.length > 0, 'expected at least one chip curated behind the expander');
  assert.equal(defaultKeys.length + hiddenChips.length, WizardChips.ACTION_CHIPS.length, 'every ACTION_CHIPS entry must be either default-visible or in the "more" set -- none can vanish');
  // A hidden chip's assembleCaption behavior must be completely
  // unaffected by being curated out of the default view.
  hiddenChips.forEach(function (c) {
    var result = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: c.key, moodKey: 'dreamy', style: 'Cinematic' });
    assert.ok(result.caption.length > 0, c.key + ': hidden chip must still produce a real caption');
    assert.match(result.caption, /style, dreamlike\.$/);
  });
});

// ── Multi-select subject (`input.subjects`) — tracker item
// for-product-wizard-characters-step-is-si-paxp07, founder repro
// 2026-08-02: "choosing Me and then adding another character (e.g. a
// stranger) UNCHECKS Me... Founder intent = multi-select." wizard.html's
// Subject step now toggles any number of staged characters + at most one
// "other" chip (stranger/animal/none/other) independently and composes
// them together into this new `subjects` array input. Singular
// subjectKey/character/subjectOtherText coverage above is left completely
// untouched (still exercised, still passing) — these tests cover ONLY the
// new array shape, which create.html's own single-select "Build it" step
// never uses.

test('assembleCaption: `subjects` array with a single entry matches the singular subjectKey/character/subjectOtherText path byte-for-byte (backward-compat sanity check)', function () {
  var viaArray = WizardChips.assembleCaption({
    subjects: [{ subjectKey: 'stranger' }],
    actionKey: 'exploring', moodKey: 'peaceful', style: 'Cinematic'
  });
  var viaSingular = WizardChips.assembleCaption({
    subjectKey: 'stranger', actionKey: 'exploring', moodKey: 'peaceful', style: 'Cinematic'
  });
  assert.equal(viaArray.caption, viaSingular.caption);
  assert.deepEqual(viaArray.characterIdsForGeneration, viaSingular.characterIdsForGeneration);
});

test('assembleCaption: founder\'s own worked example -- Me (described) + "Someone I know" (Alex, described) + "A stranger" all selected together produces ONE joined subject clause naming all three, and neither described character\'s id rides along (avoids doubling their description via generate-video.js\'s own buildPrompt)', function () {
  var result = WizardChips.assembleCaption({
    subjects: [
      { subjectKey: 'me', character: { id: 'me1', isSelf: true, name: '', description: 'a woman in her 30s, curly brown hair' } },
      { subjectKey: 'someone', character: { id: 'alex1', isSelf: false, name: 'Alex', description: 'tall with curly red hair' } },
      { subjectKey: 'stranger' }
    ],
    actionKey: 'flying', moodKey: 'dreamy', style: 'Cinematic'
  });
  assert.match(result.caption, /^aerial wide shot of me, a woman in her 30s, curly brown hair, Alex, tall with curly red hair and a stranger, flying,/);
  assert.deepEqual(result.characterIdsForGeneration, []);
});

test('assembleCaption: a PHOTO "Me" character combined with a described "Someone I know" and "A stranger" -- the photo character contributes no caption phrase (joined clause skips it) but DOES ride along in characterIdsForGeneration; the described character does the opposite (phrase, no id)', function () {
  var result = WizardChips.assembleCaption({
    subjects: [
      { subjectKey: 'me', character: { id: 'me2', isSelf: true, name: '', description: '', photoDataUrl: 'data:image/jpeg;base64,xyz' } },
      { subjectKey: 'someone', character: { id: 'alex2', isSelf: false, name: 'Alex', description: 'tall with curly red hair' } },
      { subjectKey: 'stranger' }
    ],
    actionKey: 'flying', moodKey: 'dreamy', style: 'Cinematic'
  });
  assert.equal(result.caption.indexOf('data:image'), -1);
  assert.match(result.caption, /^aerial wide shot of Alex, tall with curly red hair and a stranger,/, 'the photo character contributes no phrase of its own -- the joined clause has only the two non-photo subjects');
  assert.deepEqual(result.characterIdsForGeneration, ['me2'], 'only the photo character\'s id rides along -- Alex\'s description is already baked into the caption text');
});

test('assembleCaption: a two-character selection ("Me" + "Someone I know", no "other" chip) joins with "and", no trailing/leading artifacts', function () {
  var result = WizardChips.assembleCaption({
    subjects: [
      { subjectKey: 'me', character: { id: 'me3', isSelf: true, name: '', description: '' } },
      { subjectKey: 'someone', character: { id: 'sam1', isSelf: false, name: 'Sam', description: 'short with glasses' } }
    ],
    actionKey: 'exploring', moodKey: 'peaceful', style: 'Cinematic'
  });
  assert.match(result.caption, /of me and Sam, short with glasses,/);
});

test('assembleCaption: an empty `subjects` array falls back to the singular path exactly as if `subjects` were never passed at all (e.g. the Subject step was skipped -- nothing selected)', function () {
  var result = WizardChips.assembleCaption({ subjects: [], actionKey: 'flying', moodKey: 'dreamy', style: 'Cinematic' });
  assert.match(result.caption, /of the dream,/);
  assert.deepEqual(result.characterIdsForGeneration, []);
});

test('buildDeterministicStory: `subjects` array with a single entry matches the singular path byte-for-byte (backward-compat sanity check)', function () {
  var viaArray = WizardChips.buildDeterministicStory({ subjects: [{ subjectKey: 'stranger' }], actionKey: 'exploring', placeKey: 'nature', sceneryTime: 'Night', moodKey: 'mysterious' });
  var viaSingular = WizardChips.buildDeterministicStory({ subjectKey: 'stranger', actionKey: 'exploring', placeKey: 'nature', sceneryTime: 'Night', moodKey: 'mysterious' });
  assert.equal(viaArray, viaSingular);
});

test('buildDeterministicStory: founder\'s own worked example -- Me + Alex + "a stranger" reads as one natural "with X, Y and Z" clause', function () {
  var story = WizardChips.buildDeterministicStory({
    subjects: [
      { subjectKey: 'me' },
      { subjectKey: 'someone', character: { name: 'Alex' } },
      { subjectKey: 'stranger' }
    ],
    actionKey: 'flying', moodKey: 'dreamy'
  });
  assert.equal(story, 'I was with Alex and a stranger, flying, feeling dreamy and surreal.');
});

test('buildDeterministicStory: "Me" alone (no other subject) reads exactly like the plain, no-subject-descriptor case -- explicit "me" contributes nothing extra on its own', function () {
  var story = WizardChips.buildDeterministicStory({ subjects: [{ subjectKey: 'me' }], actionKey: 'flying', moodKey: 'dreamy' });
  assert.equal(story, 'I was flying, feeling dreamy and surreal.');
});

test('buildDeterministicStory: "Me" + "A stranger" (no named "someone") still reads "with a stranger" -- explicit Me presence upgrades the wording from the singular path\'s bare "I was a stranger" (which reads as narrator-becomes-stranger) to the correct "I was WITH a stranger"', function () {
  var story = WizardChips.buildDeterministicStory({ subjects: [{ subjectKey: 'me' }, { subjectKey: 'stranger' }], actionKey: 'exploring', moodKey: 'peaceful' });
  assert.equal(story, 'I was with a stranger, exploring somewhere new, feeling peaceful.');
});

test('assembleCaption: with a place chosen, the connector still joins the action phrase to the place phrase correctly (with-place case unaffected by the no-place fix)', function () {
  // flying+sky is the pre-existing "spec worked example" test above --
  // this adds direct with-place coverage for a couple of the OTHER
  // affected chips (an 'in' connector and a 'through' connector).
  var exam = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'exam', placeKey: 'urban', moodKey: 'dreamy', style: 'Cinematic' });
  assert.match(exam.caption, /taking an exam back in school in an urban setting,/);
  assert.doesNotMatch(exam.caption, /,\s*,/);

  var falling = WizardChips.assembleCaption({ subjectKey: 'none', actionKey: 'falling', placeKey: 'sky', moodKey: 'dreamy', style: 'Cinematic' });
  assert.match(falling.caption, /falling through an open sky,/);
  assert.doesNotMatch(falling.caption, /,\s*,/);
});
