// netlify/functions/lib/feed-comment-count.js
//
// Denormalizes a comment COUNT onto the shared feed record for a dream —
// Social Layer v2 slice 2 ("comments" — docs/SOCIAL_LAYER_V2_DESIGN.md,
// tracker item for-product-build-social-layer-v2-direct-34047c), per that
// doc's own Data/API section: "Denormalize commentCount onto the feed
// record (same accepted RMW race as likes — document identically)."
//
// This mirrors like-dream.js's own STALE-READ CLOBBER FIX almost verbatim
// — see that file's header comment for the full "why" (no compare-and-swap
// primitive in the installed @netlify/blobs 8.2.0, eventual-not-strong
// consistency, a plain +1/-1 counter has no natural idempotency against a
// retry re-deriving "current + delta" from a fresh read that already shows
// our own just-landed write) — with the field/marker names swapped for
// comments: `commentCount` instead of `likes`, `_lastCommentCountOp`
// instead of `_lastLikeOp`. Factored into its own module (rather than
// copy-pasted into add-comment.js/delete-comment.js the way like-dream.js
// inlines its own version) because BOTH those files need the identical
// logic, just with delta +1 vs -1 — one shared implementation, not two
// near-copies drifting apart later.
//
// FAIL-OPEN on retry exhaustion, same posture/reasoning as like-dream.js:
// a comment count is a low-stakes social-engagement counter, not a
// payment/entitlement marker — an exhausted retry still returns the last
// attempt's locally-computed value rather than failing the caller's whole
// request over it.
//
// NOT-FOUND -> null (not an error): if dreamId isn't in the feed at all
// (unpublished/deleted between publish and comment, or — same client-trust
// posture report-dream.js already accepts for its own dreamId — a stale/
// forged id), this returns null rather than throwing. Callers (add-comment.js/
// delete-comment.js) must treat that as "skip the denormalized count
// update, the comment write itself already succeeded independently" —
// comment-store.js is the source of truth for actual comment content; this
// module is a read-optimization only, never load-bearing for correctness.
//
// KNOWN, ACCEPTED LEAK (tracker item minor-like-dream-js-internal-dedup-
// marke-8qztvq, low severity, not urgent, checked in the tracker BEFORE
// writing this file): `_lastCommentCountOp` is internal bookkeeping stamped
// straight onto the shared feed-index record, and get-feed.js/get-profile.js
// both return that record with no field whitelist, so this marker leaks
// into every public feed/profile API response exactly the way that tracker
// item already documents `_lastLikeOp` (like-dream.js) doing today. NOT a
// new problem introduced here — the same accepted, pre-existing class,
// joining the existing item rather than needing a second one. A
// strip-before-serialize whitelist on get-feed.js/get-profile.js would fix
// both markers at once; out of scope for this build (see that tracker
// item's own "not urgent" call).

var { connectLambda, getStore } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-feed';
var KEY = 'feed-index';

/**
 * Adjusts dreamId's commentCount by delta (+1 or -1, floored at 0).
 * Returns the new count, or null if dreamId isn't found in the feed — see
 * this file's own NOT-FOUND header comment for why that's not an error.
 */
async function adjustCommentCount(event, dreamId, delta) {
  // Fresh per REQUEST (not per retry attempt) — see like-dream.js's own
  // identical-purpose opId comment for why this is what makes `mutate`
  // idempotent against a false-negative-triggered retry of its OWN write.
  var opId = crypto.randomBytes(8).toString('hex');
  var computedCount;

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, KEY, {
    read: function (evt) {
      connectLambda(evt);
      return getStore(STORE_NAME).get(KEY, { type: 'json' }).then(function (v) { return v || []; });
    },
    mutate: function (current) {
      var items = current || [];
      var idx = items.findIndex(function (d) { return d.id === dreamId; });
      if (idx === -1) return blobsRetry.SKIP; // dream not found -- see this file's own NOT-FOUND header comment

      var dream = items[idx];
      if (dream._lastCommentCountOp === opId) {
        // This exact request's delta was already applied by an earlier
        // attempt (a false-negative verify, not a real clobber) -- do NOT
        // add the delta again. See like-dream.js's identical comment.
        computedCount = dream.commentCount || 0;
        return items;
      }

      computedCount = Math.max(0, (dream.commentCount || 0) + delta);
      var next = items.slice();
      next[idx] = Object.assign({}, dream, { commentCount: computedCount, _lastCommentCountOp: opId });
      return next;
    },
    verify: function (verifyItems) {
      var found = (verifyItems || []).filter(function (d) { return d.id === dreamId; })[0];
      // Checks OWNERSHIP (this exact request's opId marker), not just that
      // the numeric value happens to match -- see like-dream.js's identical
      // comment for why (two genuinely concurrent +1s from the same base
      // land on the same target number; only the opId marker tells apart
      // "my write" from "a coincidentally-matching concurrent write").
      return !!found && found._lastCommentCountOp === opId;
    }
  });

  if (result.skipped) return null;

  // Fails open on exhaustion -- see this file's own header comment.
  var finalFeed = result.value;
  var finalIdx = finalFeed.findIndex(function (d) { return d.id === dreamId; });
  return finalIdx !== -1 ? finalFeed[finalIdx].commentCount : null;
}

module.exports = { adjustCommentCount };
