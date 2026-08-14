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
// The "store + scheduled scan" shape send-daily-claim-pushes.js first
// established in this codebase, using the `blobs10` compare-and-swap
// primitive (`setJSON(key, value, { onlyIfNew: true })`) for both the
// idempotent enqueue and the once-ever claim. This guard is keyed PER DREAM
// (operationName), not per ACCOUNT — a user can be nudged about more than one
// unwatched dream over time, so "have we nudged THIS dream" is the right
// question. (This nudge is now the single "your dream is ready to watch"
// email a signed-up user gets — the separate once-ever-per-account first-dream
// email was retired on 2026-08-11 per the founder's decision.)
//
// WHY blobs10 (CAS), not @netlify/blobs: both an idempotent enqueue (a
// retried mark-generation-completed call for the same operationName must
// not reset triggeredAt and push the 7-minute clock forward) and a race-
// safe once-per-dream claim (two overlapping scans must never both send)
// need a real conditional write — a plain read-mutate-write-verify loop
// under Blobs' default eventual consistency isn't sufficient for this class
// of guarantee (see lib/push-dedup-store.js, the codebase's other blobs10 CAS
// store, for the fuller reasoning).

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
 * 7-minute clock. Fails CLOSED (never assumes an unverified write landed).
 * Returns { ok:true } first time, { ok:true, alreadyPending:true } on a
 * duplicate, or { ok:false, error } on invalid input / a genuinely failed
 * write.
 *
 * `options.recovery` (optional) stamps `recoveryEnqueue: true` on the record —
 * set only by the SERVER-SIDE (dream-webhook.js) enqueue, which fires when the
 * CLIENT never marked the completion at all (an FB/IG-webview leaver → the
 * recovery-email path). send-unwatched-dream-nudges.js reads it to apply a
 * SHORTER pre-send delay for those records (fire the recovery email promptly)
 * while keeping the standard delay for ordinary client-enqueued nudges. Because
 * this is an onlyIfNew CAS keyed by operationName, whichever caller enqueues
 * FIRST sets the flag: a webview leaver's ONLY enqueue is the server one (so
 * it's flagged recovery), while an active user who fires the client enqueue
 * first keeps the standard delay — exactly the intended split. Absent (the
 * default / every existing caller) reads as "standard delay," fully backward
 * compatible with existing records.
 */
async function markPending(event, operationName, username, email, options) {
  if (!operationName || !username || !email) return { ok: false, error: 'invalid_input' };
  var record = { operationName: operationName, username: username, email: email, triggeredAt: Date.now() };
  if (options && options.recovery) record.recoveryEnqueue = true;
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
 * Removes a pending record — called by the scan the moment it decides
 * (sent, suppressed, or dropped), so it's never re-checked. Best-effort,
 * never throws — a failed removal is a harmless self-correcting leftover
 * (a future scan re-checks it, and markNudgedOnce's guard makes a repeat
 * send a safe no-op).
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
 * BEFORE sending. A `blobs10` onlyIfNew CAS + fail-closed contract: a single
 * conditional write settles the question with no read/verify race window.
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
 * the caller's OWN just-won claim). Best-effort, never throws.
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
