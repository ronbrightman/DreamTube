// test/pending-dream-cross-device-attach.test.js
//
// Coverage for the CROSS-DEVICE, BY-EMAIL attach of a completed pre-signup
// generation to the account that finally finalizes (tracker item
// for-product-passwordless-cross-device-attach — the founder iOS repro
// 2026-08-14 that the earlier E304 server-persist does NOT cover):
//
//   1. A funnel visitor enters their email at the wall -> a pending generation
//      starts BEFORE any account exists for that email.
//   2. The fal video FINISHES (pendingDreams.markReady -> videoUrl + email on
//      the record) while there is still NO account.
//   3. The account is finalized LATER, on a DIFFERENT device (the emailed
//      code/link -> login-with-email-code.js / verify-email-code.js /
//      verify-email-link.js), where the device-local pendingId is gone.
//
// The completion-time server persist (dream-webhook.js) correctly skipped at
// step 2 ("no account yet") and is never revisited; the client claim needs the
// gone pendingId. So the finished video would be stranded — profile shows 0
// dreams — unless finalization scans pending-dreams BY EMAIL and backfills it,
// which is exactly what lib/pending-dream-recovery.js now does.
//
// This file proves: the exact repro lands; ownership is enforced (a non-
// matching email is never attached); it converges to ONE journal entry with a
// later client sync (no duplicates); a not-yet-completed / failed record is
// skipped; and finalization never breaks when there's nothing to attach or the
// attach step itself fails.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var pendingDreams = require('../netlify/functions/lib/pending-dreams');
var pendingDreamRecovery = require('../netlify/functions/lib/pending-dream-recovery');
var dreamStore = require('../netlify/functions/lib/dream-store');

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.77.0.' + ipCounter; }

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
});
test.after(function () { global.fetch = realFetch; });

/** Creates a pending-dreams record (indexed by email) and, unless completed:false, marks it ready with a video URL — the "generation finished before any account existed" shape. */
async function seedCompletedPending(email, operationName, videoUrl, opts) {
  opts = opts || {};
  var record = await pendingDreams.create({}, {
    email: email,
    caption: opts.caption || 'engineered prompt',
    storyText: opts.storyText || 'I flew over a city',
    style: opts.style || 'Cinematic',
    operationName: operationName,
    mediaType: opts.mediaType || 'video'
  });
  if (opts.completed !== false) {
    var mark = await pendingDreams.markReady({}, record.id, videoUrl);
    assert.equal(mark.ok, true, 'markReady should win on a fresh pending record');
  }
  return record;
}

// ===================================================================
// lib/pending-dreams.js — the by-email secondary index
// ===================================================================

test('listIdsByEmail returns only the ids created under that exact email (index isolation)', async function () {
  var a = await seedCompletedPending('alice@example.com', 'fal:veo/x:req-a', 'https://v/a');
  await seedCompletedPending('bob@example.com', 'fal:veo/x:req-b', 'https://v/b');

  var aliceIds = await pendingDreams.listIdsByEmail({}, 'alice@example.com');
  assert.deepEqual(aliceIds, [a.id]);

  var noneIds = await pendingDreams.listIdsByEmail({}, 'nobody@example.com');
  assert.deepEqual(noneIds, []);
});

test('the email index normalizes case/whitespace the same way the record does', async function () {
  var rec = await seedCompletedPending('person@example.com', 'fal:veo/x:req-n', 'https://v/n');
  // A funnel record whose email was typed with different casing/spacing still
  // resolves — the index and the record share one normalization.
  var ids = await pendingDreams.listIdsByEmail({}, '  Person@Example.COM ');
  assert.deepEqual(ids, [rec.id]);
});

// ===================================================================
// THE EXACT REPRO — completed pending, no account at completion, later
// finalized on a fresh session with no pendingId
// ===================================================================

test('REPRO: a completed pending generation with no account at completion is attached by email at finalization and surfaces via reconcile', async function () {
  var op = 'fal:veo/x:req-repro';
  await seedCompletedPending('dreamer@example.com', op, 'https://videos/repro.mp4');

  // No account existed at completion — nothing is in the durable journal yet.
  var before = await dreamStore.getPrivateDreams({}, 'dreamer');
  assert.equal(before.length, 0);

  // Finalization: attach by email + the just-finalized username, NO pendingId.
  var summary = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'dreamer@example.com', 'dreamer');
  assert.equal(summary.attached, 1);
  assert.equal(summary.existed, 0);
  assert.equal(summary.failed, 0);

  var after = await dreamStore.getPrivateDreams({}, 'dreamer');
  assert.equal(after.length, 1, 'the stranded completed video is now in the account journal');
  var d = after[0];
  assert.equal(d.videoUrl, 'https://videos/repro.mp4');
  assert.equal(d.sourceOperationName, op);
  assert.equal(d.ownerHandle, '@dreamer');
  assert.equal(d.mediaType, 'video');
  assert.equal(d.dur, '0:08');
  assert.equal(d.caption, 'I flew over a city', 'human-readable storyText maps to caption (matches finalizeDream + the webhook persist)');
  assert.equal(d.storyText, 'I flew over a city');
  assert.equal(d.promptText, 'engineered prompt');
  assert.equal(d.id, dreamStore.serverDreamId(op), 'deterministic server id, so a repeated attach is idempotent by id');
});

