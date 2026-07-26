// test/like-dream.test.js
//
// Covers netlify/functions/like-dream.js's existing like/unlike behavior
// PLUS the new 'like_given'/'like_received' PostHog events added for Phase
// 1 reporting instrumentation (tracker item
// for-product-phase-1-reporting-instrument-kjlh46) — this is "the single
// choke-point that already knows the dream, the owner, and the delta" the
// tracker item calls out. Mocks global.fetch for the outbound PostHog
// capture calls, same convention as test/dodo-webhook.test.js's own
// installAnalyticsFetchSpy.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var handler = require('../netlify/functions/like-dream').handler;

var realFetch = global.fetch;

function installPostHogSpy(opts) {
  opts = opts || {};
  var calls = [];
  global.fetch = async function (url, init) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') === -1) throw new Error('unexpected fetch to ' + urlStr);
    calls.push({ url: urlStr, body: init && init.body ? JSON.parse(init.body) : null });
    if (opts.fails) return { ok: false, status: 500, json: async function () { return {}; }, text: async function () { return 'down'; } };
    return { ok: true, status: 200, json: async function () { return {}; }, text: async function () { return 'ok'; } };
  };
  return calls;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

test.after(function () {
  global.fetch = realFetch;
});

async function seedFeedDream(dream) {
  var store = getStore('dreamtube-feed');
  var feed = (await store.get('feed-index', { type: 'json' })) || [];
  feed.push(Object.assign({ likes: 0 }, dream));
  await store.setJSON('feed-index', feed);
}

function postEvent(body) {
  return fakeEvent({ method: 'POST', body: body });
}

test('wrong method -> 405', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('invalid JSON -> 400', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
});

test('missing id -> 400', async function () {
  var res = await handler(postEvent({ delta: 1 }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'id_required');
});

test('unknown dream id -> 404', async function () {
  var res = await handler(postEvent({ id: 'does-not-exist', delta: 1 }));
  assert.equal(res.statusCode, 404);
});

test('a real like (+1) still increments the shared count as before, and fires like_given + like_received', async function () {
  await seedFeedDream({ id: 'dream-1', ownerHandle: '@owner1', likes: 5 });
  var calls = installPostHogSpy();

  var res = await handler(postEvent({ id: 'dream-1', delta: 1, likerHandle: '@liker1' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.likes, 6, 'the like count itself must be unaffected by any of the new analytics wiring');

  assert.equal(calls.length, 2, 'expected exactly one like_given + one like_received call');
  var givenCall = calls.filter(function (c) { return c.body.event === 'like_given'; })[0];
  var receivedCall = calls.filter(function (c) { return c.body.event === 'like_received'; })[0];
  assert.ok(givenCall, 'like_given must fire');
  assert.ok(receivedCall, 'like_received must fire');
  assert.equal(givenCall.body.distinct_id, 'liker1', 'like_given distinct_id must be the LIKER, with the leading @ stripped');
  assert.equal(receivedCall.body.distinct_id, 'owner1', 'like_received distinct_id must be the dream OWNER, with the leading @ stripped');
  assert.equal(givenCall.body.properties.dreamId, 'dream-1');
  assert.equal(receivedCall.body.properties.dreamId, 'dream-1');
});

test('unliking (delta -1) still decrements the shared count as before, but fires NEITHER like_given nor like_received', async function () {
  await seedFeedDream({ id: 'dream-2', ownerHandle: '@owner2', likes: 5 });
  var calls = installPostHogSpy();

  var res = await handler(postEvent({ id: 'dream-2', delta: -1, likerHandle: '@liker2' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.likes, 4);
  assert.equal(calls.length, 0, 'an unlike must never fire like_given or like_received');
});

test('the shared count never goes negative, same pre-existing guarantee, unaffected by the analytics addition', async function () {
  await seedFeedDream({ id: 'dream-3', ownerHandle: '@owner3', likes: 0 });
  installPostHogSpy();
  var res = await handler(postEvent({ id: 'dream-3', delta: -1, likerHandle: '@liker3' }));
  var body = JSON.parse(res.body);
  assert.equal(body.likes, 0);
});

test('a dream liked by its own owner (self-like) fires BOTH events on the same distinct_id -- not specially handled, an honest reflection of what happened', async function () {
  await seedFeedDream({ id: 'dream-4', ownerHandle: '@selfliker', likes: 0 });
  var calls = installPostHogSpy();
  await handler(postEvent({ id: 'dream-4', delta: 1, likerHandle: '@selfliker' }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.distinct_id, 'selfliker');
  assert.equal(calls[1].body.distinct_id, 'selfliker');
});

test('missing likerHandle (logged-out/legacy caller): like_received still fires for the owner, like_given is skipped', async function () {
  await seedFeedDream({ id: 'dream-5', ownerHandle: '@owner5', likes: 0 });
  var calls = installPostHogSpy();
  var res = await handler(postEvent({ id: 'dream-5', delta: 1 })); // no likerHandle at all
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.event, 'like_received');
  assert.equal(calls[0].body.distinct_id, 'owner5');
});

test('a PostHog failure never blocks the like itself or the 200 response', async function () {
  await seedFeedDream({ id: 'dream-6', ownerHandle: '@owner6', likes: 2 });
  installPostHogSpy({ fails: true });
  var res = await handler(postEvent({ id: 'dream-6', delta: 1, likerHandle: '@liker6' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.likes, 3, 'the like itself must land even though PostHog is down');
});

test('a plain (non-@-prefixed) handle is used as-is for distinct_id (stripHandle is a no-op without a leading @)', async function () {
  await seedFeedDream({ id: 'dream-7', ownerHandle: 'owner7', likes: 0 });
  var calls = installPostHogSpy();
  await handler(postEvent({ id: 'dream-7', delta: 1, likerHandle: 'liker7' }));
  var givenCall = calls.filter(function (c) { return c.body.event === 'like_given'; })[0];
  var receivedCall = calls.filter(function (c) { return c.body.event === 'like_received'; })[0];
  assert.equal(givenCall.body.distinct_id, 'liker7');
  assert.equal(receivedCall.body.distinct_id, 'owner7');
});
