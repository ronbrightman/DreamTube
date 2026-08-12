// netlify/functions/send-interp-none-nudges.js
//
// Scheduled Netlify Function — the "wait, then decide" scan that makes the
// "No meaning yet" interpretation retention email send AUTOMATICALLY (founder-
// approved 2026-08-12: "add the no interpretation email to also be
// automatically sent like not watched video"), exactly the way send-unwatched-
// dream-nudges.js already auto-sends the "unwatched dream" nudge.
//
// THE TRIGGER, restated ("did X but NOT Y"): a signed-up user WATCHED their
// dream video (lib/result-view-store.js's viewed marker — the enqueue signal,
// written by mark-result-viewed.js) AND, ~10 minutes later, has STILL opened
// ZERO of the 5 interpretations on that dream (lib/interp-read-store.js reports
// 0 personas read). Exactly one email per dream, ever.
//
// SCOPE (deliberately narrow): this auto-sends ONLY the "No meaning yet"
// ("none") email. The flagship "Unread meanings" email stays MANUAL via the
// owner-gated send-interp-emails-batch.js endpoint — untouched. Both emails
// share lib/interp-email-store.js's per-dream once-ever guards, so a dream this
// scheduler sends the "none" email for is skipped by any later manual batch and
// vice-versa (whichever claims the CAS marker first wins; the other no-ops).
//
// This reuses the store+scan shape send-unwatched-dream-nudges.js established:
//   - ENQUEUE side: mark-result-viewed.js's maybeEnqueueInterpNoneCandidate,
//     firing off the same WATCH that writes the viewed marker.
//   - DECIDE side (this file): a Netlify Function can't `await delay(10 min)`
//     in one invocation, so the wait is modeled as a re-checked-on-a-schedule
//     state over lib/interp-none-queue-store.js's pending queue.
//
// ON EVERY RUN, for each operationName in the pending queue (bounded by
// MAX_PER_RUN so a single scheduled invocation never blows the platform
// timeout):
//   1. READ ALREADY?  If lib/interp-read-store.js reports >=1 persona read for
//      this operationName, the user engaged with the interpretations — SELF-
//      SUPPRESS (dequeue, send nothing). Checked FIRST, before the delay floor,
//      the same way send-unwatched-dream-nudges.js suppresses a VIEWED dream
//      at its step 1 regardless of the floor.
//   2. TOO SOON?  If less than DELAY_MS (~10 min) has elapsed since watchedAt,
//      leave it enqueued — the user still has time to read a meaning before we
//      email.
//   3. EXPIRED?  If more than EXPIRE_AFTER_MS (a few days) has elapsed, DROP it
//      (dequeue, send nothing) — a stale candidate that never got sent (e.g.
//      RESEND_API_KEY was unset for the whole window) must not loop forever.
//   4. SEND.  Resolve the owner's private dream whose sourceOperationName
//      matches (the zero-new-client-contract correlation send-unwatched-dream-
//      nudges.js uses) and hand it to lib/interp-none-email-sender.js's
//      sendIfEligible — which owns founder/test exclusion, the suppression
//      list, the shared once-per-dream CAS claim, the Resend send + the
//      matching push. On a real send, dequeue. On a TERMINAL skip (already
//      sent by the manual batch or an earlier run, suppressed/unsubscribed,
//      excluded, not-watched), dequeue too — none change on a retry. On a
//      TRANSIENT skip (no Resend key, a Resend failure, a guard-store blip),
//      LEAVE it for a later scan, until EXPIRE_AFTER_MS.
//
// CADENCE: every 3 minutes (`*/3 * * * *`), same as send-unwatched-dream-
// nudges.js. The dominant bound is the ~10-min DELAY floor, so max delay ≈
// floor + one interval ≈ 13 min — comfortably in the plan's "~10 min same day"
// window; a finer cadence would just multiply invocations for no benefit since
// nothing here acts inside the first 10 minutes.
//
// SAFE UNDER RE-SCAN / DOUBLE-FIRE: every send/wait/drop decision is made
// purely from what this reads; the one real correctness guarantee (exactly one
// "none" email per dream) is owned by lib/interp-email-store.js's markNoneSentOnce
// CAS claim inside the sender, so two overlapping scans can only ever produce
// redundant no-op calls into that guard, never a real double-send. removePending
// is safe to call more than once.

var { schedule } = require('@netlify/functions');
var queueStore = require('./lib/interp-none-queue-store');
var interpReadStore = require('./lib/interp-read-store');
var dreamStore = require('./lib/dream-store');
var noneSender = require('./lib/interp-none-email-sender');

// The delay floor: don't email until at least this long after the user watched
// the dream, giving them a real chance to open an interpretation first (the
// plan's "~10 min same day" timing). Env-overridable without a redeploy.
function delayMs() {
  var n = parseInt(process.env.INTERP_NONE_NUDGE_DELAY_MS, 10);
  return (n && n > 0) ? n : 10 * 60 * 1000;
}

// How long to keep a candidate enqueued before dropping it entirely (a stale
// candidate that never sent — e.g. RESEND_API_KEY unset for the whole window,
// or a dream record that never synced). Generous headroom so a legitimately
// slow send still has many scans to succeed. Env-overridable.
function expireAfterMs() {
  var n = parseInt(process.env.INTERP_NONE_NUDGE_EXPIRE_MS, 10);
  return (n && n > 0) ? n : 3 * 24 * 60 * 60 * 1000;
}

