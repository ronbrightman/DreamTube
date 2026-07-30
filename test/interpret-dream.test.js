// test/interpret-dream.test.js
//
// Covers netlify/functions/interpret-dream.js — Interpretation Wave 1
// (docs/INTERPRETATION_WAVE1_SPEC.md, tracker item
// for-product-build-interpretation-wave-1--xuftyn) extended this function
// with `mode:"questions"`/`mode:"reading"`, persona-keyed prompts, and two
// new error codes (E408/E409), REPLACING the old single blended
// `{caption}` -> `{interpretation}` legacy shape entirely (deleted per the
// spec's own §6 instruction, once result.html/js/store.js migrated in
// this same branch — no dead code left behind, see this codebase's
// standing rule in CLAUDE.md). Every E401-E407 code that predates this
// wave is still covered; E408/E409 and both new modes' own validation/
// parsing logic are new.
//
// fal.ai/OpenRouter is stubbed via a fake global.fetch (same approach the
// original version of this file, and generate-video-gate.test.js, use)
// — these tests exercise this function's own logic (validation, rate
// limiting, prompt building, response-shape handling), not a live call to
// fal.ai. Blobs (used transitively via lib/rate-limit.js) is mocked the
// same way.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/interpret-dream').handler;
var InterpreterPersonas = require('../js/interpreter-personas');

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.3.0.' + ipCounter;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function stubFetchOnce(response) {
  global.fetch = async function () { return response; };
}

/** A plausible, well-over-MIN_VALID_LENGTH reading, standing in for a real model completion. */
var SAMPLE_READING = 'Dreams about flying often echo a wish for freedom or a release from something weighing on you. What might your dream be reflecting back to you about how you\'ve been feeling lately? May this reading turn your dream toward the good.';

function stubFetchOkContent(content) {
  stubFetchOnce({
    ok: true,
    status: 200,
    json: async function () {
      return { choices: [{ message: { role: 'assistant', content: content } }] };
    }
  });
}

function stubFetchOkReading(text) {
  stubFetchOkContent(text !== undefined ? text : SAMPLE_READING);
}

function stubFetchOkQuestions(questionsObj) {
  stubFetchOkContent(JSON.stringify(questionsObj !== undefined ? questionsObj : {
    questions: [
      { text: 'What has been on your mind lately?', chips: ['Work', 'Family', 'A big change', 'Nothing in particular'] }
    ]
  }));
}

function genEvent(overrides) {
  var base = {
    method: 'POST',
    ip: nextIp(),
    body: Object.assign({ caption: 'I was flying over my childhood home', personaKey: 'jung', mode: 'reading', qa: [] }, overrides && overrides.body)
  };
  if (overrides && overrides.ip) base.ip = overrides.ip;
  if (overrides && 'body' in overrides && typeof overrides.body === 'string') base.body = overrides.body;
  return fakeEvent(base);
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.MAX_INTERPRETATIONS_PER_IP_PER_DAY;
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- E401 -----

test('non-POST request is rejected E401', async function () {
  var res = await handler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E401: method_not_allowed/);
});

// ----- E402 -----

test('missing FAL_KEY is rejected E402', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E402: missing_api_key/);
});

// ----- E403 -----

