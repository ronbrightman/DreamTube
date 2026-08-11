// test/send-interp-emails-batch.test.js
//
// Covers netlify/functions/send-interp-emails-batch.js (the owner-gated,
// hard-capped interpretation-retention batch sender) plus its libs:
// lib/interp-read-store.js (the durable SERVER-SIDE "which personas were
// read on this dream" signal — the hard part this feature depends on),
// lib/interp-email-store.js (the two once-per-dream CAS send guards), and
// lib/interp-unread-email-sender.js / lib/interp-none-email-sender.js (the
// send choke points + the exact approved copy). Same test shape as
// test/send-winback-batch.test.js: global.fetch is spied (split by URL —
// Resend vs PostHog), test/helpers/mock-blobs.js stands in for Blobs, and
// web-push is mocked — so this proves the selection/cap/dedup/exclusion/
// owner-gating LOGIC and the exact Resend request built, NOT a real
// delivered email. No real email or push is ever sent.
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();
var mockWebPush = require('./helpers/mock-web-push');
mockWebPush.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var { getStore } = require('@netlify/blobs');
var emailSuppressionStore = require('../netlify/functions/lib/email-suppression-store');
var interpReadStore = require('../netlify/functions/lib/interp-read-store');
var resultViewStore = require('../netlify/functions/lib/result-view-store');
var interpEmailStore = require('../netlify/functions/lib/interp-email-store');
var pushSubscriptionStore = require('../netlify/functions/lib/push-subscription-store');
var dreamStore = require('../netlify/functions/lib/dream-store');
var unreadSender = require('../netlify/functions/lib/interp-unread-email-sender');
var noneSender = require('../netlify/functions/lib/interp-none-email-sender');
var sendInterp = require('../netlify/functions/send-interp-emails-batch');

var realFetch = global.fetch;
var OWNER = 'ronbrightman@gmail.com';

