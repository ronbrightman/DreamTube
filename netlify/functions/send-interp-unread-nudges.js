// netlify/functions/send-interp-unread-nudges.js
//
// Scheduled Netlify Function — the "wait, then decide" scan that makes the
// FLAGSHIP "Unread meanings" interpretation retention email send AUTOMATICALLY
// (founder-approved 2026-08-12: auto-send the interpretation emails "like not
// watched video"), the direct sibling of send-interp-none-nudges.js.
//
// THE TRIGGER, restated ("did X but NOT all of Y"): a signed-up user READ their
// FIRST interpretation on a dream (lib/interp-read-store.js's per-persona read
// marker — the enqueue signal, written by interpret-dream.js on a successful
// mode:"reading") AND, ~next day, has read SOME but NOT ALL of the 5 (read
// count still 1-4). Exactly one email per dream, ever. Re-fires per dream (each
// of a user's dreams can independently trigger once).
//
// SCOPE: this auto-sends the "Unread meanings" ("unread") email. It reuses the
// SAME guarded sender the owner-gated manual batch (send-interp-emails-batch.js)
// uses — lib/interp-unread-email-sender.js's sendIfEligible — so both share
// lib/interp-email-store.js's per-dream once-ever guard (markUnreadSentOnce):
// a dream this scheduler sends for is skipped by any later manual batch and
// vice-versa (whichever claims the CAS marker first wins; the other no-ops
// already_sent). CONFIRMED both directions in test/send-interp-unread-
// nudges.test.js.
//
// This mirrors send-interp-none-nudges.js's store+scan shape exactly:
//   - ENQUEUE side: interpret-dream.js's maybeEnqueueInterpUnreadCandidate,
//     firing off the same READING that writes the read marker.
//   - DECIDE side (this file): a Netlify Function can't `await delay(~next day)`
//     in one invocation, so the wait is modeled as a re-checked-on-a-schedule
//     state over lib/interp-unread-queue-store.js's pending queue.
//
// ON EVERY RUN, for each operationName in the pending queue (bounded by
// MAX_PER_RUN so a single scheduled invocation never blows the platform
// timeout):
//   1. RE-CHECK READ COUNT (lib/interp-read-store.js):
//      - count 5 (read ALL)  -> SELF-SUPPRESS (dequeue, send nothing) — they
//        finished; nothing is "unread" to nudge toward.
//      - count 0 (shouldn't happen once enqueued — a read wrote the marker that
//        enqueued this) -> DEQUEUE (send nothing) — nothing to name as read.
//      - count 1-4 -> the live trigger; proceed.
//   2. TOO SOON?  If less than DELAY_MS (~next day) has elapsed since
//      firstReadAt, leave it enqueued — the "next day" timing the plan calls for.
//   3. EXPIRED?  If more than EXPIRE_AFTER_MS (a few days past the delay) has
//      elapsed, DROP it (dequeue, send nothing) — a stale candidate that never
//      got sent (e.g. RESEND_API_KEY unset for the whole window) must not loop.
//   4. SEND.  Resolve the owner's private dream whose sourceOperationName
//      matches (the same zero-new-client-contract correlation send-interp-none-
//      nudges.js uses), pick a read persona (readSet[0]) + the first unread
//      persona to name in the copy, and hand it to lib/interp-unread-email-
//      sender.js's sendIfEligible — which owns founder/test exclusion, the
//      suppression list, the shared once-per-dream CAS claim, the Resend send +
//      the matching push. On a real send, dequeue. On a TERMINAL skip (already
//      sent by the manual batch or an earlier run, suppressed/unsubscribed,
//      excluded, malformed), dequeue too — none change on a retry. On a
//      TRANSIENT skip (no Resend key, a Resend failure, a guard-store blip),
//      LEAVE it for a later scan, until EXPIRE_AFTER_MS.
//
// CADENCE: every 3 minutes (`*/3 * * * *`), same as send-interp-none-nudges.js.
// The dominant bound here is the ~next-day DELAY floor, so the +3-min interval
// granularity is immaterial; a finer cadence would just multiply invocations
// for no benefit since nothing here acts inside the first ~20 hours.
//
// SAFE UNDER RE-SCAN / DOUBLE-FIRE: every send/wait/drop decision is made purely
// from what this reads; the one real correctness guarantee (exactly one "unread"
// email per dream) is owned by lib/interp-email-store.js's markUnreadSentOnce
// CAS claim inside the sender, so two overlapping scans can only ever produce
// redundant no-op calls into that guard, never a real double-send. removePending
// is safe to call more than once.

var { schedule } = require('@netlify/functions');
var queueStore = require('./lib/interp-unread-queue-store');
var interpReadStore = require('./lib/interp-read-store');
var dreamStore = require('./lib/dream-store');
var unreadSender = require('./lib/interp-unread-email-sender');
var InterpreterPersonas = require('../../js/interpreter-personas');

// The full set of persona keys (single source of truth), used to name an UNREAD
// persona for the flagship email's copy — the same list + firstUnreadPersona
// logic send-interp-emails-batch.js uses for its own selection.
var ALL_PERSONA_KEYS = (InterpreterPersonas.ALL || []).map(function (p) { return p.key; });

/** The first persona key NOT present in `readSet` — a persona the user did NOT read, to name in the flagship email. Null if every persona was read (never reached for a 1-4 trigger). */
function firstUnreadPersona(readSet) {
  for (var i = 0; i < ALL_PERSONA_KEYS.length; i++) {
    if (readSet.indexOf(ALL_PERSONA_KEYS[i]) === -1) return ALL_PERSONA_KEYS[i];
  }
  return null;
}

