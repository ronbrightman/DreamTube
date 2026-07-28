// netlify/functions/lib/first-dream-email-store.js
//
// Durable, cross-device "has this account already gotten its first-dream
// retention email" flag — the server-side backstop for
// send-first-dream-email.js (tracker.html's
// for-product-retention-email-send-user-th-eke9ra item). Mirrors
// js/store.js's own `account.firstVideoCreatedFired` client-side flag in
// spirit (same "fire exactly once per account" goal, same accepted
// choke-point race — see that function's doc comment and
// docs/EVENT_TAXONOMY.md's FirstVideoCreated writeup for the full history
// of the cross-tab race this reuses, deliberately not re-litigated here),
// but lives server-side so it actually holds across devices/browsers, not
// just within one browser's localStorage — the same reason
// lib/account-store.js exists at all instead of relying purely on
// js/store.js's local copy.
//
// Backed by a single Netlify Blobs store ("dreamtube-first-dream-email"),
// ONE RECORD PER NORMALIZED USERNAME: { username, dreamId, sentAt, claimId }.
//
// ATOMICITY (tightened 2026-07-27 for tracker.html's
// for-product-activate-automatic-retention-4n74rw item — "founder has now
// EXPLICITLY approved turning this on to fire AUTOMATICALLY... be careful
// about the idempotency guarantee specifically, get that right"): this
// USED to be a plain existence-check-then-write, same accepted-race shape
// every other Blobs-backed store in this codebase started with (see
// lib/account-store.js's header comment's INCIDENT note for the full
// story of why a stricter-looking read-your-own-write check was tried and
// reverted THERE) — acceptable back when the only caller was a client-
// triggered request gated behind result.html's own one-time durable
// marker consumption (a narrow, browser-tab-scoped race). Now that
// mark-generation-completed.js also calls this directly, unconditionally,
// from the real server-verified generation-complete path — for every
// completed generation, not just a user-facing one-time page load — the
// race window is a normal, expected occurrence (e.g. two devices, or a
// regenerate racing a fresh generation, both completing within moments of
// each other for a brand-new account), not just a rare double-tab
// coincidence. A real duplicate SEND (not just a duplicate marker) is the
// one outcome that actually matters here, so this now uses
// lib/blobs-retry.js's bounded read -> mutate -> write -> verify loop
// (the same shared pattern lib/entitlements.js's refundTokensOnce/
// creditTokenPackOnce and lib/pending-dreams.js's tryTransition already
// use for their own single-key dedup markers) instead of the old bare
// get-then-setJSON: a fresh, per-attempt random claimId is written and
// then read back to confirm THIS call's own write is the one that
// actually landed, not a concurrent racer's. Fails CLOSED on exhaustion
// (see markSentOnce's own doc comment) — refusing to send is always the
// safe outcome for an email that must never fire twice; a rare skipped
// send just means this specific completion's retention email doesn't go
// out, an honest degrade in the same class as every other best-effort gap
// already documented throughout this feature.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-first-dream-email';

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

function store() {
  return getStore({ name: STORE_NAME });
}

/** True if this account's first-dream retention email has already been recorded as sent. */
async function hasSent(event, username) {
  var key = normalizeUsername(username);
  if (!key) return true; // no valid identity to key on -- treat as "already sent" so nothing sends against it
  connectLambda(event);
  return !!(await store().get(key, { type: 'json' }));
}

/**
 * Atomically records this account's first-dream email as sent, but only
 * if it hasn't been already. Returns { ok:true } the first time for a
 * given username, { ok:false, alreadySent:true } every time after
 * (including a second call for a different dreamId — this flag is per-
 * ACCOUNT, not per-dream, same as markFirstVideoCreatedIfEligible's own
 * scope). Callers MUST check `ok` BEFORE sending, not after, so a losing
 * racer never sends a duplicate — see header comment for why this is now
 * genuinely race-safe, not just "check then act."
 *
 * On the rare case every retry attempt's verify-read fails to confirm
 * OUR OWN write (blobs-retry.js's bounded loop exhausted — an eventually-
 * consistent read that never converged in time, or a true, unresolvable
 * clobber), this fails CLOSED: `{ ok:false, error:'exhausted' }`, treated
 * by every caller exactly like `alreadySent` (skip the send) — never
 * treated as "safe to send anyway." A real account very rarely, honestly
 * missing this one email is an acceptable outcome; a duplicate send to a
 * real inbox is not.
 */
async function markSentOnce(event, username, dreamId) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'invalid_username' };

  var claimId;
  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function (existing) {
      // A record already exists -- either a genuinely separate earlier
      // send for this account, or our OWN previous attempt in this same
      // loop whose write landed but whose verify-read lagged behind it
      // (see blobs-retry.js's header comment on why mutate must not
      // double-apply against its own prior attempt). Either way, there is
      // nothing new to write: SKIP.
      if (existing) return blobsRetry.SKIP;
      claimId = crypto.randomUUID();
      return { username: key, dreamId: dreamId || null, sentAt: Date.now(), claimId: claimId };
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.claimId === claimId);
    }
  });

  if (result.ok) return { ok: true, claimId: claimId };
  if (result.skipped) return { ok: false, alreadySent: true };

  // Genuine exhaustion, not the legitimate `skipped` case -- see this
  // function's own doc comment on why this fails closed rather than
  // guessing it's safe to send.
  console.error('first-dream-email-store: exhausted attempts claiming the send-once marker for ' + key + ' -- refusing to send rather than risk a double-send');
  return { ok: false, error: 'exhausted' };
}

/**
 * Releases a claim markSentOnce just won, for a caller whose actual send
 * then failed (tracker.html's for-product-bug-founder-affects-all-funn-
 * 0efe7t item, gap #6) -- without this, a Resend rejection/network failure
 * would permanently burn the one-time-ever marker for a real account that
 * never actually got an email, with no way to ever retry. Only deletes the
 * record if it still matches `claimId` (the same fresh id markSentOnce's
 * own mutate generated for THIS caller's winning write) -- i.e. this can
 * only ever undo the caller's own just-won claim, never a different,
 * legitimate send that happens to race in afterward (which would already
 * have overwritten `claimId` with its own).
 *
 * Best-effort, matching every other write in this feature: a failure to
 * release just means this specific account waits for its retention email
 * a little longer (until a human notices/retries), never a crash, and
 * never a double-send (the failed caller itself already knows it never
 * actually sent anything).
 */
async function releaseFailedSend(event, username, claimId) {
  var key = normalizeUsername(username);
  if (!key || !claimId) return { ok: false };
  try {
    connectLambda(event);
    var current = await store().get(key, { type: 'json' });
    if (!current || current.claimId !== claimId) {
      // Already overwritten by someone else's legitimate claim (or never
      // landed at all) -- nothing of OURS to undo.
      return { ok: false };
    }
    connectLambda(event);
    await store().delete(key);
    return { ok: true };
  } catch (e) {
    console.error('first-dream-email-store: failed to release a failed-send claim for ' + key + ' -- this account\'s marker stays burned until manually reset', e);
    return { ok: false };
  }
}

module.exports = { STORE_NAME, normalizeUsername, hasSent, markSentOnce, releaseFailedSend };