function installFetchSpy() {
  var resendCalls = [];
  var posthogCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    var body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (urlStr.indexOf('api.resend.com') !== -1) {
      resendCalls.push({ url: urlStr, body: body, headers: (opts && opts.headers) || {} });
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

async function seedAccount(username, email) {
  var record = { username: username, email: email, password: 'pw', updatedAt: Date.now(), emailVerified: true };
  var s = getStore({ name: 'dreamtube-accounts' });
  await s.setJSON('u:' + username, record);
  await s.setJSON('e:' + email, username);
}

/** Seeds one private dream (server-synced) for `username` directly into the dream store. */
async function seedDream(username, dream) {
  var event = fakeEvent({ method: 'POST' });
  await dreamStore.upsertPrivateDream(event, username, dream);
}

/** Marks `personas` (array of keys) as read for `operationName`. */
async function seedReads(operationName, personas) {
  var event = fakeEvent({ method: 'POST' });
  for (var i = 0; i < personas.length; i++) {
    await interpReadStore.markRead(event, operationName, personas[i]);
  }
}

async function seedWatched(operationName) {
  await resultViewStore.markViewed(fakeEvent({ method: 'POST' }), operationName);
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  mockWebPush.reset();
  process.env.RESEND_API_KEY = 'resend-test-key';
  process.env.OWNER_EMAIL = OWNER;
  delete process.env.VAPID_PRIVATE_KEY;
});

test.afterEach(function () {
  global.fetch = realFetch;
});

// ===== interp-read-store: the server-side read signal =====

test('interp-read-store records a per-persona read set and lists it back; unknown personas rejected', async function () {
  var event = fakeEvent({ method: 'POST' });
  await interpReadStore.markRead(event, 'fal:veo3:op1', 'jung');
  await interpReadStore.markRead(event, 'fal:veo3:op1', 'freud');
  await interpReadStore.markRead(event, 'fal:veo3:op1', 'jung'); // idempotent re-read

  var bogus = await interpReadStore.markRead(event, 'fal:veo3:op1', 'not-a-persona');
  assert.equal(bogus.ok, false, 'an unknown persona key is rejected');

  var set = await interpReadStore.listPersonasRead(event, 'fal:veo3:op1');
  assert.deepEqual(set.sort(), ['freud', 'jung'], 'exactly the two distinct read personas, de-duplicated');
  assert.equal(await interpReadStore.countPersonasRead(event, 'fal:veo3:op1'), 2);

  // A different operationName sharing a colon-prefix must not leak in.
  await interpReadStore.markRead(event, 'fal:veo3:op10', 'gestalt');
  var set1 = await interpReadStore.listPersonasRead(event, 'fal:veo3:op1');
  assert.deepEqual(set1.sort(), ['freud', 'jung'], 'op10 reads do not leak into op1');
});

// ===== "UNREAD MEANINGS" trigger (read 1-4 of 5) =====

test('unread trigger: a dream read on 1-4 personas is selected and sent with the exact approved copy', async function () {
  var spy = installFetchSpy();
  await seedAccount('reader', 'reader@real-user.com');
  await seedDream('reader', { id: 'd1', sourceOperationName: 'fal:veo3:op1', storyText: 'a glass city', imageUrl: '/img/x.png' });
  await seedReads('fal:veo3:op1', ['jung']); // read 1 of 5 -> unread trigger

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(summary.selected.unread, 1);
  assert.equal(summary.sent.unread, 1);
  assert.equal(spy.resendCalls.length, 1);
  var body = spy.resendCalls[0].body;
  assert.equal(body.subject, 'One reading you haven\'t seen 🌙');
  // Read persona = The Depth Analyst (jung, the one read); unread = first key
  // not read = The Analyst (freud).
  assert.ok(body.html.indexOf('You read what') !== -1, 'approved sentence lead present');
  assert.ok(body.html.indexOf('The Depth Analyst') !== -1, 'names a persona the user DID read');
  assert.ok(body.html.indexOf('The Analyst') !== -1, 'names a persona the user did NOT read');
  assert.ok(body.html.indexOf('saw something very different') !== -1, 'approved sentence tail present');
  assert.ok(body.html.indexOf('a glass city') !== -1, 'includes the recipient\'s OWN dream text so they know which dream (founder fix)');
  assert.ok(body.html.indexOf('<img') !== -1 && body.html.indexOf('/img/x.png') !== -1, 'renders the dream\'s own synced still as the media banner');
  assert.ok(body.html.indexOf('result.html?id=d1') !== -1 && body.html.indexOf('interp=1') !== -1, 'CTA deep-links to this dream\'s interpretation view');
  assert.ok(body.headers && body.headers['List-Unsubscribe'], 'one-click unsubscribe header present');
  assert.ok(body.html.indexOf('Unsubscribe') !== -1, 'visible unsubscribe footer present');
});

test('unread trigger: a dream read on ALL 5 personas is NOT eligible', async function () {
  var spy = installFetchSpy();
  await seedAccount('allread', 'allread@real-user.com');
  await seedDream('allread', { id: 'd1', sourceOperationName: 'fal:veo3:op5', storyText: 'x' });
  await seedReads('fal:veo3:op5', ['jung', 'freud', 'gestalt', 'scientist', 'talmudic']);

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(summary.selected.unread, 0);
  assert.equal(spy.resendCalls.length, 0);
});

// ===== "NO MEANING YET" trigger (watched, read 0) =====

test('none trigger: a WATCHED dream with zero reads is selected and sent with the dream text + Jung hook', async function () {
  var spy = installFetchSpy();
  await seedAccount('watcher', 'watcher@real-user.com');
  await seedDream('watcher', { id: 'd2', sourceOperationName: 'fal:veo3:op2', storyText: 'I was flying over the sea' });
  await seedWatched('fal:veo3:op2'); // watched, but zero reads

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(summary.selected.none, 1);
  assert.equal(summary.sent.none, 1);
  assert.equal(spy.resendCalls.length, 1);
  var body = spy.resendCalls[0].body;
  assert.equal(body.subject, 'There\'s a hidden meaning in your dream 🌙');
  assert.ok(body.html.indexOf('hidden meaning') !== -1, 'approved lead present');
  assert.ok(body.html.indexOf('I was flying over the sea') !== -1, 'embeds the user\'s own dream text');
  assert.ok(body.html.indexOf('See what Jung would say') !== -1, 'approved Jung hook present');
  // This dream has no synced still, so the email falls back to the branded image (never an empty slot).
  assert.ok(body.html.indexOf('<img') !== -1 && body.html.indexOf('/assets/store/dream-neon.webp') !== -1, 'renders the branded fallback image when no dream still exists');
  assert.ok(body.html.indexOf('result.html?id=d2') !== -1 && body.html.indexOf('interp=1') !== -1, 'CTA deep-links to this dream');
});

test('none trigger: a dream with zero reads that was NOT watched is skipped', async function () {
  var spy = installFetchSpy();
  await seedAccount('notwatched', 'notwatched@real-user.com');
  await seedDream('notwatched', { id: 'd3', sourceOperationName: 'fal:veo3:op3', storyText: 'x' });
  // no watched marker

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(summary.selected.none, 0);
  assert.equal(summary.sent.none, 0);
  assert.equal(spy.resendCalls.length, 0);
});

// ===== DEDUP (once-per-dream marker across runs) =====

test('dedup: a dream is never sent twice across two batch runs (both triggers, distinct users)', async function () {
  var spy = installFetchSpy();
  await seedAccount('userU', 'userU@real-user.com');
  await seedDream('userU', { id: 'du', sourceOperationName: 'fal:veo3:opU', storyText: 'x', imageUrl: '/i.png' });
  await seedReads('fal:veo3:opU', ['jung']);
  await seedAccount('userN', 'userN@real-user.com');
  await seedDream('userN', { id: 'dn', sourceOperationName: 'fal:veo3:opN', storyText: 'y' });
  await seedWatched('fal:veo3:opN');

  var first = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(first.sent.unread, 1);
  assert.equal(first.sent.none, 1);
  assert.equal(spy.resendCalls.length, 2);

  var second = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(second.sent.unread, 0);
  assert.equal(second.sent.none, 0);
  assert.equal(second.skipped.already_sent_unread, 1);
  assert.equal(second.skipped.already_sent_none, 1);
  assert.equal(spy.resendCalls.length, 2, 'no new Resend calls on the second run');
});

test('per-user cap: a user eligible on MULTIPLE dreams gets exactly ONE email per run, flagship "unread" preferred', async function () {
  var spy = installFetchSpy();
  await seedAccount('multi', 'multi@real-user.com');
  // One dream qualifies for "none" (watched, 0 read)...
  await seedDream('multi', { id: 'dn', sourceOperationName: 'fal:veo3:mN', storyText: 'the none one' });
  await seedWatched('fal:veo3:mN');
  // ...and another qualifies for the flagship "unread" (read 1 of 5).
  await seedDream('multi', { id: 'du', sourceOperationName: 'fal:veo3:mU', storyText: 'the unread one', imageUrl: '/i.png' });
  await seedReads('fal:veo3:mU', ['jung']);

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(spy.resendCalls.length, 1, 'exactly one interpretation email to this user in the run');
  assert.equal(summary.sent.unread, 1, 'the flagship unread email is the one sent');
  assert.equal(summary.sent.none, 0, 'the none email is NOT also sent to the same user');
  assert.equal(spy.resendCalls[0].body.subject, 'One reading you haven\'t seen 🌙');
});

test('per-user cap: two eligible unread dreams for one user still send only ONE email', async function () {
  var spy = installFetchSpy();
  await seedAccount('twoU', 'twoU@real-user.com');
  await seedDream('twoU', { id: 'a', sourceOperationName: 'fal:veo3:a', storyText: 'a', imageUrl: '/i.png' });
  await seedReads('fal:veo3:a', ['jung']);
  await seedDream('twoU', { id: 'b', sourceOperationName: 'fal:veo3:b', storyText: 'b', imageUrl: '/i.png' });
  await seedReads('fal:veo3:b', ['freud', 'jung']);

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(spy.resendCalls.length, 1);
  assert.equal(summary.sent.unread, 1);
});

test('dedup at the send choke point: the CAS marker blocks a second unread send even if selection is bypassed', async function () {
  var spy = installFetchSpy();
  var event = fakeEvent({ method: 'POST' });
  var opts = { operationName: 'fal:veo3:choke', username: 'c', email: 'c@real-user.com', dream: { id: 'dc', storyText: 'x' }, readPersonaKey: 'jung', unreadPersonaKey: 'freud', ownerEmail: OWNER };
  var a = await unreadSender.sendIfEligible(event, opts);
  assert.equal(a.sent, true);
  var b = await unreadSender.sendIfEligible(event, opts);
  assert.equal(b.sent, false);
  assert.equal(b.skipped, 'already_sent');
  assert.equal(spy.resendCalls.length, 1);
});

// ===== HARD CAP =====

test('hard cap: with more eligible dreams than `limit`, sends at most `limit`', async function () {
  var spy = installFetchSpy();
  for (var i = 0; i < 5; i++) {
    await seedAccount('u' + i, 'u' + i + '@real-user.com');
    await seedDream('u' + i, { id: 'd' + i, sourceOperationName: 'fal:veo3:op' + i, storyText: 'x' });
    await seedWatched('fal:veo3:op' + i); // none-trigger eligible
  }
  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 2, ownerEmail: OWNER });
  assert.equal(summary.sent.none, 2);
  assert.ok(spy.resendCalls.length <= 2, 'never exceeds the cap');
});

