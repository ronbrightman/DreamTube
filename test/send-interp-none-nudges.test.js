// test/send-interp-none-nudges.test.js
//
// Covers netlify/functions/send-interp-none-nudges.js's scanAndSend — the
// decide-and-send half of the AUTOMATIC "No meaning yet" interpretation
// retention email (founder-approved 2026-08-12: "add the no interpretation
// email to also be automatically sent like not watched video"). The scan is
// what a real Netlify scheduled trigger runs; there's no way to invoke a real
// scheduled trigger from this sandbox, so this drives scanAndSend directly
// (exactly what it's exported for), mirroring test/send-unwatched-dream-
// nudges.test.js.
//
// Covers: a WATCHED + read-0 + past-delay dream sends exactly one "none" email
// (embedding the dream text) and dequeues; a dream still inside the ~10-min
// delay floor WAITS (no send); a dream the user has since read >=1
// interpretation on is DEQUEUED without sending (self-suppress); a dream
// already sent by the MANUAL batch (the shared once-per-dream guard already
// claimed) is skipped + dequeued by the scheduler (and vice-versa); an
// UNSUBSCRIBED / founder-excluded recipient is suppressed; an EXPIRED candidate
// is dropped; an empty store is a no-op; and with no RESEND_API_KEY the send
// defers (guard released) and stays enqueued for a later run.
// Run with: node --test test/
//
// SANDBOX LIMITATION: there is no real Resend or Netlify Blobs here —
// global.fetch is spied and test/helpers/mock-blobs.js stands in for Blobs —
// so this proves the scan's decision logic + the exact Resend request it
// builds, NOT a real delivered email.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var queueStore = require('../netlify/functions/lib/interp-none-queue-store');
var interpReadStore = require('../netlify/functions/lib/interp-read-store');
var interpEmailStore = require('../netlify/functions/lib/interp-email-store');
var dreamStore = require('../netlify/functions/lib/dream-store');
var emailSuppressionStore = require('../netlify/functions/lib/email-suppression-store');
var resultViewStore = require('../netlify/functions/lib/result-view-store');
var sendNudges = require('../netlify/functions/send-interp-none-nudges');

var realFetch = global.fetch;

/** Same split-by-URL fetch spy shape as the sibling nudge test. */
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
  delete process.env.OWNER_EMAIL;
  delete process.env.INTERP_NONE_NUDGE_DELAY_MS;
  delete process.env.INTERP_NONE_NUDGE_EXPIRE_MS;
  delete process.env.INTERP_NONE_NUDGE_MAX_PER_RUN;
});
test.after(function () {
  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
});

/**
 * Enqueues a pending "none" candidate and backdates its watchedAt so the scan
 * treats it as past the ~10-minute delay floor (default), without the test
 * actually waiting. `ageMs` overrides how far in the past. The dream is ALSO
 * marked WATCHED (result-view marker) — the real precondition the sender's own
 * belt-and-suspenders re-check enforces.
 */
async function enqueueAged(operationName, username, email, ageMs) {
  await resultViewStore.markViewed(fakeEvent({}), operationName);
  await queueStore.markPending(fakeEvent({}), operationName, username, email);
  var record = await queueStore.getPending(fakeEvent({}), operationName);
  var age = (typeof ageMs === 'number') ? ageMs : (sendNudges.delayMs() + 5000);
  mockBlobs.seed(queueStore.PENDING_STORE_NAME, operationName, Object.assign({}, record, {
    watchedAt: Date.now() - age
  }));
}

/** Seeds a synced private dream with a matching sourceOperationName + human-readable story text. */
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

