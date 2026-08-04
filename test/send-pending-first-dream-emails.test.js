// test/send-pending-first-dream-emails.test.js
//
// Covers netlify/functions/send-pending-first-dream-emails.js's
// scanAndSend -- tracker item for-product-email-redesign-unsubscribe-l-16ysmp's
// founder-approved thumbnail-gating follow-up (2026-08-03/04): "wait up
// to 3 MINUTES for the captured image; if it exists, send with it; if
// not, SEND ANYWAY at the 3-minute mark." This is the second scheduled
// function in this repo (send-daily-claim-pushes.js was the first — see
// that file's own header comment for the "why a schedule, not a real
// in-request wait" reasoning this one shares); there is no way to invoke
// a real Netlify scheduled trigger from this sandbox, so this exercises
// scanAndSend directly (exactly what it's exported for), same precedent
// as test/send-daily-claim-pushes.test.js.
//
// Deliberately its own file, not folded into
// test/automatic-first-dream-email.test.js (which covers
// mark-generation-completed.js's own enqueue-side logic + all the
// job-owners/pending-dreams race hardening upstream of the enqueue) --
// this is the DOWNSTREAM decide-and-send half specifically: given a
// pending record, does it correctly wait, send with the real thumbnail,
// or fall back once the deadline passes.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var pendingStore = require('../netlify/functions/lib/first-dream-email-pending-store');
var dreamStore = require('../netlify/functions/lib/dream-store');
var accountStore = require('../netlify/functions/lib/account-store');
var sendPending = require('../netlify/functions/send-pending-first-dream-emails');

var realFetch = global.fetch;

/** Same split-by-URL fetch spy shape as test/automatic-first-dream-email.test.js's own installFetchSpy. */
function installFetchSpy() {
  var resendCalls = [];
  var posthogCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    var body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (urlStr.indexOf('api.resend.com') !== -1) {
      resendCalls.push({ url: urlStr, body: body });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    if (urlStr.indexOf('/capture/') !== -1) {
      posthogCalls.push({ url: urlStr, body: body });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
  return { resendCalls: resendCalls, posthogCalls: posthogCalls };
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  process.env.RESEND_API_KEY = 'resend-test-key';
});
test.after(function () {
  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
});

async function registerAccount(username, email) {
  await accountStore.createAccount(fakeEvent({}), { username: username, password: 'realpassword1', email: email });
}

/** Seeds a private-dream record with a matching sourceOperationName, same shape dream-sync.js's own sanitizeDream would produce off a real client upsert. `imageUrl` optional -- omit to model "captured but not yet uploaded/synced". */
async function seedSyncedDream(username, operationName, imageUrl) {
  await dreamStore.upsertPrivateDream(fakeEvent({}), username, {
    id: 'dream-' + operationName,
    ownerHandle: '@' + username,
    caption: 'A test dream', style: 'Cinematic', mediaType: 'video',
    videoUrl: 'https://example.com/v.mp4', imageUrl: imageUrl || null,
    sourceOperationName: operationName
  });
}

test('a pending record with a thumbnail already synced sends IMMEDIATELY, with the real image, without waiting for the 3-minute deadline', async function () {
  await registerAccount('withimage', 'withimage@example.com');
  await seedSyncedDream('withimage', 'mock:1:with-image', 'https://img.example/thumb.jpg');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:with-image', 'withimage', 'withimage@example.com');
  var spies = installFetchSpy();

  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.sentWithImage, 1);
  assert.equal(result.sentFallback, 0);
  assert.equal(result.stillWaiting, 0);
  assert.equal(spies.resendCalls.length, 1);
  assert.match(spies.resendCalls[0].body.html, /object-fit:cover/, 'must render the real thumbnail <img>, not the flat-color fallback banner');
  assert.match(spies.resendCalls[0].body.html, /https:\/\/img\.example\/thumb\.jpg/);

  // Dequeued -- a later scan must not touch it again.
  assert.equal(await pendingStore.getPending(fakeEvent({}), 'mock:1:with-image'), null);
});

test('a pending record with NO thumbnail yet, still within the 3-minute window, waits -- no send, still enqueued', async function () {
  await registerAccount('waiting', 'waiting@example.com');
  // No seedSyncedDream call at all -- models the client not having reached
  // result.html/captured a frame yet.
  await pendingStore.markPending(fakeEvent({}), 'mock:1:waiting', 'waiting', 'waiting@example.com');
  var spies = installFetchSpy();

  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.sentWithImage, 0);
  assert.equal(result.sentFallback, 0);
  assert.equal(result.stillWaiting, 1);
  assert.equal(spies.resendCalls.length, 0, 'must not send the flat-color fallback before the deadline -- the founder\'s own explicit ask');
  assert.ok(await pendingStore.getPending(fakeEvent({}), 'mock:1:waiting'), 'must stay enqueued for a later scan to re-check');
});