// ===== SUPPRESSION / EXCLUSION =====

test('suppressed recipients are skipped and never sent', async function () {
  var spy = installFetchSpy();
  await seedAccount('unsub', 'unsub@real-user.com');
  await seedDream('unsub', { id: 'd', sourceOperationName: 'fal:veo3:opS', storyText: 'x' });
  await seedWatched('fal:veo3:opS');
  await emailSuppressionStore.suppress(fakeEvent({ method: 'POST' }), 'unsub@real-user.com', 'user_unsubscribed');

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(summary.sent.none, 0);
  assert.equal(summary.skipped.suppressed, 1);
  assert.equal(spy.resendCalls.length, 0);
});

test('founder + test/@example.com addresses are excluded', async function () {
  var spy = installFetchSpy();
  await seedAccount('founder', OWNER);
  await seedDream('founder', { id: 'd', sourceOperationName: 'fal:veo3:opF', storyText: 'x' });
  await seedWatched('fal:veo3:opF');
  await seedAccount('exampleuser', 'someone@example.com');
  await seedDream('exampleuser', { id: 'd', sourceOperationName: 'fal:veo3:opE', storyText: 'x' });
  await seedWatched('fal:veo3:opE');

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(summary.sent.none, 0);
  assert.equal(summary.skipped.excluded, 2);
  assert.equal(spy.resendCalls.length, 0);
});

