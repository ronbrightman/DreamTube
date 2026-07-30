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
// ATOMICITY: uses lib/blobs-retry.js's shared bounded read -> mutate ->
// write -> verify loop, same as lib/first-dream-email-store.js's own
// markSentOnce — a genuine race is realistically reachable here too (e.g.
// mark-generation-completed.js being hit twice in quick succession for
// the same operationName, or two daily-claim scheduled runs overlapping).
// Fails CLOSED on exhaustion, exactly like first-dream-email-store.js's
// own markSentOnce and for the same reason: a rare skipped push is an
// honest, low-stakes degrade; a duplicate push notification for the same
// event is the one outcome worth spending a retry loop to prevent.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-push-dedup';

function store() {
  return getStore({ name: STORE_NAME });
}

// Caller-supplied keys can embed real PII (send-daily-claim-pushes.js's
// own key literally contains an email address — see the module comment
// above), and this store deliberately doesn't parse caller key structure
// to know which part that is, so any log line touching a key logs this
// hash instead of the raw value. Same "shape not content" reasoning as
// blobs-retry.js's own describeRead, which this store's exhaustion log
// used to leak around (a raw key, email included, in Netlify function
// logs on every exhaustion).
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

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
 * on the rare case every retry attempt's verify-read fails to confirm our
 * own write (see lib/blobs-retry.js's own header comment) — callers MUST
 * treat both `alreadySent` and `exhausted` identically (skip the send),
 * same discipline first-dream-email-store.js's own markSentOnce
 * documents.
 */
async function markSentOnce(event, key) {
  if (!key) return { ok: false, error: 'invalid_key' };

  var claimId;
  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function (existing) {
      if (existing) return blobsRetry.SKIP;
      claimId = crypto.randomUUID();
      return { key: key, sentAt: Date.now(), claimId: claimId };
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.claimId === claimId);
    }
  });

  if (result.ok) return { ok: true, claimId: claimId };

  // ── IS THIS SKIP OUR OWN WRITE? (tracker.html's
  //    for-product-bug-founder-affects-all-funn-0efe7t item, round 5) ──
  //
  // Same hazard, same guard, same reasoning as lib/first-dream-email-store.js's
  // own markSentOnce -- see that function's fuller comment on this branch, and
  // lib/entitlements.js's claimDailyTokens for the in-codebase precedent. In
  // short: blobs-retry reports `skipped` whenever an attempt's fresh read saw
  // an existing record, and that record may be THIS call's own write from an
  // earlier attempt whose verify-read raced it under Blobs' eventual
  // consistency. Reporting that as alreadySent suppresses a push that nobody
  // ever actually sent, and permanently -- the dedup marker stays written.
  //
  // Fails CLOSED in every ambiguous case: `claimId` is truthy only if this
  // call's own `mutate` actually built and wrote a record, so a call that
  // skipped on its very first read can never match, and a legacy record with
  // no claimId at all can never read as ours.
  if (result.skipped) {
    if (claimId && result.current && result.current.claimId === claimId) {
      console.error('push-dedup-store: retry loop skipped for key-hash ' + hashKey(key)
        + ', but the record it skipped on carries OUR OWN claim -- treating the claim as won');
      return { ok: true, claimId: claimId };
    }
    return { ok: false, alreadySent: true };
  }

  console.error('push-dedup-store: exhausted attempts claiming the send-once marker for key-hash ' + hashKey(key) + ' -- refusing to send rather than risk a duplicate push');
  return { ok: false, error: 'exhausted' };
}

module.exports = { STORE_NAME, hasSent, markSentOnce };
