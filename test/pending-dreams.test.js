// test/pending-dreams.test.js
//
// Unit coverage of netlify/functions/lib/pending-dreams.js — the durable,
// server-side record of a dream-builder-wizard generation started before
// (or without) a completed signup (see start-pending-generation.js,
// dream-webhook.js, claim-pending-generation.js, verify-pending-claim.js).
//
// Includes genuine Promise.all CONCURRENCY tests for markReady/
// markClaimed/markNotified (review finding, fixed) — the same technique
// entitlements.js's creditTokenPackOnce test uses for its own TOCTOU fix:
// two calls raced against the SAME record via Promise.all, asserting the
// underlying transition guard actually prevents both from reporting
// success. Reproduced empirically against the pre-fix plain
// read-then-Object.assign-then-write implementation before writing the
// fix: markReady() returned a record CLAIMING "status: ready" — its own
// locally-computed patch — even though a concurrent markClaimed()'s write
// was the one that actually ended up persisted, because both read the
// same stale base and neither ever verified its own write actually
// stuck. A caller trusting markReady's return value (instead of a real
// `ok` signal) would send the abandoned-dream email to someone who had
// just signed up normally.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var pendingDreams = require('../netlify/functions/lib/pending-dreams');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('create() returns a fresh record in "pending" status with a real id', async function () {
  var record = await pendingDreams.create({}, { email: 'Person@Example.com ', caption: 'a dream', style: 'Cinematic' });
  assert.ok(record.id);
  assert.equal(record.status, 'pending');
  assert.equal(record.email, 'person@example.com'); // normalized
  assert.equal(record.videoUrl, null);
  assert.equal(record.operationName, null);
});

test('get() round-trips a created record; returns null for an unknown id', async function () {
  var created = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  var fetched = await pendingDreams.get({}, created.id);
  assert.deepEqual(fetched, created);
  assert.equal(await pendingDreams.get({}, 'not-a-real-id'), null);
});

test('update() merges a patch onto an existing record; no-ops (returns null) for an unknown id', async function () {
  var created = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  var updated = await pendingDreams.update({}, created.id, { operationName: 'fal:model:req123' });
  assert.equal(updated.operationName, 'fal:model:req123');
  assert.equal(updated.status, 'pending'); // untouched fields survive the merge

  assert.equal(await pendingDreams.update({}, 'unknown', { operationName: 'x' }), null);
});

// ----- Guarded transitions: markReady / markNotified / markClaimed / markFailed -----
// Each now returns { ok, record } (changed from returning the record
// directly) — `ok` is the ONLY trustworthy "did my call win" signal, see
// pending-dreams.js's own CONCURRENT-WRITE RACE header comment.

test('markReady: transitions pending -> ready, ok:true, stamps videoUrl/readyAt', async function () {
  var created = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  var result = await pendingDreams.markReady({}, created.id, 'https://cdn.example/video.mp4');
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'ready');
  assert.equal(result.record.videoUrl, 'https://cdn.example/video.mp4');
  assert.ok(result.record.readyAt);
});

test('markReady: re-entry while already "ready" is allowed (idempotent), still ok:true', async function () {
  var created = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  await pendingDreams.markReady({}, created.id, 'https://cdn.example/v1.mp4');
  var second = await pendingDreams.markReady({}, created.id, 'https://cdn.example/v1.mp4');
  assert.equal(second.ok, true);
  assert.equal(second.record.status, 'ready');
});

test('markReady: refuses (ok:false) once already claimed/notified, returning the actual current record', async function () {
  var claimedRec = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  await pendingDreams.markClaimed({}, claimedRec.id, 'a@example.com');
  var onClaimed = await pendingDreams.markReady({}, claimedRec.id, 'https://cdn.example/v.mp4');
  assert.equal(onClaimed.ok, false);
  assert.equal(onClaimed.record.status, 'claimed');

  var notifiedRec = await pendingDreams.create({}, { email: 'b@example.com', caption: 'x', style: 'Cartoon' });
  await pendingDreams.markReady({}, notifiedRec.id, 'https://cdn.example/v.mp4');
  await pendingDreams.markNotified({}, notifiedRec.id);
  var onNotified = await pendingDreams.markReady({}, notifiedRec.id, 'https://cdn.example/v2.mp4');
  assert.equal(onNotified.ok, false);
  assert.equal(onNotified.record.status, 'notified');
});

test('markReady: an unknown id returns ok:false, record:null', async function () {
  var result = await pendingDreams.markReady({}, 'unknown-id', 'https://cdn.example/v.mp4');
  assert.equal(result.ok, false);
  assert.equal(result.record, null);
});

