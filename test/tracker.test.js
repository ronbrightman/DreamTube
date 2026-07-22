// test/tracker.test.js
//
// Covers netlify/functions/get-tracker-items.js and
// netlify/functions/update-tracker-item.js: seed-once behavior (first call
// seeds+persists, later calls don't re-seed over edits), owner-only
// enforcement on the update endpoint, and priority/done update persistence.
// Same patterns as test/admin-paywall-toggle.test.js. Run with:
//   node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';

function withEnv(vars, fn) {
  var previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; });
  Object.keys(vars).forEach(function (k) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  });
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      Object.keys(previous).forEach(function (k) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      });
    });
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/get-tracker-items')];
  delete require.cache[require.resolve('../netlify/functions/update-tracker-item')];
  delete require.cache[require.resolve('../netlify/functions/lib/tracker-store')];
});

// ===== get-tracker-items.js =====

test('GET seeds the store on first call and returns every seed item', async function () {
  var getHandler = require('../netlify/functions/get-tracker-items').handler;
  var trackerStore = require('../netlify/functions/lib/tracker-store');

  var res = await getHandler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.items.length, trackerStore.SEED_ITEMS.length);
  // Every seed item shows up unchanged (id, category, title, priority, done).
  trackerStore.SEED_ITEMS.forEach(function (seedItem) {
    var got = body.items.find(function (i) { return i.id === seedItem.id; });
    assert.ok(got, 'seed item ' + seedItem.id + ' missing from response');
    assert.equal(got.category, seedItem.category);
    assert.equal(got.title, seedItem.title);
    assert.equal(got.detail, seedItem.detail);
    assert.equal(got.priority, seedItem.priority);
    assert.equal(got.done, seedItem.done);
  });
});

test('GET only seeds once — a second call does not re-seed over an edit made in between', async function () {
  var getHandler = require('../netlify/functions/get-tracker-items').handler;
  var updateHandler = require('../netlify/functions/update-tracker-item').handler;
  var trackerStore = require('../netlify/functions/lib/tracker-store');
  var firstId = trackerStore.SEED_ITEMS[0].id;

  await getHandler(fakeEvent({ method: 'GET' })); // triggers the seed

  await withEnv({ OWNER_EMAIL: OWNER_EMAIL }, function () {
    return updateHandler(fakeEvent({
      method: 'POST',
      body: { id: firstId, email: OWNER_EMAIL, done: true }
    }));
  });

  var res = await getHandler(fakeEvent({ method: 'GET' }));
  var body = JSON.parse(res.body);
  var edited = body.items.find(function (i) { return i.id === firstId; });
  assert.equal(edited.done, true, 'the edit must survive a later GET, not be reset by re-seeding');
  assert.equal(body.items.length, trackerStore.SEED_ITEMS.length, 'count must stay the same, not double up from re-seeding');
});

test('GET response includes both categories: task and idea', async function () {
  var getHandler = require('../netlify/functions/get-tracker-items').handler;
  var res = await getHandler(fakeEvent({ method: 'GET' }));
  var body = JSON.parse(res.body);
  var categories = body.items.map(function (i) { return i.category; });
  assert.ok(categories.indexOf('task') !== -1);
  assert.ok(categories.indexOf('idea') !== -1);
});

test('GET unsupported method is rejected with 405', async function () {
  var getHandler = require('../netlify/functions/get-tracker-items').handler;
  var res = await getHandler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

// ===== update-tracker-item.js =====

test('POST from the owner updates priority and done, and it persists across a later GET', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[0].id;

    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: OWNER_EMAIL, priority: 'low', done: true }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.item.id, id);
    assert.equal(body.item.priority, 'low');
    assert.equal(body.item.done, true);
    // title/detail/category must be untouched.
    assert.equal(body.item.title, trackerStore.SEED_ITEMS[0].title);
    assert.equal(body.item.category, trackerStore.SEED_ITEMS[0].category);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    var persisted = getBody.items.find(function (i) { return i.id === id; });
    assert.equal(persisted.priority, 'low');
    assert.equal(persisted.done, true);
  });
});

test('POST updating only `done` leaves priority untouched, and vice versa', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[1].id;
    var originalPriority = trackerStore.SEED_ITEMS[1].priority;

    var res1 = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: OWNER_EMAIL, done: true }
    }));
    var body1 = JSON.parse(res1.body);
    assert.equal(body1.item.done, true);
    assert.equal(body1.item.priority, originalPriority);

    var res2 = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: OWNER_EMAIL, priority: 'high' }
    }));
    var body2 = JSON.parse(res2.body);
    assert.equal(body2.item.priority, 'high');
    assert.equal(body2.item.done, true, 'done must survive an update that only touches priority');
  });
});

test('POST from a non-owner email is rejected with 403 and does not write anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[0].id;

    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: 'not-the-owner@example.com', done: true }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E8: forbidden/);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    var untouched = getBody.items.find(function (i) { return i.id === id; });
    assert.equal(untouched.done, false);
  });
});

test('POST with a missing email is rejected with 403, same as a wrong one', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, done: true }
    }));
    assert.equal(res.statusCode, 403);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured at all', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: 'anything', email: 'anyone@example.com', done: true }
    }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('POST with a missing id is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, done: true }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: missing_id/);
  });
});

test('POST with neither priority nor done is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E5: no_fields_to_update/);
  });
});

test('POST with an invalid priority value is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, priority: 'urgent' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E6: invalid_priority/);
  });
});

test('POST with a non-boolean done value is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, done: 'yes' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E7: invalid_done/);
  });
});

test('POST with an unknown id is rejected with 404, even from the owner', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: 'does-not-exist', email: OWNER_EMAIL, done: true }
    }));
    assert.equal(res.statusCode, 404);
    assert.match(JSON.parse(res.body).error, /^E9: item_not_found/);
  });
});

test('bad shape (missing id) is rejected before the owner check even matters', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    // Wrong email AND missing id — must fail on the shape problem (400), not
    // the auth problem (403), same ordering discipline as
    // admin-paywall-toggle.js's enabled-must-be-boolean-before-forbidden test.
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { email: 'not-the-owner@example.com', done: true }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: missing_id/);
  });
});

test('unsupported method is rejected with 405', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var res = await updateHandler(fakeEvent({ method: 'DELETE' }));
    assert.equal(res.statusCode, 405);
  });
});
