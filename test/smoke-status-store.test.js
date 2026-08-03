// test/smoke-status-store.test.js
//
// Covers netlify/functions/lib/smoke-status-store.js in isolation —
// tracker item for-product-reliability-net-spec-v1-smok-x1o5zc.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var smokeStatusStore = require('../netlify/functions/lib/smoke-status-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('writeResult stamps checkGroup, domain, and a checkedAt timestamp onto the stored record', async function () {
  var record = await smokeStatusStore.writeResult(fakeEvent({}), 'both-domain-smoke', 'dreamtube.life', { ok: true, summary: 'all good' });
  assert.equal(record.checkGroup, 'both-domain-smoke');
  assert.equal(record.domain, 'dreamtube.life');
  assert.equal(record.ok, true);
  assert.equal(record.summary, 'all good');
  assert.equal(typeof record.checkedAt, 'string');
  assert.ok(!isNaN(Date.parse(record.checkedAt)), 'checkedAt must be a real parseable timestamp');
});

test('getAllResults is empty before anything has ever been written', async function () {
  var results = await smokeStatusStore.getAllResults(fakeEvent({}));
  assert.deepEqual(results, []);
});

test('different checkGroup+domain pairs are independent keys -- writing one never clobbers another', async function () {
  await smokeStatusStore.writeResult(fakeEvent({}), 'both-domain-smoke', 'dreamtube1.netlify.app', { ok: true });
  await smokeStatusStore.writeResult(fakeEvent({}), 'both-domain-smoke', 'dreamtube.life', { ok: false });
  await smokeStatusStore.writeResult(fakeEvent({}), 'seeded-journeys', 'dreamtube.life', { ok: true });

  var results = await smokeStatusStore.getAllResults(fakeEvent({}));
  assert.equal(results.length, 3);

  var byKey = {};
  results.forEach(function (r) { byKey[smokeStatusStore.keyFor(r.checkGroup, r.domain)] = r; });
  assert.equal(byKey['both-domain-smoke::dreamtube1.netlify.app'].ok, true);
  assert.equal(byKey['both-domain-smoke::dreamtube.life'].ok, false);
  assert.equal(byKey['seeded-journeys::dreamtube.life'].ok, true);
});

test('writing the SAME checkGroup+domain pair twice overwrites the earlier result (last-write-wins, no history) -- see this file\'s own header comment on why that\'s the deliberate design', async function () {
  await smokeStatusStore.writeResult(fakeEvent({}), 'both-domain-smoke', 'dreamtube.life', { ok: false, summary: 'first run failed' });
  await smokeStatusStore.writeResult(fakeEvent({}), 'both-domain-smoke', 'dreamtube.life', { ok: true, summary: 'second run passed' });

  var results = await smokeStatusStore.getAllResults(fakeEvent({}));
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].summary, 'second run passed');
});

test('getAllResults sorts newest-checked first', async function () {
  await smokeStatusStore.writeResult(fakeEvent({}), 'both-domain-smoke', 'dreamtube1.netlify.app', { ok: true });
  // Force a distinguishable, strictly-later timestamp for the second write
  // without a real sleep -- writeResult always stamps checkedAt itself
  // from Date.now(), so directly seed a record with an explicit, clearly
  // earlier timestamp to make the ordering assertion deterministic rather
  // than timing-dependent.
  var earlier = await smokeStatusStore.writeResult(fakeEvent({}), 'seeded-journeys', 'dreamtube.life', { ok: true });
  mockBlobs.seed(smokeStatusStore.STORE_NAME, smokeStatusStore.keyFor('seeded-journeys', 'dreamtube.life'), Object.assign({}, earlier, { checkedAt: '2000-01-01T00:00:00.000Z' }));

  var results = await smokeStatusStore.getAllResults(fakeEvent({}));
  assert.equal(results.length, 2);
  assert.ok(results[0].checkedAt > results[1].checkedAt, 'newest checkedAt must come first');
});
