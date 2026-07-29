// test/push-subscription-store.test.js
//
// Covers netlify/functions/lib/push-subscription-store.js in isolation —
// tracker item for-product-build-stage-0-pwa-web-push-f-jbutt5, part 3.
// Plain node:test + the shared mock-blobs helper, same convention as
// test/first-video-created-behavioral.test.js's server-side counterparts
// (e.g. test/generation-completion-marker.test.js).
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var store = require('../netlify/functions/lib/push-subscription-store');

function sub(endpoint, p256dh, auth) {
  return { endpoint: endpoint, keys: { p256dh: p256dh || 'p256dh-key', auth: auth || 'auth-key' } };
}

test.beforeEach(function () {
  mockBlobs.reset();
});

test('getSubscriptions returns [] for an account that never subscribed', async function () {
  var subs = await store.getSubscriptions(fakeEvent({}), 'nosubs');
  assert.deepEqual(subs, []);
});

test('addOrUpdateSubscription persists a subscription retrievable by getSubscriptions', async function () {
  var event = fakeEvent({});
  var result = await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep1'));
  assert.equal(result.ok, true);

  var subs = await store.getSubscriptions(event, 'alice');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].endpoint, 'https://push.example/ep1');
  assert.equal(subs[0].keys.p256dh, 'p256dh-key');
});

test('username is normalized (case/whitespace) between write and read', async function () {
  var event = fakeEvent({});
  await store.addOrUpdateSubscription(event, '  Alice  ', sub('https://push.example/ep1'));
  var subs = await store.getSubscriptions(event, 'alice');
  assert.equal(subs.length, 1);
});

test('re-subscribing the SAME endpoint updates it in place, not a duplicate entry', async function () {
  var event = fakeEvent({});
  await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep1', 'old-p256dh'));
  await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep1', 'new-p256dh'));

  var subs = await store.getSubscriptions(event, 'alice');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].keys.p256dh, 'new-p256dh');
});

test('a second, DIFFERENT endpoint for the same account is a second entry (multi-device)', async function () {
  var event = fakeEvent({});
  await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep1'));
  await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep2'));

  var subs = await store.getSubscriptions(event, 'alice');
  assert.equal(subs.length, 2);
});

test('subscriptions are capped at MAX_SUBSCRIPTIONS_PER_ACCOUNT, evicting the OLDEST first', async function () {
  var event = fakeEvent({});
  var cap = store.MAX_SUBSCRIPTIONS_PER_ACCOUNT;
  for (var i = 0; i < cap + 3; i++) {
    await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep' + i));
    // mock-blobs is perfectly synchronous, so every addedAt would otherwise
    // tie at the same Date.now() millisecond -- a real device re-subscribing
    // seconds/minutes apart always has genuinely distinct timestamps, so
    // nudge them apart here purely to make the "oldest evicted first"
    // ordering assertion below deterministic.
    await new Promise(function (resolve) { setTimeout(resolve, 2); });
  }

  var subs = await store.getSubscriptions(event, 'alice');
  assert.equal(subs.length, cap);
  var endpoints = subs.map(function (s) { return s.endpoint; });
  // The first 3 (ep0/ep1/ep2) should have been evicted as the oldest.
  assert.equal(endpoints.indexOf('https://push.example/ep0'), -1);
  assert.equal(endpoints.indexOf('https://push.example/ep1'), -1);
  assert.equal(endpoints.indexOf('https://push.example/ep2'), -1);
  assert.ok(endpoints.indexOf('https://push.example/ep' + (cap + 2)) !== -1);
});

test('removeSubscription removes exactly the matching endpoint, leaving others intact', async function () {
  var event = fakeEvent({});
  await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep1'));
  await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep2'));

  var result = await store.removeSubscription(event, 'alice', 'https://push.example/ep1');
  assert.equal(result.ok, true);

  var subs = await store.getSubscriptions(event, 'alice');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].endpoint, 'https://push.example/ep2');
});

test('removeSubscription on a non-existent endpoint is a harmless no-op', async function () {
  var event = fakeEvent({});
  await store.addOrUpdateSubscription(event, 'alice', sub('https://push.example/ep1'));
  var result = await store.removeSubscription(event, 'alice', 'https://push.example/nonexistent');
  assert.equal(result.ok, false);

  var subs = await store.getSubscriptions(event, 'alice');
  assert.equal(subs.length, 1);
});

test('addOrUpdateSubscription rejects a subscription missing endpoint/keys', async function () {
  var event = fakeEvent({});
  var noEndpoint = await store.addOrUpdateSubscription(event, 'alice', { keys: { p256dh: 'x', auth: 'y' } });
  assert.equal(noEndpoint.ok, false);
  assert.equal(noEndpoint.error, 'invalid_subscription');

  var noKeys = await store.addOrUpdateSubscription(event, 'alice', { endpoint: 'https://push.example/ep1' });
  assert.equal(noKeys.ok, false);
  assert.equal(noKeys.error, 'invalid_subscription_keys');
});

test('addOrUpdateSubscription rejects an empty/invalid username', async function () {
  var event = fakeEvent({});
  var result = await store.addOrUpdateSubscription(event, '', sub('https://push.example/ep1'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_username');
});
