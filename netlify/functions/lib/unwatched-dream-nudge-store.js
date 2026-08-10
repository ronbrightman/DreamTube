// netlify/functions/lib/unwatched-dream-nudge-store.js
//
// The two durable stores behind the "unwatched dream" retention nudge
// (founder-approved retention plan, piece 1 — see
// send-unwatched-dream-nudges.js's header comment for the full feature):
//
//   1. A PENDING QUEUE ("dreamtube-unwatched-nudge-pending"), one record
//      per operationName: { operationName, username, email, triggeredAt }.
//      mark-generation-completed.js enqueues here the moment a signed-up
//      user's video generation is independently re-verified complete;
//      send-unwatched-dream-nudges.js's scheduled scan drains it.
//
//   2. A ONCE-PER-DREAM SEND GUARD ("dreamtube-unwatched-nudge-sent"), one
//      record per operationName: { operationName, dreamId, sentAt, claimId }.
//      This is the real "exactly one nudge per dream, ever" guarantee.
//
// This mirrors, almost exactly, the pair the automatic FIRST-dream email
// already uses (lib/first-dream-email-pending-store.js +
// lib/first-dream-email-store.js) — same "store + scheduled scan" shape
// send-daily-claim-pushes.js first established in this codebase, same
// `blobs10` compare-and-swap primitive (`setJSON(key, value, { onlyIfNew:
// true })`) both of those use for their idempotent enqueue / once-ever
// claim. The ONE deliberate difference: this feature's guard is keyed PER
// DREAM (operationName), not per ACCOUNT — a user can be nudged about more
// than one unwatched dream over time, so "have we nudged THIS dream" is the
// right question, whereas the first-dream email is a genuinely once-ever-
// per-account send. See lib/first-dream-email-store.js's own header comment
// for the full "why CAS, why fail-closed" reasoning that applies verbatim
// to markNudgedOnce below.
//
// WHY blobs10 (CAS), not @netlify/blobs: both an idempotent enqueue (a
// retried mark-generation-completed call for the same operationName must
// not reset triggeredAt and push the 7-minute clock forward) and a race-
// safe once-per-dream claim (two overlapping scans must never both send)
// need a real conditional write, exactly as lib/first-dream-email-pending-
// store.js/lib/first-dream-email-store.js already established — see either
// file's own header comment for why the old read-mutate-write-verify loop
// wasn't sufficient for this class of guarantee.

var { getStore, connectLambda } = require('blobs10');
var crypto = require('crypto');

var PENDING_STORE_NAME = 'dreamtube-unwatched-nudge-pending';
var SENT_STORE_NAME = 'dreamtube-unwatched-nudge-sent';

function pendingStore() {
  return getStore({ name: PENDING_STORE_NAME });
}
function sentStore() {
  return getStore({ name: SENT_STORE_NAME });
}

// ── PENDING QUEUE ──────────────────────────────────────────────────────

/**
 * Enqueues `operationName` as a pending nudge, unless it's already
 * enqueued. IDEMPOTENT via `blobs10`'s onlyIfNew CAS — the FIRST enqueue
 * wins outright and every later duplicate call (a retried/duplicated
 * mark-generation-completed for the SAME operationName) is a harmless no-op
 * against the SAME already-ticking `triggeredAt`, never resetting the
 * 7-minute clock. Fails CLOSED (never assumes an unverified write landed),
 * same posture as lib/first-dream-email-pending-store.js's markPending.
 * Returns { ok:true } first time, { ok:true, alreadyPending:true } on a
 * duplicate, or { ok:false, error } on invalid input / a genuinely failed
 * write.
 */
async function markPending(event, operationName, username, email) {
  if (!operationName || !username || !email) return { ok: false, error: 'invalid_input' };
  var record = { operationName: operationName, username: username, email: email, triggeredAt: Date.now() };
  var result;
  try {
    connectLambda(event);
    result = await pendingStore().setJSON(operationName, record, { onlyIfNew: true });
  } catch (e) {
    console.error('unwatched-dream-nudge-store: pending CAS write threw -- refusing to assume it enqueued', e);
    return { ok: false, error: 'exhausted' };
  }
  if (result && result.modified === true) return { ok: true };
  if (result && result.modified === false) return { ok: true, alreadyPending: true };
  console.error('unwatched-dream-nudge-store: pending CAS write returned an unexpected shape: ' + JSON.stringify(result));
  return { ok: false, error: 'exhausted' };
}

