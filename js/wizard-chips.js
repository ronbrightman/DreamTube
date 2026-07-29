// js/wizard-chips.js
//
// Shared, pure (no DOM) logic for the dream-builder wizard — the chip
// taxonomy/copy and the prompt-assembly algorithm from
// dreamtube-growth/WIZARD_SPEC.md ("Prompt assembly" section), used by
// BOTH wizard.html (the new pre-signup dream-builder + signup flow) and
// create.html (the logged-in "New Dream" retrofit — see that file's
// choice-card for "Build it"). Kept as one shared, tested module rather
// than copy-pasted into each page, since the inference tables (camera
// from action/POV, lighting from mood) must stay byte-identical wherever
// the wizard runs — see test/wizard-chips.test.js.
//
// Plain script (no ES modules — matches every other file in this
// codebase, see CLAUDE.md), attaches window.WizardChips.
//
// ── Open item: no per-chip icons yet (review finding) ──
// WIZARD_SPEC.md's "Global" bullet calls for icons on chips. Only the
// Style step (reusing style.html's real .sc-icon/Icons.palette) and the
// character add-tiles (Icons.userPlus/Icons.plus, reused from
// create.html/start.html's existing character sheet) have one — the
// Subject/Setting/Action/Mood standalone chips (js/icons.js's ~30-icon
// library) don't yet, because there is no honest semantic match in that
// library for "Flying/floating," "A calm still moment," "Mysterious,"
// "Somewhere unreal," etc. — this was checked, not skipped by oversight.
// Forcing a mismatched existing icon (e.g. Icons.globe for "Somewhere
// unreal") onto a chip whose actual meaning is different would read as
// sloppy rather than helpful, which is worse than no icon for a
// tap-target that already carries a clear text label. Real per-chip
// icons need ~15-20 new bespoke SVGs matching js/icons.js's existing
// 24x24 line style (see that file's own header) — genuine design/asset
// work, not a mechanical fix to bolt onto this branch; flagged as a
// follow-up rather than done here with wrong icons.
//
// ── Why character description is NOT baked into the assembled caption
//    for a "Me"/"Someone I know" subject picked from a saved character ──
// The spec's own worked example ("Me 'man 30s grey hoodie' + Sky + Flying
// + Dreamy + Cinematic" -> "Aerial wide shot of a man in his 30s in a grey
// hoodie, flying...") bakes the character description directly into the
// prompt text. But generate-video.js's own buildPrompt() ALREADY appends a
// separate "Characters — the dreamer ('me'): ..." clause whenever a
// character id is passed via characterIds/resolveCharacters (the existing,
// already-shipped mechanism every other dream-creation path in this app
// uses). Baking the description into the caption text here AND passing
// the same character's id through characterIds would double up that
// description in the final Veo prompt. So: for a described (non-photo)
// character, this module bakes the description into the assembled caption
// (matching the spec's literal example) and the caller must NOT include
// that character's id in the generation request's characterIds. For a
// PHOTO character (self only), generate-video.js's reference-to-video path
// needs the actual photo attached via characterIds — buildPrompt() now
// folds that character's description into the SAME reference-photo
// pointer clause it already emits ("...appears as shown in the reference
// photo, with these specific details: ..."), rather than skipping it, but
// this module's own `subjectPhraseAndCharacterId` still returns an empty
// caption phrase for a photo character (see below) — the description
// never gets baked into the assembled caption text here, only ever
// reaches the prompt once via buildPrompt/characterIds — so there is
// still no double-up risk; the caller SHOULD include that character's id.
// assembleCaption's own `characterIdsForGeneration` return value already
// encodes this rule — callers should use exactly that array, not their own.