test('a synced dream with no imageUrl yet (captured but not uploaded, or never captured) is treated the same as no dream at all -- waits, does not send', async function () {
  await registerAccount('nothumb', 'nothumb@example.com');
  await seedSyncedDream('nothumb', 'mock:1:no-thumb'); // no imageUrl
  await pendingStore.markPending(fakeEvent({}), 'mock:1:no-thumb', 'nothumb', 'nothumb@example.com');
  var spies = installFetchSpy();

  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.stillWaiting, 1);
  assert.equal(spies.resendCalls.length, 0);
});

test('a pending record past the 3-minute deadline with still no thumbnail SENDS ANYWAY, using the no-thumbnail fallback template -- the founder\'s own explicit instruction', async function () {
  await registerAccount('deadline', 'deadline@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:deadline', 'deadline', 'deadline@example.com');

  // Force the enqueued record to look like it was triggered well over 3
  // minutes ago, without this test actually waiting 3 real minutes.
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:deadline');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:deadline', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS - 5000
  }));

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.sentFallback, 1);
  assert.equal(result.sentWithImage, 0);
  assert.equal(spies.resendCalls.length, 1);
  assert.doesNotMatch(spies.resendCalls[0].body.html, /object-fit:cover/, 'past the deadline with no thumbnail must use the flat-color fallback banner, not a broken/missing image');

  assert.equal(await pendingStore.getPending(fakeEvent({}), 'mock:1:deadline'), null, 'must be dequeued once acted on');
});

test('a pending record exactly AT the deadline (elapsed >= THUMBNAIL_WAIT_MS) sends the fallback -- the boundary is inclusive, matching "at the 3-minute mark"', async function () {
  await registerAccount('exact', 'exact@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:exact', 'exact', 'exact@example.com');
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:exact');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:exact', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS
  }));

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.sentFallback, 1);
  assert.equal(spies.resendCalls.length, 1);
});

test('multiple pending records in one scan are each decided independently -- one sends with image, one still waits, one falls back', async function () {
  await registerAccount('multia', 'multia@example.com');
  await registerAccount('multib', 'multib@example.com');
  await registerAccount('multic', 'multic@example.com');

  await seedSyncedDream('multia', 'mock:1:multi-a', 'https://img.example/a.jpg');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:multi-a', 'multia', 'multia@example.com');

  await pendingStore.markPending(fakeEvent({}), 'mock:1:multi-b', 'multib', 'multib@example.com');

  await pendingStore.markPending(fakeEvent({}), 'mock:1:multi-c', 'multic', 'multic@example.com');
  var recordC = await pendingStore.getPending(fakeEvent({}), 'mock:1:multi-c');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:multi-c', Object.assign({}, recordC, {
    triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS - 1000
  }));

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.scanned, 3);
  assert.equal(result.sentWithImage, 1);
  assert.equal(result.stillWaiting, 1);
  assert.equal(result.sentFallback, 1);
  assert.equal(spies.resendCalls.length, 2, 'two of the three should have actually sent (a and c), b is still waiting');
});

test('a record for an account that already got its once-ever email via a different path (e.g. the client-triggered fallback winning first) is a harmless no-op, still dequeued', async function () {
  var firstDreamEmailStore = require('../netlify/functions/lib/first-dream-email-store');
  await registerAccount('racer', 'racer@example.com');
  await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'racer'); // simulates the OTHER path already having won
  await pendingStore.markPending(fakeEvent({}), 'mock:1:racer', 'racer', 'racer@example.com');
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:racer');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:racer', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS - 1000
  }));

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(spies.resendCalls.length, 0, 'the once-ever guard must prevent a second real send');
  assert.equal(result.sentFallback, 1, 'this scan still attempted/dequeued it -- sendIfEligible itself is what no-ops, not this scan skipping it');
  assert.equal(await pendingStore.getPending(fakeEvent({}), 'mock:1:racer'), null);
});

test('an empty pending store is a harmless no-op scan', async function () {
  var result = await sendPending.scanAndSend(fakeEvent({}));
  assert.deepEqual(result, { scanned: 0, sentWithImage: 0, sentFallback: 0, stillWaiting: 0 });
});
