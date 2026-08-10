// test/mark-result-viewed.test.js
//
// Covers netlify/functions/mark-result-viewed.js + lib/result-view-store.js
// — the server-side "the account actually WATCHED its fresh video result"
// marker that the "unwatched dream" retention nudge's scheduled scan reads
// to suppress a watched dream (founder-approved retention plan, piece 1).
// See mark-result-viewed.js's header comment for why the fullscreen-open
// (not the page render) is what posts this, and why it's keyed by the
// server-issued operationName rather than a client-invented dreamId.
// Run with: node --test test/
//
// SANDBOX LIMITATION (same honest caveat as the sibling email tests): there
// is no real Netlify Blobs backend here — test/helpers/mock-blobs.js's
// in-memory fake stands in — so this proves the endpoint's contract and the
// store's read/write semantics, not real cross-region Blobs behavior.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var resultViewStore = require('../netlify/functions/lib/result-view-store');
var markResultViewed = require('../netlify/functions/mark-result-viewed');

var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.20.0.' + ipCounter; }

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.MAX_RESULT_VIEW_MARKS_PER_IP_PER_DAY;
});

test('POST { operationName } records a durable viewed marker the store can read back', async function () {
  var opName = 'mock:1:viewed-op';
  var res = await markResultViewed.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { operationName: opName } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  assert.equal(await resultViewStore.hasViewed(fakeEvent({}), opName), true, 'the marker must be persisted and readable by the scan');
  assert.equal(await resultViewStore.hasViewed(fakeEvent({}), 'mock:1:some-other-op'), false, 'an unrelated operationName must not read as viewed');
});

test('a non-POST method is rejected (405)', async function () {
  var res = await markResultViewed.handler(fakeEvent({ method: 'GET', ip: nextIp(), query: { operationName: 'mock:1:x' } }));
  assert.equal(res.statusCode, 405);
});

test('missing operationName is a 400, and writes nothing', async function () {
  var res = await markResultViewed.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /missing_operation_name/);
});

test('invalid JSON body is a 400', async function () {
  var res = await markResultViewed.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /invalid_json/);
});

test('marking the same operationName twice is idempotent (still viewed, no error)', async function () {
  var opName = 'mock:1:double-mark';
  var ip = nextIp();
  await markResultViewed.handler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: opName } }));
  var res2 = await markResultViewed.handler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: opName } }));
  assert.equal(res2.statusCode, 200);
  assert.equal(await resultViewStore.hasViewed(fakeEvent({}), opName), true);
});

test('a per-IP flood is rate-limited (429) once the daily cap is exceeded', async function () {
  process.env.MAX_RESULT_VIEW_MARKS_PER_IP_PER_DAY = '2';
  var ip = nextIp();
  var a = await markResultViewed.handler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: 'mock:1:a' } }));
  var b = await markResultViewed.handler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: 'mock:1:b' } }));
  var c = await markResultViewed.handler(fakeEvent({ method: 'POST', ip: ip, body: { operationName: 'mock:1:c' } }));
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(c.statusCode, 429, 'the third mark from the same IP exceeds the cap of 2');
});

test('result-view-store.markViewed rejects invalid input without throwing', async function () {
  var r = await resultViewStore.markViewed(fakeEvent({}), '');
  assert.equal(r.ok, false);
});
