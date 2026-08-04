// netlify/functions/send-pending-first-dream-emails.js
//
// Scheduled Netlify Function — the "wait, then decide" half of the
// thumbnail-gated automatic first-dream retention email (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp's founder-approved
// follow-up, 2026-08-03/04). See lib/first-dream-email-pending-store.js's
// own header comment for the full "why a scheduled scan, not a real
// in-request wait" reasoning and how the enqueue side works; this file is
// the other half — same "store + scheduled scan" shape send-daily-claim-
// pushes.js already established as this repo's first scheduled function
// (see that file's own header comment), same belt-and-suspenders
// netlify.toml-declared-cron-PLUS-inline-schedule()-wrapper convention
// every scheduled function since has followed.
//
// ON EVERY RUN, for every operationName still enqueued in
// lib/first-dream-email-pending-store.js:
//   1. Look up that record's owner's (`record.username`) private dreams
//      (lib/dream-store.js's getPrivateDreams) and find the one whose
//      `sourceOperationName` matches — see the pending-store's own header
//      comment for why this correlation needs no new field/client
//      contract at all.
//   2. If that dream exists AND already has a real `imageUrl` (the
//      client's own saveThumbnailBestEffort captured and synced it) —
//      SEND NOW, with the real thumbnail, and dequeue.
//   3. Otherwise, if `THUMBNAIL_WAIT_MS` (3 minutes — the founder's own
//      explicit figure: "wait up to 3 MINUTES for the captured image...
//      if not, SEND ANYWAY at the 3-minute mark") has elapsed since
//      `record.triggeredAt` — SEND ANYWAY, using
//      lib/first-dream-email-sender.js's existing no-thumbnail flat-color
//      fallback template (never deleted — this is the one real path that
//      still reaches it), and dequeue.
//   4. Otherwise — still within the window, no thumbnail yet — leave it
//      enqueued for a later run to re-check.
//
// CADENCE: every minute (`* * * * *`). This is finer-grained than every
// other scheduled function in this codebase (send-daily-claim-pushes.js's
// @hourly, reconcile-fal-cost.js's @daily, send-whatsapp-morning-
// capture.js's once-daily) because the founder's own bound here is
// MINUTES, not hours — a coarser cadence would either delay a genuinely-
// already-available thumbnail's send by that same coarser margin (missing
// "send with it" as soon as it exists) or overshoot the 3-minute deadline
// by the same margin. Every-minute keeps both errors bounded to roughly
// the sweep interval itself, the same "cadence picked against the bound
// it exists to serve" reasoning both-domain-smoke.js's own header comment
// documents for its own 4-hour interval. At this app's current real
// traffic (see FOUNDER_PRINCIPLES.md's own framing elsewhere in this
// codebase) the store this scans is always small — never a real cost or
// latency concern — see lib/first-dream-email-pending-store.js's own
// header comment on why it never accumulates a backlog.
//
// SAFE UNDER RE-SCAN / DOUBLE-FIRE: this file makes its own "send now vs.
// wait" decision purely from what it reads (no dedup marker of its own
// beyond dequeuing), on purpose — lib/first-dream-email-sender.js's
// sendIfEligible already owns the ONE real correctness guarantee (its own
// once-ever-per-account CAS guard), so two overlapping scans (or this
// scan racing the client-triggered send-first-dream-email.js fallback,
// or the OLD synchronous automatic path this replaces — there is none
// left, see mark-generation-completed.js's own updated comment) can only
// ever produce redundant no-op calls into that same guard, never a real
// double-send. removePending is likewise safe to call more than once
// (see its own doc comment).

var { schedule } = require('@netlify/functions');
var pendingStore = require('./lib/first-dream-email-pending-store');
var dreamStore = require('./lib/dream-store');
var firstDreamEmailSender = require('./lib/first-dream-email-sender');

// The founder's own explicit figure (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp, 2026-08-03 final
// clarification) — "wait up to 3 MINUTES for the captured image... if
// not, SEND ANYWAY at the 3-minute mark". Same numeric ballpark this
// codebase already uses elsewhere for a bounded real-world wait
// (js/store.js's own INTERP_AUDIO_MAX_POLL_MS is also 3 minutes, for an
// unrelated feature) — not reused from there (this is a genuinely
// separate concern, server-side vs. client-side), just noted as
// consistent with this app's own existing sense of "a reasonable bounded
// wait" elsewhere.
var THUMBNAIL_WAIT_MS = 3 * 60 * 1000;

/** Finds the private dream (if any) whose sourceOperationName matches — see this file's header comment step 1. */
function findDreamForOperation(dreams, operationName) {
  for (var i = 0; i < dreams.length; i++) {
    if (dreams[i] && dreams[i].sourceOperationName === operationName) return dreams[i];
  }
  return null;
}

/**
 * Does the actual scan + decide + send. Exposed separately from the
 * scheduled `exports.handler` below so test/send-pending-first-dream-
 * emails.test.js can call it directly with a fake event/mocked stores,
 * without needing to simulate an actual Netlify scheduled invocation
 * payload — same precedent as send-daily-claim-pushes.js's own
 * scanAndSend.
 */
async function scanAndSend(event) {
  var operationNames = await pendingStore.listPendingOperationNames(event);

  var scanned = 0;
  var sentWithImage = 0;
  var sentFallback = 0;
  var stillWaiting = 0;

  for (var i = 0; i < operationNames.length; i++) {
    var operationName = operationNames[i];
    scanned++;

    var record = await pendingStore.getPending(event, operationName);
    if (!record) continue; // already dequeued by a concurrent/earlier run

    var dreams = await dreamStore.getPrivateDreams(event, record.username);
    var dream = findDreamForOperation(dreams, operationName);

    if (dream && dream.imageUrl) {
      await firstDreamEmailSender.sendIfEligible(event, {
        username: record.username,
        email: record.email,
        dreamId: dream.id,
        imageUrl: dream.imageUrl,
        auto: true
      });
      await pendingStore.removePending(event, operationName);
      sentWithImage++;
      continue;
    }

    var elapsedMs = Date.now() - (record.triggeredAt || 0);
    if (elapsedMs >= THUMBNAIL_WAIT_MS) {
      await firstDreamEmailSender.sendIfEligible(event, {
        username: record.username,
        email: record.email,
        dreamId: dream ? dream.id : null,
        auto: true
      });
      await pendingStore.removePending(event, operationName);
      sentFallback++;
      continue;
    }

    stillWaiting++;
  }

  return { scanned: scanned, sentWithImage: sentWithImage, sentFallback: sentFallback, stillWaiting: stillWaiting };
}

exports.handler = schedule('* * * * *', async function (event) {
  try {
    var result = await scanAndSend(event);
    console.log('send-pending-first-dream-emails: scanned ' + result.scanned
      + ', sentWithImage ' + result.sentWithImage
      + ', sentFallback ' + result.sentFallback
      + ', stillWaiting ' + result.stillWaiting);
  } catch (e) {
    // Best-effort, same "never let this surface as a hard failure"
    // discipline as every other scheduled/background job in this
    // codebase — a failed scan just means this minute's batch doesn't
    // progress; the next scheduled run tries again, and no record is
    // ever lost (nothing here is destructive except a dequeue that
    // itself only happens right alongside a completed send attempt).
    console.error('send-pending-first-dream-emails: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing (test/send-pending-first-dream-emails.test.js).
exports.scanAndSend = scanAndSend;
exports.THUMBNAIL_WAIT_MS = THUMBNAIL_WAIT_MS;