// Per-invocation work cap — process at most this many candidates per scheduled
// run so a run always finishes well under the platform timeout even if the
// queue is momentarily large (same defensiveness as send-interp-emails-batch.js's
// wall-clock budget). Env-overridable.
function maxPerRun() {
  var n = parseInt(process.env.INTERP_NONE_NUDGE_MAX_PER_RUN, 10);
  return (n && n > 0) ? n : 50;
}

// Terminal skip reasons from lib/interp-none-email-sender.js — none change on a
// retry, so the record is dequeued rather than re-checked forever.
var TERMINAL_SKIPS = {
  already_sent: true,     // the shared once-per-dream guard (manual batch or an earlier run beat us) — never sends again
  suppressed: true,       // unsubscribed — never changes on a retry
  excluded: true,         // founder/test address — never sends
  not_watched: true,      // the sender's belt-and-suspenders watched re-check — a watched dream never becomes unwatched
  missing_identity: true  // a malformed candidate — never becomes valid on a retry
};

/** Finds the private dream (if any) whose sourceOperationName matches — the zero-new-client-contract correlation on the already-synced private-dream record (same helper send-unwatched-dream-nudges.js uses). */
function findDreamForOperation(dreams, operationName) {
  for (var i = 0; i < dreams.length; i++) {
    if (dreams[i] && dreams[i].sourceOperationName === operationName) return dreams[i];
  }
  return null;
}

/**
 * The scan + decide + send, exposed separately from exports.handler so
 * test/send-interp-none-nudges.test.js can drive it directly with a fake
 * event / mocked stores — same precedent as send-unwatched-dream-nudges.js's
 * own scanAndSend.
 */
async function scanAndSend(event) {
  var operationNames = await queueStore.listPendingOperationNames(event);
  var DELAY_MS = delayMs();
  var EXPIRE_MS = expireAfterMs();
  var MAX = maxPerRun();
  var ownerEmail = process.env.OWNER_EMAIL || null;

  var result = {
    scanned: 0,
    sent: 0,
    pushSent: 0,
    dequeuedRead: 0,    // user read an interpretation in the meantime — self-suppressed
    skippedTerminal: 0, // sender returned a terminal skip (already sent, suppressed, excluded, ...)
    expired: 0,         // candidate aged past EXPIRE_AFTER_MS with no send
    stillWaiting: 0     // inside the delay floor, or a transient skip left for a later scan
  };

  for (var i = 0; i < operationNames.length && result.scanned < MAX; i++) {
    var operationName = operationNames[i];
    result.scanned++;

    var record = await queueStore.getPending(event, operationName);
    if (!record) continue; // already dequeued by a concurrent/earlier run

    // 1) READ ALREADY — the user opened an interpretation; self-suppress.
    var readCount = await interpReadStore.countPersonasRead(event, operationName);
    if (readCount >= 1) {
      await queueStore.removePending(event, operationName);
      result.dequeuedRead++;
      continue;
    }

    var elapsedMs = Date.now() - (record.watchedAt || 0);

    // 2) TOO SOON — still inside the delay floor; give them time to read one.
    if (elapsedMs < DELAY_MS) {
      result.stillWaiting++;
      continue;
    }

    // 3) EXPIRED — a stale candidate that never sent; drop it.
    if (elapsedMs >= EXPIRE_MS) {
      await queueStore.removePending(event, operationName);
      result.expired++;
      continue;
    }

    // 4) SEND — resolve the dream and hand it to the guarded sender.
    var dreams = await dreamStore.getPrivateDreams(event, record.username);
    var dream = findDreamForOperation(dreams, operationName);
    if (!dream) {
      // The dream hasn't synced (or resolved) yet — wait for a later scan, or
      // give up once past the expire window.
      result.stillWaiting++;
      continue;
    }

    var sendResult = await noneSender.sendIfEligible(event, {
      operationName: operationName,
      username: record.username,
      email: record.email,
      dream: dream,
      ownerEmail: ownerEmail
    });

    if (sendResult.sent) {
      await queueStore.removePending(event, operationName);
      result.sent++;
      if (sendResult.pushSent) result.pushSent++;
      continue;
    }

    if (TERMINAL_SKIPS[sendResult.skipped]) {
      await queueStore.removePending(event, operationName);
      result.skippedTerminal++;
      continue;
    }

    // Transient skip (no Resend key, a Resend failure, a guard-store blip) —
    // the sender already released any claim it won, so a later scan can
    // genuinely retry. Leave it enqueued; step 3's EXPIRE window is the
    // ultimate backstop so a permanently-failing send can't loop forever.
    result.stillWaiting++;
  }

  return result;
}

exports.handler = schedule('*/3 * * * *', async function (event) {
  try {
    var result = await scanAndSend(event);
    console.log('send-interp-none-nudges: scanned ' + result.scanned
      + ', sent ' + result.sent
      + ', pushSent ' + result.pushSent
      + ', dequeuedRead ' + result.dequeuedRead
      + ', skippedTerminal ' + result.skippedTerminal
      + ', expired ' + result.expired
      + ', stillWaiting ' + result.stillWaiting);
  } catch (e) {
    // Best-effort, same "never surface as a hard failure" discipline as every
    // other scheduled job here — a failed scan just means this run's batch
    // doesn't progress; the next run tries again, and no record is lost
    // (nothing is destructive except a dequeue alongside a completed decision).
    console.error('send-interp-none-nudges: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing.
exports.scanAndSend = scanAndSend;
exports.delayMs = delayMs;
exports.expireAfterMs = expireAfterMs;
exports.maxPerRun = maxPerRun;
