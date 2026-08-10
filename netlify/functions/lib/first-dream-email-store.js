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
// ── CAS REWRITE (tracker.html's for-product-spike-conditional-write-only-
//    rnurgw item) ──
//
// PRODUCTION TELEMETRY going into this: `first_dream_email_sent` has been
// zero, all-time, in production. Every real attempt was dying right here,
// at the old markSentOnce's dedup-marker guard, before Resend was ever
// reached (16 "exhausted" skips out of 20 attempts since the last fix
// round). Root cause, confirmed by reading both SDK versions' own source
// (see lib/blobs-retry.js's header comment, section "WHAT WAS RE-CHECKED
// 2026-07-30"): the installed @netlify/blobs 8.2.0 has NO compare-and-swap
// primitive at all — every store in this codebase could only read-then-
// write under Blobs' default EVENTUAL consistency, and `consistency:
// 'strong'` throws unconditionally on this deploy path (connectLambda
// never populates `uncachedEdgeURL`). This file's old bounded read ->
// mutate -> write -> verify retry loop (lib/blobs-retry.js) was a
// best-effort mitigation of that gap, never a fix for it — a verify-read
// could still lag behind its own write for up to Netlify's documented 60s
// worst-case propagation window, against a ~400ms total retry budget, and
// this file's entire multi-round history (rounds 1-5, see git log for the
// pre-CAS version if that history is ever needed) was different ways of
// coping with exactly that mismatch.
//
// @netlify/blobs 10.x adds a genuine compare-and-swap primitive this file
// never had: `store.setJSON(key, value, { onlyIfNew: true })`, implemented
// server-side via `if-none-match`, resolving with `{ modified: boolean,
// etag? }` — `modified: true` means OUR write atomically created the key
// (nobody else had it), `modified: false` means the key already existed
// and our write was atomically rejected. NO read/verify race window at
// all, and no "was this skip actually our own just-landed write racing its
// own verify-read" ambiguity to disambiguate anymore (the entire subject of
// this file's old round-5 section) — a single conditional write has
// exactly two well-defined outcomes.
//
// Installed as a SEPARATE aliased package (`blobs10`, see package.json —
// `npm install blobs10@npm:@netlify/blobs@^10.7.11`), deliberately NOT a
// bump of the shared `@netlify/blobs` 8.2.0 dependency every other store in
// this codebase still uses (including lib/entitlements.js's money-adjacent
// dedup markers, which this spike explicitly does not touch) — see this
// file's own tracker item for the full scoping rationale. Only this file
// and lib/push-dedup-store.js import `blobs10`; lib/blobs-retry.js and
// every other Blobs-backed store are UNCHANGED and still on 8.2.0.
//
// FAIL-CLOSED, same philosophy as lib/entitlements.js's own dedup markers
// (creditTokenPackOnce/refundTokensOnce) even though this file doesn't
// touch that one: a conditional `setJSON` resolving normally always yields
// a real boolean `modified` per the SDK's own implementation (true = we
// won, false = someone already claimed it) — the only way to land anywhere
// else is the promise REJECTING (a genuine transport/server error, not the
// expected precondition-rejection signal, which resolves normally). That
// is treated as "cannot verify the guard" and fails closed: refuse to
// send, log it, return `{ ok:false, error:'exhausted' }`. Never silently
// swallowed into a false "safe to send".
//
// HONESTY NOTE: this is a SPIKE. Verified here: unit tests (see
// test/first-dream-email-store.test.js) against test/helpers/mock-blobs.js's
// in-memory fake of BOTH the `blobs10` and `@netlify/blobs` module names,
// including the new `onlyIfNew`/`modified` CAS semantics and error
// injection for the fail-closed path. NOT verified: real behavior against a
// real Netlify Blobs backend in production — there is no real
// Netlify/Blobs environment or RESEND key in this sandbox. Whether this
// actually fixes the zero-sends-in-production bug is confirmed only once
// this ships and real generation-completion traffic exercises it.