test('markNotified: succeeds from "ready" in the normal sequential flow, stamping notifiedAt', async function () {
  var record = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  await pendingDreams.markReady({}, record.id, 'https://cdn.example/v.mp4');
  var notifyResult = await pendingDreams.markNotified({}, record.id);
  assert.equal(notifyResult.ok, true);
  assert.equal(notifyResult.record.status, 'notified');
  assert.ok(notifyResult.record.notifiedAt);
});

test('markNotified: refuses (ok:false) once already claimed/failed', async function () {
  var record = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  await pendingDreams.markClaimed({}, record.id, 'a@example.com'); // claims straight from 'pending'
  var result = await pendingDreams.markNotified({}, record.id);
  assert.equal(result.ok, false);
  assert.equal(result.record.status, 'claimed');
});

test('markClaimed: transitions pending -> claimed when the expected email matches', async function () {
  var record = await pendingDreams.create({}, { email: 'owner@example.com', caption: 'x', style: 'Cartoon' });
  var result = await pendingDreams.markClaimed({}, record.id, 'owner@example.com');
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'claimed');
  assert.ok(result.record.claimedAt);
});

test('markClaimed: succeeds from "notified" (claiming after the email already fully sent is still meaningful bookkeeping)', async function () {
  var notifiedRec = await pendingDreams.create({}, { email: 'b@example.com', caption: 'x', style: 'Cartoon' });
  await pendingDreams.markReady({}, notifiedRec.id, 'https://cdn.example/v.mp4');
  await pendingDreams.markNotified({}, notifiedRec.id);
  var claimAfterNotified = await pendingDreams.markClaimed({}, notifiedRec.id, 'b@example.com');
  assert.equal(claimAfterNotified.ok, true);
});

