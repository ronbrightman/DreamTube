// test/report-smoke-status.test.js
//
// Covers netlify/functions/report-smoke-status.js — tracker item
// for-product-reliability-net-spec-v1-smok-x1o5zc. Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/report-smoke-status').handler;
var smokeStatusStore = require('../netlify/functions/lib/smoke-status-store');

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.SMOKE_STATUS_REPORT_TOKEN;
});

test('rejects a non-POST method', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('E2 invalid_json on a malformed body', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /E2/);
});

test('E3 not_configured when SMOKE_STATUS_REPORT_TOKEN is unset -- soft-fails closed, never writes', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'anything', checkGroup: 'seeded-journeys', domain: 'dreamtube.life', ok: true } }));
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /E3/);

  var results = await smokeStatusStore.getAllResults(fakeEvent({}));
  assert.deepEqual(results, [], 'must never write when not configured, even with a payload that would otherwise be valid');
});

test('E4 invalid_token when configured but the caller sends the wrong secret', async function () {
  process.env.SMOKE_STATUS_REPORT_TOKEN = 'the-real-secret';
  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'wrong-guess', checkGroup: 'seeded-journeys', domain: 'dreamtube.life', ok: true } }));
  assert.equal(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /E4/);
});

test('E5 invalid_payload when checkGroup/domain/ok are missing or the wrong type', async function () {
  process.env.SMOKE_STATUS_REPORT_TOKEN = 'the-real-secret';

  var missingDomain = await handler(fakeEvent({ method: 'POST', body: { token: 'the-real-secret', checkGroup: 'seeded-journeys', ok: true } }));
  assert.equal(missingDomain.statusCode, 400);
  assert.match(JSON.parse(missingDomain.body).error, /E5/);

  var okNotBoolean = await handler(fakeEvent({ method: 'POST', body: { token: 'the-real-secret', checkGroup: 'seeded-journeys', domain: 'dreamtube.life', ok: 'yes' } }));
  assert.equal(okNotBoolean.statusCode, 400);
  assert.match(JSON.parse(okNotBoolean.body).error, /E5/);
});

test('a correctly-authed, valid payload writes through to the shared store and returns ok:true', async function () {
  process.env.SMOKE_STATUS_REPORT_TOKEN = 'the-real-secret';

  var res = await handler(fakeEvent({
    method: 'POST',
    body: { token: 'the-real-secret', checkGroup: 'seeded-journeys', domain: 'dreamtube.life', ok: false, summary: 'signup wall test failed', checks: [{ name: 'signup-wall', ok: false }] }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  var results = await smokeStatusStore.getAllResults(fakeEvent({}));
  assert.equal(results.length, 1);
  assert.equal(results[0].checkGroup, 'seeded-journeys');
  assert.equal(results[0].domain, 'dreamtube.life');
  assert.equal(results[0].ok, false);
  assert.equal(results[0].summary, 'signup wall test failed');
  assert.deepEqual(results[0].checks, [{ name: 'signup-wall', ok: false }]);
});
