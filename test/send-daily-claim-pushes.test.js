// test/send-daily-claim-pushes.test.js
//
// Covers netlify/functions/send-daily-claim-pushes.js's scanAndSend --
// tracker item for-product-build-stage-0-pwa-web-push-f-jbutt5, part 4
// ("daily-claim-available: fires when a user's daily token claim becomes
// available again"). This is this repo's first Scheduled Function (see
// that file's own header comment) -- there is no way to invoke a real
// Netlify scheduled trigger from this sandbox, so this exercises
// scanAndSend directly (exactly what it's exported for), with a mocked
// lib/entitlements.js store (via mock-blobs) and a mocked web-push send
// (via mock-web-push) — real push delivery itself needs a real deployed
// environment, same honest-degrade note as test/video-ready-push.test.js.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();
var mockWebPush = require('./helpers/mock-web-push');
mockWebPush.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var accountStore = require('../netlify/functions/lib/account-store');
var pushSubscriptionStore = require('../netlify/functions/lib/push-subscription-store');
var sendDailyClaimPushes = require('../netlify/functions/send-daily-claim-pushes');

var realFetch = global.fetch;

/**
 * Blocks real outbound network for every test in this file (tracker.html's
 * for-product-bug-founder-affects-all-funn-0efe7t item, round 4).
 *
 * This file already mocks web-push, but nothing mocked
 * lib/push-sender.js's OTHER outbound call: its `push_sent` PostHog fire via
 * lib/posthog-capture.js, whose POSTHOG_KEY is require()'d from a checked-in
 * file rather than an env var. So every `npm test` run POSTed 5 REAL
 * `push_sent` events for the fixture usernames alice/frank/grace/henry into
 * the founder's REAL production PostHog project. Those exact four fixture
 * names then showed up in a production analytics review as "395 push_sent in
 * 16h to 4 test-fixture accounts -- dedup store not working", which was read
 * as a production dedup bug. It was this file.
 *
 * lib/posthog-capture.js now refuses to fire under a test runner at all (its
 * own TEST-ENVIRONMENT GUARD); this stub is the belt to that lib's braces.
 */
test.beforeEach(function () {
  global.fetch = async function (url) {
    throw new Error('unexpected real network call in a test: ' + String(url));
  };
  mockBlobs.reset();
  mockWebPush.reset();
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.VAPID_PRIVATE_KEY;
});

async function seedSubscribedAccount(username, email) {
  var event = fakeEvent({});
  await accountStore.createAccount(event, { username: username, password: 'hunter22', email: email });
  await pushSubscriptionStore.addOrUpdateSubscription(event, username, {
    endpoint: 'https://push.example/' + username,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
  });
}

test('sends a daily-claim-available push for an account whose cooldown JUST elapsed', async function () {
  var event = fakeEvent({});
  await seedSubscribedAccount('alice', 'alice@example.com');
  // lastClaimAt exactly CLAIM_COOLDOWN_MS + a few minutes ago -- just crossed nextClaimAt, comfortably inside CHECK_WINDOW_MS.
  var lastClaimAt = Date.now() - entitlements.CLAIM_COOLDOWN_MS - (5 * 60 * 1000);
  await entitlements.setEntitlement(event, 'alice@example.com', { tokens: { balance: 50, lastClaimAt: lastClaimAt, streak: 2 } });

  var result = await sendDailyClaimPushes.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 1);
  var sentCalls = mockWebPush.getSentCalls();
  assert.equal(sentCalls.length, 1);
  var payload = JSON.parse(sentCalls[0].payload);
  assert.equal(payload.type, 'daily-claim-available');
});

test('does not send for an account whose cooldown has NOT elapsed yet', async function () {
  var event = fakeEvent({});
  await seedSubscribedAccount('bob', 'bob@example.com');
  var lastClaimAt = Date.now() - (2 * 60 * 60 * 1000); // 2h ago -- nowhere near the 20h cooldown
  await entitlements.setEntitlement(event, 'bob@example.com', { tokens: { balance: 50, lastClaimAt: lastClaimAt, streak: 1 } });

  var result = await sendDailyClaimPushes.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
  assert.equal(mockWebPush.getSentCalls().length, 0);
});

test('does not re-send for an account whose cooldown elapsed long ago (outside CHECK_WINDOW_MS -- an earlier run already covered it)', async function () {
  var event = fakeEvent({});
  await seedSubscribedAccount('carol', 'carol@example.com');
  var longAgoLastClaim = Date.now() - entitlements.CLAIM_COOLDOWN_MS - (5 * 24 * 60 * 60 * 1000); // crossed nextClaimAt 5 days ago
  await entitlements.setEntitlement(event, 'carol@example.com', { tokens: { balance: 50, lastClaimAt: longAgoLastClaim, streak: 1 } });

  var result = await sendDailyClaimPushes.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
});