test('markClaimed: deliberately FAILS from "ready" (the ephemeral state while the email is being sent) — closes the exact combined-outcome race a concurrency test caught (see the CONCURRENCY block below and markClaimed\'s own doc comment)', async function () {
  var record = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  await pendingDreams.markReady({}, record.id, 'https://cdn.example/v.mp4');
  var result = await pendingDreams.markClaimed({}, record.id, 'a@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.record.status, 'ready');
});

test('markClaimed: an EMAIL MISMATCH is refused outright, before even attempting the transition (ownership check, review finding)', async function () {
  var record = await pendingDreams.create({}, { email: 'owner@example.com', caption: 'x', style: 'Cartoon' });
  var result = await pendingDreams.markClaimed({}, record.id, 'attacker@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'email_mismatch');
  var stillPending = await pendingDreams.get({}, record.id);
  assert.equal(stillPending.status, 'pending', 'a mismatched-email claim attempt must not mutate the record at all');
});

test('markClaimed: email match is case-insensitive', async function () {
  var record = await pendingDreams.create({}, { email: 'owner@example.com', caption: 'x', style: 'Cartoon' });
  var result = await pendingDreams.markClaimed({}, record.id, 'OWNER@EXAMPLE.COM');
  assert.equal(result.ok, true);
});

test('markClaimed: an unknown id returns ok:false, record:null (with or without an expectedEmail)', async function () {
  var result = await pendingDreams.markClaimed({}, 'unknown-id', 'anyone@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.record, null);
});

test('markFailed: transitions pending -> failed and stamps failedReason', async function () {
  var record = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  var result = await pendingDreams.markFailed({}, record.id, 'E105: content_policy');
  assert.equal(result.ok, true);
  assert.equal(result.record.status, 'failed');
  assert.equal(result.record.failedReason, 'E105: content_policy');
});

test('characterIdsForGeneration/cameraView/sceneryTime/sceneryPlace/whatsapp all round-trip when provided', async function () {
  var record = await pendingDreams.create({}, {
    email: 'a@example.com', whatsapp: '+15551234567', caption: 'x', style: 'Cartoon',
    characterIdsForGeneration: ['c1'], cameraView: 'POV', sceneryTime: 'Night', sceneryPlace: 'Urban'
  });
  assert.deepEqual(record.characterIdsForGeneration, ['c1']);
  assert.equal(record.whatsapp, '+15551234567');
  assert.equal(record.cameraView, 'POV');
  assert.equal(record.sceneryTime, 'Night');
  assert.equal(record.sceneryPlace, 'Urban');
});

// ============================================================================
// CONCURRENCY — genuine Promise.all races (review finding, fixed)
// ----------------------------------------------------------------------------
// The real regression coverage: markReady (the webhook's "safe to send
// the email" gate) and markClaimed (a real signup completing) racing on
// the SAME fresh record. These assert the actual invariant a caller
// needs: mutually-exclusive transitions must never BOTH report success.
// ============================================================================

test('CONCURRENCY: markReady and markClaimed racing via Promise.all on the same fresh record never BOTH report ok:true', async function () {
  var record = await pendingDreams.create({}, { email: 'racer@example.com', caption: 'x', style: 'Cinematic' });

  var results = await Promise.all([
    pendingDreams.markReady({}, record.id, 'https://cdn.fal/v.mp4'),
    pendingDreams.markClaimed({}, record.id, 'racer@example.com')
  ]);

  var successes = results.filter(function (r) { return r.ok; }).length;
  assert.equal(successes, 1, 'markReady and markClaimed must never both win the same race -- that is precisely the double-send/lost-claim bug');

  // Whichever one won must match the actually-persisted final record --
  // no caller-visible "I won" claim should ever diverge from reality.
  var final = await pendingDreams.get({}, record.id);
  var winner = results[0].ok ? results[0] : results[1];
  assert.equal(winner.record.status, final.status);
});

test('CONCURRENCY: repeated trials stay consistent (run several times to rule out a lucky single pass)', async function () {
  for (var i = 0; i < 10; i++) {
    var record = await pendingDreams.create({}, { email: 'racer-loop-' + i + '@example.com', caption: 'x', style: 'Cinematic' });
    var results = await Promise.all([
      pendingDreams.markReady({}, record.id, 'https://cdn.fal/v.mp4'),
      pendingDreams.markClaimed({}, record.id, 'racer-loop-' + i + '@example.com')
    ]);
    var successes = results.filter(function (r) { return r.ok; }).length;
    assert.equal(successes, 1, 'trial ' + i + ': exactly one of markReady/markClaimed must win');
  }
});

test('CONCURRENCY: a claim racing against dream-webhook.js\'s own markReady->markNotified pair NEVER lands claimed+ready together, and never sees the email-decision reversed', async function () {
  // The realistic three-way sequence dream-webhook.js actually runs
  // (markReady, then — only once markReady wins — markNotified), raced
  // against a genuine concurrent claim attempt starting from the same
  // 'pending' base. This is the full, real shape of the bug report, not
  // just its first half.
  var record = await pendingDreams.create({}, { email: 'racer3@example.com', caption: 'x', style: 'Cinematic' });

  var readyResult = null;
  async function webhookSuccessPath() {
    readyResult = await pendingDreams.markReady({}, record.id, 'https://cdn.fal/v.mp4');
    if (readyResult.ok) {
      // dream-webhook.js only calls markNotified after markReady's own
      // ok:true -- see that file's actual handler.
      return pendingDreams.markNotified({}, record.id);
    }
    return readyResult;
  }

  var results = await Promise.all([
    webhookSuccessPath(),
    pendingDreams.markClaimed({}, record.id, 'racer3@example.com')
  ]);

  var claimResult = results[1];
  var final = await pendingDreams.get({}, record.id);

  // The one invariant that actually matters: if the claim genuinely won
  // (transitioned pending -> claimed), the webhook's OWN markReady call
  // must have FAILED (never decided to send) -- these two outcomes must
  // be mutually exclusive, closing the exact "both the normal experience
  // and an unwanted email" bug from review.
  if (claimResult.ok) {
    assert.equal(readyResult.ok, false, 'a claim that wins from "pending" must mean markReady never won -- otherwise the email would already be sent AND the claim also succeeded');
    assert.equal(final.status, 'claimed');
  } else {
    // The webhook path won instead -- claim correctly failed rather than
    // silently succeeding from the ephemeral 'ready' state (see
    // markClaimed's own doc comment on why 'ready' is excluded).
    assert.ok(['ready', 'notified'].indexOf(final.status) !== -1);
  }
});

test('CONCURRENCY: two concurrent markClaimed calls for the same record credit exactly one claim (no double-claimedAt confusion)', async function () {
  var record = await pendingDreams.create({}, { email: 'racer4@example.com', caption: 'x', style: 'Cinematic' });
  var results = await Promise.all([
    pendingDreams.markClaimed({}, record.id, 'racer4@example.com'),
    pendingDreams.markClaimed({}, record.id, 'racer4@example.com')
  ]);
  var successes = results.filter(function (r) { return r.ok; }).length;
  assert.equal(successes, 1);
  var final = await pendingDreams.get({}, record.id);
  assert.equal(final.status, 'claimed');
});