// The delay floor: don't email until at least this long after the user opened
// their first reading, per the retention plan's "next day" timing for this
// email. ~20 hours by default. Env-overridable without a redeploy.
function delayMs() {
  var n = parseInt(process.env.INTERP_UNREAD_NUDGE_DELAY_MS, 10);
  return (n && n > 0) ? n : 20 * 60 * 60 * 1000;
}

// How long to keep a candidate enqueued before dropping it entirely (a stale
// candidate that never sent — e.g. RESEND_API_KEY unset for the whole window,
// or a dream record that never synced). A few days PAST the ~next-day delay so
// a legitimately slow send still has many scans to succeed. Env-overridable.
function expireAfterMs() {
  var n = parseInt(process.env.INTERP_UNREAD_NUDGE_EXPIRE_MS, 10);
  return (n && n > 0) ? n : 4 * 24 * 60 * 60 * 1000;
}

// Per-invocation work cap — process at most this many candidates per scheduled
// run so a run always finishes well under the platform timeout even if the
// queue is momentarily large. Env-overridable.
function maxPerRun() {
  var n = parseInt(process.env.INTERP_UNREAD_NUDGE_MAX_PER_RUN, 10);
  return (n && n > 0) ? n : 50;
}

// Terminal skip reasons from lib/interp-unread-email-sender.js — none change on
// a retry, so the record is dequeued rather than re-checked forever. (No
// not_watched here — unlike the "none" email, the "unread" trigger is read-
// based, not watch-based.)
var TERMINAL_SKIPS = {
  already_sent: true,     // the shared once-per-dream guard (manual batch or an earlier run beat us) — never sends again
  suppressed: true,       // unsubscribed — never changes on a retry
  excluded: true,         // founder/test address — never sends
  missing_identity: true  // a malformed candidate — never becomes valid on a retry
};

/** Finds the private dream (if any) whose sourceOperationName matches — the zero-new-client-contract correlation on the already-synced private-dream record (same helper send-interp-none-nudges.js uses). */
function findDreamForOperation(dreams, operationName) {
  for (var i = 0; i < dreams.length; i++) {
    if (dreams[i] && dreams[i].sourceOperationName === operationName) return dreams[i];
  }
  return null;
}

/**
 * The scan + decide + send, exposed separately from exports.handler so
 * test/send-interp-unread-nudges.test.js can drive it directly with a fake
 * event / mocked stores — same precedent as send-interp-none-nudges.js's own
 * scanAndSend.
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
    dequeuedAllRead: 0, // user read all 5 in the meantime — self-suppressed, nothing unread to nudge
    dequeuedZeroRead: 0, // read count is 0 (shouldn't happen once enqueued) — dropped, nothing to name
    skippedTerminal: 0, // sender returned a terminal skip (already sent, suppressed, excluded, ...)
    expired: 0,         // candidate aged past EXPIRE_AFTER_MS with no send
    stillWaiting: 0     // inside the delay floor, or a transient skip left for a later scan
  };

  for (var i = 0; i < operationNames.length && result.scanned < MAX; i++) {
    var operationName = operationNames[i];
    result.scanned++;

    var record = await queueStore.getPending(event, operationName);
    if (!record) continue; // already dequeued by a concurrent/earlier run

    // 1) RE-CHECK READ COUNT — the live trigger is 1-4 of 5.
    var readSet = await interpReadStore.listPersonasRead(event, operationName);
    var readCount = readSet.length;

    if (readCount >= 5) {
      // Read all 5 — they finished, nothing is "unread" to nudge toward.
      await queueStore.removePending(event, operationName);
      result.dequeuedAllRead++;
      continue;
    }
    if (readCount === 0) {
      // Shouldn't happen (a read wrote the marker that enqueued this), but if a
      // marker vanished there's no read persona to name — drop it.
      await queueStore.removePending(event, operationName);
      result.dequeuedZeroRead++;
      continue;
    }

    var elapsedMs = Date.now() - (record.firstReadAt || 0);

    // 2) TOO SOON — still inside the ~next-day delay floor.
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

    var unreadKey = firstUnreadPersona(readSet);
    if (!unreadKey) {
      // Defensive — a 1-4 count always has an unread persona. If somehow not,
      // there's nothing to name; drop it rather than loop.
      await queueStore.removePending(event, operationName);
      result.dequeuedAllRead++;
      continue;
    }

    var sendResult = await unreadSender.sendIfEligible(event, {
      operationName: operationName,
      username: record.username,
      email: record.email,
      dream: dream,
      readPersonaKey: readSet[0],
      unreadPersonaKey: unreadKey,
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
    console.log('send-interp-unread-nudges: scanned ' + result.scanned
      + ', sent ' + result.sent
      + ', pushSent ' + result.pushSent
      + ', dequeuedAllRead ' + result.dequeuedAllRead
      + ', dequeuedZeroRead ' + result.dequeuedZeroRead
      + ', skippedTerminal ' + result.skippedTerminal
      + ', expired ' + result.expired
      + ', stillWaiting ' + result.stillWaiting);
  } catch (e) {
    // Best-effort, same "never surface as a hard failure" discipline as every
    // other scheduled job here — a failed scan just means this run's batch
    // doesn't progress; the next run tries again, and no record is lost
    // (nothing is destructive except a dequeue alongside a completed decision).
    console.error('send-interp-unread-nudges: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing.
exports.scanAndSend = scanAndSend;
exports.firstUnreadPersona = firstUnreadPersona;
exports.delayMs = delayMs;
exports.expireAfterMs = expireAfterMs;
exports.maxPerRun = maxPerRun;