test('a WATCHED, read-0, past-delay dream sends exactly one "none" email embedding the dream text, then dequeues', async function () {
  var op = 'mock:1:none-send';
  await enqueueAged(op, 'dreamer', 'dreamer@sample.io');
  await seedDream('dreamer', op, { storyText: 'I was flying over a neon city made of glass' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 1);
  assert.equal(result.dequeuedRead, 0);
  assert.equal(spies.resendCalls.length, 1);

  var body = spies.resendCalls[0].body;
  assert.deepEqual(body.to, ['dreamer@sample.io']);
  assert.match(body.subject, /hidden meaning/i, 'the "No meaning yet" subject line');
  assert.match(body.html, /neon city made of glass/, 'the user\'s own dream text rides the email');
  assert.match(body.html, /Jung/, 'the approved copy names Jung as the hook');
  assert.ok(body.headers && body.headers['List-Unsubscribe'], 'RFC 8058 one-click header present');

  assert.equal(await queueStore.getPending(fakeEvent({}), op), null, 'dequeued after send');
});

test('a dream still inside the ~10-minute delay floor WAITS — no send, stays enqueued', async function () {
  var op = 'mock:1:none-toosoon';
  await enqueueAged(op, 'soon', 'soon@sample.io', 60 * 1000); // only 1 minute since watch
  await seedDream('soon', op, { storyText: 'not yet' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.stillWaiting, 1);
  assert.equal(result.sent, 0);
  assert.equal(spies.resendCalls.length, 0, 'give the user time to read a meaning before emailing');
  assert.ok(await queueStore.getPending(fakeEvent({}), op), 'still enqueued for a later scan');
});

test('a dream the user has since READ an interpretation on is DEQUEUED without sending (self-suppress)', async function () {
  var op = 'mock:1:none-read';
  await enqueueAged(op, 'reader', 'reader@sample.io');
  await seedDream('reader', op, { storyText: 'a curious dream' });
  // The user opened one interpretation in the meantime.
  await interpReadStore.markRead(fakeEvent({}), op, 'jung');
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.dequeuedRead, 1);
  assert.equal(result.sent, 0);
  assert.equal(spies.resendCalls.length, 0, 'an engaged reader must not get the "No meaning yet" email');
  assert.equal(await queueStore.getPending(fakeEvent({}), op), null, 'dequeued — they self-suppressed by reading');
});

test('a dream already sent by the MANUAL batch (shared once-per-dream guard claimed) is SKIPPED + dequeued by the scheduler', async function () {
  var op = 'mock:1:none-batchfirst';
  await enqueueAged(op, 'shared', 'shared@sample.io');
  await seedDream('shared', op, { storyText: 'shared dream' });
  // Simulate the manual batch having already sent this dream's "none" email:
  // it claimed the shared once-per-dream CAS marker (interp-email-store).
  var claim = await interpEmailStore.markNoneSentOnce(fakeEvent({}), op);
  assert.ok(claim.ok, 'test setup: the batch claims the shared guard first');
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
  assert.equal(result.skippedTerminal, 1, 'the scheduler sees already_sent from the shared guard and dequeues');
  assert.equal(spies.resendCalls.length, 0, 'the shared guard prevents the scheduler double-sending what the batch sent');
  assert.equal(await queueStore.getPending(fakeEvent({}), op), null, 'dequeued — already_sent never changes on retry');
});

test('once the SCHEDULER sends a dream, a later MANUAL batch send for the same dream is a no-op (vice-versa direction of the shared guard)', async function () {
  var op = 'mock:1:none-schedfirst';
  await enqueueAged(op, 'firstwin', 'firstwin@sample.io');
  await seedDream('firstwin', op, { storyText: 'scheduler wins' });
  var spies1 = installFetchSpy();
  var r1 = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(r1.sent, 1, 'the scheduler sends first and claims the shared guard');
  assert.equal(spies1.resendCalls.length, 1);

  // Now a manual batch tries the same dream: the shared guard is already claimed.
  var noneSender = require('../netlify/functions/lib/interp-none-email-sender');
  var spies2 = installFetchSpy();
  var res = await noneSender.sendIfEligible(fakeEvent({}), {
    operationName: op, username: 'firstwin', email: 'firstwin@sample.io',
    dream: { id: 'dream-' + op, storyText: 'scheduler wins' }
  });
  assert.equal(res.sent, false);
  assert.equal(res.skipped, 'already_sent', 'the batch sees the scheduler already claimed the shared per-dream guard');
  assert.equal(spies2.resendCalls.length, 0, 'no double-send — one "none" email per dream across BOTH senders');
});

test('an UNSUBSCRIBED recipient is suppressed — no send, dequeued', async function () {
  var op = 'mock:1:none-unsub';
  await enqueueAged(op, 'gone', 'gone@sample.io');
  await seedDream('gone', op, { storyText: 'a dream' });
  await emailSuppressionStore.suppress(fakeEvent({}), 'gone@sample.io', 'user_unsubscribed');
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
  assert.equal(result.skippedTerminal, 1);
  assert.equal(spies.resendCalls.length, 0, 'unsubscribed users get nothing');
  assert.equal(await queueStore.getPending(fakeEvent({}), op), null, 'dequeued — unsubscribe does not change on retry');
});

test('a founder/test-EXCLUDED recipient is suppressed — no send, dequeued', async function () {
  var op = 'mock:1:none-excluded';
  process.env.OWNER_EMAIL = 'owner@company.com';
  await enqueueAged(op, 'owner', 'owner@company.com');
  await seedDream('owner', op, { storyText: 'founders own dream' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
  assert.equal(result.skippedTerminal, 1, 'the founder/owner address is excluded at the send choke point');
  assert.equal(spies.resendCalls.length, 0);
  assert.equal(await queueStore.getPending(fakeEvent({}), op), null, 'dequeued — exclusion never changes on retry');
});

test('an EXPIRED candidate (aged past the expire window) is DROPPED without sending', async function () {
  var op = 'mock:1:none-expired';
  process.env.INTERP_NONE_NUDGE_EXPIRE_MS = String(60 * 60 * 1000); // 1h expire for the test
  // Aged well past the 1h expire window.
  await enqueueAged(op, 'stale', 'stale@sample.io', 2 * 60 * 60 * 1000);
  await seedDream('stale', op, { storyText: 'too old now' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.expired, 1);
  assert.equal(result.sent, 0);
  assert.equal(spies.resendCalls.length, 0, 'a stale candidate is dropped, never sent late');
  assert.equal(await queueStore.getPending(fakeEvent({}), op), null, 'dropped and dequeued');
});

test('an empty pending store is a harmless no-op scan', async function () {
  var result = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(result.scanned, 0);
  assert.equal(result.sent, 0);
});

test('with no RESEND_API_KEY, the send defers (shared guard released) and stays enqueued for a later run', async function () {
  delete process.env.RESEND_API_KEY;
  var op = 'mock:1:none-nokey';
  await enqueueAged(op, 'nokey', 'nokey@sample.io');
  await seedDream('nokey', op, { storyText: 'later' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 0);
  assert.equal(result.stillWaiting, 1, 'a no-key transient skip stays enqueued (not terminal)');
  assert.equal(spies.resendCalls.length, 0);
  assert.ok(await queueStore.getPending(fakeEvent({}), op), 'stays enqueued to retry once a key is configured');

  // And once the key is set, a later scan actually sends it (guard was released, not burned).
  process.env.RESEND_API_KEY = 'resend-test-key';
  var spies2 = installFetchSpy();
  var result2 = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(result2.sent, 1, 'the released shared guard lets a later run send — the config gap did not burn this dream\'s one email');
  assert.equal(spies2.resendCalls.length, 1);
});

test('the per-run cap bounds how many candidates a single scan processes', async function () {
  process.env.INTERP_NONE_NUDGE_MAX_PER_RUN = '2';
  for (var n = 0; n < 4; n++) {
    var op = 'mock:1:none-cap-' + n;
    await enqueueAged(op, 'capuser' + n, 'capuser' + n + '@sample.io');
    await seedDream('capuser' + n, op, { storyText: 'dream ' + n });
  }
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.scanned, 2, 'the scan stops after MAX_PER_RUN candidates');
  assert.equal(spies.resendCalls.length, 2, 'at most MAX_PER_RUN sends per invocation');
});
