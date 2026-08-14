// test/get-moderation-log.test.js
//
// Covers netlify/functions/get-moderation-log.js — the owner-gated read side of
// the MODERATION LOG. Mirrors the owner-check discipline of
// get-moderation-reports.js / add-tracker-item.js: a client-supplied `email`
// query param checked against OWNER_EMAIL. Proves a non-owner is rejected and
// the owner gets the records (newest-first, limit-respecting).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var moderationLogStore = require('../netlify/functions/lib/moderation-log-store');
var handler = require('../netlify/functions/get-moderation-log').handler;

var OWNER = 'ronbrightman@gmail.com';

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.OWNER_EMAIL = OWNER;
});
test.after(function () {
  delete process.env.OWNER_EMAIL;
});

function getEvent(query) {
  return fakeEvent({ method: 'GET', query: query || null });
}

async function seed(n, base) {
  base = base || Date.parse('2026-08-14T00:00:00.000Z');
  for (var i = 0; i < n; i++) {
    await moderationLogStore.append(fakeEvent({}), {
      ts: new Date(base + i * 1000).toISOString(),
      reason: 'E116', promptText: 'blocked ' + i, mediaType: 'video', user: 'u' + i
    });
  }
}

test('wrong method -> 405 E1', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1:/);
});

test('OWNER_EMAIL not configured -> 500 E2', async function () {
  delete process.env.OWNER_EMAIL;
  var res = await handler(getEvent({ email: OWNER }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E2:/);
});

test('non-owner email -> 403 E3, no records leaked', async function () {
  await seed(3);
  var res = await handler(getEvent({ email: 'someoneelse@example.com' }));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /^E3:/);
  assert.equal(res.body.indexOf('blocked'), -1, 'no record content in a forbidden response');
});

test('missing email -> 403 E3', async function () {
  var res = await handler(getEvent({}));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /^E3:/);
});

test('owner email -> 200 with records, newest first', async function () {
  await seed(3);
  var res = await handler(getEvent({ email: OWNER }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.records.length, 3);
  assert.deepEqual(body.records.map(function (r) { return r.promptText; }), ['blocked 2', 'blocked 1', 'blocked 0']);
});

test('owner email is matched case/whitespace-insensitively (normalizeEmail), and limit is respected', async function () {
  await seed(5);
  var res = await handler(getEvent({ email: '  RonBrightman@Gmail.com  ', limit: '2' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.records.length, 2, 'limit=2 respected');
  assert.deepEqual(body.records.map(function (r) { return r.promptText; }), ['blocked 4', 'blocked 3']);
});