// ===== PUSH (second channel) =====

test('a matching push fires for a subscribed user when VAPID is configured', async function () {
  installFetchSpy();
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  await seedAccount('pushuser', 'pushuser@real-user.com');
  await seedDream('pushuser', { id: 'dp', sourceOperationName: 'fal:veo3:opP', storyText: 'a vivid dream' });
  await seedWatched('fal:veo3:opP');
  await pushSubscriptionStore.addOrUpdateSubscription(fakeEvent({ method: 'POST' }), 'pushuser', {
    endpoint: 'https://push.example/pushuser', keys: { p256dh: 'p', auth: 'a' }
  });

  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(summary.sent.none, 1);
  assert.equal(summary.sent.push, 1, 'the matching push counted');
  var pushes = mockWebPush.getSentCalls();
  assert.equal(pushes.length, 1);
  assert.equal(JSON.parse(pushes[0].payload).type, 'interp-none');
  delete process.env.VAPID_PRIVATE_KEY;
});

// ===== OWNER GATING + INPUT VALIDATION + PREVIEW =====

test('owner-gating: a non-owner email is rejected with 403 and sends nothing', async function () {
  var spy = installFetchSpy();
  var res = await sendInterp.handler(fakeEvent({ method: 'POST', body: { email: 'attacker@evil.com' } }));
  assert.equal(res.statusCode, 403);
  assert.equal(spy.resendCalls.length, 0);
});

