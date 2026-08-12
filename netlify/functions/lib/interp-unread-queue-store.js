// netlify/functions/lib/interp-unread-queue-store.js
//
// The PENDING QUEUE behind the AUTOMATIC flagship "Unread meanings"
// interpretation retention email (founder-approved 2026-08-12: auto-send the
// interpretation emails "like not watched video"). One record per
// operationName: { operationName, username, email, firstReadAt }.
//
// This is the exact "store + scheduled scan" shape lib/interp-none-queue-
// store.js established for the "No meaning yet" trigger, reused here for the
// symmetric "read SOME but not all" trigger:
//   - interpret-dream.js ENQUEUES a candidate the moment a signed-up user
//     actually READS their FIRST interpretation on a dream (a successful
//     mode:"reading" — the same event that writes lib/interp-read-store.js's
//     per-persona read marker). The FIRST read is the enqueue trigger; the
//     onlyIfNew CAS below makes every later read of the SAME dream a harmless
//     no-op that never resets the ~next-day clock.
//   - send-interp-unread-nudges.js's scheduled scan drains it ~next day:
//     if the user has read 1-4 of the 5 interpretations by then it sends via
//     lib/interp-unread-email-sender.js's sendIfEligible (which owns the real
//     exclusion / suppression / once-per-dream CAS + Resend send + push); if
//     they've since read ALL 5 it self-suppresses (dequeue, no send — they
//     finished); a candidate that somehow shows 0 reads is dropped (dequeue);
//     a very old candidate expires (dequeue).
//
// DELIBERATELY NO once-per-dream SEND GUARD HERE (same split as lib/interp-
// none-queue-store.js): the "Unread meanings" email's once-per-dream guard
// ALREADY EXISTS — lib/interp-email-store.js's "dreamtube-interp-unread-sent"
// store (markUnreadSentOnce / hasSentUnread), claimed by lib/interp-unread-
// email-sender.js's own send choke point. That SAME marker is the one the
// MANUAL batch (send-interp-emails-batch.js) also claims, so the manual batch
// and this scheduler share ONE guard: whichever fires first for a given dream
// wins the CAS, and the other's send is a safe no-op skip (already_sent). This
// store therefore only needs the pending-queue half.
//
// WHY blobs10 (CAS) for the enqueue: an idempotent enqueue — a repeated read
// of a persona on the SAME operationName (opening a second, third, ... reading
// on the same dream) must NOT reset firstReadAt and push the ~next-day clock
// forward. The FIRST enqueue wins outright (onlyIfNew) and every later
// duplicate is a harmless no-op against the same already-ticking firstReadAt.
// Same reasoning lib/interp-none-queue-store.js's markPending documents.

var { getStore, connectLambda } = require('blobs10');

var PENDING_STORE_NAME = 'dreamtube-interp-unread-pending';

function pendingStore() {
  return getStore({ name: PENDING_STORE_NAME });
}

/**
 * Enqueues `operationName` as a pending "Unread meanings" candidate, unless
 * it's already enqueued. IDEMPOTENT via blobs10's onlyIfNew CAS — the FIRST
 * enqueue wins and every later duplicate call (another reading opened on the
 * same dream) is a harmless no-op against the SAME already-ticking
 * `firstReadAt`, never resetting the ~next-day clock. Fails CLOSED (never
 * assumes an unverified write landed). Returns { ok:true } first time,
 * { ok:true, alreadyPending:true } on a duplicate, or { ok:false, error } on
 * invalid input / a failed write.
 */
async function markPending(event, operationName, username, email) {
  if (!operationName || !username || !email) return { ok: false, error: 'invalid_input' };
  var record = { operationName: operationName, username: username, email: email, firstReadAt: Date.now() };
  var result;
  try {
    connectLambda(event);
    result = await pendingStore().setJSON(operationName, record, { onlyIfNew: true });
  } catch (e) {
    console.error('interp-unread-queue-store: pending CAS write threw -- refusing to assume it enqueued', e);
    return { ok: false, error: 'exhausted' };
  }
  if (result && result.modified === true) return { ok: true };
  if (result && result.modified === false) return { ok: true, alreadyPending: true };
  console.error('interp-unread-queue-store: pending CAS write returned an unexpected shape: ' + JSON.stringify(result));
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
 * self-suppressed because read-all/read-none, or expired), so it's never
 * re-checked. Best-effort, never throws — a failed removal is a harmless self-
 * correcting leftover (a future scan re-checks it, and the shared once-per-
 * dream guard in lib/interp-email-store.js makes a repeat send a safe no-op).
 */
async function removePending(event, operationName) {
  if (!operationName) return { ok: false };
  try {
    connectLambda(event);
    await pendingStore().delete(operationName);
    return { ok: true };
  } catch (e) {
    console.error('interp-unread-queue-store: failed to remove a pending record -- a future scan will just re-check it', e);
    return { ok: false };
  }
}

module.exports = {
  PENDING_STORE_NAME,
  markPending, listPendingOperationNames, getPending, removePending
};