/** Every currently-pending operationName — enumerated by the scan on each run. Same whole-store list() as lib/first-dream-email-pending-store.js's own (this queue only ever holds records still inside their short window, so it stays naturally small). */
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
 * Removes a pending record — called by the scan the moment it decides
 * (sent, suppressed, or dropped), so it's never re-checked. Best-effort,
 * never throws — a failed removal is a harmless self-correcting leftover
 * (a future scan re-checks it, and markNudgedOnce's guard makes a repeat
 * send a safe no-op), same reasoning as lib/first-dream-email-pending-
 * store.js's removePending.
 */
async function removePending(event, operationName) {
  if (!operationName) return { ok: false };
  try {
    connectLambda(event);
    await pendingStore().delete(operationName);
    return { ok: true };
  } catch (e) {
    console.error('unwatched-dream-nudge-store: failed to remove a pending record -- a future scan will just re-check it', e);
    return { ok: false };
  }
}

// ── ONCE-PER-DREAM SEND GUARD ──────────────────────────────────────────

/**
 * Atomically records this dream's nudge as sent, but only if it hasn't been
 * already. Keyed by `operationName` (per DREAM, not per account — see this
 * file's header comment). Returns { ok:true, claimId } the first time,
 * { ok:false, alreadyNudged:true } every time after, or
 * { ok:false, error } on a genuine transport/server failure (fails CLOSED:
 * refuse to send rather than risk a double-send). Callers MUST check `ok`
 * BEFORE sending. Same `blobs10` onlyIfNew CAS + fail-closed contract as
 * lib/first-dream-email-store.js's markSentOnce — see that file's header
 * comment for the full reasoning.
 */
async function markNudgedOnce(event, operationName, dreamId) {
  if (!operationName) return { ok: false, error: 'invalid_operation_name' };
  var claimId = crypto.randomUUID();
  var record = { operationName: operationName, dreamId: dreamId || null, sentAt: Date.now(), claimId: claimId };
  var result;
  try {
    connectLambda(event);
    result = await sentStore().setJSON(operationName, record, { onlyIfNew: true });
  } catch (e) {
    console.error('unwatched-dream-nudge-store: sent-guard CAS write threw -- refusing to send rather than risk a double-send', e);
    return { ok: false, error: 'exhausted' };
  }
  if (result && result.modified === true) return { ok: true, claimId: claimId };
  if (result && result.modified === false) return { ok: false, alreadyNudged: true };
  console.error('unwatched-dream-nudge-store: sent-guard CAS write returned an unexpected shape: ' + JSON.stringify(result));
  return { ok: false, error: 'exhausted' };
}

/**
 * Releases a claim markNudgedOnce just won, for a caller whose actual send
 * then failed — without this a Resend rejection/network failure would
 * permanently burn this dream's one-and-only nudge with no way to retry.
 * Only deletes the record if it still matches `claimId` (can only ever undo
 * the caller's OWN just-won claim). Best-effort, never throws. Same
 * contract/reasoning as lib/first-dream-email-store.js's releaseFailedSend.
 */
async function releaseFailedNudge(event, operationName, claimId) {
  if (!operationName || !claimId) return { ok: false };
  try {
    connectLambda(event);
    var current = await sentStore().get(operationName, { type: 'json' });
    if (!current || current.claimId !== claimId) return { ok: false };
    connectLambda(event);
    await sentStore().delete(operationName);
    return { ok: true };
  } catch (e) {
    console.error('unwatched-dream-nudge-store: failed to release a failed-nudge claim -- this dream\'s marker stays burned until manually reset', e);
    return { ok: false };
  }
}

module.exports = {
  PENDING_STORE_NAME, SENT_STORE_NAME,
  markPending, listPendingOperationNames, getPending, removePending,
  markNudgedOnce, releaseFailedNudge
};
