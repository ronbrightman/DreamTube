// test/send-pending-first-dream-emails.test.js
//
// Covers netlify/functions/send-pending-first-dream-emails.js's
// scanAndSend -- tracker item for-product-email-redesign-unsubscribe-l-16ysmp's
// thumbnail-gating follow-up, as amended by the founder's 2026-08-08 rule
// ("do NOT send the email at all until the thumbnail is available"): wait
// for the captured image; if it lands within the give-up window, send with
// it; if it NEVER lands, DROP the email (never a thumbnail-less send). The
// old "SEND ANYWAY at the 3-minute mark" flat-color fallback is gone -- see
// send-pending-first-dream-emails.js's "DROP, NOT SEND-ANYWAY" header note.
// This is the second scheduled
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
  assert.equal(result.droppedNoThumbnail, 0);
  assert.equal(result.stillWaiting, 0);
  assert.equal(spies.resendCalls.length, 1);
  assert.match(spies.resendCalls[0].body.html, /object-fit:cover/, 'must render the real thumbnail <img>');
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
  assert.equal(result.droppedNoThumbnail, 0);
  assert.equal(result.stillWaiting, 1);
  assert.equal(spies.resendCalls.length, 0, 'must not send before a thumbnail lands -- the founder\'s own explicit ask');
  assert.ok(await pendingStore.getPending(fakeEvent({}), 'mock:1:waiting'), 'must stay enqueued for a later scan to re-check');
});

test('DEFERRED THEN SENT: a first scan with no thumbnail defers (no send), and a later scan once the thumbnail has synced sends WITH the real image in the HTML -- the core founder 08-08 flow', async function () {
  await registerAccount('deferred', 'deferred@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:deferred', 'deferred', 'deferred@example.com');

  var spies1 = installFetchSpy();
  var first = await sendPending.scanAndSend(fakeEvent({}));
  assert.equal(first.stillWaiting, 1, 'no thumbnail yet -- must defer');
  assert.equal(spies1.resendCalls.length, 0, 'must NOT send a thumbnail-less email on the first scan');
  assert.ok(await pendingStore.getPending(fakeEvent({}), 'mock:1:deferred'), 'still enqueued for a later scan');

  // The client's capture finally syncs -- the dream now has a real imageUrl.
  await seedSyncedDream('deferred', 'mock:1:deferred', 'https://img.example/deferred-thumb.jpg');

  var spies2 = installFetchSpy();
  var second = await sendPending.scanAndSend(fakeEvent({}));
  assert.equal(second.sentWithImage, 1, 'the thumbnail landed -- now it sends');
  assert.equal(spies2.resendCalls.length, 1);
  assert.match(spies2.resendCalls[0].body.html, /<img src="https:\/\/img\.example\/deferred-thumb\.jpg"/, 'the deferred-then-sent email must carry the real thumbnail');
  assert.equal(await pendingStore.getPending(fakeEvent({}), 'mock:1:deferred'), null, 'dequeued once sent');
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

test('a pending record past the give-up window with still no thumbnail is DROPPED -- never sent thumbnail-less (founder rule 2026-08-08)', async function () {
  await registerAccount('deadline', 'deadline@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:deadline', 'deadline', 'deadline@example.com');

  // Force the enqueued record to look like it was triggered well past the
  // give-up window, without this test actually waiting for it.
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:deadline');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:deadline', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.GIVE_UP_AFTER_MS - 5000
  }));

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.droppedNoThumbnail, 1);
  assert.equal(result.sentWithImage, 0);
  assert.equal(spies.resendCalls.length, 0, 'past the window with no thumbnail must send NOTHING, not a bare email');

  assert.equal(await pendingStore.getPending(fakeEvent({}), 'mock:1:deadline'), null, 'must be dequeued once dropped');
});

test('a pending record exactly AT the give-up window (elapsed >= GIVE_UP_AFTER_MS) is dropped -- the boundary is inclusive', async function () {
  await registerAccount('exact', 'exact@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:exact', 'exact', 'exact@example.com');
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:exact');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:exact', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.GIVE_UP_AFTER_MS
  }));

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.droppedNoThumbnail, 1);
  assert.equal(spies.resendCalls.length, 0);
});

