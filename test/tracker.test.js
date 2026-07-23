// test/tracker.test.js
//
// Covers netlify/functions/get-tracker-items.js,
// netlify/functions/update-tracker-item.js,
// netlify/functions/add-tracker-item.js, and
// netlify/functions/delete-tracker-item.js: seed-once behavior (first call
// seeds+persists, later calls don't re-seed over edits), owner-only
// enforcement on every write endpoint, priority/done/comment update
// persistence, and add/delete's own validation + persistence. Same patterns
// as test/admin-paywall-toggle.test.js. Run with:
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
  delete require.cache[require.resolve('../netlify/functions/add-tracker-item')];
  delete require.cache[require.resolve('../netlify/functions/delete-tracker-item')];
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
  // Every seed item shows up unchanged (id, category, title, priority, done,
  // comments, createdAt, doneAt, startedAt).
  trackerStore.SEED_ITEMS.forEach(function (seedItem) {
    var got = body.items.find(function (i) { return i.id === seedItem.id; });
    assert.ok(got, 'seed item ' + seedItem.id + ' missing from response');
    assert.equal(got.category, seedItem.category);
    assert.equal(got.title, seedItem.title);
    assert.equal(got.detail, seedItem.detail);
    assert.equal(got.priority, seedItem.priority);
    assert.equal(got.done, seedItem.done);
    assert.deepEqual(got.comments, seedItem.comments);
    assert.equal(got.createdAt, seedItem.createdAt);
    assert.equal(got.doneAt, seedItem.doneAt);
    assert.equal(got.startedAt, seedItem.startedAt);
  });
});

