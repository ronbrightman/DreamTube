// test/video-ready-push.test.js
//
// Covers netlify/functions/mark-generation-completed.js's
// maybeSendVideoReadyPush -- tracker item for-product-build-stage-0-pwa-
// web-push-f-jbutt5, part 4. Deliberately its own file, separate from
// test/unwatched-dream-nudge-enqueue.test.js (the retention EMAIL side's
// own coverage of the same choke point) -- these are two independent
// channels with two independent dedup markers (see push-dedup-store.js's
// own header comment), and this file exercises the push side in
// isolation, calling maybeSendVideoReadyPush directly rather than the
// full HTTP handler (avoiding needing to also stand up the email
// machinery's own Resend-fetch stubbing for a test that isn't about
// email at all).
//
// Uses test/helpers/mock-web-push.js (this feature's own new fake, same
// require.cache-preloading shape as mock-blobs.js) so `web-push`'s real
// sendNotification is never actually called.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();
var mockWebPush = require('./helpers/mock-web-push');
mockWebPush.install();

var { fakeEvent } = require('./helpers/fake-event');
// See test/helpers/fetch-double.js -- marks this file's own fetch double so
// lib/posthog-capture.js's test-process guard lets its analytics fires reach it.
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');
var jobOwners = require('../netlify/functions/lib/job-owners');
var accountStore = require('../netlify/functions/lib/account-store');
var pushSubscriptionStore = require('../netlify/functions/lib/push-subscription-store');
var markGenerationCompleted = require('../netlify/functions/mark-generation-completed');

var realFetch = global.fetch;
var posthogCalls = [];

function installPosthogSpy() {
  posthogCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') !== -1) {
      posthogCalls.push({ url: urlStr, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
}

var opCounter = 0;
function freshOpName() {
  opCounter += 1;
  return 'mock:1:' + opCounter;
}

async function seedAccountAndSubscription(username, email, endpointSuffix) {
  var event = fakeEvent({});
  await accountStore.createAccount(event, { username: username, password: 'hunter22', email: email });
  await pushSubscriptionStore.addOrUpdateSubscription(event, username, {
    endpoint: 'https://push.example/' + (endpointSuffix || username),
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
  });
}

test.beforeEach(function () {
  mockBlobs.reset();
  mockWebPush.reset();
  installPosthogSpy();
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.VAPID_PRIVATE_KEY;
});

test('sends a video-ready push for a subscribed account with a video job-owner record', async function () {
  var operationName = freshOpName();
  await seedAccountAndSubscription('alice', 'alice@example.com');
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, 'alice@example.com', 'video');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);

  var sentCalls = mockWebPush.getSentCalls();
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].endpoint, 'https://push.example/alice');
  var payload = JSON.parse(sentCalls[0].payload);
  assert.equal(payload.type, 'video-ready');
  assert.equal(payload.distinctId, 'alice');

  var pushSentEvent = posthogCalls.find(function (c) { return c.body.event === 'push_sent'; });
  assert.ok(pushSentEvent, 'expected a push_sent PostHog capture');
  assert.equal(pushSentEvent.body.distinct_id, 'alice');
});

test('never sends twice for the SAME operationName (per-completion dedup)', async function () {
  var operationName = freshOpName();
  await seedAccountAndSubscription('bob', 'bob@example.com');
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, 'bob@example.com', 'video');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);
  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);

  assert.equal(mockWebPush.getSentCalls().length, 1);
});

test('a DIFFERENT operationName for the same account is NOT deduped against an earlier one (every dream gets its own push)', async function () {
  await seedAccountAndSubscription('carol', 'carol@example.com');
  var opOne = freshOpName();
  var opTwo = freshOpName();
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), opOne, 'carol@example.com', 'video');
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), opTwo, 'carol@example.com', 'video');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), opOne);
  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), opTwo);

  assert.equal(mockWebPush.getSentCalls().length, 2);
});

test('skips silently for an IMAGE job (video-ready is video-only scope, matching the retention email)', async function () {
  var operationName = freshOpName();
  await seedAccountAndSubscription('dave', 'dave@example.com');
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, 'dave@example.com', 'image');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);

  assert.equal(mockWebPush.getSentCalls().length, 0);
});

test('skips silently when there is no job-owner record at all', async function () {
  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), 'mock:1:never-recorded');
  assert.equal(mockWebPush.getSentCalls().length, 0);
});

test('skips silently when the email does not resolve to a real registered account', async function () {
  var operationName = freshOpName();
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, 'ghost@example.com', 'video');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);

  assert.equal(mockWebPush.getSentCalls().length, 0);
});

test('skips silently when the account has never subscribed to push at all', async function () {
  var operationName = freshOpName();
  await accountStore.createAccount(fakeEvent({}), { username: 'erin', password: 'hunter22', email: 'erin@example.com' });
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, 'erin@example.com', 'video');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);

  assert.equal(mockWebPush.getSentCalls().length, 0);
});

test('does not send (fails closed) when VAPID_PRIVATE_KEY is not configured', async function () {
  delete process.env.VAPID_PRIVATE_KEY;
  var operationName = freshOpName();
  await seedAccountAndSubscription('frank', 'frank@example.com');
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, 'frank@example.com', 'video');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);

  assert.equal(mockWebPush.getSentCalls().length, 0);
});

test('sends to EVERY subscribed device for a multi-device account, but fires push_sent only once', async function () {
  var operationName = freshOpName();
  var event = fakeEvent({});
  await accountStore.createAccount(event, { username: 'grace', password: 'hunter22', email: 'grace@example.com' });
  await pushSubscriptionStore.addOrUpdateSubscription(event, 'grace', { endpoint: 'https://push.example/grace-phone', keys: { p256dh: 'a', auth: 'b' } });
  await pushSubscriptionStore.addOrUpdateSubscription(event, 'grace', { endpoint: 'https://push.example/grace-desktop', keys: { p256dh: 'c', auth: 'd' } });
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, 'grace@example.com', 'video');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);

  assert.equal(mockWebPush.getSentCalls().length, 2);
  var pushSentEvents = posthogCalls.filter(function (c) { return c.body.event === 'push_sent'; });
  assert.equal(pushSentEvents.length, 1);
});

test('a dead subscription (404/410) is removed from the store and does not block the marker from being claimed', async function () {
  var operationName = freshOpName();
  var event = fakeEvent({});
  await accountStore.createAccount(event, { username: 'henry', password: 'hunter22', email: 'henry@example.com' });
  await pushSubscriptionStore.addOrUpdateSubscription(event, 'henry', { endpoint: 'https://push.example/henry-dead', keys: { p256dh: 'a', auth: 'b' } });
  mockWebPush.setResponse('https://push.example/henry-dead', { reject: true, statusCode: 410 });
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, 'henry@example.com', 'video');

  await markGenerationCompleted.maybeSendVideoReadyPush(fakeEvent({}), operationName);

  var remaining = await pushSubscriptionStore.getSubscriptions(fakeEvent({}), 'henry');
  assert.equal(remaining.length, 0);
});
