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
// This uses the "store + scheduled scan" shape send-daily-claim-pushes.js
// established as this repo's first scheduled function: the enqueue side is
// mark-generation-completed.js's maybeEnqueueUnwatchedNudge, and the
// deferred-decision half solves the same problem a Netlify Function can't
// `await delay(7 minutes)` in one invocation, so the wait is modeled as a
// re-checked-on-a-schedule state. As of the founder's 2026-08-11 decision
// (retire the separate first-dream email; let this nudge be the single "your
// dream is ready to watch" email per unwatched dream, including a user's
// FIRST dream), this scan drives the ONLY such email the app now sends to a
// signed-up user.
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
//      sourceOperationName matches (lib/dream-store.js — a zero-new-client-
//      contract correlation on the already-synced private-dream record). If
//      it has a real imageUrl, hand it to lib/unwatched-dream-nudge-sender.js
//      (which owns suppression / the once-per-dream guard / the actual Resend
//      send with the List-Unsubscribe headers). On a real send, dequeue. On a
//      terminal skip (unsubscribed, already nudged), dequeue too — none of
//      those change on a retry. On a transient skip
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
// CADENCE: every 3 minutes (`*/3 * * * *`). This nudge's dominant bound is
// the 7-minute unwatched FLOOR, and the founder ask is to land the email
// ~7-10 min after ready. Max delay ≈ floor + one interval = 7 + 3 = ~10 min,
// which lands squarely in that window; a finer (every-minute) cadence would
// just triple the invocation count for no benefit, since nothing here needs
// to act in the first 7 minutes at all. The queue only ever holds records
// still inside their short window, so it stays naturally small.
//
// SAFE UNDER RE-SCAN / DOUBLE-FIRE: this makes its send/wait/drop decision
// purely from what it reads; the ONE
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
var posthogCapture = require('./lib/posthog-capture');

// The "unwatched" floor: don't nudge until at least this long after the
// dream became ready, giving the user a real chance to watch it first. This is
// the DEFAULT for an ordinary client-enqueued nudge; overridable via the
// UNWATCHED_NUDGE_DELAY_MS env var (see resolvedStandardFloorMs).
var READY_AGE_MS = 7 * 60 * 1000;

// The SHORTER floor for a SERVER-side (dream-webhook.js) recovery enqueue — a
// record flagged `recoveryEnqueue` (the CLIENT never marked completion, i.e. an
// FB/IG-webview leaver whose durable video was saved server-side; see
// dream-webhook.js). For that user the pre-send wait is just dead time — the
// recovery email, whose link opens their real browser to the saved video,
// should land promptly. DEFAULT 3 min; overridable via RECOVERY_NUDGE_DELAY_MS.
// This ONLY changes how soon we CHECK-and-send — the watched/active guard
// (step 1's viewed check + the sender's own belt-and-suspenders viewed re-check)
// is fully intact, so a user who watched within the (shorter) window is still
// suppressed exactly as before.
var RECOVERY_READY_AGE_MS = 3 * 60 * 1000;

// Env-tunable effective floors, resolved at scan time (not module load) so a
// test can set the env var and call scanAndSend directly without re-requiring
// the module. Each falls back to its own default constant for any missing/
// non-positive value.
function resolvedStandardFloorMs() {
  var v = parseInt(process.env.UNWATCHED_NUDGE_DELAY_MS, 10);
  return (v && v > 0) ? v : READY_AGE_MS;
}
function resolvedRecoveryFloorMs() {
  var v = parseInt(process.env.RECOVERY_NUDGE_DELAY_MS, 10);
  return (v && v > 0) ? v : RECOVERY_READY_AGE_MS;
}

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
  already_nudged: true,
  missing_identity: true,
  // The sender's own belt-and-suspenders viewed re-check (a viewed marker
  // that landed after this scan's own step-1 check) — a watched dream never
  // becomes unwatched, so dequeue rather than re-check forever. The scan
  // suppresses viewed dreams at step 1 anyway; this only fires in the narrow
  // step-1-to-send race the sender re-check closes.
  already_viewed: true
};

/**
 * Best-effort DROP telemetry — fires 'unwatched_dream_nudge_dropped', never
 * throws. A give-up drop (no thumbnail ever synced, or a send that never
 * succeeded before the window closed) is the ONE outcome that otherwise
 * emits NOTHING (the sender's sent/skipped events only fire once the scan
 * reaches sendIfEligible with a real thumbnail), so it was the exact blind
 * spot that hid this nudge being dead — a queue full of thumbnail-starved
 * records draining to zero sends with no signal. Surfacing it lets the
 * morning report tell "nobody eligible" from "everybody dropped for lack of
 * a thumbnail" (the post-processing.html-removal regression this build also
 * fixes on the capture side).
 */
async function reportDrop(record, reason) {
  try {
    await posthogCapture.captureEvent({
      event: 'unwatched_dream_nudge_dropped',
      distinct_id: (record && (record.username || record.email)) || 'unknown',
      properties: { reason: reason }
    });
  } catch (e) { /* analytics must never break the app */ }
}