var { getStore, connectLambda } = require('blobs10');
var crypto = require('crypto');

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
 * Returns the full { username, dreamId, sentAt, claimId } record for this
 * account's first-dream email, or null if none has ever been sent. Added so
 * the "unwatched dream" retention nudge (send-unwatched-dream-nudges.js) can
 * check whether the first-dream email ALREADY covered a SPECIFIC dream (by
 * comparing `dreamId`) and suppress its own send for that exact dream —
 * both are "your dream is ready, come watch it" emails, so they must never
 * both fire for the same person/dream. A thin read wrapper over the same
 * per-normalized-username record hasSent already checks; unchanged behavior
 * for every existing caller (none used it before). Returns null (never
 * throws) for an empty/invalid username, matching this store's other reads.
 */
async function getSentRecord(event, username) {
  var key = normalizeUsername(username);
  if (!key) return null;
  connectLambda(event);
  return (await store().get(key, { type: 'json' })) || null;
}

/**
 * Atomically records this account's first-dream email as sent, but only
 * if it hasn't been already. Returns { ok:true } the first time for a
 * given username, { ok:false, alreadySent:true } every time after
 * (including a second call for a different dreamId — this flag is per-
 * ACCOUNT, not per-dream, same as markFirstVideoCreatedIfEligible's own
 * scope). Callers MUST check `ok` BEFORE sending, not after, so a losing
 * racer never sends a duplicate.
 *
 * Uses `blobs10`'s real compare-and-swap write (`setJSON(key, value,
 * { onlyIfNew: true })`) — see this file's header comment for the full
 * "why", but in short: the write either atomically creates the record
 * (`modified: true`, we won, safe to send) or atomically no-ops because the
 * key already existed (`modified: false`, someone else already claimed it,
 * we must not send). There is no read/verify race window and no retry loop
 * — a single conditional write settles the question completely. Any
 * unexpected outcome (the write REJECTING rather than resolving with a
 * `modified` boolean) fails CLOSED: refuse to send rather than guess.
 */
async function markSentOnce(event, username, dreamId) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'invalid_username' };

  var claimId = crypto.randomUUID();
  var record = { username: key, dreamId: dreamId || null, sentAt: Date.now(), claimId: claimId };

  var result;
  try {
    connectLambda(event);
    result = await store().setJSON(key, record, { onlyIfNew: true });
  } catch (e) {
    // Not the expected "key already exists" CAS-rejection signal (that
    // resolves normally with modified:false -- it never throws). A genuine
    // transport/server error means we cannot verify whether we hold the
    // claim. Fail CLOSED: refuse to send rather than risk a double-send.
    console.error('first-dream-email-store: CAS write threw for a first-dream-email claim -- refusing to send rather than risk a double-send', e);
    return { ok: false, error: 'exhausted' };
  }

  if (result && result.modified === true) {
    return { ok: true, claimId: claimId };
  }

  if (result && result.modified === false) {
    // The key already existed -- some earlier call (this account's actual,
    // legitimate first-dream email) already won this claim. Atomically
    // rejected by the store itself, nothing ambiguous left to re-verify.
    return { ok: false, alreadySent: true };
  }

  // The write resolved without throwing but didn't come back with a real
  // `modified` boolean -- not a shape this SDK's own implementation should
  // ever produce (see this file's header comment), but fail CLOSED rather
  // than assume either outcome.
  console.error('first-dream-email-store: CAS write for a first-dream-email claim returned an unexpected shape -- refusing to send rather than risk a double-send: ' + JSON.stringify(result));
  return { ok: false, error: 'exhausted' };
}

/**
 * Releases a claim markSentOnce just won, for a caller whose actual send
 * then failed (tracker.html's for-product-bug-founder-affects-all-funn-
 * 0efe7t item, gap #6) -- without this, a Resend rejection/network failure
 * would permanently burn the one-time-ever marker for a real account that
 * never actually got an email, with no way to ever retry. Only deletes the
 * record if it still matches `claimId` (the same fresh id markSentOnce's
 * own CAS write generated for THIS caller's winning write) -- i.e. this can
 * only ever undo the caller's own just-won claim, never a different,
 * legitimate send that happens to race in afterward (which, under CAS,
 * could never have won a SECOND `onlyIfNew` write against an already-
 * existing key in the first place — the guard below is kept anyway as
 * defense-in-depth, e.g. against a manual/legacy record).
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

module.exports = { STORE_NAME, normalizeUsername, hasSent, getSentRecord, markSentOnce, releaseFailedSend };
