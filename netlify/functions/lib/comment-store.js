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
// dream's comments, `[{ id, handle, text, parentId, createdAt }, ...]`,
// oldest-first (append order) — callers that want newest-first (the
// comment sheet's own display order, per the design doc's own "flat list
// newest first" state E) reverse it themselves, same "storage order vs.
// display order are independent, caller's job" split this codebase already
// uses for the shared feed (get-feed.js stores/returns newest-first at
// publish time by unshifting; this store is simpler and stores in raw
// append order instead, since a per-dream comment list is far smaller and
// never needs a feed-scale windowed/paginated read).
//
// THREADING (one level deep, tracker item
// for-product-founder-go-08-07-add-threadi-zb3j26 — reply-to-comment on top
// of the flat comments this file originally shipped): `parentId` is an
// ADDITIVE field, null for a top-level comment, the parent comment's own id
// for a reply — same "opaque passthrough, no schema rewrite" precedent
// lib/moderation-store.js's own `targetType` addition set (see that file's
// own header comment). This store itself needed NO structural change for
// it — `entry` was already treated as an opaque, pre-validated record built
// entirely by the caller (add-comment.js), so a wider entry shape (one more
// field) passes through addComment unchanged. Every comment written before
// this shipped simply has no `parentId` key at all, read as null/falsy by
// every consumer, not a placeholder value. FLAT STORAGE, NOT NESTED: the
// array stays one flat list regardless of parentId — get-comments.js
// returns it as-is (flat + parentId, not a nested tree) and js/comment-sheet.js
// groups client-side; see that function's own header comment for why flat
// was chosen over restructuring the response shape. One-level-deep is
// enforced by the CALLER (add-comment.js rejects parentId pointing at a
// comment that is itself a reply) — this store has no opinion on nesting
// depth, it just stores whatever entry it's handed.
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
// FAIL-OPEN on retry exhaustion for addComment/deleteComment/deleteComments,
// same posture as moderation-store.js's appendReport / profile-store.js's
// upsertProfile: every attempt writes before verifying, so even an
// exhausted loop has very likely actually persisted something — a comment
// or a delete is low-stakes UGC, not a money/dedup path.
//
// CASCADE DELETE (deleteComments, plural): deleting a TOP-LEVEL comment
// also deletes its replies, in one write — see delete-comment.js's own
// header comment for the full "why" (this codebase has no existing
// "[deleted] placeholder that preserves replies" concept for anything, and
// introducing one for this single feature would be new, unproven UI/data
// surface for a one-level-deep MVP; full removal is simplest and matches
// this store's own pre-existing single-delete semantics exactly, just
// applied to more than one id in the same write). deleteComment (singular)
// is unchanged and still used directly wherever only one specific id needs
// removing (a lone reply, or — internally — a single top-level comment with
// no replies); it's now a thin wrapper around deleteComments so the two
// never drift.

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
 * Removes every id in commentIds from dreamId's list, if present, in ONE
 * write — see this file's own CASCADE DELETE header comment for why
 * delete-comment.js hands this a multi-id list (a top-level comment plus
 * whichever replies it cascades to) rather than calling a single-id delete
 * once per id (which would mean multiple separate read-mutate-write races
 * for what is logically one delete operation). A no-op (not an error) for
 * any id already gone — same "removing something already absent is a
 * success, not a failure" posture the original single-id deleteComment
 * established (the SAME false-negative-verify-read reasoning as addComment
 * above: `mutate` filtering an array that already lacks these ids is
 * naturally idempotent, no special-case needed the way a numeric counter
 * increment would). Returns the list as stored (post-removal).
 */
async function deleteComments(event, dreamId, commentIds) {
  var idSet = {};
  (commentIds || []).forEach(function (id) { idSet[id] = true; });
  var result = await blobsRetry.retryingWrite(event, STORE_NAME, dreamId, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: function (evt) { return getComments(evt, dreamId); },
    mutate: function (current) {
      return current.filter(function (c) { return !idSet[c.id]; });
    },
    verify: function (verifyRead) {
      return !(verifyRead || []).some(function (c) { return idSet[c.id]; });
    }
  });
  return result.value || [];
}

/** Removes a single commentId — thin wrapper around deleteComments, see this file's own CASCADE DELETE header comment for why the plural version exists. */
async function deleteComment(event, dreamId, commentId) {
  return deleteComments(event, dreamId, [commentId]);
}

module.exports = { STORE_NAME, getComments, addComment, deleteComment, deleteComments };
