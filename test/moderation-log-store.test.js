// test/moderation-log-store.test.js
//
// Covers netlify/functions/lib/moderation-log-store.js in isolation — the
// MODERATION LOG store (founder-approved 2026-08-14). Run with: node --test
//
// Uses the same in-memory mock-blobs fake every other lib/*.js store test in
// this suite uses (see test/deploy-log-store.test.js's own header), against the
// normal connectLambda(event) request-time pattern. Exercises:
//   - append + list newest-first,
//   - normalizeRecord's defaulting,
//   - retention: prunes beyond MAX_RECORDS, and prunes anything older than
//     MAX_AGE_MS on the next append.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var moderationLogStore = require('../netlify/functions/lib/moderation-log-store');

var STORE = moderationLogStore.STORE_NAME;

test.beforeEach(function () {
  mockBlobs.reset();
});

// ----- keyFor / millisFromKey (pure helpers) -----

test('keyFor -> millisFromKey round-trips the embedded epoch millis', function () {
  var key = moderationLogStore.keyFor(1755100000000, 'abcd1234');
  assert.equal(moderationLogStore.millisFromKey(key), 1755100000000);
});

test('keyFor zero-pads to a fixed width so lexicographic sort == chronological', function () {
  var older = moderationLogStore.keyFor(900000000000, 'aaaa');   // 12 digits
  var newer = moderationLogStore.keyFor(1755100000000, 'bbbb');  // 13 digits
  assert.ok(older < newer, 'a smaller millis must sort before a larger one as a plain string');
});

// ----- normalizeRecord -----

test('normalizeRecord defaults every field and coerces promptText to a string', function () {
  var rec = moderationLogStore.normalizeRecord({}, Date.parse('2026-08-14T00:00:00.000Z'));
  assert.equal(rec.ts, '2026-08-14T00:00:00.000Z');
  assert.equal(rec.reason, null);
  assert.equal(rec.promptText, null);
  assert.equal(rec.mediaType, null);
  assert.equal(rec.user, null);
  assert.equal(rec.source, null);
  assert.equal(rec.operationName, null);
});

test('normalizeRecord caps an over-long promptText at MAX_PROMPT_TEXT_LENGTH', function () {
  var huge = 'x'.repeat(moderationLogStore.MAX_PROMPT_TEXT_LENGTH + 500);
  var rec = moderationLogStore.normalizeRecord({ promptText: huge }, Date.now());
  assert.equal(rec.promptText.length, moderationLogStore.MAX_PROMPT_TEXT_LENGTH);
});

// ----- append + list -----

test('append stores the normalized record and list returns it', async function () {
  var event = fakeEvent({});
  await moderationLogStore.append(event, {
    reason: 'E116', promptText: 'a blocked dream', mediaType: 'video',
    user: 'someone@example.com', source: 'create', operationName: null
  });
  var recs = await moderationLogStore.list(event, {});
  assert.equal(recs.length, 1);
  assert.equal(recs[0].reason, 'E116');
  assert.equal(recs[0].promptText, 'a blocked dream');
  assert.equal(recs[0].mediaType, 'video');
  assert.equal(recs[0].user, 'someone@example.com');
  assert.equal(recs[0].source, 'create');
});

test('list returns records NEWEST FIRST', async function () {
  var event = fakeEvent({});
  var base = Date.parse('2026-08-14T00:00:00.000Z');
  await moderationLogStore.append(event, { ts: new Date(base).toISOString(), promptText: 'oldest', reason: 'E116', mediaType: 'video' });
  await moderationLogStore.append(event, { ts: new Date(base + 1000).toISOString(), promptText: 'middle', reason: 'E116', mediaType: 'image' });
  await moderationLogStore.append(event, { ts: new Date(base + 2000).toISOString(), promptText: 'newest', reason: 'content_policy_violation', mediaType: 'video' });

  var recs = await moderationLogStore.list(event, {});
  assert.deepEqual(recs.map(function (r) { return r.promptText; }), ['newest', 'middle', 'oldest']);
});

test('list respects an explicit limit, keeping the newest N', async function () {
  var event = fakeEvent({});
  var base = Date.parse('2026-08-14T00:00:00.000Z');
  for (var i = 0; i < 5; i++) {
    await moderationLogStore.append(event, { ts: new Date(base + i * 1000).toISOString(), promptText: 'p' + i, reason: 'E116', mediaType: 'video' });
  }
  var recs = await moderationLogStore.list(event, { limit: 2 });
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map(function (r) { return r.promptText; }), ['p4', 'p3']);
});

// ----- retention -----

test('append prunes so at most MAX_RECORDS are kept (newest survive)', async function () {
  var event = fakeEvent({});
  var base = Date.parse('2026-08-14T00:00:00.000Z');
  var total = moderationLogStore.MAX_RECORDS + 5; // 505
  for (var i = 0; i < total; i++) {
    await moderationLogStore.append(event, { ts: new Date(base + i * 1000).toISOString(), promptText: 'p' + i, reason: 'E116', mediaType: 'video' });
  }
  var recs = await moderationLogStore.list(event, { limit: 10000 });
  assert.equal(recs.length, moderationLogStore.MAX_RECORDS);
  // Newest survivor is the last appended; oldest survivor is index 5 (0-4 pruned).
  assert.equal(recs[0].promptText, 'p' + (total - 1));
  assert.ok(recs.every(function (r) { return r.promptText !== 'p0'; }), 'the 5 oldest must have been pruned');
  assert.ok(recs.every(function (r) { return r.promptText !== 'p4'; }));
});

test('a record older than MAX_AGE_MS is pruned on the next append', async function () {
  var event = fakeEvent({});
  var now = Date.now();
  var oldMillis = now - (moderationLogStore.MAX_AGE_MS + 24 * 60 * 60 * 1000); // 31 days ago

  // Seed a pre-existing, deliberately-old record directly at its sortable key.
  var oldRecord = moderationLogStore.normalizeRecord(
    { reason: 'E116', promptText: 'OLD BLOCKED', mediaType: 'video', user: 'x' },
    oldMillis
  );
  mockBlobs.seed(STORE, moderationLogStore.keyFor(oldMillis, 'oldrand'), oldRecord);

  // A fresh append triggers a best-effort prune, which should drop the old one.
  await moderationLogStore.append(event, { reason: 'E116', promptText: 'fresh', mediaType: 'video', user: 'y' });

  var recs = await moderationLogStore.list(event, { limit: 10000 });
  assert.ok(recs.some(function (r) { return r.promptText === 'fresh'; }), 'the fresh record must remain');
  assert.ok(recs.every(function (r) { return r.promptText !== 'OLD BLOCKED'; }), 'the >30d record must be pruned');
});
