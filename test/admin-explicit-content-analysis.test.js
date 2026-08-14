// test/admin-explicit-content-analysis.test.js
//
// Covers netlify/functions/admin-explicit-content-analysis.js — the
// owner-gated historical sexual-content analysis (founder-requested
// 2026-08-14). Proves: the owner-email gate (same shape as
// get-moderation-log.js), the window (days) cutoff, that private-dream AND
// feed content are both scanned and unified per user, that classification
// uses the app's own matchesExplicitKeyword (so a keyword-hit dream counts
// and a clean dream does not), and that the response carries aggregates only
// — never the raw dream text.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var dreamStore = require('../netlify/functions/lib/dream-store');
var handler = require('../netlify/functions/admin-explicit-content-analysis').handler;

var OWNER = 'ronbrightman@gmail.com';
var NOW = Date.parse('2026-08-14T00:00:00.000Z');
var DAY = 24 * 60 * 60 * 1000;

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

async function seedPrivate(username, dreams) {
  await getStore({ name: dreamStore.STORE_NAME }).setJSON(username, {
    username: username, dreams: dreams, updatedAt: NOW
  });
}
async function seedFeed(records) {
  await getStore({ name: 'dreamtube-feed' }).setJSON('feed-index', records);
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

test('non-owner / missing email -> 403 E3, nothing scanned', async function () {
  await seedPrivate('alice', [{ id: 'd1', storyText: 'we had sex on the beach', createdAt: NOW - DAY }]);
  var res1 = await handler(getEvent({ email: 'nope@example.com' }));
  assert.equal(res1.statusCode, 403);
  assert.match(JSON.parse(res1.body).error, /^E3:/);
  var res2 = await handler(getEvent(null));
  assert.equal(res2.statusCode, 403);
});

test('owner: private + feed scanned, explicit classified, aggregates only (no raw text)', async function () {
  // alice: 1 explicit (keyword "naked") + 1 clean, both in-window
  await seedPrivate('alice', [
    { id: 'a1', storyText: 'a naked figure walking through fog', createdAt: NOW - DAY },
    { id: 'a2', storyText: 'flying peacefully over the mountains', createdAt: NOW - 2 * DAY }
  ]);
  // bob: 1 explicit via caption fallback (no storyText)
  await seedPrivate('bob', [
    { id: 'b1', caption: 'two people having sex', createdAt: NOW - 3 * DAY }
  ]);
  // feed published dream by @Carol (explicit) — unifies under "carol"
  await seedFeed([
    { id: 'f1', ownerHandle: '@Carol', caption: 'a nude portrait in moonlight', publishedAt: NOW - DAY }
  ]);

  var res = await handler(getEvent({ email: OWNER, days: '30' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);

  assert.equal(body.windowDays, 30);
  assert.equal(body.totalDreams, 4);
  assert.equal(body.explicitDreams, 3);
  assert.equal(body.explicitUsers, 3);

  var byUser = {};
  body.perUser.forEach(function (r) { byUser[r.user] = r; });
  assert.equal(byUser.alice.total, 2);
  assert.equal(byUser.alice.explicit, 1);
  assert.equal(byUser.bob.explicit, 1);
  assert.equal(byUser.carol.explicit, 1); // @Carol normalized to carol

  // Aggregates only — the raw dream text must NEVER appear in the response.
  assert.ok(!/naked|having sex|nude/i.test(res.body), 'response leaked raw dream text');
  // firstExplicitAt is a timestamp, not the content.
  assert.equal(typeof byUser.alice.firstExplicitAt, 'number');
});

test('window cutoff: a dream older than `days` is excluded', async function () {
  await seedPrivate('alice', [
    { id: 'old', storyText: 'we had sex', createdAt: NOW - 40 * DAY }, // outside 14d
    { id: 'new', storyText: 'we had sex', createdAt: NOW - 2 * DAY }   // inside 14d
  ]);
  var res = await handler(getEvent({ email: OWNER })); // default 14 days
  var body = JSON.parse(res.body);
  // Only the in-window dream is counted.
  assert.equal(body.totalDreams, 1);
  assert.equal(body.explicitDreams, 1);
});

test('a fully clean corpus reports zero explicit', async function () {
  await seedPrivate('alice', [{ id: 'c1', storyText: 'a calm river at dawn', createdAt: NOW - DAY }]);
  await seedFeed([{ id: 'f2', ownerHandle: '@bob', caption: 'blue birds in a garden', publishedAt: NOW - DAY }]);
  var res = await handler(getEvent({ email: OWNER }));
  var body = JSON.parse(res.body);
  assert.equal(body.explicitDreams, 0);
  assert.equal(body.explicitUsers, 0);
  assert.equal(body.totalDreams, 2);
});