test('every seed item has an empty comments array, and a null createdAt/doneAt/startedAt — no fabricated history', function () {
  var trackerStore = require('../netlify/functions/lib/tracker-store');
  trackerStore.SEED_ITEMS.forEach(function (seedItem) {
    assert.ok(Array.isArray(seedItem.comments));
    assert.equal(seedItem.comments.length, 0);
    assert.equal(seedItem.createdAt, null);
    assert.equal(seedItem.doneAt, null);
    assert.equal(seedItem.startedAt, null);
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

// ===== schema migration: legacy `comment` (string) -> `comments` (array) =====
//
// A real, already-deployed environment's Blobs store may still contain
// items shaped the old way (an earlier branch shipped the single
// overwritable `comment` field before this build replaced it) — these
// tests seed that legacy shape directly into the mock store (bypassing
// getItems()' own seeding) and confirm getItems() self-heals it on read,
// same "materialize on first read" spirit as this file's own seeding step.

test('a legacy item with a non-empty `comment` string is migrated into a single `comments` entry (author "ron", timestamp null) and the old field is dropped', async function () {
  var trackerStore = require('../netlify/functions/lib/tracker-store');
  var legacyItem = { id: 'legacy-1', category: 'task', title: 'Legacy item', detail: 'Detail.', priority: 'medium', done: false, comment: 'an old-style saved comment' };
  mockBlobs.seed(trackerStore.STORE_NAME, trackerStore.KEY, [legacyItem]);

  var items = await trackerStore.getItems(fakeEvent({ method: 'GET' }));
  var migrated = items.find(function (i) { return i.id === 'legacy-1'; });
  assert.ok(migrated, 'the legacy item must still be present after migration');
  assert.equal(migrated.comment, undefined, 'the legacy `comment` field must be dropped once migrated');
  assert.equal(migrated.comments.length, 1);
  assert.equal(migrated.comments[0].text, 'an old-style saved comment');
  assert.equal(migrated.comments[0].author, 'ron', 'the old field was owner-write-only, so any pre-existing value can only have been written by the founder');
  assert.equal(migrated.comments[0].timestamp, null, 'no real historical timestamp exists for pre-migration content -- must not be fabricated');
  assert.equal(migrated.createdAt, null);
  assert.equal(migrated.doneAt, null);
  assert.equal(migrated.startedAt, null);
});

test('a legacy item with an empty-string `comment` migrates to an empty `comments` array, not a spurious entry', async function () {
  var trackerStore = require('../netlify/functions/lib/tracker-store');
  var legacyItem = { id: 'legacy-2', category: 'task', title: 'Legacy item 2', detail: 'Detail.', priority: 'medium', done: false, comment: '' };
  mockBlobs.seed(trackerStore.STORE_NAME, trackerStore.KEY, [legacyItem]);

  var items = await trackerStore.getItems(fakeEvent({ method: 'GET' }));
  var migrated = items.find(function (i) { return i.id === 'legacy-2'; });
  assert.deepEqual(migrated.comments, []);
});

test('migration persists -- a second GET does not re-derive from the legacy shape again (no duplicate comment entries)', async function () {
  var trackerStore = require('../netlify/functions/lib/tracker-store');
  var legacyItem = { id: 'legacy-3', category: 'task', title: 'Legacy item 3', detail: 'Detail.', priority: 'medium', done: false, comment: 'note' };
  mockBlobs.seed(trackerStore.STORE_NAME, trackerStore.KEY, [legacyItem]);

  await trackerStore.getItems(fakeEvent({ method: 'GET' })); // triggers migration + persist
  var items = await trackerStore.getItems(fakeEvent({ method: 'GET' })); // second read
  var migrated = items.find(function (i) { return i.id === 'legacy-3'; });
  assert.equal(migrated.comments.length, 1, 'a second read must not re-migrate and duplicate the entry');
});

test('an item already in the new shape is left untouched by migration (no unnecessary re-write)', async function () {
  var trackerStore = require('../netlify/functions/lib/tracker-store');
  var modernItem = { id: 'modern-1', category: 'task', title: 'Modern item', detail: 'Detail.', priority: 'medium', done: false, comments: [{ id: 'c-1', author: 'ron', text: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }], createdAt: '2026-01-01T00:00:00.000Z', doneAt: null, startedAt: null };
  mockBlobs.seed(trackerStore.STORE_NAME, trackerStore.KEY, [modernItem]);

  var items = await trackerStore.getItems(fakeEvent({ method: 'GET' }));
  var got = items.find(function (i) { return i.id === 'modern-1'; });
  assert.deepEqual(got, modernItem);
});

// ===== update-tracker-item.js =====

test('POST from the owner updates priority and done, and it persists across a later GET', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    // SEED_ITEMS[1] rather than [0]: [0] ('token-refund-gap') already
    // starts done:true in the seed data, which would make this a no-op
    // done:true -> done:true transition and never actually exercise the
    // false -> true doneAt derivation this test checks.
    var id = trackerStore.SEED_ITEMS[1].id;

    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: OWNER_EMAIL, priority: 'low', done: true }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.item.id, id);
    assert.equal(body.item.priority, 'low');
    assert.equal(body.item.done, true);
    assert.equal(typeof body.item.doneAt, 'string', 'a false -> true done transition must set a real doneAt');
    // title/detail/category must be untouched.
    assert.equal(body.item.title, trackerStore.SEED_ITEMS[1].title);
    assert.equal(body.item.category, trackerStore.SEED_ITEMS[1].category);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    var persisted = getBody.items.find(function (i) { return i.id === id; });
    assert.equal(persisted.priority, 'low');
    assert.equal(persisted.done, true);
    assert.equal(persisted.doneAt, body.item.doneAt);
  });
});

test('POST setting done back to false clears doneAt', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    // SEED_ITEMS[1]: [0] already starts done:true (see the test above).
    var id = trackerStore.SEED_ITEMS[1].id;

    var res1 = await updateHandler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL, done: true } }));
    assert.equal(typeof JSON.parse(res1.body).item.doneAt, 'string');

    var res2 = await updateHandler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL, done: false } }));
    var body2 = JSON.parse(res2.body);
    assert.equal(body2.item.done, false);
    assert.equal(body2.item.doneAt, null, 'un-marking done must clear doneAt back to null');
  });
});

