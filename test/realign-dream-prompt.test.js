// test/realign-dream-prompt.test.js
//
// Covers netlify/functions/realign-dream-prompt.js: every E7xx error code
// from its own header comment, the JSON response parse/validation
// (including the code-fence-stripping fallback), and a successful call
// carrying promptText/storyText/deltaText through to the fal request. Same
// fake-global.fetch + mock-blobs approach as test/rewrite-dream-story.test.js,
// since this function reuses that exact fal.ai/OpenRouter passthrough shape.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/realign-dream-prompt').handler;

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

var SAMPLE_PROMPT = 'Cinematic aerial POV shot, dreamer gliding through a night sky above a golden-lit city skyline, streetlights twinkling below, gentle wind motion in hair, warm golden-hour glow transitioning to night, smooth continuous flight camera movement, sense of freedom and wonder, photorealistic lighting, 16:9, no text overlays.';
var SAMPLE_STORY = "I'm flying over a golden city at night, gliding past twinkling lights, feeling completely free.";
var SAMPLE_DELTA = 'Make it daytime instead of night, and add my dog flying right next to me.';
var REALIGNED_PROMPT = 'Cinematic aerial POV shot, dreamer gliding through a bright daytime sky above a golden-lit city skyline, a dog flying right alongside the dreamer, sunlight glinting off skyscraper windows below, gentle wind motion in hair and fur, smooth continuous flight camera movement, sense of freedom and wonder, photorealistic lighting, 16:9, no text overlays.';
var REALIGNED_STORY = "I'm flying over a golden city in daylight, gliding past the skyscrapers with my dog flying right beside me, feeling completely free.";

function stubFetchOk(promptText, storyText) {
  var content = JSON.stringify({
    promptText: promptText !== undefined ? promptText : REALIGNED_PROMPT,
    storyText: storyText !== undefined ? storyText : REALIGNED_STORY
  });
  stubFetchOnce({
    ok: true,
    status: 200,
    json: async function () { return { choices: [{ message: { role: 'assistant', content: content } }] }; }
  });
}

function genEvent(overrides) {
  var base = {
    method: 'POST',
    ip: nextIp(),
    body: Object.assign({ promptText: SAMPLE_PROMPT, storyText: SAMPLE_STORY, deltaText: SAMPLE_DELTA }, overrides && overrides.body)
  };
  if (overrides && overrides.ip) base.ip = overrides.ip;
  if (overrides && 'body' in overrides && typeof overrides.body === 'string') base.body = overrides.body;
  return fakeEvent(base);
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.MAX_REALIGNS_PER_IP_PER_DAY;
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- E701 -----

test('non-POST request is rejected E701', async function () {
  var res = await handler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E701: method_not_allowed/);
});

// ----- E702 -----

test('missing FAL_KEY is rejected E702', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E702: missing_api_key/);
});

// ----- E703 -----

