// test/send-unwatched-dream-nudges.test.js
//
// Covers netlify/functions/send-unwatched-dream-nudges.js's scanAndSend —
// the decide-and-send half of the "unwatched dream" retention nudge
// (founder-approved retention plan, piece 1). The scan is what a real
// Netlify scheduled trigger runs; there's no way to invoke a real scheduled
// trigger from this sandbox, so this drives scanAndSend directly (exactly
// what it's exported for), same precedent as
// test/send-pending-first-dream-emails.test.js.
//
// Covers: a ready-but-UNVIEWED signed-up dream sends exactly one email
// carrying the dream text (subject + body) + the real thumbnail + the RFC
// 8058 List-Unsubscribe headers; a VIEWED dream is suppressed (no send); an
// UNSUBSCRIBED recipient is suppressed; a double-scan sends only once
// (idempotent, via the once-per-dream CAS guard); a dream the automatic
// FIRST-dream email already covered is suppressed (no double "your dream is
// ready"); a too-soon dream waits; a dream that never gets a thumbnail is
// eventually dropped (never sent thumbnail-less).
// Run with: node --test test/
//
// SANDBOX LIMITATION (same honest caveat as test/send-pending-first-dream-
// emails.test.js): there is no real Resend or Netlify Blobs here —
// global.fetch is spied and test/helpers/mock-blobs.js stands in for Blobs
// — so this proves the scan's decision logic + the exact Resend request it
// builds, NOT a real delivered email.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var nudgeStore = require('../netlify/functions/lib/unwatched-dream-nudge-store');
var resultViewStore = require('../netlify/functions/lib/result-view-store');
var dreamStore = require('../netlify/functions/lib/dream-store');
var emailSuppressionStore = require('../netlify/functions/lib/email-suppression-store');
var firstDreamEmailStore = require('../netlify/functions/lib/first-dream-email-store');
var sendNudges = require('../netlify/functions/send-unwatched-dream-nudges');

var realFetch = global.fetch;

/** Same split-by-URL fetch spy shape as the sibling email tests. */
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

/**
 * Enqueues a pending nudge and backdates its triggeredAt so the scan treats
 * it as past the 7-minute unwatched floor (default), without the test
 * actually waiting. `ageMs` overrides how far in the past.
 */
async function enqueueAged(operationName, username, email, ageMs) {
  await nudgeStore.markPending(fakeEvent({}), operationName, username, email);
  var record = await nudgeStore.getPending(fakeEvent({}), operationName);
  var age = (typeof ageMs === 'number') ? ageMs : (sendNudges.READY_AGE_MS + 5000);
  mockBlobs.seed(nudgeStore.PENDING_STORE_NAME, operationName, Object.assign({}, record, {
    triggeredAt: Date.now() - age
  }));
}

/** Seeds a synced private dream with a matching sourceOperationName, thumbnail, and human-readable story text. */
async function seedDream(username, operationName, opts) {
  opts = opts || {};
  await dreamStore.upsertPrivateDream(fakeEvent({}), username, {
    id: opts.id || ('dream-' + operationName),
    ownerHandle: '@' + username,
    caption: opts.caption !== undefined ? opts.caption : 'A test dream',
    storyText: opts.storyText,
    style: 'Cinematic', mediaType: 'video',
    videoUrl: 'https://example.com/v.mp4',
    imageUrl: opts.imageUrl !== undefined ? opts.imageUrl : 'https://img.example/thumb.jpg',
    sourceOperationName: operationName
  });
}

