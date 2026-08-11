// netlify/functions/lib/interp-email-store.js
//
// The two ONCE-PER-DREAM send guards behind the interpretation retention
// emails (founder-approved retention plan; see send-interp-emails-batch.js's
// header comment for the full feature):
//
//   1. "dreamtube-interp-unread-sent"  — the flagship "Unread meanings"
//      email's guard, one record per operationName.
//   2. "dreamtube-interp-none-sent"    — the "No meaning yet" email's guard,
//      one record per operationName.
//
// Each is keyed PER DREAM (operationName), not per ACCOUNT — a user can be
// nudged about interpretations on more than one of their dreams over time,
// so "have we sent THIS email for THIS dream" is the right question (exactly
// the same per-dream scoping lib/unwatched-dream-nudge-store.js's
// markNudgedOnce uses, and the founder's own "re-fires per dream — the self-
// suppression is per-dream, not per-user" instruction for the flagship
// email). Two separate stores so a dream that legitimately qualifies for one
// email at one time and (later, in a different read-state) the other is
// guarded independently — though in practice a single dream can only ever
// match one trigger, since "read 1-4 of 5" and "read 0 of 5" are mutually
// exclusive.
//
// Uses the `blobs10` compare-and-swap primitive (`setJSON(key, value,
// { onlyIfNew: true })`) — the same atomic once-ever claim lib/unwatched-
// dream-nudge-store.js's markNudgedOnce and lib/push-dedup-store.js's
// markSentOnce use, for the same reason: a real conditional write settles
// "exactly one send per dream" with no read/verify race window, and fails
// CLOSED (refuse to send rather than risk a duplicate) on any write that
// rejects rather than resolving with a real `modified` boolean.

var { getStore, connectLambda } = require('blobs10');
var crypto = require('crypto');

var UNREAD_STORE_NAME = 'dreamtube-interp-unread-sent';
var NONE_STORE_NAME = 'dreamtube-interp-none-sent';

function storeFor(name) {
  return getStore({ name: name });
}

/**
 * Atomically records this dream's email (of `storeName`'s kind) as sent, but
 * only if it hasn't been already. Returns { ok:true, claimId } the first
 * time, { ok:false, alreadySent:true } every time after, or { ok:false,
 * error } on a genuine transport/server failure (fails CLOSED). Callers MUST
 * check `ok` BEFORE sending.
 */
async function markSentOnce(event, storeName, operationName) {
  if (!operationName) return { ok: false, error: 'invalid_operation_name' };
  var claimId = crypto.randomUUID();
  var record = { operationName: operationName, sentAt: Date.now(), claimId: claimId };
  var result;
  try {
    connectLambda(event);
    result = await storeFor(storeName).setJSON(operationName, record, { onlyIfNew: true });
  } catch (e) {
    console.error('interp-email-store: sent-guard CAS write threw for ' + storeName + ' -- refusing to send rather than risk a double-send', e);
    return { ok: false, error: 'exhausted' };
  }
  if (result && result.modified === true) return { ok: true, claimId: claimId };
  if (result && result.modified === false) return { ok: false, alreadySent: true };
  console.error('interp-email-store: sent-guard CAS write for ' + storeName + ' returned an unexpected shape: ' + JSON.stringify(result));
  return { ok: false, error: 'exhausted' };
}

/**
 * Releases a claim markSentOnce just won, for a caller whose actual send
 * then failed — without this a Resend rejection/network failure would
 * permanently burn this dream's one-and-only email for that kind. Only
 * deletes the record if it still matches `claimId` (can only ever undo the
 * caller's OWN just-won claim). Best-effort, never throws.
 */
async function releaseFailed(event, storeName, operationName, claimId) {
  if (!operationName || !claimId) return { ok: false };
  try {
    connectLambda(event);
    var current = await storeFor(storeName).get(operationName, { type: 'json' });
    if (!current || current.claimId !== claimId) return { ok: false };
    connectLambda(event);
    await storeFor(storeName).delete(operationName);
    return { ok: true };
  } catch (e) {
    console.error('interp-email-store: failed to release a failed-send claim for ' + storeName + ' -- this dream\'s marker stays burned until manually reset', e);
    return { ok: false };
  }
}

/**
 * Exact counts of dreams already emailed, of each kind — one blob per
 * dream in each sent-store, so a whole-store `list()` length IS the count.
 * Cheap (two list() calls, no per-account scan), and the SOURCE OF TRUTH for
 * "did any real interp email go out" (used by the batch endpoint's countOnly/
 * dryRun diagnostic). Never throws — a failed list degrades to a `null` count
 * for that kind so a caller can tell "0 sent" from "couldn't read".
 */
async function countSent(event) {
  var out = { unread: null, none: null };
  try {
    connectLambda(event);
    out.unread = ((await storeFor(UNREAD_STORE_NAME).list()).blobs || []).length;
  } catch (e) {
    console.error('interp-email-store: countSent list failed for ' + UNREAD_STORE_NAME, e);
  }
  try {
    connectLambda(event);
    out.none = ((await storeFor(NONE_STORE_NAME).list()).blobs || []).length;
  } catch (e) {
    console.error('interp-email-store: countSent list failed for ' + NONE_STORE_NAME, e);
  }
  return out;
}

/** True if this dream's email (of `storeName`'s kind) has already been sent — the cheap selection-pass check (the real guarantee is markSentOnce's CAS at the send choke point). */
async function hasSent(event, storeName, operationName) {
  if (!operationName) return false;
  try {
    connectLambda(event);
    return !!(await storeFor(storeName).get(operationName, { type: 'json' }));
  } catch (e) {
    console.error('interp-email-store: hasSent read failed for ' + storeName + ' -- treating as not-sent', e);
    return false;
  }
}

// Thin per-store wrappers so callers read as their own email's guard.
module.exports = {
  UNREAD_STORE_NAME,
  NONE_STORE_NAME,
  markSentOnce,
  releaseFailed,
  hasSent,
  countSent,

  markUnreadSentOnce: function (event, operationName) { return markSentOnce(event, UNREAD_STORE_NAME, operationName); },
  releaseUnread: function (event, operationName, claimId) { return releaseFailed(event, UNREAD_STORE_NAME, operationName, claimId); },
  hasSentUnread: function (event, operationName) { return hasSent(event, UNREAD_STORE_NAME, operationName); },

  markNoneSentOnce: function (event, operationName) { return markSentOnce(event, NONE_STORE_NAME, operationName); },
  releaseNone: function (event, operationName, claimId) { return releaseFailed(event, NONE_STORE_NAME, operationName, claimId); },
  hasSentNone: function (event, operationName) { return hasSent(event, NONE_STORE_NAME, operationName); }
};