test('multiple pending records in one scan are each decided independently -- one sends with image, one still waits, one is dropped', async function () {
  await registerAccount('multia', 'multia@example.com');
  await registerAccount('multib', 'multib@example.com');
  await registerAccount('multic', 'multic@example.com');

  await seedSyncedDream('multia', 'mock:1:multi-a', 'https://img.example/a.jpg');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:multi-a', 'multia', 'multia@example.com');

  await pendingStore.markPending(fakeEvent({}), 'mock:1:multi-b', 'multib', 'multib@example.com');

  await pendingStore.markPending(fakeEvent({}), 'mock:1:multi-c', 'multic', 'multic@example.com');
  var recordC = await pendingStore.getPending(fakeEvent({}), 'mock:1:multi-c');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:multi-c', Object.assign({}, recordC, {
    triggeredAt: Date.now() - sendPending.GIVE_UP_AFTER_MS - 1000
  }));

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.scanned, 3);
  assert.equal(result.sentWithImage, 1);
  assert.equal(result.stillWaiting, 1);
  assert.equal(result.droppedNoThumbnail, 1);
  assert.equal(spies.resendCalls.length, 1, 'only a (the one with a synced thumbnail) actually sends; b is still waiting, c is dropped');
});

test('a record whose thumbnail lands, for an account that already got its once-ever email via a different path (client-triggered fallback winning first), is a harmless no-op via the guard, still dequeued', async function () {
  var firstDreamEmailStore = require('../netlify/functions/lib/first-dream-email-store');
  await registerAccount('racer', 'racer@example.com');
  await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'racer'); // simulates the OTHER path already having won
  // A thumbnail HAS now synced, so this scan hits the send-with-image branch
  // (the only path that actually calls sendIfEligible) -- which the once-ever
  // guard no-ops, proving the guard, not this scan, is what prevents a
  // second real send.
  await seedSyncedDream('racer', 'mock:1:racer', 'https://img.example/racer.jpg');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:racer', 'racer', 'racer@example.com');

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(spies.resendCalls.length, 0, 'the once-ever guard must prevent a second real send');
  assert.equal(result.sentWithImage, 1, 'this scan still attempted/dequeued it -- sendIfEligible itself is what no-ops, not this scan skipping it');
  assert.equal(await pendingStore.getPending(fakeEvent({}), 'mock:1:racer'), null);
});

test('an empty pending store is a harmless no-op scan', async function () {
  var result = await sendPending.scanAndSend(fakeEvent({}));
  assert.deepEqual(result, { scanned: 0, sentWithImage: 0, suppressedViewed: 0, droppedNoThumbnail: 0, stillWaiting: 0 });
});

test('WATCHED-AWARE: a pending record whose dream the user has already opened the fullscreen player for is SUPPRESSED — no send, even with a thumbnail synced (founder complaint 2026-08-10)', async function () {
  var resultViewStore = require('../netlify/functions/lib/result-view-store');
  await registerAccount('watched', 'watched@example.com');
  // The dream is fully ready (thumbnail synced) — the ONLY reason not to send
  // is that it was watched.
  await seedSyncedDream('watched', 'mock:1:watched', 'https://img.example/watched.jpg');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:watched', 'watched', 'watched@example.com');
  // The user opened the fullscreen player — the server-side viewed marker.
  await resultViewStore.markViewed(fakeEvent({}), 'mock:1:watched');
  var spies = installFetchSpy();

  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.suppressedViewed, 1, 'a watched dream must be suppressed');
  assert.equal(result.sentWithImage, 0);
  assert.equal(spies.resendCalls.length, 0, 'must NOT send a "ready to watch" email for a dream the user already watched');
  assert.equal(await pendingStore.getPending(fakeEvent({}), 'mock:1:watched'), null, 'suppressed record must be dequeued');
});

test('WATCHED-AWARE belt-and-suspenders: even if a scan somehow reached the send branch, the shared sender itself re-checks the viewed marker and refuses to send (no guard burned)', async function () {
  var resultViewStore = require('../netlify/functions/lib/result-view-store');
  var firstDreamEmailStore = require('../netlify/functions/lib/first-dream-email-store');
  var firstDreamEmailSender = require('../netlify/functions/lib/first-dream-email-sender');
  await registerAccount('senderguard', 'senderguard@example.com');
  await resultViewStore.markViewed(fakeEvent({}), 'mock:1:senderguard');
  var spies = installFetchSpy();

  var res = await firstDreamEmailSender.sendIfEligible(fakeEvent({}), {
    username: 'senderguard', email: 'senderguard@example.com',
    dreamId: 'd-senderguard', operationName: 'mock:1:senderguard',
    imageUrl: 'https://img.example/x.jpg', auto: true
  });

  assert.equal(res.sent, false);
  assert.equal(res.skipped, 'already_viewed');
  assert.equal(spies.resendCalls.length, 0);
  // Crucially: the once-ever guard must NOT be burned — a genuinely-unwatched
  // later dream must still be able to claim it.
  var guard = await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'senderguard');
  assert.ok(guard.ok, 'the account\'s one-time guard must still be claimable — the watched-suppress must not have burned it');
});