test('a ready, UNVIEWED signed-up dream sends exactly one email with the dream text (subject + body), the real thumbnail, and the RFC 8058 List-Unsubscribe headers', async function () {
  var op = 'mock:1:unwatched';
  await enqueueAged(op, 'dreamer', 'dreamer@example.com');
  await seedDream('dreamer', op, { storyText: 'I was flying over a neon city made of glass', imageUrl: 'https://img.example/neon.jpg' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 1);
  assert.equal(result.suppressedViewed, 0);
  assert.equal(spies.resendCalls.length, 1);

  var body = spies.resendCalls[0].body;
  assert.deepEqual(body.to, ['dreamer@example.com']);
  assert.match(body.subject, /neon city made of glass/, 'the dream text must be embedded in the subject');
  assert.match(body.html, /neon city made of glass/, 'the dream text must be embedded in the body');
  assert.match(body.html, /https:\/\/img\.example\/neon\.jpg/, 'the real thumbnail must be rendered');
  assert.match(body.html, /object-fit:cover/, 'the thumbnail <img> uses the shared banner style');
  // RFC 8058 one-click headers.
  assert.ok(body.headers, 'must send message headers');
  assert.match(body.headers['List-Unsubscribe'], /unsubscribe-email\?email=/, 'List-Unsubscribe header present, pointing at the unsubscribe endpoint');
  assert.equal(body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  // Provider-side idempotency key.
  assert.equal(JSON.parse(JSON.stringify(spies.resendCalls[0].url)), 'https://api.resend.com/emails');

  // Dequeued after send.
  assert.equal(await nudgeStore.getPending(fakeEvent({}), op), null);
});

test('a VIEWED dream is suppressed — no send, dequeued', async function () {
  var op = 'mock:1:viewed';
  await enqueueAged(op, 'watcher', 'watcher@example.com');
  await seedDream('watcher', op, { storyText: 'a quiet forest', imageUrl: 'https://img.example/f.jpg' });
  // The user actually watched it.
  await resultViewStore.markViewed(fakeEvent({}), op);
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.suppressedViewed, 1);
  assert.equal(result.sent, 0);
  assert.equal(spies.resendCalls.length, 0, 'a watched dream must never get an unwatched nudge');
  assert.equal(await nudgeStore.getPending(fakeEvent({}), op), null, 'dequeued once suppressed');
});

test('an UNSUBSCRIBED recipient is suppressed — no send', async function () {
  var op = 'mock:1:unsub';
  await enqueueAged(op, 'gone', 'gone@example.com');
  await seedDream('gone', op, { storyText: 'a dream', imageUrl: 'https://img.example/g.jpg' });
  await emailSuppressionStore.suppress(fakeEvent({}), 'gone@example.com', 'user_unsubscribed');
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
  assert.equal(result.skippedTerminal, 1);
  assert.equal(spies.resendCalls.length, 0, 'unsubscribed users get nothing');
  assert.equal(await nudgeStore.getPending(fakeEvent({}), op), null, 'dequeued — unsubscribe does not change on retry');
});

test('a double-scan sends only ONCE (idempotent via the once-per-dream guard)', async function () {
  var op = 'mock:1:once';
  await enqueueAged(op, 'solo', 'solo@example.com');
  await seedDream('solo', op, { storyText: 'only once', imageUrl: 'https://img.example/o.jpg' });

  var spies1 = installFetchSpy();
  var r1 = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(r1.sent, 1);
  assert.equal(spies1.resendCalls.length, 1);

  // Re-enqueue the SAME dream (simulating a record that wasn't dequeued, or
  // a duplicate enqueue) and scan again — the CAS sent-guard must no-op it.
  await enqueueAged(op, 'solo', 'solo@example.com');
  var spies2 = installFetchSpy();
  var r2 = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(spies2.resendCalls.length, 0, 'the once-per-dream guard prevents a second real send');
  assert.equal(r2.skippedTerminal, 1, 'the second scan sees already_nudged and dequeues');
});

test('a dream the automatic FIRST-dream email already covered is suppressed — no double "your dream is ready"', async function () {
  var op = 'mock:1:overlap';
  var dreamId = 'dream-overlap-1';
  await enqueueAged(op, 'firsty', 'firsty@example.com');
  await seedDream('firsty', op, { id: dreamId, storyText: 'my very first dream', imageUrl: 'https://img.example/1.jpg' });
  // The first-dream email already sent for THIS SAME dream.
  await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'firsty', dreamId);
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
  assert.equal(result.skippedTerminal, 1);
  assert.equal(spies.resendCalls.length, 0, 'must not send a second near-identical email for the same dream');
  assert.equal(await nudgeStore.getPending(fakeEvent({}), op), null);
});