test('an image-mode completed record attaches with imageUrl (not videoUrl)', async function () {
  var op = 'fal:flux/x:req-img';
  var rec = await pendingDreams.create({}, {
    email: 'img@example.com', caption: 'p', storyText: 'a still', style: 'Cartoon',
    operationName: op, mediaType: 'image'
  });
  // Image records complete without the webhook; simulate the ready image via a
  // plain update (the store's own bookkeeping-only patch).
  await pendingDreams.update({}, rec.id, { imageUrl: 'https://images/x.png', status: 'ready', readyAt: Date.now() });

  var summary = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'img@example.com', 'img');
  assert.equal(summary.attached, 1);
  var dreams = await dreamStore.getPrivateDreams({}, 'img');
  assert.equal(dreams[0].mediaType, 'image');
  assert.equal(dreams[0].imageUrl, 'https://images/x.png');
  assert.equal(dreams[0].videoUrl, null);
});

// ===================================================================
// OWNERSHIP — never attach a record whose email doesn't match
// ===================================================================

test('OWNERSHIP: a pending record for a DIFFERENT email is never attached to the finalized account', async function () {
  await seedCompletedPending('someone-else@example.com', 'fal:veo/x:req-own', 'https://videos/own.mp4');

  // A different email finalizes — the index is keyed by the record's own email,
  // so nothing is found; even the defense-in-depth per-record email re-check
  // would block it.
  var summary = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'victim@example.com', 'victim');
  assert.equal(summary.scanned, 0);
  assert.equal(summary.attached, 0);

  var victimDreams = await dreamStore.getPrivateDreams({}, 'victim');
  assert.equal(victimDreams.length, 0, "a stranger's completed dream must never land in the victim's journal");
});

// ===================================================================
// DEDUP — converges with a later client sync to ONE entry
// ===================================================================

test('DEDUP: attaching twice is idempotent (second attach reports existed, one journal entry)', async function () {
  var op = 'fal:veo/x:req-dedup1';
  await seedCompletedPending('dd@example.com', op, 'https://videos/dd.mp4');

  var first = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'dd@example.com', 'dd');
  assert.equal(first.attached, 1);
  var second = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'dd@example.com', 'dd');
  assert.equal(second.attached, 0);
  assert.equal(second.existed, 1, 'the same operation is insert-if-absent — never a duplicate');

  var dreams = await dreamStore.getPrivateDreams({}, 'dd');
  assert.equal(dreams.length, 1);
});

test('DEDUP end-to-end: a client dream-sync for the SAME operation after the attach converges to ONE journal entry', async function () {
  var op = 'fal:veo/x:req-dedup2';
  await seedCompletedPending('conv@example.com', op, 'https://videos/conv.mp4');

  await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'conv@example.com', 'conv');

  // The original device eventually comes back online and syncs its own richer
  // copy (its own random id, real mood/interpretation) for the SAME operation.
  await dreamStore.upsertPrivateDream({}, 'conv', {
    id: 'd-client-random', ownerHandle: '@conv', sourceOperationName: op,
    caption: 'I flew over a city', storyText: 'I flew over a city', promptText: 'engineered prompt',
    style: 'Cinematic', mediaType: 'video', videoUrl: 'https://videos/conv.mp4', dur: '0:08',
    mood: 'dreamy', interpretationText: 'a dream of freedom', likes: 0, likedByMe: false, isPublished: false
  });

  var dreams = await dreamStore.getPrivateDreams({}, 'conv');
  assert.equal(dreams.length, 1, 'server attach + client sync of one generation = one dream, never two');
  assert.equal(dreams[0].id, 'd-client-random', "the client's richer copy wins (replaces the backfill by operation)");
  assert.equal(dreams[0].mood, 'dreamy');
});

// ===================================================================
// NOT-COMPLETED / FAILED records are skipped
// ===================================================================

test('a still-pending (no video yet) record is NOT attached', async function () {
  await seedCompletedPending('waiting@example.com', 'fal:veo/x:req-wait', null, { completed: false });
  var summary = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'waiting@example.com', 'waiting');
  assert.equal(summary.scanned, 1);
  assert.equal(summary.attached, 0);
  assert.equal(summary.skipped, 1);
  assert.equal((await dreamStore.getPrivateDreams({}, 'waiting')).length, 0);
});

test('a FAILED generation record is NOT attached (no media to attach)', async function () {
  var rec = await seedCompletedPending('failed@example.com', 'fal:veo/x:req-fail', null, { completed: false });
  await pendingDreams.markFailed({}, rec.id, 'content_policy');
  var summary = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'failed@example.com', 'failed');
  assert.equal(summary.attached, 0);
  assert.equal((await dreamStore.getPrivateDreams({}, 'failed')).length, 0);
});

