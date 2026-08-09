// test/content-classifier.test.js
//
// Unit coverage for netlify/functions/lib/content-classifier.js — the
// content-tier safety gate's classifier + decision layer. Covers:
//   - detectNamedOtherPersonPhoto (the anti-NCII structural trigger)
//   - buildClassifiableText (caption + character descriptions, no bypass)
//   - classifyText parsing (clean JSON, fenced JSON, bare word, unparseable,
//     HTTP error, timeout/abort) — all against a STUBBED fetch, never a real
//     paid classifier call
//   - evaluateGenerationGate: the tiered thresholds AND both fail-safe
//     directions (normal fails OPEN, named-other-person-photo fails CLOSED)
//   - evaluateExplicitRecheck: explicit-only, fails OPEN
//   - the mock/test hooks (CONTENT_CLASSIFIER_MOCK_TIER / GENERATION_MOCK_MODE)

var test = require('node:test');
var assert = require('node:assert/strict');

var cc = require('../netlify/functions/lib/content-classifier');

var realFetch = global.fetch;

/** Stubs fetch to return a chat-completion whose content is `content` (already a string). */
function stubClassifierContent(content) {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: content } }] }; } };
  };
}

test.beforeEach(function () {
  global.fetch = realFetch;
  delete process.env.CONTENT_CLASSIFIER_MOCK_TIER;
  delete process.env.GENERATION_MOCK_MODE;
});

test.after(function () { global.fetch = realFetch; });

// ---- detectNamedOtherPersonPhoto ----

test('detectNamedOtherPersonPhoto: a named non-self character WITH a photo -> true', function () {
  assert.equal(cc.detectNamedOtherPersonPhoto([{ name: 'Alex', isSelf: false, photoDataUrl: 'data:image/png;base64,AAA' }]), true);
});

test('detectNamedOtherPersonPhoto: the self ("Me") character with a photo -> false (self is allowed)', function () {
  assert.equal(cc.detectNamedOtherPersonPhoto([{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAA' }]), false);
});

test('detectNamedOtherPersonPhoto: a named non-self character with NO photo -> false', function () {
  assert.equal(cc.detectNamedOtherPersonPhoto([{ name: 'Alex', isSelf: false, description: 'a tall man' }]), false);
});

test('detectNamedOtherPersonPhoto: a photographed non-self character with NO name -> false', function () {
  assert.equal(cc.detectNamedOtherPersonPhoto([{ name: '   ', isSelf: false, photoDataUrl: 'data:image/png;base64,AAA' }]), false);
});

test('detectNamedOtherPersonPhoto: forward-compatible photoUrl field is also honored', function () {
  assert.equal(cc.detectNamedOtherPersonPhoto([{ name: 'Sam', isSelf: false, photoUrl: 'https://x/y.jpg' }]), true);
});

test('detectNamedOtherPersonPhoto: empty / non-array -> false', function () {
  assert.equal(cc.detectNamedOtherPersonPhoto([]), false);
  assert.equal(cc.detectNamedOtherPersonPhoto(null), false);
  assert.equal(cc.detectNamedOtherPersonPhoto(undefined), false);
});

test('detectNamedOtherPersonPhoto: mix — one clean self + one named-other-with-photo -> true', function () {
  assert.equal(cc.detectNamedOtherPersonPhoto([
    { name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAA' },
    { name: 'Jordan', isSelf: false, photoDataUrl: 'data:image/png;base64,BBB' }
  ]), true);
});

// ---- buildClassifiableText ----

test('buildClassifiableText: folds caption + character descriptions (so explicit text cannot hide in a description)', function () {
  var text = cc.buildClassifiableText('a walk in the park', [
    { name: 'Alex', isSelf: false, description: 'wearing a red coat' },
    { name: 'Me', isSelf: true }
  ]);
  assert.match(text, /a walk in the park/);
  assert.match(text, /wearing a red coat/);
});

test('buildClassifiableText: caption only when no character descriptions', function () {
  assert.equal(cc.buildClassifiableText('just the caption', []), 'just the caption');
});

// ---- classifyText parsing (stubbed fetch) ----

test('classifyText: clean JSON {"tier":"explicit"} -> explicit', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'explicit' }));
  var r = await cc.classifyText('some text', 'k');
  assert.deepEqual(r, { ok: true, tier: 'explicit' });
});

test('classifyText: ```json fenced ``` response is tolerated', async function () {
  stubClassifierContent('```json\n{"tier":"romantic"}\n```');
  var r = await cc.classifyText('some text', 'k');
  assert.deepEqual(r, { ok: true, tier: 'romantic' });
});

test('classifyText: a bare one-word answer is tolerated', async function () {
  stubClassifierContent('clean');
  var r = await cc.classifyText('some text', 'k');
  assert.deepEqual(r, { ok: true, tier: 'clean' });
});

test('classifyText: an unrecognized tier -> ok:false (unparseable)', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'spicy' }));
  var r = await cc.classifyText('some text', 'k');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'classifier_unparseable');
});

