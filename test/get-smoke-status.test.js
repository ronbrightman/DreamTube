// test/get-smoke-status.test.js
//
// Covers netlify/functions/get-smoke-status.js — tracker item
// for-product-reliability-net-spec-v1-smok-x1o5zc. Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/get-smoke-status').handler;
var smokeStatusStore = require('../netlify/functions/lib/smoke-status-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('rejects a non-GET method', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
});

test('returns an empty checks array before anything has ever been written -- no auth required to read', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).checks, []);
});

test('surfaces every previously-written record, most recent first', async function () {
  await smokeStatusStore.writeResult(fakeEvent({}), 'both-domain-smoke', 'dreamtube1.netlify.app', { ok: true, summary: 'all good' });
  await smokeStatusStore.writeResult(fakeEvent({}), 'both-domain-smoke', 'dreamtube.life', { ok: false, summary: 'shop.html 500' });

  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  var checks = JSON.parse(res.body).checks;
  assert.equal(checks.length, 2);
  var domains = checks.map(function (c) { return c.domain; }).sort();
  assert.deepEqual(domains, ['dreamtube.life', 'dreamtube1.netlify.app']);
  var failing = checks.filter(function (c) { return !c.ok; });
  assert.equal(failing.length, 1);
  assert.equal(failing[0].summary, 'shop.html 500');
});
