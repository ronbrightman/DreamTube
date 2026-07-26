// test/generation-completion-marker.test.js
//
// Covers the durable, server-side replacement for the old sessionStorage
// `dreamtube_just_generated_id` marker (tracker.html's
// result-htmls-firstvideocreated-still-dep-qfg48t item, founder-approved
// 2026-07-27):
//   - netlify/functions/lib/generation-completion-store.js: markCompleted /
//     consumeIfPresent, the dream-id-keyed Blobs store itself.
//   - netlify/functions/mark-generation-completed.js: the POST endpoint
//     processing.html calls right before its redirect.
//   - netlify/functions/consume-generation-marker.js: the POST endpoint
//     result.html calls to read + consume the marker exactly once.
//
// The end-to-end browser-driven proof that result.html actually fires (or
// correctly doesn't fire) FirstVideoCreated using this mechanism lives in
// test/first-video-created-behavioral.test.js — this file is server-side
// unit coverage only, same split as send-first-dream-email.js/
// test/send-first-dream-email.test.js.
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/mark-generation-completed')];
  delete require.cache[require.resolve('../netlify/functions/consume-generation-marker')];
  delete require.cache[require.resolve('../netlify/functions/lib/generation-completion-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
  delete process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY;
});

// ===== lib/generation-completion-store.js =====

test('generation-completion-store: markCompleted then consumeIfPresent -- true the first time, false every time after', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  await store.markCompleted(event, 'dream-abc');
  var first = await store.consumeIfPresent(event, 'dream-abc');
  assert.equal(first, true);

  var second = await store.consumeIfPresent(event, 'dream-abc');
  assert.equal(second, false, 'the marker was already consumed by the first call');
});

test('generation-completion-store: consumeIfPresent for a dreamId that was never marked returns false', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  var result = await store.consumeIfPresent(event, 'never-marked-dream');
  assert.equal(result, false);
});

test('generation-completion-store: different dream ids get independent markers', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  await store.markCompleted(event, 'dream-1');
  await store.markCompleted(event, 'dream-2');

  var consumedOther = await store.consumeIfPresent(event, 'dream-2');
  assert.equal(consumedOther, true);
  var stillThere = await store.consumeIfPresent(event, 'dream-1');
  assert.equal(stillThere, true, 'marking/consuming one dream must not touch a different dream\'s own marker');
});

test('generation-completion-store: a fresh mark overwrites a previous unconsumed one for the same dreamId', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  await store.markCompleted(event, 'dream-regenerate');
  await store.markCompleted(event, 'dream-regenerate'); // e.g. a regenerate re-marking the same id
  var consumed = await store.consumeIfPresent(event, 'dream-regenerate');
  assert.equal(consumed, true, 'still consumable exactly once after being marked twice');
  var consumedAgain = await store.consumeIfPresent(event, 'dream-regenerate');
  assert.equal(consumedAgain, false);
});

test('generation-completion-store: markCompleted/consumeIfPresent no-op safely for an empty/missing dreamId', async function () {
  var store = require('../netlify/functions/lib/generation-completion-store');
  var event = fakeEvent({ method: 'POST' });

  await store.markCompleted(event, null);
  await store.markCompleted(event, '');
  var result = await store.consumeIfPresent(event, null);
  assert.equal(result, false);
});

// ===== mark-generation-completed.js =====

test('mark-generation-completed: a valid dreamId is recorded and later consumable', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { dreamId: 'dream-e2e-1' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  var store = require('../netlify/functions/lib/generation-completion-store');
  var consumed = await store.consumeIfPresent(fakeEvent({ method: 'POST' }), 'dream-e2e-1');
  assert.equal(consumed, true);
});

test('mark-generation-completed: missing dreamId -> E3, still 400 (nothing to record)', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3/);
});

test('mark-generation-completed: wrong method -> E1', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1/);
});

test('mark-generation-completed: invalid JSON body -> E2', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var res = await markHandler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': nextIp() }, body: 'not json', queryStringParameters: {} });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2/);
});

test('mark-generation-completed: per-IP rate limit blocks further marks from the same source once exceeded', async function () {
  process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY = '2';
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var ip = nextIp();

  var r1 = await markHandler(fakeEvent({ method: 'POST', ip: ip, body: { dreamId: 'dream-rl-1' } }));
  var r2 = await markHandler(fakeEvent({ method: 'POST', ip: ip, body: { dreamId: 'dream-rl-2' } }));
  var r3 = await markHandler(fakeEvent({ method: 'POST', ip: ip, body: { dreamId: 'dream-rl-3' } }));

  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r3.statusCode, 429);
});

// ===== consume-generation-marker.js =====

test('consume-generation-marker: end-to-end -- mark then consume matches exactly once, false after', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;

  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { dreamId: 'dream-flow-1' } }));

  var first = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { dreamId: 'dream-flow-1' } }));
  assert.equal(JSON.parse(first.body).matched, true);

  var second = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { dreamId: 'dream-flow-1' } }));
  assert.equal(JSON.parse(second.body).matched, false, 'the marker was already consumed -- a reload of result.html must not match again');
});

test('consume-generation-marker: a dreamId that was never marked returns matched:false (an ordinary revisit of an old dream)', async function () {
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var res = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { dreamId: 'never-marked-dream-2' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).matched, false);
});

test('consume-generation-marker: a different dreamId than the one marked does not match', async function () {
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;

  await markHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { dreamId: 'dream-real-1' } }));
  var res = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { dreamId: 'dream-imposter-1' } }));
  assert.equal(JSON.parse(res.body).matched, false);

  // The real marker must still be there, untouched by the mismatched attempt.
  var stillThere = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { dreamId: 'dream-real-1' } }));
  assert.equal(JSON.parse(stillThere.body).matched, true);
});

test('consume-generation-marker: missing dreamId -> E3', async function () {
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var res = await consumeHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3/);
});

test('consume-generation-marker: wrong method -> E1', async function () {
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var res = await consumeHandler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1/);
});

test('consume-generation-marker: invalid JSON body -> E2', async function () {
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var res = await consumeHandler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': nextIp() }, body: 'not json', queryStringParameters: {} });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2/);
});

test('consume-generation-marker: per-IP rate limit blocks further consume attempts from the same source once exceeded', async function () {
  process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY = '2';
  var consumeHandler = require('../netlify/functions/consume-generation-marker').handler;
  var ip = nextIp();

  var r1 = await consumeHandler(fakeEvent({ method: 'POST', ip: ip, body: { dreamId: 'dream-x1' } }));
  var r2 = await consumeHandler(fakeEvent({ method: 'POST', ip: ip, body: { dreamId: 'dream-x2' } }));
  var r3 = await consumeHandler(fakeEvent({ method: 'POST', ip: ip, body: { dreamId: 'dream-x3' } }));

  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r3.statusCode, 429);
});
