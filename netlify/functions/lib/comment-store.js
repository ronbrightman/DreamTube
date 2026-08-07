// netlify/functions/lib/comment-store.js
//
// Backing store for get-comments.js/add-comment.js/delete-comment.js —
// Social Layer v2 slice 2 ("comments" — docs/SOCIAL_LAYER_V2_DESIGN.md,
// tracker item for-product-build-social-layer-v2-direct-34047c). Not a
// Netlify Function itself — a plain module those three require(), matching
// this codebase's existing "self-contained function, shared bits in a
// plain require()" pattern (see lib/moderation-store.js, lib/profile-store.js).
//
// Backed by a single Netlify Blobs store ("dreamtube-comments"), ONE RECORD
// PER DREAM ID: the value at key `dreamId` is the full array of that
// dream's comments, `[{ id, handle, text, createdAt }, ...]`, oldest-first
// (append order) — callers that want newest-first (the comment sheet's own
// display order, per the design doc's own "flat list newest first" state
// E) reverse it themselves, same "storage order vs. display order are
// independent, caller's job" split this codebase already uses for the
// shared feed (get-feed.js stores/returns newest-first at publish time by
// unshifting; this store is simpler and stores in raw append order instead,
// since a per-dream comment list is far smaller and never needs a feed-scale
// windowed/paginated read).
//
// GOES THROUGH lib/blobs-retry.js's bounded retry, same shape as
// lib/moderation-store.js's appendReport — see that file's own
// CONCURRENT-WRITE RACE comment for the full writeup (read-full-array ->
// mutate -> setJSON-the-full-array-back, no compare-and-swap primitive in
// the installed @netlify/blobs 8.2.0, mitigated not eliminated). Same
// "check alreadyPresent by id before concatenating" idempotency discipline
// as moderation-store.js's appendReport, for the identical reason: a retry
// triggered by our OWN verify-read's false negative (eventual consistency)
// must not double-append the same comment once it does propagate.
//
// FAIL-OPEN on retry exhaustion for BOTH addComment and deleteComment, same
// posture as moderation-store.js's appendReport / profile-store.js's
// upsertProfile: every attempt writes before verifying, so even an
// exhausted loop has very likely actually persisted something — a comment
// or a delete is low-stakes UGC, not a money/dedup path.

var { getStore, connectLambda } = require('@netlify/blobs');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-comments';
var MAX_WRITE_ATTEMPTS = 3;

function store() {
  return getStore({ name: STORE_NAME });
}

/** Returns dreamId's full comment array (append order), empty if none exist yet. `event` is the calling function's Lambda event, passed through to connectLambda so this works from any Netlify Function. */
async function getComments(event, dreamId) {
  connectLambda(event);
  var comments = await store().get(dreamId, { type: 'json' });
  return comments || [];
}

/**
 * Appends one new comment to dreamId's list. `entry` must already be a
 * complete, validated record ({ id, handle, text, createdAt }) — shape/
 * validation is the caller's job (add-comment.js). Returns the entry as
 * stored. See this file's own header comment for the idempotency/retry
 * shape.
 */
async function addComment(event, dreamId, entry) {
  await blobsRetry.retryingWrite(event, STORE_NAME, dreamId, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: function (evt) { return getComments(evt, dreamId); },
    mutate: function (current) {
      var alreadyPresent = current.some(function (c) { return c.id === entry.id; });
      return alreadyPresent ? current : current.concat([entry]);
    },
    verify: function (verifyRead) {
      return (verifyRead || []).some(function (c) { return c.id === entry.id; });
    }
  });
  return entry;
}

/**
 * Removes commentId from dreamId's list, if present. A no-op (not an
 * error) if it's already gone — same "removing something already absent
 * is a success, not a failure" posture a retry of our own just-completed
 * delete needs (the SAME false-negative-verify-read reasoning as addComment
 * above: `mutate` filtering an array that already lacks commentId is
 * naturally idempotent, no special-case needed the way a numeric counter
 * increment would). Returns the list as stored (post-removal).
 */
async function deleteComment(event, dreamId, commentId) {
  var result = await blobsRetry.retryingWrite(event, STORE_NAME, dreamId, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: function (evt) { return getComments(evt, dreamId); },
    mutate: function (current) {
      return current.filter(function (c) { return c.id !== commentId; });
    },
    verify: function (verifyRead) {
      return !(verifyRead || []).some(function (c) { return c.id === commentId; });
    }
  });
  return result.value || [];
}

module.exports = { STORE_NAME, getComments, addComment, deleteComment };
