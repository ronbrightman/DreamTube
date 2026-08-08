// test/soften-dream-text.test.js
//
// Coverage for netlify/functions/soften-dream-text.js — the "Soften it for
// me" recovery action behind the content-block panel (founder upgrade
// 2026-08-08). The load-bearing property under test is the MANDATORY RE-GATE:
// a softened rewrite is only reported as usable (allowed:true) if it now
// PASSES the same content gate; a rewrite that is still explicit comes back
// allowed:false, so softening can never launder explicit content through.
//
// The LLM call is driven deterministically via SOFTEN_MOCK_TEXT (no real,
// paid call — same "never a real paid call in tests" rule the generation
// pipeline uses), and the re-gate's own classifier via
// CONTENT_CLASSIFIER_MOCK_TIER. The deterministic explicit-keyword backstop
// in the gate means a softened text that still names a sexual act is caught
// regardless of the mocked classifier tier.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var handler = require('../netlify/functions/soften-dream-text').handler;

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.7.0.' + ipCounter; }

function event(body) {
  return fakeEvent({ method: 'POST', ip: nextIp(), body: body });
}

test.beforeEach(function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.SOFTEN_MOCK_TEXT;
  delete process.env.CONTENT_CLASSIFIER_MOCK_TIER;
  delete process.env.GENERATION_MOCK_MODE;
});
test.after(function () { global.fetch = realFetch; });

test('non-POST -> 405 E701', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E701/);
});

test('missing text -> 400 E704', async function () {
  var res = await handler(event({ text: '   ' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E704/);
});

test('soften -> re-gate PASSES: softened clean text is returned as allowed:true', async function () {
  process.env.SOFTEN_MOCK_TEXT = 'I was resting peacefully in a sunlit meadow, feeling calm and loved.';
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  var res = await handler(event({ text: 'I was having sex in a meadow' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, true);
  assert.equal(body.softenedText, 'I was resting peacefully in a sunlit meadow, feeling calm and loved.');
  assert.equal(body.message, null);
});

test('soften -> re-gate PASSES with a romantic (allowed) rewrite', async function () {
  process.env.SOFTEN_MOCK_TEXT = 'I was slow dancing with someone I loved, holding them close.';
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'romantic';
  var res = await handler(event({ text: 'explicit original' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, true);
  assert.equal(body.tier, 'romantic');
});

test('soften -> re-gate STILL BLOCKS: a rewrite that still names a sexual act comes back allowed:false (no laundering)', async function () {
  // Even with the classifier mocked to the most lenient 'clean', the
  // deterministic keyword backstop in the re-gate catches the still-explicit
  // rewrite — softening can never turn explicit into allowed by itself.
  process.env.SOFTEN_MOCK_TEXT = 'we had sex again, slower this time';
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  var res = await handler(event({ text: 'having sex' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, false);
  assert.ok(body.message && body.message.length > 0, 'a blocked re-gate returns a message for the panel');
});

test('soften via the real LLM path (stubbed fetch) -> re-gate passes', async function () {
  // No SOFTEN_MOCK_TEXT: the endpoint calls the LLM. Stub fetch to return the
  // softened content; the re-gate classifier is short-circuited by
  // CONTENT_CLASSIFIER_MOCK_TIER so no second real call happens.
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () {
      return { choices: [{ message: { content: 'I drifted through a warm, tender dream about someone I love.' } }] };
    } };
  };
  var res = await handler(event({ text: 'explicit original text here' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.allowed, true);
  assert.match(body.softenedText, /tender dream/);
});

test('soften LLM returns empty -> 502 E707 (no degenerate success)', async function () {
  process.env.SOFTEN_MOCK_TEXT = '   ';
  // Empty mock text falls through to the real path; stub fetch to return empty.
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { choices: [{ message: { content: '' } }] }; } };
  };
  var res = await handler(event({ text: 'something' }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E707/);
});