// ===================================================================
// DON'T-BREAK-FINALIZATION — best-effort, never throws
// ===================================================================

test("attach is a clean no-op summary when the email has NO pending generations", async function () {
  var summary = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'empty@example.com', 'empty');
  assert.deepEqual(summary, { scanned: 0, attached: 0, existed: 0, failed: 0, skipped: 0 });
});

test('attach never throws and reports failed when the durable write itself fails', async function () {
  await seedCompletedPending('willfail@example.com', 'fal:veo/x:req-wf', 'https://videos/wf.mp4');
  // Force every write to the private-dream store to reject — the backfill
  // exhausts its retries and returns { ok:false }; attach must swallow it.
  mockBlobs.setWriteOverride(dreamStore.STORE_NAME, function () { return new Error('simulated blobs write failure'); });
  var summary;
  await assert.doesNotReject(async function () {
    summary = await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'willfail@example.com', 'willfail');
  });
  mockBlobs.clearWriteOverride(dreamStore.STORE_NAME);
  assert.equal(summary.failed, 1);
  assert.equal(summary.attached, 0);
});

test('attach is a no-op for a missing email or username (never throws)', async function () {
  assert.deepEqual(await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, '', 'x'),
    { scanned: 0, attached: 0, existed: 0, failed: 0, skipped: 0 });
  assert.deepEqual(await pendingDreamRecovery.attachCompletedPendingDreamsForEmail({}, 'x@example.com', ''),
    { scanned: 0, attached: 0, existed: 0, failed: 0, skipped: 0 });
});

// ===================================================================
// END-TO-END through the real login-with-email-code.js handler
// ===================================================================

function installFetchSpy() {
  global.fetch = async function () { return { ok: true, status: 200, json: async function () { return {}; } }; };
}

test('END-TO-END: login-with-email-code finalizes an account and attaches the stranded completed dream, and still returns a real session', async function () {
  process.env.RESEND_API_KEY = 'resend-test-key';
  try {
    installFetchSpy();
    var op = 'fal:veo/x:req-e2e';

    // 1) The video finished BEFORE any account existed for this email.
    await seedCompletedPending('omar@example.com', op, 'https://videos/e2e.mp4');

    // 2) The account gets created (register branch 2 — the wall). No webhook
    //    re-fires, so the ready record stays stranded (persist already skipped).
    var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
    var first = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'omar@example.com' } }));
    assert.equal(JSON.parse(first.body).created, true);
    assert.equal((await dreamStore.getPrivateDreams({}, 'omar')).length, 0, 'still stranded after account creation');

    // 3) Finalize on a fresh session via the mailed code (no pendingId here).
    // The stored code is hashed, so capture the real one from a fresh send
    // (register's resolve branch always mails a fresh code) — same "read it
    // off the sender" convention as passwordless-signup.test.js.
    var sent = [];
    global.fetch = async function (url, opts) { sent.push(opts && opts.body ? JSON.parse(opts.body) : null); return { ok: true, status: 200, json: async function () { return {}; } }; };
    await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'omar@example.com' } }));
    var realCode = /(\d{6})/.exec(sent[0].html)[1];

    var loginHandler = require('../netlify/functions/login-with-email-code').handler;
    var res = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'omar@example.com', code: realCode } }));
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true, 'login still succeeds');
    assert.ok(body.authToken, 'a real session is minted');
    assert.equal(body.username, 'omar');

    // The stranded completed video is now attached — a client reconcile would surface it.
    var dreams = await dreamStore.getPrivateDreams({}, 'omar');
    assert.equal(dreams.length, 1, 'the completed dream is attached at finalization');
    assert.equal(dreams[0].sourceOperationName, op);
    assert.equal(dreams[0].videoUrl, 'https://videos/e2e.mp4');
  } finally {
    delete process.env.RESEND_API_KEY;
    global.fetch = realFetch;
  }
});

test('END-TO-END: login-with-email-code with NO stranded dream still returns a real session (attach is a clean no-op)', async function () {
  process.env.RESEND_API_KEY = 'resend-test-key';
  try {
    var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
    await (async function () {
      global.fetch = async function () { return { ok: true, status: 200, json: async function () { return {}; } }; };
      await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'nodream@example.com' } }));
    })();

    var sent = [];
    global.fetch = async function (url, opts) { sent.push(opts && opts.body ? JSON.parse(opts.body) : null); return { ok: true, status: 200, json: async function () { return {}; } }; };
    await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'nodream@example.com' } }));
    var realCode = /(\d{6})/.exec(sent[0].html)[1];

    var loginHandler = require('../netlify/functions/login-with-email-code').handler;
    var res = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'nodream@example.com', code: realCode } }));
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.authToken);
    assert.equal((await dreamStore.getPrivateDreams({}, 'nodream')).length, 0);
  } finally {
    delete process.env.RESEND_API_KEY;
    global.fetch = realFetch;
  }
});