/**
 * A nudge that terminally resolved WITHOUT sending and WITHOUT being a drop —
 * the user already watched their dream (reason 'viewed', the common case) or a
 * terminal skip fired (reason 'terminal'). Emitted so the enqueue→resolution
 * accounting closes to 100% (enqueued = sent + dropped + suppressed + the
 * transient still-waiting), which is what makes "why did only N of M enqueued
 * send?" answerable at source instead of an inferred gap (founder asked exactly
 * this 2026-08-16: most enqueued nudges are suppressed because the user watched
 * their dream, but nothing recorded that until now).
 */
async function reportSuppress(record, reason) {
  try {
    await posthogCapture.captureEvent({
      event: 'unwatched_dream_nudge_suppressed',
      distinct_id: (record && (record.username || record.email)) || 'unknown',
      properties: { reason: reason }
    });
  } catch (e) { /* analytics must never break the app */ }
}

/** Finds the private dream (if any) whose sourceOperationName matches — the zero-new-client-contract correlation on the already-synced private-dream record. */
function findDreamForOperation(dreams, operationName) {
  for (var i = 0; i < dreams.length; i++) {
    if (dreams[i] && dreams[i].sourceOperationName === operationName) return dreams[i];
  }
  return null;
}

/**
 * The scan + decide + send, exposed separately from exports.handler so
 * test/send-unwatched-dream-nudges.test.js can drive it directly with a
 * fake event / mocked stores — same precedent as send-daily-claim-pushes.js's
 * own scanAndSend.
 */
async function scanAndSend(event) {
  var operationNames = await nudgeStore.listPendingOperationNames(event);
  var standardFloorMs = resolvedStandardFloorMs();
  var recoveryFloorMs = resolvedRecoveryFloorMs();

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
      await reportSuppress(record, 'viewed');
      continue;
    }

    var elapsedMs = Date.now() - (record.triggeredAt || 0);

    // 2) TOO SOON — still inside the unwatched floor; give them time. A
    // server-side recovery enqueue (a webview leaver) uses the SHORTER floor so
    // its recovery email fires promptly; an ordinary client-enqueued nudge keeps
    // the standard floor. The VIEWED suppression (step 1 above) already ran
    // regardless of which floor applies, so the shorter floor never emails
    // someone who has already watched.
    var floorMs = record.recoveryEnqueue ? recoveryFloorMs : standardFloorMs;
    if (elapsedMs < floorMs) {
      result.stillWaiting++;
      continue;
    }

    // 3) RESOLVE THE DREAM + decide whether to send.
    var dreams = await dreamStore.getPrivateDreams(event, record.username);
    var dream = findDreamForOperation(dreams, operationName);

    // A per-dream thumbnail is PREFERRED but no longer REQUIRED (founder
    // 2026-08-15): a recovery (webview-leaver) dream is persisted server-side
    // with a videoUrl but NO imageUrl — fal's webhook returns no poster and no
    // client ran to sync a first-frame still — so it will NEVER get one, and
    // requiring it silently dropped the recovery email for the exact cohort it
    // exists for. So the sender falls back to a branded dreamscape hero when
    // there's no real thumbnail, and this scan sends when the dream record
    // exists AND either: it has a real thumbnail; OR it's a recovery enqueue
    // (thumbnail will never come — send promptly); OR a normal enqueue has
    // waited out the give-up window for its client thumbnail (send with the
    // fallback rather than dropping). A NULL dream (never persisted) still
    // can't be sent — there's nothing to link to.
    var giveUpElapsed = elapsedMs >= GIVE_UP_AFTER_MS;
    var readyToSend = dream && (dream.imageUrl || record.recoveryEnqueue || giveUpElapsed);

    if (readyToSend) {
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
        await reportSuppress(record, 'terminal:' + sendResult.skipped);
        continue;
      }

      // Transient skip (no Resend key, a Resend failure, a guard-store blip)
      // — the sender already released any claim it won, so a later scan can
      // genuinely retry. Leave it enqueued, unless we're past the give-up
      // window (a permanently-failing send must not loop forever).
      if (giveUpElapsed) {
        await nudgeStore.removePending(event, operationName);
        result.droppedNoThumbnail++;
        await reportDrop(record, 'send_never_succeeded');
        continue;
      }
      result.stillWaiting++;
      continue;
    }

    // 4) NOT READY — a normal dream still inside its thumbnail-grace window
    // (give its client first-frame still time to sync before falling back to
    // the branded hero), or no dream record persisted at all. Wait, then give
    // up.
    if (giveUpElapsed) {
      await nudgeStore.removePending(event, operationName);
      result.droppedNoThumbnail++;
      await reportDrop(record, dream ? 'no_thumbnail' : 'no_dream_record');
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
exports.RECOVERY_READY_AGE_MS = RECOVERY_READY_AGE_MS;
exports.GIVE_UP_AFTER_MS = GIVE_UP_AFTER_MS;