test('never sends for an account that has never claimed even once (no lastClaimAt at all)', async function () {
  var event = fakeEvent({});
  await seedSubscribedAccount('dave', 'dave@example.com');
  await entitlements.setEntitlement(event, 'dave@example.com', { tokens: { balance: 220 } }); // fresh account, never claimed

  var result = await sendDailyClaimPushes.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
});

test('skips an account with no push subscription on file', async function () {
  var event = fakeEvent({});
  await accountStore.createAccount(event, { username: 'erin', password: 'hunter22', email: 'erin@example.com' }); // no push subscription
  var lastClaimAt = Date.now() - entitlements.CLAIM_COOLDOWN_MS - (1000);
  await entitlements.setEntitlement(event, 'erin@example.com', { tokens: { balance: 50, lastClaimAt: lastClaimAt, streak: 1 } });

  var result = await sendDailyClaimPushes.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
});

test('does not double-send across two consecutive scans for the SAME availability window', async function () {
  var event = fakeEvent({});
  await seedSubscribedAccount('frank', 'frank@example.com');
  var lastClaimAt = Date.now() - entitlements.CLAIM_COOLDOWN_MS - (1000);
  await entitlements.setEntitlement(event, 'frank@example.com', { tokens: { balance: 50, lastClaimAt: lastClaimAt, streak: 1 } });

  var firstScan = await sendDailyClaimPushes.scanAndSend(fakeEvent({}));
  var secondScan = await sendDailyClaimPushes.scanAndSend(fakeEvent({}));

  assert.equal(firstScan.sent, 1);
  assert.equal(secondScan.sent, 0); // same window, already claimed by the dedup marker
  assert.equal(mockWebPush.getSentCalls().length, 1);
});

test('a NEW claim (fresh lastClaimAt) after an earlier push gets its own fresh push once its own cooldown elapses', async function () {
  var event = fakeEvent({});
  await seedSubscribedAccount('grace', 'grace@example.com');
  var firstLastClaimAt = Date.now() - entitlements.CLAIM_COOLDOWN_MS - (1000);
  await entitlements.setEntitlement(event, 'grace@example.com', { tokens: { balance: 50, lastClaimAt: firstLastClaimAt, streak: 1 } });
  await sendDailyClaimPushes.scanAndSend(fakeEvent({}));
  assert.equal(mockWebPush.getSentCalls().length, 1);

  // Grace claims again (a new, later lastClaimAt), and THAT cooldown also elapses.
  // Forced to be strictly greater than firstLastClaimAt rather than a bare
  // second Date.now() read -- tracker item for-product-pre-existing-red-
  // test-on-mai-hxtm53: on a fast enough run (mocked Blobs/web-push, no
  // real I/O latency), both Date.now() calls in this test can land in the
  // SAME millisecond, making firstLastClaimAt === secondLastClaimAt. Since
  // send-daily-claim-pushes.js's dedup key is 'daily-claim-available:' +
  // email + ':' + (lastClaimAt + CLAIM_COOLDOWN_MS), an identical
  // lastClaimAt collapses onto the SAME dedup key as the first claim, and
  // the (working-as-designed) dedup guard correctly refuses to send a
  // second push for what it sees as the same availability window -- a
  // real deterministic test-timing bug, not a product bug in the dedup
  // logic itself.
  var secondLastClaimAt = Math.max(Date.now() - entitlements.CLAIM_COOLDOWN_MS - 1000, firstLastClaimAt + 1);
  await entitlements.setEntitlement(event, 'grace@example.com', { tokens: { balance: 70, lastClaimAt: secondLastClaimAt, streak: 2 } });
  await sendDailyClaimPushes.scanAndSend(fakeEvent({}));

  assert.equal(mockWebPush.getSentCalls().length, 2);
});

test('scans multiple accounts in one run, sending only to the ones actually eligible', async function () {
  var event = fakeEvent({});
  await seedSubscribedAccount('henry', 'henry@example.com');
  await seedSubscribedAccount('iris', 'iris@example.com');
  var justElapsed = Date.now() - entitlements.CLAIM_COOLDOWN_MS - 1000;
  var notYet = Date.now() - (60 * 60 * 1000);
  await entitlements.setEntitlement(event, 'henry@example.com', { tokens: { balance: 50, lastClaimAt: justElapsed, streak: 1 } });
  await entitlements.setEntitlement(event, 'iris@example.com', { tokens: { balance: 50, lastClaimAt: notYet, streak: 1 } });

  var result = await sendDailyClaimPushes.scanAndSend(fakeEvent({}));

  assert.equal(result.scanned, 2);
  assert.equal(result.sent, 1);
});