test('invalid JSON body is rejected E703', async function () {
  var res = await handler(genEvent({ body: '{not valid json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E703: invalid_json/);
});

// ----- E704 -----

test('missing promptText is rejected E704', async function () {
  var res = await handler(genEvent({ body: { promptText: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E704: fields_required/);
});

test('missing storyText is rejected E704', async function () {
  var res = await handler(genEvent({ body: { storyText: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E704: fields_required/);
});

test('missing deltaText is rejected E704', async function () {
  var res = await handler(genEvent({ body: { deltaText: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E704: fields_required/);
});

test('whitespace-only deltaText is rejected E704', async function () {
  var res = await handler(genEvent({ body: { deltaText: '   ' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E704: fields_required/);
});

// ----- E705 -----

test('a non-ok fal/OpenRouter response is rejected E705, using error.message when present', async function () {
  stubFetchOnce({
    ok: false,
    status: 502,
    json: async function () { return { error: { message: 'upstream model unavailable' } }; }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E705: llm_request_failed: upstream model unavailable/);
});

test('a network failure reaching fal at all is rejected E705', async function () {
  global.fetch = async function () { throw new Error('ECONNRESET'); };
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E705: llm_request_failed/);
});

// ----- E706 -----

test('exceeding the per-IP daily cap is rejected E706, independent of rewrite-dream-story.js\'s own rate-limit bucket', async function () {
  process.env.MAX_REALIGNS_PER_IP_PER_DAY = '1';
  stubFetchOk();
  var ip = nextIp();
  var first = await handler(genEvent({ ip: ip }));
  assert.equal(first.statusCode, 200);
  stubFetchOk();
  var second = await handler(genEvent({ ip: ip }));
  assert.equal(second.statusCode, 429);
  assert.match(JSON.parse(second.body).error, /^E706: rate_limited/);
});

test('a pre-tripped counter under the "dream-realign-ip" scope blocks the request without touching "story-rewrite-ip"\'s own scope key', async function () {
  var ip = nextIp();
  mockBlobs.seed('dreamtube-rate-limits', 'dream-realign-ip:' + todayUtc() + ':' + ip, 200);
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E706: rate_limited/);
});

// ----- E707 -----

test('a non-JSON completion is rejected E707, not treated as a degenerate success', async function () {
  stubFetchOnce({
    ok: true, status: 200,
    json: async function () { return { choices: [{ message: { content: 'not json at all' } }] }; }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E707: empty_or_invalid_response/);
});

test('JSON missing storyText is rejected E707', async function () {
  stubFetchOnce({
    ok: true, status: 200,
    json: async function () { return { choices: [{ message: { content: JSON.stringify({ promptText: REALIGNED_PROMPT }) } }] }; }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E707: empty_or_invalid_response/);
});

test('JSON with a too-short promptText is rejected E707', async function () {
  stubFetchOnce({
    ok: true, status: 200,
    json: async function () { return { choices: [{ message: { content: JSON.stringify({ promptText: 'short', storyText: REALIGNED_STORY }) } }] }; }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E707: empty_or_invalid_response/);
});

test('a response with no choices at all is rejected E707', async function () {
  stubFetchOnce({ ok: true, status: 200, json: async function () { return {}; } });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E707: empty_or_invalid_response/);
});

// ----- Success -----

test('a normal completion succeeds and is returned as { promptText, storyText }', async function () {
  stubFetchOk();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.promptText, REALIGNED_PROMPT);
  assert.equal(body.storyText, REALIGNED_STORY);
});

test('a completion wrapped in a ```json code fence is still parsed correctly', async function () {
  stubFetchOnce({
    ok: true, status: 200,
    json: async function () {
      return { choices: [{ message: { content: '```json\n' + JSON.stringify({ promptText: REALIGNED_PROMPT, storyText: REALIGNED_STORY }) + '\n```' } }] };
    }
  });
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.promptText, REALIGNED_PROMPT);
  assert.equal(body.storyText, REALIGNED_STORY);
});

test('the request sent to fal carries the current prompt, story, and delta in the user message, and the spec-mandated params', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: JSON.stringify({ promptText: REALIGNED_PROMPT, storyText: REALIGNED_STORY }) } }] }; } };
  };
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(capturedBody.model, 'openai/gpt-4o-mini');
  assert.equal(capturedBody.temperature, 0.5);
  assert.equal(capturedBody.max_tokens, 200);
  var userMsg = capturedBody.messages.filter(function (m) { return m.role === 'user'; })[0].content;
  assert.ok(userMsg.indexOf(SAMPLE_PROMPT) !== -1);
  assert.ok(userMsg.indexOf(SAMPLE_STORY) !== -1);
  assert.ok(userMsg.indexOf(SAMPLE_DELTA) !== -1);
  var systemMsg = capturedBody.messages.filter(function (m) { return m.role === 'system'; })[0].content;
  assert.match(systemMsg, /apply ONLY the requested change/);
});

test('extra whitespace on promptText/storyText/deltaText is trimmed before use', async function () {
  var capturedBody = null;
  global.fetch = async function (url, opts) {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: JSON.stringify({ promptText: REALIGNED_PROMPT, storyText: REALIGNED_STORY }) } }] }; } };
  };
  await handler(genEvent({ body: { promptText: '  ' + SAMPLE_PROMPT + '  ', storyText: '  ' + SAMPLE_STORY + '  ', deltaText: '  ' + SAMPLE_DELTA + '  ' } }));
  var userMsg = capturedBody.messages.filter(function (m) { return m.role === 'user'; })[0].content;
  assert.equal(userMsg, 'Current prompt: ' + SAMPLE_PROMPT + '\nCurrent story: ' + SAMPLE_STORY + '\nChange: ' + SAMPLE_DELTA);
});