test('invalid JSON body is rejected E403', async function () {
  var res = await handler(genEvent({ body: '{not valid json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E403: invalid_json/);
});

// ----- E404 -----

test('missing caption is rejected E404', async function () {
  var res = await handler(genEvent({ body: { caption: '', personaKey: 'jung', mode: 'reading' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E404: caption_required/);
});

test('whitespace-only caption is rejected E404', async function () {
  var res = await handler(genEvent({ body: { caption: '   ', personaKey: 'jung', mode: 'reading' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E404: caption_required/);
});

// ----- E408 (new) -----

test('a missing personaKey is rejected E408 unknown_persona', async function () {
  var res = await handler(genEvent({ body: { personaKey: undefined } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E408: unknown_persona/);
});

test('an unrecognized personaKey is rejected E408 unknown_persona', async function () {
  var res = await handler(genEvent({ body: { personaKey: 'not-a-real-persona' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E408: unknown_persona/);
});

test('every real persona key is accepted (E408 only rejects an actually-unknown key)', async function () {
  for (var i = 0; i < InterpreterPersonas.ALL.length; i++) {
    var key = InterpreterPersonas.ALL[i].key;
    stubFetchOkReading();
    var res = await handler(genEvent({ body: { personaKey: key, mode: 'reading' } }));
    assert.equal(res.statusCode, 200, 'expected persona ' + key + ' to be accepted');
  }
});

// ----- E409 (new) -----

test('a valid personaKey with a missing mode is rejected E409 invalid_mode', async function () {
  var res = await handler(genEvent({ body: { personaKey: 'jung', mode: undefined } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E409: invalid_mode/);
});

test('a valid personaKey with an unrecognized mode is rejected E409 invalid_mode', async function () {
  var res = await handler(genEvent({ body: { personaKey: 'jung', mode: 'summarize' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E409: invalid_mode/);
});

test('the OLD legacy shape (caption only, no personaKey/mode) is rejected E408, not silently handled -- the legacy branch was deleted, not kept dormant', async function () {
  var res = await handler(genEvent({ body: { personaKey: undefined, mode: undefined } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E408: unknown_persona/);
});

// ----- E405 (shared by both modes) -----

test('a non-ok fal/OpenRouter response is rejected E405, using error.message when present (mode:reading)', async function () {
  stubFetchOnce({
    ok: false,
    status: 502,
    json: async function () { return { error: { message: 'upstream model unavailable' } }; }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E405: llm_request_failed: upstream model unavailable/);
});

test('a network failure reaching fal at all is rejected E405 (mode:questions)', async function () {
  global.fetch = async function () { throw new Error('ECONNRESET'); };
  var res = await handler(genEvent({ body: { mode: 'questions' } }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E405: llm_request_failed/);
});

// ----- E406 (unchanged scope, both modes count against it) -----

test('exceeding the per-IP daily cap is rejected E406, and BOTH modes count against the SAME "interpret-ip" counter', async function () {
  process.env.MAX_INTERPRETATIONS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  stubFetchOkQuestions();
  var first = await handler(genEvent({ ip: ip, body: { mode: 'questions' } }));
  assert.equal(first.statusCode, 200);
  stubFetchOkReading();
  var second = await handler(genEvent({ ip: ip, body: { mode: 'reading' } }));
  assert.equal(second.statusCode, 200);
  stubFetchOkQuestions();
  var third = await handler(genEvent({ ip: ip, body: { mode: 'questions' } }));
  assert.equal(third.statusCode, 429);
  assert.match(JSON.parse(third.body).error, /^E406: rate_limited/);
});

test('a pre-tripped counter under the "interpret-ip" scope blocks the request without touching generate-video.js\'s "ip" scope key', async function () {
  var ip = nextIp();
  mockBlobs.seed('dreamtube-rate-limits', 'interpret-ip:' + todayUtc() + ':' + ip, 40);
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E406: rate_limited/);
});

// ===== mode:"questions" =====

test('mode:questions success returns questions with server-assigned ids, passing through the model\'s text/chips', async function () {
  stubFetchOkQuestions({
    questions: [
      { text: 'What feels unbalanced in your life right now?', chips: ['Work', 'A relationship', 'My health', 'Not sure'] },
      { text: 'What situation does this echo?', chips: ['A conflict', 'A big decision'] }
    ]
  });
  var res = await handler(genEvent({ body: { mode: 'questions' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.questions.length, 2);
  assert.equal(body.questions[0].id, 'q1');
  assert.equal(body.questions[1].id, 'q2');
  assert.equal(body.questions[0].text, 'What feels unbalanced in your life right now?');
  assert.deepEqual(body.questions[0].chips, ['Work', 'A relationship', 'My health', 'Not sure']);
});

test('mode:questions tolerates a ```json fenced code block, per the spec\'s own "tolerating a fenced code block" instruction', async function () {
  var fenced = '```json\n' + JSON.stringify({ questions: [{ text: 'What has been on your mind?', chips: ['Work', 'Family'] }] }) + '\n```';
  stubFetchOkContent(fenced);
  var res = await handler(genEvent({ body: { mode: 'questions' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.questions.length, 1);
  assert.equal(body.questions[0].text, 'What has been on your mind?');
});

test('mode:questions caps a persona\'s returned question count at its own maxQuestions', async function () {
  var freud = InterpreterPersonas.get('freud'); // maxQuestions: 2
  stubFetchOkQuestions({
    questions: [
      { text: 'Q1?', chips: ['a', 'b'] },
      { text: 'Q2?', chips: ['a', 'b'] },
      { text: 'Q3 -- should be dropped?', chips: ['a', 'b'] }
    ]
  });
  var res = await handler(genEvent({ body: { personaKey: freud.key, mode: 'questions' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.questions.length, freud.maxQuestions);
});

test('mode:questions truncates an over-length question text/chip rather than rejecting the whole response', async function () {
  var longText = 'x'.repeat(200);
  var longChip = 'y'.repeat(80);
  stubFetchOkQuestions({ questions: [{ text: longText, chips: [longChip, 'short chip'] }] });
  var res = await handler(genEvent({ body: { mode: 'questions' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.ok(body.questions[0].text.length <= 140);
  assert.ok(body.questions[0].chips[0].length <= 40);
});

test('mode:questions drops an individual malformed question (no text) rather than failing the whole response', async function () {
  stubFetchOkQuestions({
    questions: [
      { text: '', chips: ['a'] },
      { chips: ['no text field at all'] },
      { text: 'A real, valid question?', chips: ['Yes', 'No'] }
    ]
  });
  var res = await handler(genEvent({ body: { mode: 'questions' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.questions.length, 1);
  assert.equal(body.questions[0].text, 'A real, valid question?');
});

test('mode:questions with completely unparseable JSON is rejected E407, not treated as a degenerate success', async function () {
  stubFetchOkContent('Sorry, I cannot help with that.');
  var res = await handler(genEvent({ body: { mode: 'questions' } }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E407: empty_or_invalid_response/);
});

test('mode:questions with a `questions` array that has zero usable items after cleaning is rejected E407', async function () {
  stubFetchOkQuestions({ questions: [{ text: '' }, { text: '   ' }] });
  var res = await handler(genEvent({ body: { mode: 'questions' } }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E407: empty_or_invalid_response/);
});

test('mode:questions with `questions` missing entirely from the parsed JSON is rejected E407', async function () {
  stubFetchOkContent(JSON.stringify({ notQuestions: [] }));
  var res = await handler(genEvent({ body: { mode: 'questions' } }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E407: empty_or_invalid_response/);
});

test('mode:questions sends the persona\'s voice/method/questionFocus and the caption to fal, using temperature 0.8', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: JSON.stringify({ questions: [{ text: 'Q?', chips: ['a', 'b'] }] }) } }] }; } };
  };
  var jung = InterpreterPersonas.get('jung');
  var res = await handler(genEvent({ body: { caption: 'a dream about a locked door', personaKey: 'jung', mode: 'questions' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(capturedBody.temperature, 0.8);
  assert.equal(capturedBody.model, 'openai/gpt-4o-mini');
  var systemMsg = capturedBody.messages.filter(function (m) { return m.role === 'system'; })[0].content;
  assert.ok(systemMsg.indexOf(jung.questionFocus) !== -1, 'system prompt must include the persona\'s questionFocus');
  var userMsg = capturedBody.messages.filter(function (m) { return m.role === 'user'; })[0].content;
  assert.ok(userMsg.indexOf('a dream about a locked door') !== -1);
});

// ===== mode:"reading" =====

test('mode:reading success returns { interpretation }', async function () {
  stubFetchOkReading();
  var res = await handler(genEvent({ body: { mode: 'reading', qa: [] } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.interpretation, SAMPLE_READING);
});

test('mode:reading with qa:[] tells the model the dreamer chose not to answer, and with qa carries every Q/A pair', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: SAMPLE_READING } }] }; } };
  };
  var res1 = await handler(genEvent({ body: { mode: 'reading', qa: [] } }));
  assert.equal(res1.statusCode, 200);
  var userMsg1 = capturedBody.messages.filter(function (m) { return m.role === 'user'; })[0].content;
  assert.ok(userMsg1.indexOf('chose not to answer') !== -1);

  var res2 = await handler(genEvent({ body: { mode: 'reading', qa: [{ q: 'What has been on your mind?', a: 'A big move coming up' }] } }));
  assert.equal(res2.statusCode, 200);
  var userMsg2 = capturedBody.messages.filter(function (m) { return m.role === 'user'; })[0].content;
  assert.ok(userMsg2.indexOf('What has been on your mind?') !== -1);
  assert.ok(userMsg2.indexOf('A big move coming up') !== -1);
});

test('mode:reading drops a malformed qa entry rather than sending it through raw, and caps answer length at 280', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: SAMPLE_READING } }] }; } };
  };
  var longAnswer = 'z'.repeat(400);
  var res = await handler(genEvent({
    body: {
      mode: 'reading',
      qa: [
        { q: 'Real question?', a: longAnswer },
        { q: '', a: 'malformed -- empty question, dropped' },
        { q: 'no a field at all' },
        null
      ]
    }
  }));
  assert.equal(res.statusCode, 200);
  var userMsg = capturedBody.messages.filter(function (m) { return m.role === 'user'; })[0].content;
  assert.ok(userMsg.indexOf('Real question?') !== -1);
  assert.ok(userMsg.indexOf('malformed -- empty question') === -1);
  // The 400-char raw answer must be capped to 280 somewhere in the sent
  // message, not passed straight through.
  assert.ok(userMsg.indexOf(longAnswer) === -1, 'a 400-char answer must have been truncated before being sent');
});

test('mode:reading uses temperature 0.9 and includes the persona\'s voice/method + the shared safety block', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: SAMPLE_READING } }] }; } };
  };
  var talmudic = InterpreterPersonas.get('talmudic');
  var res = await handler(genEvent({ body: { personaKey: 'talmudic', mode: 'reading', qa: [] } }));
  assert.equal(res.statusCode, 200);
  assert.equal(capturedBody.temperature, 0.9);
  var systemMsg = capturedBody.messages.filter(function (m) { return m.role === 'system'; })[0].content;
  assert.ok(systemMsg.indexOf(talmudic.method) !== -1, 'system prompt must include the persona\'s method');
  assert.match(systemMsg, /never mention that you are an ai/i);
  assert.match(systemMsg, /religious ruling/i);
});

test('mode:reading with an empty completion is rejected E407', async function () {
  stubFetchOkReading('');
  var res = await handler(genEvent({ body: { mode: 'reading' } }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E407: empty_or_invalid_response/);
});

test('mode:reading with a suspiciously short completion is rejected E407', async function () {
  stubFetchOkReading('Nice dream.');
  var res = await handler(genEvent({ body: { mode: 'reading' } }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E407: empty_or_invalid_response/);
});

// ===== Cross-cutting safety =====

test('every mode:reading system prompt bans the words therapy/diagnosis/healing/treatment (spec §4 banned-words framing, defense-in-depth into the LLM prompt itself)', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: SAMPLE_READING } }] }; } };
  };
  for (var i = 0; i < InterpreterPersonas.ALL.length; i++) {
    var key = InterpreterPersonas.ALL[i].key;
    var res = await handler(genEvent({ body: { personaKey: key, mode: 'reading', qa: [] } }));
    assert.equal(res.statusCode, 200);
    var systemMsg = capturedBody.messages.filter(function (m) { return m.role === 'system'; })[0].content;
    assert.match(systemMsg, /"therapy,"\s*"diagnosis,"\s*"healing,"\s*"mental health,"\s*or\s*"treatment"/i, 'persona ' + key + '\'s system prompt must carry the shared banned-words instruction');
  }
});