test('a non-POST verb is rejected with 405', async function () {
  var res = await sendInterp.handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('a missing OWNER_EMAIL configuration is rejected with 500', async function () {
  delete process.env.OWNER_EMAIL;
  var res = await sendInterp.handler(fakeEvent({ method: 'POST', body: { email: OWNER } }));
  assert.equal(res.statusCode, 500);
});

test('invalid JSON / limit / which are rejected with 400', async function () {
  var badJson = await sendInterp.handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(badJson.statusCode, 400);
  var badLimit = await sendInterp.handler(fakeEvent({ method: 'POST', body: { email: OWNER, limit: 0 } }));
  assert.equal(badLimit.statusCode, 400);
  var badWhich = await sendInterp.handler(fakeEvent({ method: 'POST', body: { email: OWNER, which: 'nonsense' } }));
  assert.equal(badWhich.statusCode, 400);
});

test('the absolute ceiling of 50 is applied even if a larger limit is requested', async function () {
  installFetchSpy();
  var res = await sendInterp.handler(fakeEvent({ method: 'POST', body: { email: OWNER, limit: 500 } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).limit, 50);
});

test('previewTo sends BOTH interpretation email previews by default', async function () {
  var spy = installFetchSpy();
  var res = await sendInterp.handler(fakeEvent({ method: 'POST', body: { email: OWNER, previewTo: 'preview@somewhere.com' } }));
  assert.equal(res.statusCode, 200);
  var out = JSON.parse(res.body);
  assert.equal(out.preview, true);
  assert.equal(out.which, 'both');
  assert.equal(spy.resendCalls.length, 2, 'both previews sent in one call');
  var subjects = spy.resendCalls.map(function (c) { return c.body.subject; }).sort();
  assert.deepEqual(subjects, ['One reading you haven\'t seen 🌙', 'There\'s a hidden meaning in your dream 🌙']);
  // Both previews render a real (branded sample) image so the founder sees the thumbnail slot.
  spy.resendCalls.forEach(function (c) {
    assert.ok(c.body.html.indexOf('<img') !== -1 && c.body.html.indexOf('/assets/store/dream-neon.webp') !== -1, 'preview email shows a real sample image');
  });
});

test('previewTo with which:"unread" sends only the flagship preview', async function () {
  var spy = installFetchSpy();
  var res = await sendInterp.handler(fakeEvent({ method: 'POST', body: { email: OWNER, previewTo: 'preview@somewhere.com', which: 'unread' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(spy.resendCalls.length, 1);
  assert.equal(spy.resendCalls[0].body.subject, 'One reading you haven\'t seen 🌙');
});

// ===== PERF: wall-clock time budget + countOnly diagnostic =====

test('time budget: the selection scan stops early (timeBudgetHit) and sends nothing when the budget is exhausted', async function () {
  var spy = installFetchSpy();
  for (var i = 0; i < 4; i++) {
    await seedAccount('tb' + i, 'tb' + i + '@real-user.com');
    await seedDream('tb' + i, { id: 'd' + i, sourceOperationName: 'fal:veo3:tb' + i, storyText: 'x' });
    await seedWatched('fal:veo3:tb' + i); // all none-eligible
  }
  // A zero-ms budget trips on the very first account, before any per-dream scan.
  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER, selectionBudgetMs: -1 });
  assert.equal(summary.timeBudgetHit, true, 'the scan reports it was time-bounded');
  assert.ok(summary.accountsScanned < summary.totalAccounts, 'it did NOT scan every account');
  assert.equal(summary.sent.none, 0);
  assert.equal(spy.resendCalls.length, 0, 'nothing sent when the budget trips immediately');
});

test('time budget: with a generous budget it scans and sends normally (bound is a ceiling, not a floor)', async function () {
  var spy = installFetchSpy();
  await seedAccount('tbok', 'tbok@real-user.com');
  await seedDream('tbok', { id: 'd', sourceOperationName: 'fal:veo3:tbok', storyText: 'x' });
  await seedWatched('fal:veo3:tbok');
  var summary = await sendInterp.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER, selectionBudgetMs: 60000 });
  assert.equal(summary.timeBudgetHit, false);
  assert.equal(summary.sent.none, 1);
  assert.equal(spy.resendCalls.length, 1);
});

test('countOnly: reports exact already-sent counts + eligible counts and SENDS NOTHING', async function () {
  var spy = installFetchSpy();
  var ev = fakeEvent({ method: 'POST' });
  // One currently-eligible "none" dream (watched, zero read).
  await seedAccount('cu', 'cu@real-user.com');
  await seedDream('cu', { id: 'de', sourceOperationName: 'fal:veo3:elig', storyText: 'x' });
  await seedWatched('fal:veo3:elig');
  // Two dreams already emailed (the source of truth for "did anything leak").
  await interpEmailStore.markNoneSentOnce(ev, 'fal:veo3:sent-none-1');
  await interpEmailStore.markUnreadSentOnce(ev, 'fal:veo3:sent-unread-1');

  var res = await sendInterp.handler(fakeEvent({ method: 'POST', body: { email: OWNER, countOnly: true } }));
  assert.equal(res.statusCode, 200);
  var out = JSON.parse(res.body);
  assert.equal(out.mode, 'countOnly');
  assert.equal(out.alreadySent.none, 1, 'exact already-sent none count from the marker store');
  assert.equal(out.alreadySent.unread, 1, 'exact already-sent unread count from the marker store');
  assert.equal(out.eligible.none, 1, 'the one eligible none dream is counted');
  assert.equal(out.eligible.unread, 0);
  assert.equal(spy.resendCalls.length, 0, 'countOnly never sends');
});