test('classifyText: an HTTP error -> ok:false with the status', async function () {
  global.fetch = async function () { return { ok: false, status: 429, json: async function () { return {}; } }; };
  var r = await cc.classifyText('some text', 'k');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'classifier_http_429');
});

test('classifyText: a network/abort error -> ok:false', async function () {
  global.fetch = async function () { var e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  var r = await cc.classifyText('some text', 'k');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'classifier_timeout');
});

test('classifyText: empty text short-circuits to clean with NO fetch', async function () {
  var called = 0;
  global.fetch = async function () { called++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  var r = await cc.classifyText('   ', 'k');
  assert.deepEqual(r, { ok: true, tier: 'clean' });
  assert.equal(called, 0);
});

test('classifyText: missing key -> ok:false classifier_no_key (no fetch)', async function () {
  var called = 0;
  global.fetch = async function () { called++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  var r = await cc.classifyText('some text', null);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'classifier_no_key');
  assert.equal(called, 0);
});

test('classifyText: CONTENT_CLASSIFIER_MOCK_TIER forces a tier with NO fetch', async function () {
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'explicit';
  var called = 0;
  global.fetch = async function () { called++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  var r = await cc.classifyText('some text', 'k');
  assert.deepEqual(r, { ok: true, tier: 'explicit' });
  assert.equal(called, 0);
});

test('classifyText: GENERATION_MOCK_MODE -> clean with NO fetch', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var called = 0;
  global.fetch = async function () { called++; return { ok: true, status: 200, json: async function () { return {}; } }; };
  var r = await cc.classifyText('some text', 'k');
  assert.deepEqual(r, { ok: true, tier: 'clean' });
  assert.equal(called, 0);
});

// ---- evaluateGenerationGate: normal thresholds ----

test('gate normal: explicit -> BLOCKED with the explicit message', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'explicit' }));
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: false, falKey: 'k' });
  assert.equal(g.allowed, false);
  assert.equal(g.message, cc.EXPLICIT_BLOCK_MESSAGE);
});

test('gate normal: romantic -> ALLOWED (mainstream romantic is NOT over-blocked)', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'romantic' }));
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: false, falKey: 'k' });
  assert.equal(g.allowed, true);
  assert.equal(g.tier, 'romantic');
});

test('gate normal: clean -> ALLOWED', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'clean' }));
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: false, falKey: 'k' });
  assert.equal(g.allowed, true);
});

// ---- evaluateGenerationGate: named-other-person threshold (anti-NCII) ----

test('gate named-photo: romantic -> BLOCKED with the named-person message', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'romantic' }));
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: true, falKey: 'k' });
  assert.equal(g.allowed, false);
  assert.equal(g.message, cc.NAMED_PERSON_BLOCK_MESSAGE);
});

test('gate named-photo: explicit -> BLOCKED with the named-person message', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'explicit' }));
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: true, falKey: 'k' });
  assert.equal(g.allowed, false);
  assert.equal(g.message, cc.NAMED_PERSON_BLOCK_MESSAGE);
});

test('gate named-photo: clean -> ALLOWED (a named real person in a non-intimate dream is fine)', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'clean' }));
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: true, falKey: 'k' });
  assert.equal(g.allowed, true);
});

// ---- evaluateGenerationGate: FAIL-SAFE directions ----

test('gate FAIL-OPEN: classifier error on a NORMAL request -> ALLOWED (product stays up)', async function () {
  global.fetch = async function () { return { ok: false, status: 500, json: async function () { return {}; } }; };
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: false, falKey: 'k' });
  assert.equal(g.allowed, true);
  assert.equal(g.reason, 'fail_open');
});

test('gate FAIL-CLOSED: classifier error on a NAMED-PHOTO request -> BLOCKED (NCII must never slip through)', async function () {
  global.fetch = async function () { return { ok: false, status: 500, json: async function () { return {}; } }; };
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: true, falKey: 'k' });
  assert.equal(g.allowed, false);
  assert.equal(g.failClosed, true);
  assert.equal(g.message, cc.NAMED_PERSON_BLOCK_MESSAGE);
});

test('gate FAIL-CLOSED: missing key on a NAMED-PHOTO request -> BLOCKED', async function () {
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: true, falKey: null });
  assert.equal(g.allowed, false);
  assert.equal(g.message, cc.NAMED_PERSON_BLOCK_MESSAGE);
});

test('gate FAIL-OPEN: missing key on a NORMAL request -> ALLOWED', async function () {
  var g = await cc.evaluateGenerationGate({ text: 't', hasNamedOtherPersonPhoto: false, falKey: null });
  assert.equal(g.allowed, true);
});

// ---- evaluateExplicitRecheck (output side) ----

test('recheck: explicit -> BLOCKED with the explicit message', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'explicit' }));
  var r = await cc.evaluateExplicitRecheck({ text: 't', falKey: 'k' });
  assert.equal(r.allowed, false);
  assert.equal(r.message, cc.EXPLICIT_BLOCK_MESSAGE);
});

