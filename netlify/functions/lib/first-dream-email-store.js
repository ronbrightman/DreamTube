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
 * When every retry attempt's verify-read fails to confirm OUR OWN write
 * (blobs-retry.js's bounded loop exhausted), this makes ONE final
 * confirming read before deciding — see the FINAL CONFIRMING READ comment
 * in the body for the full reasoning and the in-codebase precedent
 * (entitlements.js's claimDailyTokens does the identical thing on the
 * identical branch). That read resolves to `{ ok:true }` only if the store
 * is showing OUR own per-attempt-random claimId; to `{ ok:false,
 * alreadySent:true }` if a different, legitimate claim is what actually
 * landed; and otherwise this still fails CLOSED: `{ ok:false,
 * error:'exhausted' }`, treated by every caller exactly like `alreadySent`
 * (skip the send) — never treated as "safe to send anyway." A real account
 * very rarely, honestly missing this one email is an acceptable outcome; a
 * duplicate send to a real inbox is not.
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

  // ── IS THIS SKIP OUR OWN WRITE? (tracker.html's
  //    for-product-bug-founder-affects-all-funn-0efe7t item, round 5) ──
  //
  // blobs-retry returns `skipped` whenever an attempt's fresh read showed an
  // existing record, because `mutate` above answers "something is already
  // there, nothing to write." That existing record has TWO possible origins,
  // and this used to collapse both into alreadySent:
  //   (a) a genuinely separate, earlier claim for this account -- that caller
  //       is the one sending, so this call correctly must not; or
  //   (b) THIS SAME CALL's own write from an earlier attempt in this very
  //       loop. Attempt 1's write can land for real while attempt 1's own
  //       verify-read races it and comes back empty (Blobs is only eventually
  //       consistent -- see blobs-retry.js's header comment); the loop then
  //       retries, and attempt 2's fresh read is the one that finally catches
  //       up -- seeing OUR record, and skipping on it.
  // In case (b) nobody has claimed anything but us, so reporting alreadySent
  // is exactly wrong twice over: sendIfEligible treats any !ok as "don't
  // send," so the account's one-time-ever retention email is skipped, AND the
  // once-ever marker stays burned behind it (releaseFailedSend is only ever
  // called by a caller that believes it WON), so it can never be retried. It
  // is also invisible in a log review, being indistinguishable from an
  // ordinary, correct duplicate-send prevention.
  //
  // This is the identical hazard the exhaustion branch below already guards
  // via its final confirming read, just reachable one step earlier, and the
  // identical guard lib/entitlements.js's claimDailyTokens already applies on
  // its OWN skip branch ("if (result.current.lastClaimAttemptId === attemptId)
  // return claimed:true"), for the identical reason, in a path where getting
  // it wrong costs real tokens. This function is the same shape and only ever
  // got half of it.
  //
  // Still fails CLOSED in every ambiguous case: `claimId` is truthy ONLY if
  // this call's own `mutate` actually ran and built a record to write, so a
  // call that skipped on its very first read (never minting a claimId) can
  // never match -- which is what keeps a legacy, pre-claimId record shape
  // (`current.claimId` undefined) from reading as `undefined === undefined`
  // and wrongly reporting a win against someone else's already-sent email.
  if (result.skipped) {
    if (claimId && result.current && result.current.claimId === claimId) {
      console.error('first-dream-email-store: retry loop skipped for ' + key
        + ', but the record it skipped on carries OUR OWN claim -- treating the claim as won'
        + ' (blobs-retry trace: ' + JSON.stringify(result.attempts || []) + ')');
      return { ok: true, claimId: claimId };
    }
    return { ok: false, alreadySent: true };
  }

  // ── FINAL CONFIRMING READ (tracker.html's
  //    for-product-bug-founder-affects-all-funn-0efe7t item, round 4) ──
  //
  // Exhaustion above means no attempt's verify-read ever came back showing
  // OUR claimId. That covers two genuinely different situations, and the old
  // code collapsed both into 'exhausted':
  //   (a) our write never landed, or a concurrent racer's write is the one
  //       that did -- correctly "we did not claim this";
  //   (b) our write DID land and simply hadn't propagated to any of the
  //       loop's verify-reads yet. Netlify's own documented guarantee for
  //       Blobs is that a write reaches all edge locations "within 60
  //       seconds"; this loop's entire wall-clock budget is (maxAttempts-1)
  //       x retryDelayMs, i.e. ~400ms at the shared defaults -- 0.7% of that
  //       window. A read that hasn't caught up inside 400ms is an ordinary
  //       outcome, not an exotic one.
  // In case (b) the marker is genuinely, durably ours; treating it as
  // 'exhausted' both skips an email the account should have received AND
  // leaves the once-ever marker burned with no send behind it, since
  // releaseFailedSend is only ever called by a caller that believes it WON
  // the claim. That is the worst of both outcomes.
  //
  // So: one more read, after one more propagation delay, asking the only
  // question that actually matters -- is the record now visible, and is the
  // claimId on it OURS. This is not a new invention or a loosening of the
  // guarantee: lib/entitlements.js's claimDailyTokens already does exactly
  // this on exactly this branch ("var finalRead = await getEntitlement(...);
  // if (finalRead.lastClaimAttemptId === attemptId) return claimed:true"),
  // for exactly this reason, in a path where getting it wrong costs real
  // tokens. This function is the same shape and simply never got it.
  //
  // Still fails CLOSED in every ambiguous case, so the "never double-send"
  // guarantee is untouched -- ok:true here requires the store to be showing
  // OUR OWN freshly-minted, per-attempt-random claimId. A concurrent racer
  // that won instead has necessarily overwritten it with its own, which
  // reads as alreadySent (correct: that racer is sending, we must not).
  // Nothing visible at all stays 'exhausted' (correct: no evidence we hold
  // the claim, so refuse).
  try {
    if (blobsRetry.DEFAULT_RETRY_DELAY_MS > 0) {
      await new Promise(function (resolve) { setTimeout(resolve, blobsRetry.DEFAULT_RETRY_DELAY_MS); });
    }
    connectLambda(event);
    var finalRead = await store().get(key, { type: 'json' });
    if (finalRead && claimId && finalRead.claimId === claimId) {
      console.error('first-dream-email-store: retry loop exhausted for ' + key
        + ', but a final confirming read shows OUR OWN claim landed -- treating the claim as won'
        + ' (blobs-retry trace: ' + JSON.stringify(result.attempts || []) + ')');
      return { ok: true, claimId: claimId };
    }
    if (finalRead) {
      // Someone else's legitimate claim is what's actually stored -- they
      // are the ones sending, so this call must not.
      return { ok: false, alreadySent: true };
    }
  } catch (e) {
    // A failed confirming read tells us nothing -- fall through to the
    // fail-closed outcome below, same best-effort posture as every other
    // read in this feature.
    console.error('first-dream-email-store: final confirming read failed for ' + key, e);
  }

  // Genuine exhaustion, not the legitimate `skipped` case -- see this
  // function's own doc comment on why this fails closed rather than
  // guessing it's safe to send. The blobs-retry trace (per-attempt elapsed
  // ms + what each read/verify-read actually saw) is what makes this
  // diagnosable at all -- see lib/blobs-retry.js's own
  // "PER-ATTEMPT DIAGNOSTICS" comment.
  console.error('first-dream-email-store: exhausted attempts claiming the send-once marker for ' + key
    + ' -- refusing to send rather than risk a double-send'
    + ' (blobs-retry trace: ' + JSON.stringify(result.attempts || []) + ')');
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
