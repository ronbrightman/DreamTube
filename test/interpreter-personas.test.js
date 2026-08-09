// test/interpreter-personas.test.js
//
// Unit tests for js/interpreter-personas.js's pure persona data — the
// single source of truth shared by both the client (js/interpret-
// experience.js) and the server (netlify/functions/interpret-dream.js
// requires this same file) for Interpretation Wave 1
// (docs/INTERPRETATION_WAVE1_SPEC.md, tracker item
// for-product-build-interpretation-wave-1--xuftyn). Same
// require()-the-file-directly, node --test style as
// test/wizard-chips.test.js's own persona-agnostic data checks.

var test = require('node:test');
var assert = require('node:assert/strict');

var InterpreterPersonas = require('../js/interpreter-personas');

var EXPECTED_KEYS = ['jung', 'freud', 'gestalt', 'scientist', 'talmudic'];

test('exactly the five spec-named personas, in the spec\'s own table order', function () {
  assert.deepEqual(InterpreterPersonas.ALL.map(function (p) { return p.key; }), EXPECTED_KEYS);
});

test('get() resolves every real key and returns null for anything else', function () {
  EXPECTED_KEYS.forEach(function (key) {
    var p = InterpreterPersonas.get(key);
    assert.ok(p, 'expected a persona for key ' + key);
    assert.equal(p.key, key);
  });
  assert.equal(InterpreterPersonas.get('not-a-real-persona'), null);
  assert.equal(InterpreterPersonas.get(undefined), null);
  assert.equal(InterpreterPersonas.get(''), null);
  assert.equal(InterpreterPersonas.get(null), null);
});

// Full schema per spec §5: key/name/inspiredBy/tagline/asksAbout/accent/
// portrait/loadingQuestions/loadingReading/voice/method/questionFocus/
// maxQuestions.
var STRING_FIELDS = ['key', 'name', 'inspiredBy', 'tagline', 'asksAbout', 'accent', 'portrait', 'loadingQuestions', 'loadingReading', 'voice', 'method', 'questionFocus'];

test('every persona carries every spec §5 field, all non-empty', function () {
  InterpreterPersonas.ALL.forEach(function (p) {
    STRING_FIELDS.forEach(function (field) {
      assert.equal(typeof p[field], 'string', p.key + '.' + field + ' must be a string');
      assert.ok(p[field].trim().length > 0, p.key + '.' + field + ' must not be empty');
    });
    assert.equal(typeof p.maxQuestions, 'number');
    assert.ok(p.maxQuestions >= 1 && p.maxQuestions <= 3, p.key + '.maxQuestions must be 1-3, got ' + p.maxQuestions);
  });
});

test('every persona\'s accent is a distinct, valid #hex color', function () {
  var seen = {};
  InterpreterPersonas.ALL.forEach(function (p) {
    assert.match(p.accent, /^#[0-9a-fA-F]{6}$/, p.key + '.accent must be a 6-digit hex color, got ' + p.accent);
    assert.ok(!seen[p.accent], 'accent ' + p.accent + ' is reused by more than one persona (' + p.key + ')');
    seen[p.accent] = true;
  });
});

test('every persona\'s portrait path follows the documented assets/interpreters/<key>.webp convention', function () {
  InterpreterPersonas.ALL.forEach(function (p) {
    assert.equal(p.portrait, 'assets/interpreters/' + p.key + '.webp');
  });
});

test('every persona\'s inspiredBy attribution names the real tradition/figure, never claiming to BE them', function () {
  InterpreterPersonas.ALL.forEach(function (p) {
    assert.match(p.inspiredBy.toLowerCase(), /inspired by|grounded in/, p.key + '.inspiredBy must use "inspired by"/"grounded in" attribution language, not a bare claim of identity');
  });
});

// Safety/crisis framing lives in interpret-dream.js's shared SAFETY_BLOCK,
// appended to every prompt (spec §4) — but two personas carry an EXTRA
// persona-specific safety line in their own data (Talmudic: never issue
// religious rulings; Scientist: never fabricate citations). Guards against
// silently losing these on a future data-file edit.
test('the Talmudic persona\'s own voice text bans issuing religious rulings (spec §4, persona-specific safety line)', function () {
  var p = InterpreterPersonas.get('talmudic');
  assert.match(p.voice.toLowerCase(), /religious ruling/);
});

test('the Scientist persona\'s own method text bans fabricating citations (spec §4, persona-specific safety line)', function () {
  var p = InterpreterPersonas.get('scientist');
  assert.match(p.method.toLowerCase(), /fabricated/);
});

// Never anything health/therapy-flavored in the CLIENT-FACING display
// fields (name/tagline/asksAbout) — same standing ad-pixel-domain firewall
// this app enforces on every other user-facing surface (see
// test/interp-analytics-behavioral.test.js's own equivalent assertion).
test('client-facing display copy (name/tagline/asksAbout) is never health/therapy-flavored', function () {
  InterpreterPersonas.ALL.forEach(function (p) {
    [p.name, p.tagline, p.asksAbout].forEach(function (copy) {
      assert.doesNotMatch(copy, /therap|diagnos|mental.?health|treatment/i, p.key + '\'s copy "' + copy + '" must never be health/therapy-flavored');
    });
  });
});

// Guards against a future data-file edit silently reviving the retired
// split intro shape (tracker item
// auto-cleanup-retire-the-now-unused-split-dwea7w) — js/interpret-
// experience.js's shouldShowIntro/voiceStageHtml no longer know that shape
// exists, so a stray introClipUrl/introVoiceUrl on a persona would be
// silently ignored rather than loudly broken; this test is the loud check.
test('every voice-eligible persona uses the current one-file talking-head intro shape, never the retired introClipUrl/introVoiceUrl split shape', function () {
  InterpreterPersonas.ALL.forEach(function (p) {
    if (!p.voiceId) return;
    assert.equal(typeof p.introTalkingHeadUrl, 'string', p.key + ' must carry introTalkingHeadUrl');
    assert.ok(p.introTalkingHeadUrl.trim().length > 0, p.key + '.introTalkingHeadUrl must not be empty');
    assert.equal(p.introClipUrl, undefined, p.key + ' must not carry the retired split-shape introClipUrl field');
    assert.equal(p.introVoiceUrl, undefined, p.key + ' must not carry the retired split-shape introVoiceUrl field');
  });
});

test('is browser-attachable and Node-require()-able at once (UMD-lite dual export, matching js/wizard-chips.js/js/analytics-config.js\'s convention)', function () {
  var src = require('node:fs').readFileSync(require.resolve('../js/interpreter-personas'), 'utf8');
  assert.match(src, /if\s*\(\s*typeof window !== 'undefined'\s*\)\s*window\.InterpreterPersonas/);
  assert.match(src, /if\s*\(\s*typeof module !== 'undefined' && module\.exports\s*\)\s*module\.exports/);
});
