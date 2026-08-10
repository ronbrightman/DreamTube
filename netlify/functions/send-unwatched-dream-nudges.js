// netlify/functions/send-unwatched-dream-nudges.js
//
// Scheduled Netlify Function — the "wait, then decide" scan for the
// "unwatched dream" retention nudge (founder-approved retention plan, piece
// 1): a triggered email to a SIGNED-UP user whose dream video finished
// generating but who hasn't actually watched it.
//
// THE TRIGGER, restated ("did X but NOT Y"): a user's dream VIDEO finished
// generating (ready + a real thumbnail is available) AND they have NOT
// watched the result within ~7 minutes AND they are a registered account
// with an email on file. Exactly one nudge per dream, ever.
//
// This reuses, wholesale, the "store + scheduled scan" shape the automatic
// first-dream email already established (mark-generation-completed.js
// enqueues -> send-pending-first-dream-emails.js's scan drains), because
// the enqueue side is literally the same choke point (see
// mark-generation-completed.js's maybeEnqueueUnwatchedNudge) and the
// deferred-decision half is the same problem: a Netlify Function can't
// `await delay(7 minutes)` in one invocation, so the wait is modeled as a
// re-checked-on-a-schedule state. Read send-pending-first-dream-emails.js's
// header comment and lib/first-dream-email-pending-store.js's for the full
// "why a scan, not an in-request wait" reasoning this shares.
//
// ON EVERY RUN, for every operationName in lib/unwatched-dream-nudge-
// store.js's pending queue:
//   1. VIEWED?  If lib/result-view-store.js has a viewed marker for this
//      operationName, the user watched it — SUPPRESS (dequeue, send
//      nothing). This is the whole point of the server-side viewed marker:
//      it's the one signal a scheduled scan can read that the client-only
//      PostHog `first_video_result_view` can't give it (see
//      lib/result-view-store.js's header comment).
//   2. TOO SOON?  If less than READY_AGE_MS (7 min) has elapsed since the
//      record's triggeredAt (≈ when the video became ready), leave it
//      enqueued — the user still has time to watch before we'd nudge.
//   3. THUMBNAIL?  Resolve the owner's private dream whose
//      sourceOperationName matches (lib/dream-store.js — the SAME zero-new-
//      client-contract correlation send-pending-first-dream-emails.js uses;
//      see lib/first-dream-email-pending-store.js's header comment). If it
//      has a real imageUrl, hand it to lib/unwatched-dream-nudge-sender.js
//      (which owns suppression / first-dream-email overlap / the once-per-
//      dream guard / the actual Resend send with the List-Unsubscribe
//      headers). On a real send, dequeue. On a terminal skip (unsubscribed,
//      first-dream email already covered this dream, already nudged),
//      dequeue too — none of those change on a retry. On a transient skip
//      (no Resend key, a Resend failure, a guard-store blip), LEAVE it for
//      a later scan, until the give-up window below.
//   4. GIVE UP.  If GIVE_UP_AFTER_MS has elapsed and there's still no
//      thumbnail (or the send never succeeded), DROP it. The only accounts
//      that hit this are those whose thumbnail never synced at all — which,
//      because the thumbnail is captured on result.html's own ambient
//      preview render, means the user never even loaded their result page.
//      That's a real retention target too, but it has no thumbnail to
//      include, so it's deliberately OUT OF SCOPE for this "ready + thumbnail
//      available" nudge (matching the trigger's own wording and the founder
//      ask to include the thumbnail) — a dropped email is strictly better
//      here than a thumbnail-less one. See this file's report notes.
//
// CADENCE: every 3 minutes (`*/3 * * * *`). Unlike send-pending-first-dream-
// emails.js's every-MINUTE cadence — which exists to send the instant a
// slow thumbnail lands, a sub-minute goal — this nudge's dominant bound is
// the 7-minute unwatched FLOOR, and the founder ask is to land the email
// ~7-10 min after ready. Max delay ≈ floor + one interval = 7 + 3 = ~10 min,
// which lands squarely in that window; a finer (every-minute) cadence would
// just triple the invocation count for no benefit, since nothing here needs
// to act in the first 7 minutes at all. The queue only ever holds records
// still inside their short window, so it stays naturally small (same
// reasoning as the first-dream pending store).
//
// SAFE UNDER RE-SCAN / DOUBLE-FIRE: like send-pending-first-dream-emails.js,
// this makes its send/wait/drop decision purely from what it reads; the ONE
// real correctness guarantee (exactly one nudge per dream) is owned by
// lib/unwatched-dream-nudge-store.js's markNudgedOnce CAS claim inside the
// sender, so two overlapping scans can only ever produce redundant no-op
// calls into that guard, never a real double-send. removePending is safe to
// call more than once.

var { schedule } = require('@netlify/functions');
var nudgeStore = require('./lib/unwatched-dream-nudge-store');
var resultViewStore = require('./lib/result-view-store');
var dreamStore = require('./lib/dream-store');
var nudgeSender = require('./lib/unwatched-dream-nudge-sender');