test('POST setting done:true on an item that is already done does not bump its existing doneAt to a newer timestamp', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[0].id;

    var res1 = await updateHandler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL, done: true } }));
    var firstDoneAt = JSON.parse(res1.body).item.doneAt;

    var res2 = await updateHandler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL, done: true } }));
    var secondDoneAt = JSON.parse(res2.body).item.doneAt;
    assert.equal(secondDoneAt, firstDoneAt, 'a done:true patch on an already-done item must be a no-op on doneAt, not bump it');
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

test('POST with a `comment`+`commentAuthor` appends a new comment entry and leaves priority/done untouched', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var seedItem = trackerStore.SEED_ITEMS[2];
    var id = seedItem.id;

    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: OWNER_EMAIL, comment: 'actually this is lower priority', commentAuthor: 'ron' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.item.comments.length, 1);
    assert.equal(body.item.comments[0].text, 'actually this is lower priority');
    assert.equal(body.item.comments[0].author, 'ron');
    assert.equal(typeof body.item.comments[0].timestamp, 'string');
    assert.equal(typeof body.item.comments[0].id, 'string');
    assert.equal(body.item.priority, seedItem.priority);
    assert.equal(body.item.done, seedItem.done);
    // title/detail/category must still be untouched too.
    assert.equal(body.item.title, seedItem.title);
    assert.equal(body.item.detail, seedItem.detail);
    assert.equal(body.item.category, seedItem.category);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    var persisted = getBody.items.find(function (i) { return i.id === id; });
    assert.equal(persisted.comments.length, 1);
    assert.equal(persisted.comments[0].text, 'actually this is lower priority');
  });
});

test('a second comment on the same item APPENDS rather than replacing the first', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[3].id;

    await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: OWNER_EMAIL, comment: 'first note', commentAuthor: 'ron' }
    }));

    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: OWNER_EMAIL, comment: 'second note', commentAuthor: 'claude' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.item.comments.length, 2, "the earlier comment must survive -- this is an append, not the old overwritable `comment` field");
    assert.equal(body.item.comments[0].text, 'first note');
    assert.equal(body.item.comments[0].author, 'ron');
    assert.equal(body.item.comments[1].text, 'second note');
    assert.equal(body.item.comments[1].author, 'claude');
  });
});

test('POST with an empty-string comment is rejected with 400 -- there is nothing to "clear" in an append-only list', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, comment: '', commentAuthor: 'ron' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E10: invalid_comment/);
  });
});

test('POST with a comment but a missing/invalid commentAuthor is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');

    var res1 = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, comment: 'a note' }
    }));
    assert.equal(res1.statusCode, 400);
    assert.match(JSON.parse(res1.body).error, /^E10: invalid_comment/);

    var res2 = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, comment: 'a note', commentAuthor: 'someone-else' }
    }));
    assert.equal(res2.statusCode, 400);
    assert.match(JSON.parse(res2.body).error, /^E10: invalid_comment/);
  });
});

test('POST with a non-string comment is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, comment: 12345, commentAuthor: 'ron' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E10: invalid_comment/);
  });
});

test('POST with a comment longer than the max length is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var tooLong = new Array(2002).join('x'); // 2001 chars, one over the 2000 cap
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, comment: tooLong, commentAuthor: 'ron' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E10: invalid_comment/);
  });
});

test('POST with a comment at exactly the max length is accepted', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var maxLength = new Array(2001).join('x'); // exactly 2000 chars
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, comment: maxLength, commentAuthor: 'ron' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.item.comments[body.item.comments.length - 1].text.length, 2000);
  });
});

test('POST with a comment from a non-owner email is rejected with 403 and does not write anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[4].id;

    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: 'not-the-owner@example.com', comment: 'sneaky comment', commentAuthor: 'ron' }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E8: forbidden/);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    var untouched = getBody.items.find(function (i) { return i.id === id; });
    assert.deepEqual(untouched.comments, trackerStore.SEED_ITEMS[4].comments);
  });
});

// ===== `started` (one-way "start working on this" signal) =====

