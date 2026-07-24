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
// needs the actual photo attached via characterIds — but it already skips
// appending a text description for any character that has a photo (see
// its buildPrompt: `.filter(c => !c.photoDataUrl)`), so there is no
// double-up risk there; the caller SHOULD include that character's id.
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

  var ACTION_CHIPS = [
    { key: 'flying', label: 'Flying/floating', phrase: 'flying through' },
    { key: 'running', label: 'Running/chasing/chased', phrase: 'running, chasing and being chased through' },
    { key: 'falling', label: 'Falling', phrase: 'falling through' },
    { key: 'exploring', label: 'Exploring somewhere new', phrase: 'exploring' },
    { key: 'calm', label: 'A calm still moment', phrase: 'sitting in a calm, still moment in' },
    { key: 'magical', label: 'Something magical happens', phrase: 'witnessing something magical happen in' },
    { key: 'meeting', label: 'Meeting someone', phrase: 'meeting someone in' },
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
   *   style: one of STYLE_CHIPS
   *   freeText: optional trailing free-text addendum (the demoted Step 6 box)
   * @returns {{ caption: string, characterIdsForGeneration: string[] }}
   */
  function assembleCaption(input) {
    input = input || {};
    var actionKey = input.actionKey || DEFAULT_ACTION;
    var moodKey = input.moodKey || DEFAULT_MOOD;
    var style = input.style || DEFAULT_STYLE;

    var camera = inferCamera(actionKey, !!input.pov, moodKey);
    var lighting = inferLighting(moodKey, input.sceneryTime || null);

    var subjectResult = subjectPhraseAndCharacterId(input.subjectKey, input.character, input.subjectOtherText);

    var actionChip = ACTION_CHIPS.filter(function (a) { return a.key === actionKey; })[0];
    var actionPhrase = actionKey === 'other'
      ? (input.actionOtherText || '').trim()
      : (actionChip ? actionChip.phrase : ACTION_CHIPS.filter(function (a) { return a.key === DEFAULT_ACTION; })[0].phrase);

    var placeChip = SETTING_PLACE_CHIPS.filter(function (p) { return p.key === input.placeKey; })[0];
    var placePhrase = input.placeKey === 'other'
      ? (input.placeOtherText || '').trim()
      : (placeChip ? placeChip.phrase : '');

    var moodForPrompt = moodKey === 'other'
      ? (input.moodOtherText || '').trim()
      : (MOOD_LABEL_FOR_PROMPT[moodKey] || MOOD_LABEL_FOR_PROMPT[DEFAULT_MOOD]);

    var parts = [];
    parts.push(camera + ' of ' + (subjectResult.phrase || 'the dream') + ',');
    parts.push(actionPhrase + (placePhrase ? ' ' + placePhrase : '') + ',');
    if (moodForPrompt) parts.push(moodForPrompt + ' mood,');
    parts.push(lighting + ',');
    parts.push(style + ' style, dreamlike.');

    var caption = parts.join(' ').replace(/\s+/g, ' ').replace(/,\s*,/g, ',').trim();
    if (input.freeText && input.freeText.trim()) {
      caption += ' ' + input.freeText.trim();
    }

    return {
      caption: caption,
      characterIdsForGeneration: subjectResult.characterId ? [subjectResult.characterId] : []
    };
  }

  var WizardChips = {
    SUBJECT_CHIPS: SUBJECT_CHIPS,
    SETTING_PLACE_CHIPS: SETTING_PLACE_CHIPS,
    ACTION_CHIPS: ACTION_CHIPS,
    MOOD_CHIPS: MOOD_CHIPS,
    STYLE_CHIPS: STYLE_CHIPS,
    DEFAULT_MOOD: DEFAULT_MOOD,
    DEFAULT_STYLE: DEFAULT_STYLE,
    DEFAULT_ACTION: DEFAULT_ACTION,
    chipLabel: chipLabel,
    inferCamera: inferCamera,
    inferLighting: inferLighting,
    assembleCaption: assembleCaption
  };

  // Browser: attach to window, same as every other js/*.js file in this
  // codebase. Node/test environment (no `window` global): export via
  // module.exports instead, so test/wizard-chips.test.js can require()
  // this file directly — the simplest way to unit test this pure logic
  // without standing up a browser for it.
  if (typeof window !== 'undefined') window.WizardChips = WizardChips;
  if (typeof module !== 'undefined' && module.exports) module.exports = WizardChips;
})();
