// test/get-deploy-count.test.js
//
// Covers netlify/functions/get-deploy-count.js — tracker item
// for-product-surface-deploys-day-as-a-vis-xld1vk. Run with:
// node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/get-deploy-count').handler;
var deployLogStore = require('../netlify/functions/lib/deploy-log-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('rejects a non-GET method', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'E1: method_not_allowed');
});

test('defaults to today (UTC) and returns count 0 before anything has ever been written -- no auth required to read', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.date, deployLogStore.utcDateStr());
  assert.equal(data.count, 0);
});

test('counts real deploy-log entries written for today -- write path (recordBuildTimeDeploy) -> read path (this endpoint), same store', async function () {
  var baseEnv = { SITE_ID: 'site-abc', NETLIFY_BLOBS_BUILD_TOKEN: 'tok' };
  await deployLogStore.recordBuildTimeDeploy(Object.assign({}, baseEnv, { DEPLOY_ID: 'dep-1' }));
  await deployLogStore.recordBuildTimeDeploy(Object.assign({}, baseEnv, { DEPLOY_ID: 'dep-2' }));
  await deployLogStore.recordBuildTimeDeploy(Object.assign({}, baseEnv, { DEPLOY_ID: 'dep-3' }));

  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.count, 3);
});

test('accepts a ?date= query param for a specific past date, scoped to just that date', async function () {
  var { getStore, connectLambda } = require('@netlify/blobs');
  connectLambda(fakeEvent({}));
  var store = getStore({ name: deployLogStore.STORE_NAME });
  await store.setJSON(deployLogStore.keyFor('2026-08-01', 'dep-old-1'), { deployId: 'dep-old-1' });
  await store.setJSON(deployLogStore.keyFor('2026-08-01', 'dep-old-2'), { deployId: 'dep-old-2' });
  await store.setJSON(deployLogStore.keyFor('2026-08-02', 'dep-other-day'), { deployId: 'dep-other-day' });

  var res = await handler(fakeEvent({ method: 'GET', query: { date: '2026-08-01' } }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.date, '2026-08-01');
  assert.equal(data.count, 2);
});

test('rejects a malformed ?date= with E2 rather than silently falling back to today', async function () {
  var res = await handler(fakeEvent({ method: 'GET', query: { date: 'not-a-date' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E2: invalid_date');
});

test('rejects an almost-right date shape too (single-digit month, no zero-padding)', async function () {
  var res = await handler(fakeEvent({ method: 'GET', query: { date: '2026-8-1' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E2: invalid_date');
});