test('POST with started:true sets startedAt, and a second started:true is a no-op on the timestamp', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[5].id;

    var res1 = await updateHandler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL, started: true } }));
    assert.equal(res1.statusCode, 200);
    var body1 = JSON.parse(res1.body);
    assert.equal(typeof body1.item.startedAt, 'string');

    var res2 = await updateHandler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL, started: true } }));
    var body2 = JSON.parse(res2.body);
    assert.equal(body2.item.startedAt, body1.item.startedAt, 'a second started:true on an already-started item must not bump the timestamp -- there is no "un-start", so this must stay idempotent');
  });
});

test('POST with started:false is rejected with 400 -- this endpoint never accepts un-starting', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, started: false }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E11: invalid_started/);
  });
});

test('POST with started:true from a non-owner email is rejected with 403 and does not write anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[6].id;

    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: id, email: 'not-the-owner@example.com', started: true }
    }));
    assert.equal(res.statusCode, 403);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    var untouched = getBody.items.find(function (i) { return i.id === id; });
    assert.equal(untouched.startedAt, null);
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
    // Compare against the seed's own starting value, not a hardcoded
    // `false` — the rejected POST tried to set done:true regardless of
    // where the item actually started, so "untouched" means "still
    // whatever the seed said," not "still false" specifically.
    assert.equal(untouched.done, trackerStore.SEED_ITEMS[0].done);
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

test('POST with only `comment` present does not trip the no_fields_to_update check', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: OWNER_EMAIL, comment: 'just a note', commentAuthor: 'ron' }
    }));
    assert.equal(res.statusCode, 200);
  });
});

test('bad comment shape (non-string) is rejected before the owner check even matters', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var updateHandler = require('../netlify/functions/update-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    // Wrong email AND a non-string comment — must fail on the shape problem
    // (400), not the auth problem (403), same ordering discipline as the
    // missing-id case below.
    var res = await updateHandler(fakeEvent({
      method: 'POST',
      body: { id: trackerStore.SEED_ITEMS[0].id, email: 'not-the-owner@example.com', comment: 999 }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E10: invalid_comment/);
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

// ===== add-tracker-item.js =====

test('POST from the owner creates a new item with a real generated id and correct defaults, and it persists across a later GET', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');

    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: 'New task title', detail: 'New task detail.', priority: 'high' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.item.category, 'task');
    assert.equal(body.item.title, 'New task title');
    assert.equal(body.item.detail, 'New task detail.');
    assert.equal(body.item.priority, 'high');
    assert.equal(body.item.done, false);
    assert.deepEqual(body.item.comments, []);
    assert.equal(typeof body.item.createdAt, 'string', 'a brand-new item must get a real createdAt, unlike SEED_ITEMS\' null fallback');
    assert.equal(body.item.doneAt, null);
    assert.equal(body.item.startedAt, null);
    assert.equal(typeof body.item.id, 'string');
    assert.ok(body.item.id.length > 0, 'id must be a real, non-empty generated value');
    // Never trust a client-supplied id — nothing in the request even offered
    // one, and the response's id must not just echo something from the body.
    assert.notEqual(body.item.id, undefined);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    assert.equal(getBody.items.length, trackerStore.SEED_ITEMS.length + 1, 'the new item must be appended, not replace anything');
    var persisted = getBody.items.find(function (i) { return i.id === body.item.id; });
    assert.ok(persisted, 'the created item must be readable back from a later GET');
    assert.equal(persisted.title, 'New task title');
  });
});

test('POST with priority omitted defaults to medium', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'idea', title: 'An idea', detail: 'Some detail.' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.item.priority, 'medium');
  });
});

test('two items created from the same title get different ids', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res1 = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: 'Duplicate title', detail: 'First.' }
    }));
    var res2 = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: 'Duplicate title', detail: 'Second.' }
    }));
    var id1 = JSON.parse(res1.body).item.id;
    var id2 = JSON.parse(res2.body).item.id;
    assert.notEqual(id1, id2);
  });
});

test('POST with a missing category is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, title: 'Title', detail: 'Detail.' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: invalid_category/);
  });
});

test('POST with an invalid category value is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'bug', title: 'Title', detail: 'Detail.' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: invalid_category/);
  });
});