(function () {
  'use strict';

  var SUBJECT_CHIPS = [
    { key: 'me', label: 'Me' },
    { key: 'someone', label: 'Someone I know' },
    { key: 'stranger', label: 'A stranger' },
    { key: 'animal', label: 'An animal or creature' },
    { key: 'none', label: 'No people — just a place/thing' },
    { key: 'other', label: '+ Something else' }
  ];

  var SETTING_PLACE_CHIPS = [
    { key: 'urban', label: 'Urban/city', phrase: 'an urban setting' },
    { key: 'nature', label: 'Nature/outdoors', phrase: 'a natural outdoor landscape' },
    { key: 'house', label: 'Inside a house', phrase: 'inside a house' },
    { key: 'water', label: 'Water/ocean', phrase: 'in and around water, an ocean' },
    { key: 'sky', label: 'Sky/space', phrase: 'an open sky' },
    { key: 'unreal', label: 'Somewhere unreal', phrase: 'a surreal, otherworldly place' },
    { key: 'other', label: '+ Something else' }
  ];

  // Each entry's `phrase` is the action clause ALONE, with no trailing
  // preposition baked in. Most actions need a preposition ('in'/'through')
  // to connect naturally to whatever place phrase follows -- that's the
  // `connector` field below, appended by assembleCaption ONLY when there
  // actually is a place phrase to connect to (the Setting/place step is
  // skippable in both wizard.html and create.html's "Build it" retrofit,
  // so placePhrase is often '' -- see assembleCaption's own comment).
  // Baking the preposition into `phrase` itself (the original design) left
  // a dangling ", in," / ", through," fragment in the assembled prompt
  // whenever the place step was skipped -- review finding, fixed here for
  // every affected chip, not just the newest ones. 'exploring' and 'other'
  // never needed a connector (already read fine standalone) and are
  // untouched.
  var ACTION_CHIPS = [
    { key: 'flying', label: 'Flying/floating', phrase: 'flying', connector: 'through' },
    { key: 'running', label: 'Running/chasing/chased', phrase: 'running, chasing and being chased', connector: 'through' },
    { key: 'falling', label: 'Falling', phrase: 'falling', connector: 'through' },
    // Nielsen/Zadra 2003 ("Typical Dreams of Canadian University Students,"
    // Dreaming 13(4), N=1181, replicated by Schredl 2004) found these to be
    // the most common dream archetypes/themes after chasing (81.5%, already
    // 'running' above) and falling (73.8%, already 'falling' above) --
    // 'exam'/'late'/'trying' are added here in that same published
    // prevalence order (67.1% and descending, straight from the paper's
    // top ten). 'newroom' and 'child' are also well-documented dream
    // archetypes (secondary sourcing puts "being a child again" at
    // ~36.7%, ahead of "discovering a new room" at ~32.3%) but fall
    // outside the paper's strict top-ten ranking, so their relative order
    // here is not itself a prevalence claim the way the three above are.
    // Teeth-falling-out is the most famous dream trope in pop culture but
    // scores under 24% in this same study (outside their top 30) and is
    // deliberately left out.
    { key: 'exam', label: 'Back in school, taking a test', phrase: 'taking an exam back in school', connector: 'in' },
    { key: 'late', label: 'Arriving too late', phrase: 'rushing to get somewhere but arriving too late', connector: 'in' },
    { key: 'trying', label: 'Trying again and again', phrase: 'trying to do the same thing again and again without success', connector: 'in' },
    { key: 'newroom', label: 'Discovering a new room', phrase: 'discovering a hidden room that was never there before', connector: 'in' },
    { key: 'child', label: 'Being a child again', phrase: 'being a child again, playing', connector: 'in' },
    { key: 'exploring', label: 'Exploring somewhere new', phrase: 'exploring' },
    { key: 'calm', label: 'A calm still moment', phrase: 'sitting in a calm, still moment', connector: 'in' },
    { key: 'magical', label: 'Something magical happens', phrase: 'witnessing something magical happen', connector: 'in' },
    { key: 'meeting', label: 'Meeting someone', phrase: 'meeting someone', connector: 'in' },
    { key: 'other', label: '+ Something else' }
  ];

  var MOOD_CHIPS = [
    { key: 'peaceful', label: 'Peaceful', lighting: 'soft warm light' },
    { key: 'joyful', label: 'Joyful', lighting: 'bright airy light' },
    { key: 'dreamy', label: 'Dreamy/surreal', lighting: 'hazy ethereal light' },
    { key: 'mysterious', label: 'Mysterious', lighting: 'low-key moody light' },
    { key: 'tense', label: 'Tense/scary', lighting: 'harsh high-contrast light' },
    { key: 'epic', label: 'Epic/awe-inspiring', lighting: 'golden-hour rim light' },
    { key: 'other', label: '+ Something else' }
  ];
  var MOOD_LABEL_FOR_PROMPT = {
    peaceful: 'peaceful', joyful: 'joyful', dreamy: 'dreamy surreal',
    mysterious: 'mysterious', tense: 'tense', epic: 'epic awe-inspiring'
  };

  // ── Step 3 (Action) default-visible curation ──────────────────────────
  // Tracker item for-product-wizard-step-3-has-too-many-c-lrg1ct: founder
  // live-tested the 13 ACTION_CHIPS above + the POV toggle and called it
  // straight out -- "Too many options to choose from." His flow doctrine
  // (FOUNDER_PRINCIPLES.md): fast to value, choice overload slows down a
  // required step (this one has no skip).
  //
  // Curated to ~6 default-visible chips, the tracker item's own suggested
  // split: the archetypes it names by name -- chased (running, 81.5% in
  // the Nielsen/Zadra ranking documented above), falling (73.8%),
  // school/test (exam, 67.1%) -- plus flying, which isn't part of that
  // published ranking but IS this app's own DEFAULT_ACTION and the
  // archetype the tracker item itself names alongside the research three,
  // so it stays default-visible too. Rounded out with exactly one
  // open-ended chip ('magical' -- "Something magical", the tracker's own
  // named example of what an open-ended default chip should look like)
  // and the ever-present '+ Something else' free-entry. That's 6 chips,
  // matching "roughly 6" -- not 4 archetypes + 2 open-ended, since a
  // single strong open-ended option plus the free-text escape hatch
  // already covers "none of these archetypes fit" without a second
  // half-redundant open-ended chip crowding the row back up.
  //
  // Every OTHER chip (late/trying/newroom/child/exploring/calm/meeting)
  // remains fully selectable, just behind wizard.html's/create.html's
  // "+N more" expander -- this list only curates default VISIBILITY, it
  // changes no chip's key/label/phrase/connector and touches no part of
  // assembleCaption/buildDeterministicStory above. Order here matches
  // ACTION_CHIPS' own order (not re-ranked) so the default row renders in
  // the same relative order chips have always appeared in.
  var ACTION_DEFAULT_VISIBLE_KEYS = ['flying', 'running', 'falling', 'exam', 'magical', 'other'];

  var STYLE_CHIPS = ['Cinematic', 'Realistic', 'Cartoon', 'Anime'];

  var DEFAULT_MOOD = 'dreamy';
  var DEFAULT_STYLE = 'Cinematic';
  var DEFAULT_ACTION = 'flying';

  function chipLabel(list, key) {
    var found = list.filter(function (c) { return c.key === key; })[0];
    return found ? found.label : null;
  }

  /**
   * Inferred camera per the spec's table. Priority order: POV toggle wins
   * outright; then Flying/Falling; then an Epic mood; then Calm/Meeting;
   * else a plain medium tracking shot.
   */
  function inferCamera(actionKey, pov, moodKey) {
    if (pov) return 'first-person POV shot';
    if (actionKey === 'flying' || actionKey === 'falling') return 'aerial wide shot';
    if (moodKey === 'epic') return 'sweeping crane shot';
    if (actionKey === 'calm' || actionKey === 'meeting') return 'intimate close-up shot';
    return 'medium tracking shot';
  }

  /** Inferred lighting per the spec's table — an explicit Day/Night scenery chip overrides the mood-inferred value. */
  function inferLighting(moodKey, sceneryTime) {
    if (sceneryTime === 'Day') return 'bright daylight';
    if (sceneryTime === 'Night') return 'nighttime lighting';
    var mood = MOOD_CHIPS.filter(function (m) { return m.key === moodKey; })[0];
    return (mood && mood.lighting) || MOOD_CHIPS.filter(function (m) { return m.key === DEFAULT_MOOD; })[0].lighting;
  }

  /**
   * Builds the subject phrase + decides which (if any) character id should
   * ride along on the actual generation request — see the header comment
   * for why those two things are linked (avoiding a doubled-up character
   * description in the final prompt).
   *
   * `character` (only relevant for subjectKey 'me'/'someone'): the
   * resolved character object as DreamStore.getCharacters()/findCharacter
   * already shape it — { id, name, isSelf, description, photoDataUrl? }.
   */
  function subjectPhraseAndCharacterId(subjectKey, character, otherText) {
    if (subjectKey === 'me' || subjectKey === 'someone') {
      if (!character) return { phrase: '', characterId: null };
      if (character.photoDataUrl) {
        // No text phrase needed — generate-video.js's reference-to-video
        // path already adds "the dreamer ('me') appears as shown in the
        // reference photo" once characterIds carries this id.
        return { phrase: '', characterId: character.id };
      }
      var who = character.isSelf ? 'me' : ((character.name || '').trim() || 'a character');
      var desc = (character.description || '').trim();
      var phrase = desc ? (who === 'me' ? 'me, ' + desc : who + ', ' + desc) : who;
      return { phrase: phrase, characterId: null };
    }
    if (subjectKey === 'stranger') return { phrase: 'a stranger', characterId: null };
    if (subjectKey === 'animal') return { phrase: 'an animal or creature', characterId: null };
    if (subjectKey === 'none') return { phrase: '', characterId: null };
    if (subjectKey === 'other') return { phrase: (otherText || '').trim(), characterId: null };
    return { phrase: '', characterId: null };
  }

  /**
   * Assembles the final prompt/caption string per WIZARD_SPEC.md's
   * template: "[camera] of [subject], [action], in [place + time], [mood]
   * mood, [lighting], [style] style, dreamlike. [+ optional free text]".
   *
   * @param {object} input
   *   subjectKey: 'me'|'someone'|'stranger'|'animal'|'none'|'other'
   *   character: resolved character object (see above), only for me/someone
   *   subjectOtherText: string, only for subjectKey==='other'
   *   placeKey: one of SETTING_PLACE_CHIPS[].key, or null
   *   placeOtherText: string, only for placeKey==='other'
   *   sceneryTime: 'Day'|'Night'|null
   *   actionKey: one of ACTION_CHIPS[].key (required, defaults applied by caller)
   *   actionOtherText: string, only for actionKey==='other'
   *   pov: boolean
   *   moodKey: one of MOOD_CHIPS[].key
   *   moodOtherText: string, only for moodKey==='other'
   *   style: one of STYLE_CHIPS, or explicitly `null` to omit the style
   *     clause entirely (see below) — omitting the property altogether
   *     (undefined) still defaults to DEFAULT_STYLE, same as before.
   *   freeText: optional trailing free-text addendum (the demoted Step 6 box)
   * @returns {{ caption: string, characterIdsForGeneration: string[] }}
   */
  function assembleCaption(input) {
    input = input || {};
    var actionKey = input.actionKey || DEFAULT_ACTION;
    var moodKey = input.moodKey || DEFAULT_MOOD;
    // `style: null` EXPLICITLY (not just omitted/undefined) means "the
    // real style choice hasn't happened yet" — used by create.html's
    // "Build it" retrofit, whose Subject/Setting/Action/Mood steps hand
    // off to style.html (reused as-is per the spec) for the actual style
    // pick, same as "Write it" already does. Omitting the property
    // entirely still defaults to DEFAULT_STYLE (wizard.html always
    // supplies a real chosen style itself, so this never applies there).
    var styleOmitted = input.style === null;
    var style = styleOmitted ? null : (input.style || DEFAULT_STYLE);

    var camera = inferCamera(actionKey, !!input.pov, moodKey);
    var lighting = inferLighting(moodKey, input.sceneryTime || null);

    var subjectResult = subjectPhraseAndCharacterId(input.subjectKey, input.character, input.subjectOtherText);

    var actionChip = ACTION_CHIPS.filter(function (a) { return a.key === actionKey; })[0];
    var defaultActionChip = ACTION_CHIPS.filter(function (a) { return a.key === DEFAULT_ACTION; })[0];
    var actionPhrase = actionKey === 'other'
      ? (input.actionOtherText || '').trim()
      : (actionChip ? actionChip.phrase : defaultActionChip.phrase);
    // The connecting preposition ('in'/'through') a chip's phrase needs
    // before a place phrase -- only ever used below when there IS a place
    // phrase to connect to. A free-typed "+ Something else" action has no
    // connector of its own (matches its pre-existing behavior).
    var actionConnector = actionKey === 'other'
      ? ''
      : ((actionChip ? actionChip.connector : defaultActionChip.connector) || '');

    var placeChip = SETTING_PLACE_CHIPS.filter(function (p) { return p.key === input.placeKey; })[0];
    var placePhrase = input.placeKey === 'other'
      ? (input.placeOtherText || '').trim()
      : (placeChip ? placeChip.phrase : '');

    var moodForPrompt = moodKey === 'other'
      ? (input.moodOtherText || '').trim()
      : (MOOD_LABEL_FOR_PROMPT[moodKey] || MOOD_LABEL_FOR_PROMPT[DEFAULT_MOOD]);

    // Only append the connector + place phrase when there actually IS a
    // place phrase (the Setting/place step is skippable) -- otherwise the
    // action clause ends cleanly on its own, no dangling preposition.
    var actionAndPlace = actionPhrase;
    if (placePhrase) {
      actionAndPlace += (actionConnector ? ' ' + actionConnector : '') + ' ' + placePhrase;
    }

    var parts = [];
    parts.push(camera + ' of ' + (subjectResult.phrase || 'the dream') + ',');
    parts.push(actionAndPlace + ',');
    if (moodForPrompt) parts.push(moodForPrompt + ' mood,');
    parts.push(lighting + ',');
    // A real style choice hasn't happened yet (styleOmitted) -- omit the
    // clause entirely rather than baking in a default that a later,
    // real style pick (style.html) would then contradict/duplicate. See
    // generate-video.js's own STYLE_MODIFIERS, which unconditionally
    // appends the REAL chosen style for every create.html path once
    // style.html's Generate button runs.
    parts.push(styleOmitted ? 'dreamlike.' : (style + ' style, dreamlike.'));

    var caption = parts.join(' ').replace(/\s+/g, ' ').replace(/,\s*,/g, ',').trim();
    if (input.freeText && input.freeText.trim()) {
      caption += ' ' + input.freeText.trim();
    }

    return {
      caption: caption,
      characterIdsForGeneration: subjectResult.characterId ? [subjectResult.characterId] : []
    };
  }

  // ── Deterministic (non-LLM) first-person story fallback ──────────────
  // tracker item for-product-split-prompttext-storytext-f-yt5kc7: the
  // chip flow's assembled caption above is written to read as camera-
  // direction/style-modifier prompt engineering (see this file's own
  // header), never fit to show a real person as "their dream" — that's
  // promptText, generation-only from here on. This builds the OTHER half,
  // storyText, for the "chips selected, no free text typed" path: a
  // short, natural, first-person sentence, no camera/lighting/style
  // language at all. Used two ways: (1) the IMMEDIATE, zero-cost, always-
  // available value shown the instant the user reaches the preview step
  // (style.html / wizard.html's Contact step), while an LLM rewrite
  // (netlify/functions/rewrite-dream-story.js) is opportunistically fired
  // in the background to try to upgrade it to something more natural
  // before Generate is tapped; (2) the fallback if that call fails or
  // never resolves in time — this function alone must always produce a
  // presentable sentence, since generation must never be blocked or
  // slowed waiting on the LLM path.
  //
  // Deliberately SEPARATE word tables from ACTION_CHIPS/SETTING_PLACE_CHIPS
  // above, rather than reusing their `.phrase` values — those are written
  // to concatenate with camera/lighting language (e.g. the 'calm' action's
  // "sitting in a calm, still moment in" + the 'house' place's "inside a
  // house" doubles up "in ... in" — harmless filler for a Veo prompt,
  // wrong for a sentence a real person reads back as their own dream).
  // These tables are written to read naturally as a plain sentence on
  // their own instead.
  var STORY_ACTION_PHRASES = {
    flying: 'flying', running: 'running, chasing and being chased', falling: 'falling',
    exam: 'taking an exam I never studied for, back in school',
    late: 'rushing to get somewhere, but arriving too late',
    trying: 'trying to do the same thing again and again without success',
    newroom: 'discovering a hidden room that was never there before',
    child: 'a child again',
    exploring: 'exploring somewhere new', calm: 'sitting in a calm, still moment',
    magical: 'watching something magical happen', meeting: 'meeting someone new'
  };
  var STORY_PLACE_PHRASES = {
    urban: 'in a city', nature: 'in a natural outdoor landscape', house: 'inside a house',
    water: 'in and around water', sky: 'in an open sky', unreal: 'somewhere surreal and otherworldly'
  };
  var STORY_MOOD_WORDS = {
    peaceful: 'peaceful', joyful: 'joyful', dreamy: 'dreamy and surreal',
    mysterious: 'mysterious', tense: 'tense', epic: 'awestruck'
  };

  /**
   * Builds a short, natural, first-person dream sentence directly from the
   * SAME chip-selection fields assembleCaption takes (a subset — camera/
   * POV/character-description/style are meaningless here, a human "what
   * happened in the dream" sentence has no camera or rendering style).
   * Pure and synchronous — no network call, never fails.
   */
  function buildDeterministicStory(input) {
    input = input || {};
    var actionKey = input.actionKey || DEFAULT_ACTION;
    var moodKey = input.moodKey || DEFAULT_MOOD;

    // 'me'/'none' (and an empty 'other') carry no separate descriptor —
    // "I" alone is the whole subject, same as assembleCaption's own
    // subjectPhraseAndCharacterId treating those as the plain/no-op case.
    var subjectDescriptor = null;
    if (input.subjectKey === 'someone') {
      var name = (input.character && (input.character.name || '').trim()) || 'someone I know';
      subjectDescriptor = 'with ' + name;
    } else if (input.subjectKey === 'stranger') {
      subjectDescriptor = 'a stranger';
    } else if (input.subjectKey === 'animal') {
      subjectDescriptor = 'an animal or creature';
    } else if (input.subjectKey === 'other' && input.subjectOtherText && input.subjectOtherText.trim()) {
      subjectDescriptor = input.subjectOtherText.trim();
    }

    var actionPhrase = actionKey === 'other'
      ? ((input.actionOtherText || '').trim() || 'in the middle of something happening')
      : (STORY_ACTION_PHRASES[actionKey] || STORY_ACTION_PHRASES[DEFAULT_ACTION]);

    // Review finding: every STORY_PLACE_PHRASES table entry already
    // carries its own preposition ("in a city", "inside a house", ...) so
    // `actionPhrase + ' ' + placePhrase` reads naturally -- but a custom
    // "+ Something else" place has none of its own, producing a broken
    // "exploring a floating library" (missing "in"). Prepend a generic
    // preposition here, same role the table entries' own leading word
    // already plays.
    var placePhrase = input.placeKey === 'other'
      ? ((input.placeOtherText || '').trim() ? 'in ' + input.placeOtherText.trim() : '')
      : (STORY_PLACE_PHRASES[input.placeKey] || '');

    var timeClause = input.sceneryTime === 'Day' ? ' during the day' : (input.sceneryTime === 'Night' ? ' at night' : '');

    var moodWord = moodKey === 'other'
      ? (input.moodOtherText || '').trim()
      : (STORY_MOOD_WORDS[moodKey] || STORY_MOOD_WORDS[DEFAULT_MOOD]);

    var sentence = 'I was ' +
      (subjectDescriptor ? subjectDescriptor + ', ' : '') +
      actionPhrase +
      (placePhrase ? ' ' + placePhrase : '') +
      timeClause +
      (moodWord ? ', feeling ' + moodWord : '') +
      '.';

    return sentence.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();
  }

  var WizardChips = {
    SUBJECT_CHIPS: SUBJECT_CHIPS,
    SETTING_PLACE_CHIPS: SETTING_PLACE_CHIPS,
    ACTION_CHIPS: ACTION_CHIPS,
    ACTION_DEFAULT_VISIBLE_KEYS: ACTION_DEFAULT_VISIBLE_KEYS,
    MOOD_CHIPS: MOOD_CHIPS,
    STYLE_CHIPS: STYLE_CHIPS,
    DEFAULT_MOOD: DEFAULT_MOOD,
    DEFAULT_STYLE: DEFAULT_STYLE,
    DEFAULT_ACTION: DEFAULT_ACTION,
    chipLabel: chipLabel,
    inferCamera: inferCamera,
    inferLighting: inferLighting,
    assembleCaption: assembleCaption,
    buildDeterministicStory: buildDeterministicStory
  };

  // Browser: attach to window, same as every other js/*.js file in this
  // codebase. Node/test environment (no `window` global): export via
  // module.exports instead, so test/wizard-chips.test.js can require()
  // this file directly — the simplest way to unit test this pure logic
  // without standing up a browser for it.
  if (typeof window !== 'undefined') window.WizardChips = WizardChips;
  if (typeof module !== 'undefined' && module.exports) module.exports = WizardChips;
})();