test('the first-dream email covering a DIFFERENT (earlier) dream does NOT suppress a nudge for a later unwatched dream', async function () {
  var op = 'mock:1:secondDream';
  await enqueueAged(op, 'repeat', 'repeat@example.com');
  await seedDream('repeat', op, { id: 'dream-second', storyText: 'my second dream', imageUrl: 'https://img.example/2.jpg' });
  // First-dream email was for the account's FIRST dream (a different id).
  await firstDreamEmailStore.markSentOnce(fakeEvent({}), 'repeat', 'dream-first');
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 1, 'the nudge covers unwatched dreams the once-ever first-dream email cannot');
  assert.equal(spies.resendCalls.length, 1);
});

test('a dream still inside the 7-minute unwatched floor WAITS — no send, stays enqueued', async function () {
  var op = 'mock:1:tooSoon';
  await enqueueAged(op, 'soon', 'soon@example.com', 60 * 1000); // only 1 minute old
  await seedDream('soon', op, { storyText: 'not yet', imageUrl: 'https://img.example/s.jpg' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.stillWaiting, 1);
  assert.equal(result.sent, 0);
  assert.equal(spies.resendCalls.length, 0, 'give the user time to watch before nudging');
  assert.ok(await nudgeStore.getPending(fakeEvent({}), op), 'still enqueued for a later scan');
});

test('a dream past the floor but with NO thumbnail yet WAITS, then DROPS past the give-up window (never sent thumbnail-less)', async function () {
  var op = 'mock:1:noThumb';
  // Past the floor, but not yet past give-up; no thumbnail synced.
  await enqueueAged(op, 'nothumb', 'nothumb@example.com', sendNudges.READY_AGE_MS + 5000);
  await seedDream('nothumb', op, { storyText: 'pending frame', imageUrl: null });
  var spies = installFetchSpy();

  var waiting = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(waiting.stillWaiting, 1, 'no thumbnail yet -- waits');
  assert.equal(spies.resendCalls.length, 0);

  // Now push it past the give-up window; still no thumbnail -> drop.
  var record = await nudgeStore.getPending(fakeEvent({}), op);
  mockBlobs.seed(nudgeStore.PENDING_STORE_NAME, op, Object.assign({}, record, {
    triggeredAt: Date.now() - sendNudges.GIVE_UP_AFTER_MS - 1000
  }));
  var spies2 = installFetchSpy();
  var dropped = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(dropped.droppedNoThumbnail, 1);
  assert.equal(spies2.resendCalls.length, 0, 'past the window with no thumbnail sends NOTHING, not a bare email');
  assert.equal(await nudgeStore.getPending(fakeEvent({}), op), null, 'dropped and dequeued');
});

test('an empty pending store is a harmless no-op scan', async function () {
  var result = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(result.scanned, 0);
  assert.equal(result.sent, 0);
});

test('with no RESEND_API_KEY, the send defers (guard released) and stays enqueued for a later run', async function () {
  delete process.env.RESEND_API_KEY;
  var op = 'mock:1:nokey';
  await enqueueAged(op, 'nokey', 'nokey@example.com');
  await seedDream('nokey', op, { storyText: 'later', imageUrl: 'https://img.example/l.jpg' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
  assert.equal(spies.resendCalls.length, 0);
  assert.ok(await nudgeStore.getPending(fakeEvent({}), op), 'stays enqueued to retry once a key is configured');

  // And once the key is set, a later scan actually sends it (guard was released, not burned).
  process.env.RESEND_API_KEY = 'resend-test-key';
  var spies2 = installFetchSpy();
  var result2 = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(result2.sent, 1, 'the released guard lets a later run send — the config gap did not burn this dream\'s one nudge');
  assert.equal(spies2.resendCalls.length, 1);
});
