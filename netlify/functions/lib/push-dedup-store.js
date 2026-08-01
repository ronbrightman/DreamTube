// netlify/functions/lib/push-dedup-store.js
//
// Generic "has this specific push notification event already been sent"
// guard — tracker item for-product-build-stage-0-pwa-web-push-f-jbutt5,
// part 4's own explicit ask: "be deliberate about... how do these two
// channels [push, email] coordinate" and (separately) never double-send
// the SAME push twice for the same real-world event.
//
// Deliberately its OWN dedup marker, separate from lib/first-dream-email-
// store.js's account-scoped "has this account ever gotten its first-dream
// email" flag — the two channels have genuinely different scopes, not
// just different storage:
//   - The retention EMAIL fires at most ONCE EVER per account (first
//     dream only) — first-dream-email-store.js's own existing marker.
//   - The video-ready PUSH is meant to fire for the SPECIFIC dream a user
//     is actively waiting on right now ("get notified when your dream is
//     ready" — every dream, not just their first) — so it needs a
//     per-EVENT marker (keyed by that generation's own operationName, see
//     mark-generation-completed.js's call site), not a per-account one.
// Reusing first-dream-email-store.js's own marker for both would either
// under-fire the push (skip it whenever the once-ever email marker is
// already burned, i.e. every dream after someone's first) or require
// bolting a second, differently-scoped meaning onto a store whose entire
// existing contract is "once ever" — this is a real, deliberate design
// decision, not an oversight; see mark-generation-completed.js's own
// comment for how the two channels are actually coordinated in practice
// (both may legitimately fire for the same completion — that's the
// intended "second, independent channel" behavior the tracker item asks
// for, not a bug to suppress).
//
// Backed by a single Netlify Blobs store ("dreamtube-push-dedup"), ONE
// RECORD PER CALLER-SUPPLIED KEY: { key, sentAt, claimId }. Callers build
// their own fully-qualified key (see e.g. mark-generation-completed.js's
// 'video-ready:' + operationName, or send-daily-claim-pushes.js's
// 'daily-claim-available:' + email + ':' + nextClaimAt) so this one store
// can back multiple, differently-scoped push types without them colliding
// — same "generic store, caller owns key semantics" shape as
// lib/rate-limit.js's own checkAndIncrement(scope, identifier, ...).
//
// ── CAS REWRITE (tracker.html's for-product-spike-conditional-write-only-
//    rnurgw item) ──
//
// Same root cause and same fix as lib/first-dream-email-store.js's own
// markSentOnce, which carries the fuller writeup — see that file's header
// comment. Short version: the installed @netlify/blobs 8.2.0 has no
// compare-and-swap primitive, so the old bounded read -> mutate -> write ->
// verify retry loop (lib/blobs-retry.js) could only mitigate, never close,
// the eventual-consistency race window; @netlify/blobs 10.x's
// `setJSON(key, value, { onlyIfNew: true })` closes it completely, resolving
// with `{ modified: boolean }` — true if THIS write atomically created the
// key, false if it already existed. No retry loop, no "was this skip
// actually our own just-landed write" ambiguity (this file's own old
// round-5 section) — an atomic conditional write is unambiguous by
// construction.
//
// Installed as the SEPARATE aliased `blobs10` package (see package.json),
// not a bump of the shared `@netlify/blobs` 8.2.0 dependency — only this
// file and lib/first-dream-email-store.js import `blobs10`.
//
// Fails CLOSED on any write that REJECTS rather than resolving with a real
// `modified` boolean (a genuine transport/server error, never the expected
// precondition-rejection signal) — same posture as
// lib/first-dream-email-store.js's own markSentOnce and for the same
// reason: a rare skipped push is an honest, low-stakes degrade; a
// duplicate push notification for the same event is the one outcome worth
// refusing to guess about.
//
// HONESTY NOTE: this is a SPIKE, same as lib/first-dream-email-store.js's
// own rewrite — verified against test/helpers/mock-blobs.js's in-memory
// fake (both module names, including the new CAS semantics and
// error-injection for the fail-closed path), NOT against a real Netlify
// Blobs backend. See that file's header comment for the fuller honesty
// note; it applies here identically.

var { getStore, connectLambda } = require('blobs10');
var crypto = require('crypto');

var STORE_NAME = 'dreamtube-push-dedup';

function store() {
  return getStore({ name: STORE_NAME });
}

// Caller-supplied keys can embed real PII (send-daily-claim-pushes.js's
// own key literally contains an email address — see the module comment
// above), and this store deliberately doesn't parse caller key structure
// to know which part that is, so NO log line in this file may touch a key
// at all — pinned by push-dedup-store.test.js.

/** True if `key` has already been recorded as sent. */
async function hasSent(event, key) {
  if (!key) return true; // no valid key to check -- treat as "already sent" so nothing sends against it, same fail-closed posture as first-dream-email-store.js's hasSent
  connectLambda(event);
  return !!(await store().get(key, { type: 'json' }));
}

/**
 * Atomically records `key` as sent, but only if it hasn't been already.
 * Returns { ok:true } the first time for a given key, { ok:false,
 * alreadySent:true } every time after, or { ok:false, error:'exhausted' }
 * if the underlying CAS write REJECTS rather than resolving with a real
 * `modified` boolean (see this file's header comment) — callers MUST
 * treat both `alreadySent` and `exhausted` identically (skip the send),
 * same discipline first-dream-email-store.js's own markSentOnce
 * documents.
 */
async function markSentOnce(event, key) {
  if (!key) return { ok: false, error: 'invalid_key' };

  var claimId = crypto.randomUUID();
  var record = { key: key, sentAt: Date.now(), claimId: claimId };

  var result;
  try {
    connectLambda(event);
    result = await store().setJSON(key, record, { onlyIfNew: true });
  } catch (e) {
    // Deliberately does NOT include `key` in the log -- see the module
    // comment above on why no log line here may touch a caller-supplied
    // key. Not the expected "key already exists" CAS-rejection signal
    // (that resolves normally with modified:false); a genuine
    // transport/server error means we cannot verify the guard. Fail
    // CLOSED: refuse to send rather than risk a duplicate push.
    console.error('push-dedup-store: CAS write threw for a push-dedup claim -- refusing to send rather than risk a duplicate push', e);
    return { ok: false, error: 'exhausted' };
  }

  if (result && result.modified === true) {
    return { ok: true, claimId: claimId };
  }

  if (result && result.modified === false) {
    // The key already existed -- some earlier call already won this claim,
    // atomically rejected by the store itself.
    return { ok: false, alreadySent: true };
  }

  // Resolved without throwing but didn't come back with a real `modified`
  // boolean -- not a shape this SDK's own implementation should ever
  // produce, but fail CLOSED rather than assume either outcome. No key in
  // the log, same rule as the catch branch above.
  console.error('push-dedup-store: CAS write for a push-dedup claim returned an unexpected shape -- refusing to send rather than risk a duplicate push: ' + JSON.stringify(result));
  return { ok: false, error: 'exhausted' };
}

module.exports = { STORE_NAME, hasSent, markSentOnce };