test('POST with a missing/empty title is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;

    var res1 = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', detail: 'Detail.' }
    }));
    assert.equal(res1.statusCode, 400);
    assert.match(JSON.parse(res1.body).error, /^E5: invalid_title/);

    var res2 = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: '   ', detail: 'Detail.' }
    }));
    assert.equal(res2.statusCode, 400);
    assert.match(JSON.parse(res2.body).error, /^E5: invalid_title/);
  });
});

test('POST with a title over 200 chars is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: 'x'.repeat(201), detail: 'Detail.' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E5: invalid_title/);
  });
});

test('POST with a missing/empty detail is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;

    var res1 = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: 'Title' }
    }));
    assert.equal(res1.statusCode, 400);
    assert.match(JSON.parse(res1.body).error, /^E6: invalid_detail/);

    var res2 = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: 'Title', detail: '' }
    }));
    assert.equal(res2.statusCode, 400);
    assert.match(JSON.parse(res2.body).error, /^E6: invalid_detail/);
  });
});

test('POST with a detail over 4000 chars is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: 'Title', detail: 'x'.repeat(4001) }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E6: invalid_detail/);
  });
});

test('POST with an invalid priority value is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: 'Title', detail: 'Detail.', priority: 'urgent' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E7: invalid_priority/);
  });
});

test('POST from a non-owner email is rejected with 403 and does not create anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');

    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: 'not-the-owner@example.com', category: 'task', title: 'Sneaky item', detail: 'Detail.' }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E8: forbidden/);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    assert.equal(getBody.items.length, trackerStore.SEED_ITEMS.length, 'a rejected add must not append anything');
  });
});

test('bad shape (missing category) is rejected before the owner check even matters', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: 'not-the-owner@example.com', title: 'Title', detail: 'Detail.' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: invalid_category/);
  });
});

test('add-tracker-item unsupported method is rejected with 405', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 405);
    assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
  });
});

test('add-tracker-item is rejected with 500 when OWNER_EMAIL is not configured at all', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: 'anyone@example.com', category: 'task', title: 'Title', detail: 'Detail.' }
    }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('POST with leading/trailing whitespace around title/detail persists them trimmed, not verbatim', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: '  Padded title  ', detail: '  Padded detail.  ' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.item.title, 'Padded title');
    assert.equal(body.item.detail, 'Padded detail.');
  });
});

test('a whitespace-padded title still rejected for exceeding the cap pre-trim (validated against the raw string, not the trimmed one)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var addHandler = require('../netlify/functions/add-tracker-item').handler;
    // 200 real chars plus padding — over the cap before trimming, even
    // though the trimmed content alone would fit.
    var res = await addHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, category: 'task', title: '  ' + 'x'.repeat(200) + '  ', detail: 'Detail.' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E5: invalid_title/);
  });
});

// ===== delete-tracker-item.js =====

test('POST from the owner deletes an existing item, and it is gone from a later GET', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var deleteHandler = require('../netlify/functions/delete-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[0].id;

    var res = await deleteHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, id: id }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.deleted, true);
    assert.equal(body.id, id);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    assert.equal(getBody.items.length, trackerStore.SEED_ITEMS.length - 1);
    assert.equal(getBody.items.find(function (i) { return i.id === id; }), undefined);
  });
});

test('POST deleting a nonexistent id is rejected with 404 and does not touch the store', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var deleteHandler = require('../netlify/functions/delete-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');

    var res = await deleteHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, id: 'does-not-exist' }
    }));
    assert.equal(res.statusCode, 404);
    assert.match(JSON.parse(res.body).error, /^E6: item_not_found/);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    assert.equal(getBody.items.length, trackerStore.SEED_ITEMS.length, 'a 404 delete must not change the stored count');
  });
});

test('POST from a non-owner email is rejected with 403 and does not delete anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var getHandler = require('../netlify/functions/get-tracker-items').handler;
    var deleteHandler = require('../netlify/functions/delete-tracker-item').handler;
    var trackerStore = require('../netlify/functions/lib/tracker-store');
    var id = trackerStore.SEED_ITEMS[0].id;

    var res = await deleteHandler(fakeEvent({
      method: 'POST',
      body: { email: 'not-the-owner@example.com', id: id }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var getRes = await getHandler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    assert.ok(getBody.items.find(function (i) { return i.id === id; }), 'the item must still exist after a rejected delete');
  });
});

