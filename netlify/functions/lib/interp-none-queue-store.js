// netlify/functions/lib/interp-none-queue-store.js
//
// The PENDING QUEUE behind the AUTOMATIC "No meaning yet" interpretation
// retention email (founder-approved 2026-08-12: "add the no interpretation
// email to also be automatically sent like not watched video"). One record
// per operationName: { operationName, username, email, watchedAt }.
//
// This is the exact "store + scheduled scan" shape lib/unwatched-dream-nudge-
// store.js established for the "unwatched dream" nudge, reused here for the
// symmetric "watched but read no meaning yet" trigger:
//   - mark-result-viewed.js ENQUEUES a candidate the moment a signed-up user
//     actually WATCHES their dream (the WATCH is the enqueue trigger — the
//     same server-side viewed marker lib/result-view-store.js records).
//   - send-interp-none-nudges.js's scheduled scan drains it ~10 min later:
//     if the user has STILL read zero interpretations it sends via
//     lib/interp-none-email-sender.js's sendIfEligible (which owns the real
//     exclusion / suppression / once-per-dream CAS + Resend send + push); if
//     they've since read one it self-suppresses (dequeue, no send); a very old
//     candidate expires (dequeue).
//
// DELIBERATELY NO once-per-dream SEND GUARD HERE (unlike lib/unwatched-dream-
// nudge-store.js, which owns both halves): the "No meaning yet" email's once-
// per-dream guard ALREADY EXISTS — lib/interp-email-store.js's
// "dreamtube-interp-none-sent" store (markNoneSentOnce / hasSentNone), claimed
// by lib/interp-none-email-sender.js's own send choke point. That SAME marker
// is the one the MANUAL batch (send-interp-emails-batch.js) also claims, so the
// manual batch and this scheduler share one guard: whichever fires first for a
// given dream wins the CAS, and the other's send is a safe no-op skip
// (already_sent). This store therefore only needs the pending-queue half.
//
// WHY blobs10 (CAS) for the enqueue: an idempotent enqueue — a repeated
// mark-result-viewed for the SAME operationName (two taps of "watch", the same
// tap racing across tabs) must NOT reset watchedAt and push the ~10-minute
// clock forward. The FIRST enqueue wins outright (onlyIfNew) and every later
// duplicate is a harmless no-op against the same already-ticking watchedAt.
// Same reasoning lib/unwatched-dream-nudge-store.js's markPending documents.

var { getStore, connectLambda } = require('blobs10');

var PENDING_STORE_NAME = 'dreamtube-interp-none-pending';

function pendingStore() {
  return getStore({ name: PENDING_STORE_NAME });
}

/**
 * Enqueues `operationName` as a pending "No meaning yet" candidate, unless
 * it's already enqueued. IDEMPOTENT via blobs10's onlyIfNew CAS — the FIRST
 * enqueue wins and every later duplicate call (a re-watch of the same dream)
 * is a harmless no-op against the SAME already-ticking `watchedAt`, never
 * resetting the ~10-minute clock. Fails CLOSED (never assumes an unverified
 * write landed). Returns { ok:true } first time, { ok:true, alreadyPending:true }
 * on a duplicate, or { ok:false, error } on invalid input / a failed write.
 */
async function markPending(event, operationName, username, email) {
  if (!operationName || !username || !email) return { ok: false, error: 'invalid_input' };
  var record = { operationName: operationName, username: username, email: email, watchedAt: Date.now() };
  var result;
  try {
    connectLambda(event);
    result = await pendingStore().setJSON(operationName, record, { onlyIfNew: true });
  } catch (e) {
    console.error('interp-none-queue-store: pending CAS write threw -- refusing to assume it enqueued', e);
    return { ok: false, error: 'exhausted' };
  }
  if (result && result.modified === true) return { ok: true };
  if (result && result.modified === false) return { ok: true, alreadyPending: true };
  console.error('interp-none-queue-store: pending CAS write returned an unexpected shape: ' + JSON.stringify(result));
  return { ok: false, error: 'exhausted' };
}

/** Every currently-pending operationName — enumerated by the scan on each run. A whole-store list() (this queue only ever holds records still inside their short window, so it stays naturally small). */
async function listPendingOperationNames(event) {
  connectLambda(event);
  var listResult = await pendingStore().list();
  return listResult.blobs.map(function (b) { return b.key; });
}

/** One pending record by operationName, or null if not (or no longer) enqueued. */
async function getPending(event, operationName) {
  if (!operationName) return null;
  connectLambda(event);
  return (await pendingStore().get(operationName, { type: 'json' })) || null;
}

/**
 * Removes a pending record — called by the scan the moment it decides (sent,
 * self-suppressed because read, or expired), so it's never re-checked. Best-
 * effort, never throws — a failed removal is a harmless self-correcting
 * leftover (a future scan re-checks it, and the shared once-per-dream guard in
 * lib/interp-email-store.js makes a repeat send a safe no-op).
 */
async function removePending(event, operationName) {
  if (!operationName) return { ok: false };
  try {
    connectLambda(event);
    await pendingStore().delete(operationName);
    return { ok: true };
  } catch (e) {
    console.error('interp-none-queue-store: failed to remove a pending record -- a future scan will just re-check it', e);
    return { ok: false };
  }
}

module.exports = {
  PENDING_STORE_NAME,
  markPending, listPendingOperationNames, getPending, removePending
};
