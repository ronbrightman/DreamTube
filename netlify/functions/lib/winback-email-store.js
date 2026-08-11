// netlify/functions/lib/winback-email-store.js
//
// The once-EVER-per-account "we already sent this account its win-back
// email" claim, for the owner-gated win-back batch sender
// (send-winback-batch.js + lib/winback-email-sender.js). This is the real
// "no user can ever receive the win-back twice, even across repeated batch
// runs" guarantee.
//
// Same `blobs10` compare-and-swap (`setJSON(key, value, { onlyIfNew:true })`)
// primitive lib/push-dedup-store.js and lib/unwatched-dream-nudge-store.js
// already use in this codebase for a race-safe one-time claim — see
// lib/push-dedup-store.js's header comment for the full "why blobs10 CAS,
// not @netlify/blobs 8.x's non-conditional writes" writeup, which applies
// here identically. Short version: the installed base `@netlify/blobs`
// exposes no conditional-write primitive (account-store.js's own header
// comment documents this directly), so a plain read-then-write claim can't
// close the eventual-consistency race two overlapping batch runs would
// open; the `blobs10`-aliased 10.x SDK's `onlyIfNew` CAS closes it with a
// single atomic conditional write that resolves `{ modified:boolean }`.
//
// The task that commissioned this described the marker as "a per-account
// 'winback-sent' marker claimed BEFORE send via @netlify/blobs onlyIfNew
// CAS" — "@netlify/blobs onlyIfNew" there means exactly this 10.x /
// `blobs10` conditional-write API, the same one this codebase's other two
// CAS stores already import.
//
// SCOPED PER ACCOUNT (keyed by normalized username), unlike the unwatched-
// dream nudge's PER-DREAM guard: the win-back is a one-time "come back"
// message to a lapsed PERSON, sent at most once ever regardless of how many
// dreams they made, so "have we ever win-back'd THIS account" is the right
// question — the same once-ever-per-account scope lib/first-dream-email-
// store.js used for the (now-retired) first-dream email.
//
// FAILS CLOSED (refuses to claim) on any write that REJECTS rather than
// resolving with a real `modified` boolean — a rare skipped win-back is an
// honest, low-stakes degrade; a DUPLICATE win-back to a real lapsed user is
// the one outcome worth refusing to guess about. releaseFailedWinback lets
// the sender undo its OWN just-won claim when the actual Resend send then
// fails, so a transient send failure never permanently burns an account's
// one-and-only win-back marker (same release pattern the nudge store uses).
//
// Backed by a single Netlify Blobs store ("dreamtube-winback-sent"), one
// record per account: { username, sentAt, claimId }.

var { getStore, connectLambda } = require('blobs10');
var crypto = require('crypto');

var STORE_NAME = 'dreamtube-winback-sent';

/** Trim + lowercase, matching account-store.js's own username normalization so a claim keys identically to how the account is stored/enumerated. */
function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

function store() {
  return getStore({ name: STORE_NAME });
}

/** True if this account has already been marked win-back-sent. A read, no claim — used by send-winback-batch.js's SELECTION pass to skip already-sent accounts before ever spending a slot on them (the real one-time guarantee is markSentOnce's CAS below, not this read). Missing/blank username fails closed (treated as "already sent" so nothing sends against it). */
async function hasSentWinback(event, username) {
  var key = normalizeUsername(username);
  if (!key) return true;
  connectLambda(event);
  return !!(await store().get(key, { type: 'json' }));
}

/**
 * Atomically records this account's win-back as sent, but only if it hasn't
 * been already. Keyed PER ACCOUNT (normalized username). Returns
 * { ok:true, claimId } the FIRST time for a given account, { ok:false,
 * alreadySent:true } every time after (some earlier claim won), or
 * { ok:false, error } on invalid input / a genuine transport-server failure
 * (fails CLOSED — refuse to send rather than risk a double win-back).
 * Callers MUST check `ok` BEFORE sending, and treat both `alreadySent` and
 * `error` identically (skip the send). A single `blobs10` onlyIfNew CAS
 * settles the question with no read/verify race window.
 */
async function markSentOnce(event, username) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'invalid_username' };

  var claimId = crypto.randomUUID();
  var record = { username: key, sentAt: Date.now(), claimId: claimId };

  var result;
  try {
    connectLambda(event);
    result = await store().setJSON(key, record, { onlyIfNew: true });
  } catch (e) {
    console.error('winback-email-store: CAS write threw for a win-back claim -- refusing to send rather than risk a duplicate win-back', e);
    return { ok: false, error: 'exhausted' };
  }

  if (result && result.modified === true) return { ok: true, claimId: claimId };
  if (result && result.modified === false) return { ok: false, alreadySent: true };

  console.error('winback-email-store: CAS write for a win-back claim returned an unexpected shape -- refusing to send: ' + JSON.stringify(result));
  return { ok: false, error: 'exhausted' };
}

/**
 * Releases a claim markSentOnce just won, for a caller whose actual send
 * then failed — without this a Resend rejection/network failure would
 * permanently burn this account's one-and-only win-back with no way to
 * retry on a later batch run. Only deletes the record if it still matches
 * `claimId` (can only ever undo the caller's OWN just-won claim). Best-
 * effort, never throws.
 */
async function releaseFailedWinback(event, username, claimId) {
  var key = normalizeUsername(username);
  if (!key || !claimId) return { ok: false };
  try {
    connectLambda(event);
    var current = await store().get(key, { type: 'json' });
    if (!current || current.claimId !== claimId) return { ok: false };
    connectLambda(event);
    await store().delete(key);
    return { ok: true };
  } catch (e) {
    console.error('winback-email-store: failed to release a failed win-back claim -- this account\'s marker stays burned until manually reset', e);
    return { ok: false };
  }
}

module.exports = { STORE_NAME, normalizeUsername, hasSentWinback, markSentOnce, releaseFailedWinback };
