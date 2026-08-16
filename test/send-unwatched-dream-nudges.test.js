// test/send-unwatched-dream-nudges.test.js
//
// Covers netlify/functions/send-unwatched-dream-nudges.js's scanAndSend —
// the decide-and-send half of the "unwatched dream" retention nudge
// (founder-approved retention plan, piece 1). As of the founder's 2026-08-11
// decision (retire the separate first-dream email; let this nudge be the
// single "your dream is ready to watch" email per unwatched dream, INCLUDING
// a user's first), this scan drives the only such email the app now sends a
// signed-up user. The scan is what a real Netlify scheduled trigger runs;
// there's no way to invoke a real scheduled trigger from this sandbox, so
// this drives scanAndSend directly (exactly what it's exported for).
//
// Covers: a ready-but-UNVIEWED signed-up dream sends exactly one email
// carrying the dream text (subject + body) + the real thumbnail + the RFC
// 8058 List-Unsubscribe headers; a user's FIRST unwatched dream (nothing
// else suppressing) is nudged, not skipped; a VIEWED dream is suppressed
// (no send); an UNSUBSCRIBED recipient is suppressed; a double-scan sends
// only once (idempotent, via the once-per-dream CAS guard); a too-soon dream
// waits; a dream that never gets a thumbnail is eventually dropped (never
// sent thumbnail-less).
// Run with: node --test test/
//
// SANDBOX LIMITATION: there is no real Resend or Netlify Blobs here —
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
  // The subject is PLAIN TEXT — it must NOT carry raw HTML entities (they
  // render literally in an inbox subject; founder-caught 2026-08-15).
  assert.doesNotMatch(body.subject, /&(ldquo|rdquo|mdash|hellip|amp|#\d+);/, 'the subject must use real Unicode punctuation, not HTML entities');
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
  // Observability (founder ask 2026-08-16 "why only N of M enqueued sent?"): a
  // viewed-suppression must now emit unwatched_dream_nudge_suppressed{reason:viewed}
  // so the enqueue->resolution accounting closes at source instead of leaving a
  // silent gap.
  var suppressed = spies.posthogCalls.filter(function (c) {
    return c.body && c.body.event === 'unwatched_dream_nudge_suppressed';
  });
  assert.equal(suppressed.length, 1, 'a viewed-suppression fires exactly one suppressed telemetry event');
  assert.equal(suppressed[0].body.properties.reason, 'viewed', 'suppressed event carries reason:viewed');
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
  // Observability (founder ask 2026-08-16): a TERMINAL skip (not just the
  // viewed path) must also fire unwatched_dream_nudge_suppressed, carrying
  // the sender's own skip reason prefixed 'terminal:' — so the accounting
  // closes for every non-send resolution, not just the viewed one.
  var suppressed = spies.posthogCalls.filter(function (c) {
    return c.body && c.body.event === 'unwatched_dream_nudge_suppressed';
  });
  assert.equal(suppressed.length, 1, 'a terminal-skip suppression fires exactly one suppressed telemetry event');
  assert.equal(suppressed[0].body.properties.reason, 'terminal:suppressed', 'suppressed event carries reason:terminal:<skip>');
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

test('a user\'s FIRST unwatched dream (nothing else suppressing) gets exactly one nudge — the nudge now covers the first dream (founder decision 2026-08-11: the separate first-dream email was retired, so nothing suppresses this anymore)', async function () {
  var op = 'mock:1:firstDream';
  await enqueueAged(op, 'firsty', 'firsty@example.com');
  await seedDream('firsty', op, { id: 'dream-firsty-1', storyText: 'my very first dream', imageUrl: 'https://img.example/1.jpg' });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 1, 'a first unwatched dream must be nudged — there is no longer a first-dream email to step aside for');
  assert.equal(spies.resendCalls.length, 1);
  assert.deepEqual(spies.resendCalls[0].body.to, ['firsty@example.com']);
  assert.match(spies.resendCalls[0].body.html, /my very first dream/, 'the first dream\'s own text rides the nudge');
  assert.equal(await nudgeStore.getPending(fakeEvent({}), op), null, 'dequeued after send');
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

test('a NORMAL dream past the floor with NO thumbnail WAITS for its client still to sync, then (past give-up) SENDS with the branded fallback hero rather than dropping (founder 2026-08-15: never silently drop the recovery email)', async function () {
  var op = 'mock:1:noThumb';
  // Past the floor, but not yet past give-up; no thumbnail synced.
  await enqueueAged(op, 'nothumb', 'nothumb@example.com', sendNudges.READY_AGE_MS + 5000);
  await seedDream('nothumb', op, { storyText: 'pending frame', imageUrl: null });
  var spies = installFetchSpy();

  // Within the grace window: give the client first-frame still time to sync.
  var waiting = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(waiting.stillWaiting, 1, 'no thumbnail yet, still inside grace -- waits');
  assert.equal(spies.resendCalls.length, 0);

  // Past the give-up window, still no thumbnail -> SEND with the branded
  // fallback (was: silently dropped, which killed the recovery email).
  var record = await nudgeStore.getPending(fakeEvent({}), op);
  mockBlobs.seed(nudgeStore.PENDING_STORE_NAME, op, Object.assign({}, record, {
    triggeredAt: Date.now() - sendNudges.GIVE_UP_AFTER_MS - 1000
  }));
  var spies2 = installFetchSpy();
  var sentRes = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(sentRes.sent, 1, 'past give-up with no client thumbnail, the email still sends (with a fallback hero)');
  assert.equal(spies2.resendCalls.length, 1);
  assert.match(spies2.resendCalls[0].body.html, /dream-neon\.webp/, 'the branded fallback dreamscape is the hero when no per-dream thumbnail exists');
  assert.match(spies2.resendCalls[0].body.html, /pending frame/, 'the dream text still personalizes the email');
  assert.equal(await nudgeStore.getPending(fakeEvent({}), op), null, 'sent and dequeued');
});

test('a RECOVERY dream with NO thumbnail (the webview-leaver cohort) SENDS PROMPTLY with the branded fallback hero — fixes the no_thumbnail drop that silently killed the recovery email (founder 2026-08-15)', async function () {
  delete process.env.RECOVERY_NUDGE_DELAY_MS;
  delete process.env.UNWATCHED_NUDGE_DELAY_MS;
  var op = 'mock:1:rec-nothumb';
  // Past the short recovery floor, nowhere near the give-up window — the
  // webview leaver's server-persisted dream carries a videoUrl but no imageUrl
  // and never will (fal returns no poster, no client ran to sync a still).
  await enqueueAgedRecovery(op, 'recnothumb', 'recnothumb@example.com', sendNudges.RECOVERY_READY_AGE_MS + 30 * 1000);
  await seedDream('recnothumb', op, { storyText: 'left before the frame synced', imageUrl: null });
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 1, 'the recovery email sends promptly even with no thumbnail — no more silent no_thumbnail drop');
  assert.equal(spies.resendCalls.length, 1);
  assert.match(spies.resendCalls[0].body.html, /dream-neon\.webp/, 'uses the branded fallback dreamscape hero');
  assert.deepEqual(spies.resendCalls[0].body.to, ['recnothumb@example.com']);
  assert.equal(await nudgeStore.getPending(fakeEvent({}), op), null, 'sent and dequeued');
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

test('SEND-TIME viewed re-check: the sender itself refuses to send if a viewed marker landed after the scan\'s step-1 check, WITHOUT burning the once-per-dream guard (founder ask: re-check watched at send time, not just enqueue)', async function () {
  var nudgeSender = require('../netlify/functions/lib/unwatched-dream-nudge-sender');
  var op = 'mock:1:sendrace';
  await resultViewStore.markViewed(fakeEvent({}), op);
  var spies = installFetchSpy();

  var res = await nudgeSender.sendIfEligible(fakeEvent({}), {
    operationName: op,
    username: 'racer', email: 'racer@example.com',
    dream: { id: 'd-sendrace', imageUrl: 'https://img.example/r.jpg', storyText: 'a dream' }
  });

  assert.equal(res.sent, false);
  assert.equal(res.skipped, 'already_viewed');
  assert.equal(spies.resendCalls.length, 0, 'a watched dream must not get a nudge even if it reaches the sender');
  // The once-per-dream guard must NOT have been burned by the watched-suppress.
  var guard = await nudgeStore.markNudgedOnce(fakeEvent({}), op, 'd-sendrace');
  assert.ok(guard.ok, 'the watched re-check must skip BEFORE claiming the guard — it must still be claimable');
});

// ===== SHORT recovery-delay floor for server-side (webview-leaver) enqueues =====
//
// A record flagged `recoveryEnqueue` (dream-webhook.js's server-side enqueue,
// fired when the CLIENT never marked completion — an FB/IG-webview leaver) uses
// a SHORTER pre-send floor so the recovery email — whose link opens the user's
// real browser to the durably-saved video — lands promptly. The watched/active
// guard is fully intact: the shorter floor only changes how soon we CHECK-and-
// send. Env-tunable via RECOVERY_NUDGE_DELAY_MS / UNWATCHED_NUDGE_DELAY_MS.

/** Like enqueueAged, but flags the record recoveryEnqueue (the server-side webhook enqueue path). */
async function enqueueAgedRecovery(operationName, username, email, ageMs) {
  await nudgeStore.markPending(fakeEvent({}), operationName, username, email, { recovery: true });
  var record = await nudgeStore.getPending(fakeEvent({}), operationName);
  assert.equal(record.recoveryEnqueue, true, 'test setup: the recovery flag must be stored on the pending record');
  var age = (typeof ageMs === 'number') ? ageMs : (sendNudges.RECOVERY_READY_AGE_MS + 5000);
  mockBlobs.seed(nudgeStore.PENDING_STORE_NAME, operationName, Object.assign({}, record, {
    triggeredAt: Date.now() - age
  }));
}

test('a RECOVERY-flagged dream SENDS after the SHORT recovery floor while a standard-enqueued dream of the SAME age still WAITS', async function () {
  delete process.env.RECOVERY_NUDGE_DELAY_MS;
  delete process.env.UNWATCHED_NUDGE_DELAY_MS;
  // An age past the 3-min recovery floor but still inside the 7-min standard floor.
  var age = sendNudges.RECOVERY_READY_AGE_MS + 30 * 1000;
  assert.ok(age < sendNudges.READY_AGE_MS, 'sanity: this age is inside the standard floor');

  var opStd = 'mock:1:std-young';
  await enqueueAged(opStd, 'stduser', 'stduser@example.com', age); // client-enqueued (no recovery flag)
  await seedDream('stduser', opStd, { storyText: 'client dream', imageUrl: 'https://img.example/c.jpg' });

  var opRec = 'mock:1:rec-young';
  await enqueueAgedRecovery(opRec, 'recuser', 'recuser@example.com', age); // server-enqueued (recovery)
  await seedDream('recuser', opRec, { storyText: 'recovery dream', imageUrl: 'https://img.example/r.jpg' });

  var spies = installFetchSpy();
  var result = await sendNudges.scanAndSend(fakeEvent({}));

  assert.equal(result.sent, 1, 'only the recovery dream is eligible at this age');
  assert.equal(result.stillWaiting, 1, 'the standard dream keeps waiting under the longer floor');
  assert.equal(spies.resendCalls.length, 1);
  assert.deepEqual(spies.resendCalls[0].body.to, ['recuser@example.com'], 'only the recovery dream got the prompt email');
  assert.ok(await nudgeStore.getPending(fakeEvent({}), opStd), 'the standard dream is still enqueued');
  assert.equal(await nudgeStore.getPending(fakeEvent({}), opRec), null, 'the recovery dream was sent and dequeued');
});

test('the WATCHED guard still suppresses a RECOVERY-flagged dream — the short floor never emails someone who already watched', async function () {
  delete process.env.RECOVERY_NUDGE_DELAY_MS;
  var op = 'mock:1:rec-watched';
  await enqueueAgedRecovery(op, 'recwatch', 'recwatch@example.com');
  await seedDream('recwatch', op, { storyText: 'watched recovery', imageUrl: 'https://img.example/w.jpg' });
  await resultViewStore.markViewed(fakeEvent({}), op); // they watched it
  var spies = installFetchSpy();

  var result = await sendNudges.scanAndSend(fakeEvent({}));
  assert.equal(result.suppressedViewed, 1);
  assert.equal(result.sent, 0);
  assert.equal(spies.resendCalls.length, 0, 'a watched dream is suppressed even on the short recovery floor');
});

test('RECOVERY_NUDGE_DELAY_MS env var tunes the recovery floor (a record younger than the override waits)', async function () {
  process.env.RECOVERY_NUDGE_DELAY_MS = String(20 * 60 * 1000); // override to 20 min
  try {
    var op = 'mock:1:rec-envtune';
    await enqueueAgedRecovery(op, 'envuser', 'envuser@example.com', 5 * 60 * 1000); // 5 min: past 3-min default, inside 20-min override
    await seedDream('envuser', op, { storyText: 'tuned', imageUrl: 'https://img.example/t.jpg' });
    var spies = installFetchSpy();

    var result = await sendNudges.scanAndSend(fakeEvent({}));
    assert.equal(result.stillWaiting, 1, 'the env-overridden longer recovery floor keeps it waiting');
    assert.equal(result.sent, 0);
    assert.equal(spies.resendCalls.length, 0);
  } finally {
    delete process.env.RECOVERY_NUDGE_DELAY_MS;
  }
});