test('POST with a missing id is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var deleteHandler = require('../netlify/functions/delete-tracker-item').handler;
    var res = await deleteHandler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: missing_id/);
  });
});

test('bad shape (missing id) is rejected before the owner check even matters', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var deleteHandler = require('../netlify/functions/delete-tracker-item').handler;
    var res = await deleteHandler(fakeEvent({
      method: 'POST',
      body: { email: 'not-the-owner@example.com' }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: missing_id/);
  });
});

test('delete-tracker-item unsupported method is rejected with 405', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var deleteHandler = require('../netlify/functions/delete-tracker-item').handler;
    var res = await deleteHandler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 405);
    assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
  });
});

test('delete-tracker-item is rejected with 500 when OWNER_EMAIL is not configured at all', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var deleteHandler = require('../netlify/functions/delete-tracker-item').handler;
    var res = await deleteHandler(fakeEvent({
      method: 'POST',
      body: { email: 'anyone@example.com', id: 'anything' }
    }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== Concurrent-write race (see tracker-store.js's own CONCURRENT-WRITE
// RACE comment above addItem/deleteItem) =====
//
// These call trackerStore.addItem/deleteItem directly (not through the
// HTTP handlers) since what's under test is the store's own read-mutate-
// write-then-verify retry loop, not endpoint auth/validation — the same
// race exists regardless of which of add-tracker-item.js/
// delete-tracker-item.js/tracker.html's own JS a given caller is. The
// mock store's get/setJSON are plain resolved-Promise stand-ins with no
// real network latency, but they still interleave via the microtask
// queue exactly the way two genuinely concurrent Lambda invocations
// would race over the real store — enough to reproduce (and confirm the
// fix for) the underlying clobber.

test('two concurrent addItem calls both survive — the second does not silently clobber the first', async function () {
  var trackerStore = require('../netlify/functions/lib/tracker-store');
  await trackerStore.getItems(fakeEvent({ method: 'GET' })); // trigger the seed first, same starting point as a real request

  var results = await Promise.all([
    trackerStore.addItem(fakeEvent({ method: 'POST' }), { category: 'task', title: 'Race A', detail: 'Detail A.', priority: 'medium' }),
    trackerStore.addItem(fakeEvent({ method: 'POST' }), { category: 'task', title: 'Race B', detail: 'Detail B.', priority: 'medium' })
  ]);

  var finalItems = await trackerStore.getItems(fakeEvent({ method: 'GET' }));
  var ids = results.map(function (r) { return r.id; });
  assert.notEqual(ids[0], ids[1], 'the two concurrently created items must still get distinct ids');
  ids.forEach(function (id) {
    var count = finalItems.filter(function (i) { return i.id === id; }).length;
    assert.equal(count, 1, 'item ' + id + ' must be present exactly once in the final store — neither lost nor duplicated by the race');
  });
});

test('an addItem racing a deleteItem on a different item: the add survives and the delete survives', async function () {
  var trackerStore = require('../netlify/functions/lib/tracker-store');
  var seeded = await trackerStore.getItems(fakeEvent({ method: 'GET' }));
  var idToDelete = seeded[0].id;

  var results = await Promise.all([
    trackerStore.addItem(fakeEvent({ method: 'POST' }), { category: 'idea', title: 'Race idea', detail: 'Detail.', priority: 'low' }),
    trackerStore.deleteItem(fakeEvent({ method: 'POST' }), idToDelete)
  ]);
  var created = results[0];
  var deleted = results[1];
  assert.equal(deleted, true);

  var finalItems = await trackerStore.getItems(fakeEvent({ method: 'GET' }));
  assert.ok(finalItems.find(function (i) { return i.id === created.id; }), 'the item added mid-race must survive');
  assert.equal(finalItems.find(function (i) { return i.id === idToDelete; }), undefined, 'the item deleted mid-race must stay deleted');
});
