// test/rewrite-dream-story.test.js
//
// Covers netlify/functions/rewrite-dream-story.js: every E6xx error code
// from its own header comment, plus a successful call and the wrapping-
// quote-strip behavior. Same fake-global.fetch + mock-blobs approach as
// test/interpret-dream.test.js, since this function reuses the same
// fal.ai/OpenRouter passthrough shape and the same lib/rate-limit.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/rewrite-dream-story').handler;

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.2.0.' + ipCounter;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function stubFetchOnce(response) {
  global.fetch = async function () { return response; };
}

var SAMPLE_STORY = 'I was a stranger walking through a foggy forest at night, feeling uneasy.';

function stubFetchOk(content) {
  stubFetchOnce({
    ok: true,
    status: 200,
    json: async function () {
      return { choices: [{ message: { role: 'assistant', content: content !== undefined ? content : SAMPLE_STORY } }] };
    }
  });
}

function genEvent(overrides) {
  var base = {
    method: 'POST',
    ip: nextIp(),
    body: Object.assign({ promptText: 'medium tracking shot of a stranger, walking through a foggy forest, mysterious mood, warm lighting, Cartoon style, dreamlike.' }, overrides && overrides.body)
  };
  if (overrides && overrides.ip) base.ip = overrides.ip;
  if (overrides && 'body' in overrides && typeof overrides.body === 'string') base.body = overrides.body;
  return fakeEvent(base);
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.MAX_STORY_REWRITES_PER_IP_PER_DAY;
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- E601 -----

test('non-POST request is rejected E601', async function () {
  var res = await handler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E601: method_not_allowed/);
});

// ----- E602 -----

test('missing FAL_KEY is rejected E602', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E602: missing_api_key/);
});

// ----- E603 -----

test('invalid JSON body is rejected E603', async function () {
  var res = await handler(genEvent({ body: '{not valid json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E603: invalid_json/);
});

// ----- E604 -----

test('missing promptText is rejected E604', async function () {
  var res = await handler(genEvent({ body: { promptText: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E604: prompt_text_required/);
});

test('whitespace-only promptText is rejected E604', async function () {
  var res = await handler(genEvent({ body: { promptText: '   ' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E604: prompt_text_required/);
});

// ----- E605 -----

test('a non-ok fal/OpenRouter response is rejected E605, using error.message when present', async function () {
  stubFetchOnce({
    ok: false,
    status: 502,
    json: async function () { return { error: { message: 'upstream model unavailable' } }; }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E605: llm_request_failed: upstream model unavailable/);
});

test('a network failure reaching fal at all is rejected E605', async function () {
  global.fetch = async function () { throw new Error('ECONNRESET'); };
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E605: llm_request_failed/);
});

// ----- E606 -----

test('exceeding the per-IP daily cap is rejected E606, independent of interpret-dream.js\'s own rate-limit bucket', async function () {
  process.env.MAX_STORY_REWRITES_PER_IP_PER_DAY = '1';
  stubFetchOk();
  var ip = nextIp();
  var first = await handler(genEvent({ ip: ip }));
  assert.equal(first.statusCode, 200);
  stubFetchOk();
  var second = await handler(genEvent({ ip: ip }));
  assert.equal(second.statusCode, 429);
  assert.match(JSON.parse(second.body).error, /^E606: rate_limited/);
});

test('a pre-tripped counter under the "story-rewrite-ip" scope blocks the request without touching interpret-dream.js\'s "interpret-ip" scope key', async function () {
  var ip = nextIp();
  mockBlobs.seed('dreamtube-rate-limits', 'story-rewrite-ip:' + todayUtc() + ':' + ip, 200);
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E606: rate_limited/);
});

// ----- E607 -----

test('an empty completion is rejected E607, not treated as a degenerate success', async function () {
  stubFetchOk('');
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E607: empty_or_invalid_response/);
});

test('a response with no choices at all is rejected E607', async function () {
  stubFetchOnce({ ok: true, status: 200, json: async function () { return {}; } });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E607: empty_or_invalid_response/);
});

// ----- Success -----

test('a normal completion succeeds and is returned as { storyText }', async function () {
  stubFetchOk();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.storyText, SAMPLE_STORY);
});

test('a completion the model wrapped in quotes has them stripped', async function () {
  stubFetchOk('"I was flying over my childhood home, feeling peaceful."');
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.storyText, 'I was flying over my childhood home, feeling peaceful.');
});

test('the request sent to fal carries promptText in the messages array', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: SAMPLE_STORY } }] }; } };
  };
  var res = await handler(genEvent({ body: { promptText: 'aerial wide shot of a dog, flying through an open sky, dreamy surreal mood, hazy ethereal light, Cinematic style, dreamlike.' } }));
  assert.equal(res.statusCode, 200);
  assert.ok(capturedBody.messages.some(function (m) { return m.role === 'user' && m.content.indexOf('aerial wide shot of a dog') !== -1; }));
  assert.equal(capturedBody.model, 'openai/gpt-4o-mini');
});