// The "unwatched" floor: don't nudge until at least this long after the
// dream became ready, giving the user a real chance to watch it first.
var READY_AGE_MS = 7 * 60 * 1000;

// How long to keep a record enqueued before giving up entirely (dropping,
// never sending a thumbnail-less nudge). Generous headroom past the 7-min
// floor for a slow thumbnail sync; anything still thumbnail-less by 30 min
// almost certainly never synced at all (the user never loaded result.html),
// which is out of this nudge's "thumbnail available" scope (see header
// comment step 4).
var GIVE_UP_AFTER_MS = 30 * 60 * 1000;

// Terminal skip reasons from the sender — none change on a retry, so the
// record is dequeued rather than re-checked forever.
var TERMINAL_SKIPS = {
  suppressed: true,
  first_dream_email_already_sent: true,
  already_nudged: true,
  missing_identity: true
};

/** Finds the private dream (if any) whose sourceOperationName matches — same correlation as send-pending-first-dream-emails.js's findDreamForOperation. */
function findDreamForOperation(dreams, operationName) {
  for (var i = 0; i < dreams.length; i++) {
    if (dreams[i] && dreams[i].sourceOperationName === operationName) return dreams[i];
  }
  return null;
}

/**
 * The scan + decide + send, exposed separately from exports.handler so
 * test/send-unwatched-dream-nudges.test.js can drive it directly with a
 * fake event / mocked stores — same precedent as send-pending-first-dream-
 * emails.js's scanAndSend and send-daily-claim-pushes.js's own.
 */
async function scanAndSend(event) {
  var operationNames = await nudgeStore.listPendingOperationNames(event);

  var result = {
    scanned: 0,
    sent: 0,
    suppressedViewed: 0,
    skippedTerminal: 0,
    droppedNoThumbnail: 0,
    stillWaiting: 0
  };

  for (var i = 0; i < operationNames.length; i++) {
    var operationName = operationNames[i];
    result.scanned++;

    var record = await nudgeStore.getPending(event, operationName);
    if (!record) continue; // already dequeued by a concurrent/earlier run

    // 1) VIEWED — the user watched it; suppress.
    var viewed = await resultViewStore.hasViewed(event, operationName);
    if (viewed) {
      await nudgeStore.removePending(event, operationName);
      result.suppressedViewed++;
      continue;
    }

    var elapsedMs = Date.now() - (record.triggeredAt || 0);

    // 2) TOO SOON — still inside the unwatched floor; give them time.
    if (elapsedMs < READY_AGE_MS) {
      result.stillWaiting++;
      continue;
    }

    // 3) THUMBNAIL — resolve the dream and, if it has one, try to send.
    var dreams = await dreamStore.getPrivateDreams(event, record.username);
    var dream = findDreamForOperation(dreams, operationName);

    if (dream && dream.imageUrl) {
      var sendResult = await nudgeSender.sendIfEligible(event, {
        operationName: operationName,
        username: record.username,
        email: record.email,
        dream: dream
      });

      if (sendResult.sent) {
        await nudgeStore.removePending(event, operationName);
        result.sent++;
        continue;
      }

      if (TERMINAL_SKIPS[sendResult.skipped]) {
        await nudgeStore.removePending(event, operationName);
        result.skippedTerminal++;
        continue;
      }

      // Transient skip (no Resend key, a Resend failure, a guard-store blip)
      // — the sender already released any claim it won, so a later scan can
      // genuinely retry. Leave it enqueued, unless we're past the give-up
      // window (a permanently-failing send must not loop forever).
      if (elapsedMs >= GIVE_UP_AFTER_MS) {
        await nudgeStore.removePending(event, operationName);
        result.droppedNoThumbnail++;
        continue;
      }
      result.stillWaiting++;
      continue;
    }

    // 4) NO THUMBNAIL yet — wait, then give up.
    if (elapsedMs >= GIVE_UP_AFTER_MS) {
      await nudgeStore.removePending(event, operationName);
      result.droppedNoThumbnail++;
      continue;
    }
    result.stillWaiting++;
  }

  return result;
}

exports.handler = schedule('*/3 * * * *', async function (event) {
  try {
    var result = await scanAndSend(event);
    console.log('send-unwatched-dream-nudges: scanned ' + result.scanned
      + ', sent ' + result.sent
      + ', suppressedViewed ' + result.suppressedViewed
      + ', skippedTerminal ' + result.skippedTerminal
      + ', droppedNoThumbnail ' + result.droppedNoThumbnail
      + ', stillWaiting ' + result.stillWaiting);
  } catch (e) {
    // Best-effort, same "never surface as a hard failure" discipline as
    // every other scheduled job here — a failed scan just means this run's
    // batch doesn't progress; the next run tries again, and no record is
    // lost (nothing is destructive except a dequeue alongside a completed
    // decision).
    console.error('send-unwatched-dream-nudges: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing.
exports.scanAndSend = scanAndSend;
exports.READY_AGE_MS = READY_AGE_MS;
exports.GIVE_UP_AFTER_MS = GIVE_UP_AFTER_MS;