test('recheck: romantic -> ALLOWED (output side is explicit-only; romantic may reach the public feed)', async function () {
  stubClassifierContent(JSON.stringify({ tier: 'romantic' }));
  var r = await cc.evaluateExplicitRecheck({ text: 't', falKey: 'k' });
  assert.equal(r.allowed, true);
});

test('recheck: FAILS OPEN on a classifier error (a classifier outage must not block every publish)', async function () {
  global.fetch = async function () { throw new Error('down'); };
  var r = await cc.evaluateExplicitRecheck({ text: 't', falKey: 'k' });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'fail_open');
});

// ---- Deterministic explicit-keyword backstop (founder repro 2026-08-08) ----
// The founder wrote "I was having sex" and it was NOT blocked (the LLM leaned
// romantic / could fail open). matchesExplicitKeyword is the code-side backstop
// that catches unambiguous explicit phrasing before the LLM and independent of
// it. The matrix below is the founder's own tuning target: true explicit is
// caught, suggestive-but-clothed is NOT keyword-blocked (it goes to the LLM,
// which the retuned rubric allows as romantic).

test('matchesExplicitKeyword: clearly-explicit phrases -> true (must be caught)', function () {
  ['I was having sex', 'we had sex', 'they have sex', 'she was naked', 'he was nude',
   'oral sex', 'anal sex', 'she was masturbating', 'exposed genitals', 'his penis',
   'her vagina', 'a topless woman', 'watching porn', 'we fucked all night'
  ].forEach(function (phrase) {
    assert.equal(cc.matchesExplicitKeyword(phrase), true, 'must catch: ' + phrase);
  });
});

test('matchesExplicitKeyword: suggestive-but-clothed / romantic -> false (NOT keyword-blocked)', function () {
  ['a woman wearing stylish lingerie with an attractive figure', 'a sexy dance in a bikini',
   'she had a sexy figure', 'a low-cut dress showing cleavage', 'dancing suggestively',
   'kissing passionately', 'a couple hugging', 'they were flirting', 'in her underwear',
   'a fucking amazing dream about flying'  // profanity used non-sexually must NOT match
  ].forEach(function (phrase) {
    assert.equal(cc.matchesExplicitKeyword(phrase), false, 'must NOT keyword-block: ' + phrase);
  });
});

test('gate: an unambiguous explicit KEYWORD blocks even when the classifier would FAIL OPEN', async function () {
  // Classifier endpoint errors (would normally fail open on the normal path) —
  // the keyword backstop must still block, WITHOUT any classifier call needed.
  var called = 0;
  global.fetch = async function () { called++; return { ok: false, status: 500, json: async function () { return {}; } }; };
  var g = await cc.evaluateGenerationGate({ text: 'I was having sex', hasNamedOtherPersonPhoto: false, falKey: 'k' });
  assert.equal(g.allowed, false);
  assert.equal(g.tier, 'explicit');
  assert.equal(g.reason, 'explicit_keyword');
  assert.equal(g.message, cc.EXPLICIT_BLOCK_MESSAGE);
  assert.equal(called, 0, 'the keyword backstop short-circuits before any classifier call');
});

test('gate: explicit keyword on a NAMED-PHOTO request -> blocked with the named-person message', async function () {
  var g = await cc.evaluateGenerationGate({ text: 'we had sex', hasNamedOtherPersonPhoto: true, falKey: 'k' });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'named_person_explicit_keyword');
  assert.equal(g.message, cc.NAMED_PERSON_BLOCK_MESSAGE);
});

test('gate: suggestive-but-clothed is NOT keyword-blocked -> the classifier tier decides (romantic -> ALLOWED)', async function () {
  // No keyword match, so the (stubbed) classifier's romantic verdict stands —
  // the founder\'s over-block case ("lingerie, attractive figure") passes.
  stubClassifierContent(JSON.stringify({ tier: 'romantic' }));
  var g = await cc.evaluateGenerationGate({ text: 'a woman wearing stylish lingerie with an attractive figure', hasNamedOtherPersonPhoto: false, falKey: 'k' });
  assert.equal(g.allowed, true);
  assert.equal(g.tier, 'romantic');
});

test('recheck: an explicit KEYWORD blocks on the output side even if the classifier fails open', async function () {
  global.fetch = async function () { throw new Error('down'); };
  var r = await cc.evaluateExplicitRecheck({ text: 'we had sex on the beach', falKey: 'k' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'explicit_keyword');
  assert.equal(r.message, cc.EXPLICIT_BLOCK_MESSAGE);
});

// ---- RUBRIC content assertions (the model's few-shot tuning) ----
// Can't call the real LLM in tests, but we CAN assert the rubric string draws
// the founder's line, so a future edit that deletes the suggestive-allow
// guidance or the explicit examples fails loudly here.

test('RUBRIC: draws the Instagram-allowable line (suggestive-but-clothed allowed, nudity/acts blocked)', function () {
  assert.match(cc.RUBRIC, /lingerie/i);
  assert.match(cc.RUBRIC, /bikini/i);
  assert.match(cc.RUBRIC, /having sex/i);
  assert.match(cc.RUBRIC, /naked/i);
  assert.match(cc.RUBRIC, /clothed/i);
});
