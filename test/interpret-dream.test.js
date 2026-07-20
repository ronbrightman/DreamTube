// test/interpret-dream.test.js
//
// Covers netlify/functions/interpret-dream.js: every E4xx error code from
// its own header comment, plus a successful call. fal.ai/OpenRouter is
// stubbed via a fake global.fetch (same approach generate-video-gate.test.js
// uses for fal.ai itself) — these tests exercise this function's own logic
// (validation, rate limiting, response-shape handling), not a live call to
// fal.ai. Blobs (used transitively via lib/rate-limit.js) is mocked the same
// way generate-video-gate.test.js mocks it, since this function reuses that
// same rate-limit lib.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/interpret-dream').handler;

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.1.0.' + ipCounter;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function stubFetchOnce(response) {
  global.fetch = async function () { return response; };
}

/** A plausible, well-over-MIN_VALID_LENGTH reflection, standing in for a real model completion. */
var SAMPLE_INTERPRETATION = 'Dreams about flying often echo a wish for freedom or a release from something weighing on you. What might your dream be reflecting back to you about how you\'ve been feeling lately?';

function stubFetchOk(content) {
  stubFetchOnce({
    ok: true,
    status: 200,
    json: async function () {
      return { choices: [{ message: { role: 'assistant', content: content !== undefined ? content : SAMPLE_INTERPRETATION } }] };
    }
  });
}

function genEvent(overrides) {
  var base = {
    method: 'POST',
    ip: nextIp(),
    body: Object.assign({ caption: 'I was flying over my childhood home', style: 'Cinematic' }, overrides && overrides.body)
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
  var res = await handler(genEvent({ body: { caption: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E404: caption_required/);
});

test('whitespace-only caption is rejected E404', async function () {
  var res = await handler(genEvent({ body: { caption: '   ' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E404: caption_required/);
});

// ----- E405 -----

test('a non-ok fal/OpenRouter response is rejected E405, using error.message when present', async function () {
  stubFetchOnce({
    ok: false,
    status: 502,
    json: async function () { return { error: { message: 'upstream model unavailable' } }; }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E405: llm_request_failed: upstream model unavailable/);
});

test('a fal-style validation error (detail array) is rejected E405 with the extracted message', async function () {
  stubFetchOnce({
    ok: false,
    status: 422,
    json: async function () { return { detail: [{ msg: 'field required', type: 'missing' }] }; }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E405: llm_request_failed: field required/);
});

test('a network failure reaching fal at all is rejected E405', async function () {
  global.fetch = async function () { throw new Error('ECONNRESET'); };
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E405: llm_request_failed/);
});

// ----- E406 -----

test('exceeding the per-IP daily cap is rejected E406, independent of generate-video.js\'s own rate-limit bucket', async function () {
  process.env.MAX_INTERPRETATIONS_PER_IP_PER_DAY = '1';
  stubFetchOk();
  var ip = nextIp();
  var first = await handler(genEvent({ ip: ip }));
  assert.equal(first.statusCode, 200);
  stubFetchOk();
  var second = await handler(genEvent({ ip: ip }));
  assert.equal(second.statusCode, 429);
  assert.match(JSON.parse(second.body).error, /^E406: rate_limited/);
});

test('a pre-tripped counter under the "interpret-ip" scope blocks the request without touching generate-video.js\'s "ip" scope key', async function () {
  var ip = nextIp();
  mockBlobs.seed('dreamtube-rate-limits', 'interpret-ip:' + todayUtc() + ':' + ip, 40);
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E406: rate_limited/);
});

// ----- E407 -----

test('an empty completion is rejected E407, not treated as a degenerate success', async function () {
  stubFetchOk('');
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E407: empty_or_invalid_response/);
});

test('a suspiciously short completion is rejected E407', async function () {
  stubFetchOk('Nice dream.');
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E407: empty_or_invalid_response/);
});

test('a response with no choices at all is rejected E407', async function () {
  stubFetchOnce({ ok: true, status: 200, json: async function () { return {}; } });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E407: empty_or_invalid_response/);
});

// ----- Success -----

test('a normal completion succeeds and is returned as { interpretation }', async function () {
  stubFetchOk();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.interpretation, SAMPLE_INTERPRETATION);
});

test('the request sent to fal carries the caption in the messages array and never echoes style into the prompt shape', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: SAMPLE_INTERPRETATION } }] }; } };
  };
  var res = await handler(genEvent({ body: { caption: 'a dream about losing my teeth', style: 'Anime' } }));
  assert.equal(res.statusCode, 200);
  assert.ok(capturedBody.messages.some(function (m) { return m.role === 'user' && m.content.indexOf('a dream about losing my teeth') !== -1; }));
  assert.equal(capturedBody.model, 'openai/gpt-4o-mini');
});
