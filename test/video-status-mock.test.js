// test/video-status-mock.test.js
//
// Covers netlify/functions/video-status.js's mock path (checkMockStatus),
// the counterpart to generate-video.js's GENERATION_MOCK_MODE — see that
// file's doc block and docs/TESTING.md. A mock operationName embeds its own
// start timestamp ("mock:<startedAtMs>:<id>"), so these tests construct
// operationNames with a deliberately old/fresh embedded timestamp rather
// than sleeping for real — same end result (exercising "still generating"
// vs. "done"), without a slow test suite.
//
// global.fetch is never stubbed in this file: the whole point of the mock
// path is that it never calls fetch at all, and a real accidental call
// would fail fast against the sandbox's real network rather than silently
// pass.

var test = require('node:test');
var assert = require('node:assert/strict');

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/video-status').handler;

var realFetch = global.fetch;

test.beforeEach(function () {
  // Any accidental real network call from this file's tests should error
  // loudly rather than silently hang or hit the real internet.
  global.fetch = function () { throw new Error('video-status.js should never call fetch for a mock: operationName'); };
});

test.after(function () {
  global.fetch = realFetch;
});

function statusEvent(name) {
  return fakeEvent({ method: 'GET', query: { name: name } });
}

test('mock operation still within the simulated delay window: done=false, matching the real in-progress poll shape', async function () {
  var name = 'mock:' + Date.now() + ':abc123'; // just started
  var res = await handler(statusEvent(name));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.deepEqual(body, { done: false });
});

test('mock operation past the simulated delay window: done=true with a working videoUrl', async function () {
  var name = 'mock:' + (Date.now() - 25000) + ':abc123'; // "started" 25s ago
  var res = await handler(statusEvent(name));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(typeof body.videoUrl, 'string');
  assert.match(body.videoUrl, /^https:\/\//);
  assert.ok(!body.error);
});

test('the resolved mock videoUrl is a real, reachable, publicly-hosted video', { timeout: 20000 }, async function () {
  global.fetch = realFetch; // this one test needs the real network to verify reachability
  var name = 'mock:' + (Date.now() - 25000) + ':abc123';
  var res = await handler(statusEvent(name));
  var videoUrl = JSON.parse(res.body).videoUrl;
  var probe = await realFetch(videoUrl, { method: 'HEAD' });
  assert.ok(probe.ok, 'expected the mock sample video URL to be reachable (HTTP ' + probe.status + ')');
  assert.match(probe.headers.get('content-type') || '', /^video\//);
});

test('a couple of consecutive polls transition false -> true as time passes the delay window, never instantly done', async function () {
  var startedAt = Date.now();
  var justStarted = await handler(statusEvent('mock:' + startedAt + ':xyz'));
  assert.equal(JSON.parse(justStarted.body).done, false);

  var stillWithinWindow = await handler(statusEvent('mock:' + (startedAt - 5000) + ':xyz')); // "5s elapsed"
  assert.equal(JSON.parse(stillWithinWindow.body).done, false, 'a mock job should not resolve after only one ~10s poll cycle');

  var pastWindow = await handler(statusEvent('mock:' + (startedAt - 21000) + ':xyz')); // "21s elapsed"
  assert.equal(JSON.parse(pastWindow.body).done, true);
});

test('malformed mock operationName (no parseable timestamp) resolves done=true rather than polling forever', async function () {
  var res = await handler(statusEvent('mock::not-a-number'));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.done, true);
  assert.equal(typeof body.videoUrl, 'string');
});

// ----- Doesn't interfere with the real fal: / legacy paths -----

test('a "fal:" operationName is unaffected by the mock path (still requires FAL_KEY, still goes to checkFalStatus)', async function () {
  var previousKey = process.env.FAL_KEY;
  delete process.env.FAL_KEY;
  try {
    var res = await handler(statusEvent('fal:fal-ai/veo3.1/fast:some-request-id'));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E210: missing_api_key/);
  } finally {
    if (previousKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = previousKey;
  }
});
