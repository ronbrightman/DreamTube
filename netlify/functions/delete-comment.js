// netlify/functions/delete-comment.js
//
// POST { dreamId, commentId, authToken } -> { ok:true, commentCount } | { ok:false, error }
//
// Auth-gated delete half of Social Layer v2 slice 2 ("comments" —
// docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Same
// lib/account-auth-token.js verifyToken shape as add-comment.js/
// sync-profile.js — a bare client-supplied handle would let anyone forge a
// delete of someone else's comment.
//
// CASCADE DELETE ON REPLIES (tracker item
// for-product-founder-go-08-07-add-threadi-zb3j26 — one-level threading on
// top of slice 2's flat comments): deleting a TOP-LEVEL comment (its own
// parentId is null/absent) also deletes every reply whose parentId points
// at it, in the SAME store write (commentStore.deleteComments, plural — see
// that function's own header comment). Deleting a REPLY deletes only that
// one row, same as before threading existed. Chosen over a Reddit-style
// "[deleted]" placeholder that preserves the replies: this codebase has no
// existing soft-delete/placeholder concept for ANY content (comments,
// dreams, reports) — every existing delete in this app is a real removal —
// and introducing one here would be new, unproven UI/data surface for a
// one-level-deep MVP feature. Full cascade removal is the simplest option
// that's consistent with this endpoint's own pre-existing single-delete
// semantics, just applied to more than one id when the target has replies.
// PERMISSION is still evaluated against the TARGET comment only (commenter-
// or-dream-owner, unchanged) — a cascade of the target's own replies
// proceeds regardless of who wrote each individual reply, the same way
// deleting a dream already removes every comment/report attached to it
// without re-checking permission per attached item.
//
// KNOWN NARROW RACE (accepted, not eliminated — same posture as this
// codebase's other documented read-modify-write races): idsToDelete is
// computed from ONE snapshot read of `comments` below, then handed to
// commentStore.deleteComments, which does its own fresh read internally. A
// reply landing in that window survives the cascade (not in idsToDelete)
// but is left pointing at a parentId that will never render again, and its
// earlier +1 to commentCount is never offset. Unlike this file's other RMW
// races this doesn't self-heal on retry; narrow enough (needs a reply to
// land in the same instant its parent is being deleted) that a full fix —
// recomputing the cascade set from deleteComments' own fresh read — is
// deferred rather than blocking this PR.
//
// commentCount SEMANTICS: the denormalized feed counter counts the WHOLE
// comment tree (top-level + replies), not just top-level rows — see
// add-comment.js's own +1-per-post (fires identically for a reply) and this
// file's own delta below, which is -(however many rows this delete actually
// removed: 1 for a lone comment/reply, or 1+repliesRemoved for a cascading
// top-level delete). Chosen because the sheet's own visible "Comments · N"
// count (js/comment-sheet.js) is total rows rendered, replies included —
// a badge that undercounts what you actually see after opening the sheet
// would be the confusing outcome, not this one.
//
// PERMISSION (design doc's own Data/API line): allowed if
// commenter === caller OR dream owner === caller — i.e. you can always
// delete your own comment, and a dream's own author can additionally
// moderate comments left on their own dream. Both checks are
// case-insensitive handle comparisons (same normalization every other
// handle comparison in this codebase uses — see get-profile.js's stripAt/
// lowercase, sync-profile.js's owner-mismatch check).
//
// dream-owner lookup reads the shared feed directly (same store
// like-dream.js/get-profile.js already read) — if the dream isn't found
// there (unpublished/deleted since), only the comment-owner permission
// path is possible; that's a correct, not a degraded, outcome (there's no
// "dream owner" to defer to for a dream that no longer exists on the feed).
//
// Denormalizes commentCount onto the shared feed record via
// lib/feed-comment-count.js's adjustCommentCount — see that module's own
// header comment for the accepted read-modify-write race and its
// NOT-FOUND -> null, best-effort posture (same as add-comment.js's
// identical use of it).
//
// Error codes (local to this function, same small-number-scheme reasoning
// as sync-profile.js/add-comment.js):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 dream_id_required
//   E4 comment_id_required
//   E5 auth_token_required
//   E6 invalid_or_expired_token  — same "200, ok:false, business outcome"
//                                    shape sync-profile.js's own E5 uses
//   E7 comment_not_found         — 404, commentId isn't (or is no longer)
//                                    present in dreamId's comment list
//   E8 forbidden                 — 403, caller is neither the commenter
//                                    nor the dream's own owner

var { connectLambda, getStore } = require('@netlify/blobs');
var accountAuthToken = require('./lib/account-auth-token');
var commentStore = require('./lib/comment-store');
var feedCommentCount = require('./lib/feed-comment-count');

var FEED_STORE_NAME = 'dreamtube-feed';
var FEED_KEY = 'feed-index';

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

/** The ownerHandle of dreamId on the shared feed, or null if the dream isn't found there. */
async function findDreamOwnerHandle(event, dreamId) {
  connectLambda(event);
  var feed = (await getStore(FEED_STORE_NAME).get(FEED_KEY, { type: 'json' })) || [];
  var dream = feed.filter(function (d) { return d && d.id === dreamId; })[0];
  return dream ? dream.ownerHandle : null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var dreamId = (typeof payload.dreamId === 'string' ? payload.dreamId : '').trim();
  if (!dreamId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: dream_id_required' }) };
  }

  var commentId = (typeof payload.commentId === 'string' ? payload.commentId : '').trim();
  if (!commentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: comment_id_required' }) };
  }

  var authToken = (payload.authToken || '').trim();
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: auth_token_required' }) };
  }

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E6: invalid_or_expired_token' }) };
  }

  try {
    connectLambda(event);
    var comments = await commentStore.getComments(event, dreamId);
    var target = comments.filter(function (c) { return c.id === commentId; })[0];
    if (!target) {
      return { statusCode: 404, body: JSON.stringify({ error: 'E7: comment_not_found' }) };
    }

    var callerUsername = auth.username; // already normalized lowercase, see account-auth-token.js
    var isCommenter = stripAt(target.handle).toLowerCase() === callerUsername;

    var isDreamOwner = false;
    if (!isCommenter) {
      var dreamOwnerHandle = await findDreamOwnerHandle(event, dreamId);
      isDreamOwner = !!dreamOwnerHandle && stripAt(dreamOwnerHandle).toLowerCase() === callerUsername;
    }

    if (!isCommenter && !isDreamOwner) {
      return { statusCode: 403, body: JSON.stringify({ error: 'E8: forbidden' }) };
    }

    // See this file's own CASCADE DELETE ON REPLIES header comment.
    var idsToDelete = [commentId];
    if (!target.parentId) {
      comments.forEach(function (c) { if (c.parentId === commentId) idsToDelete.push(c.id); });
    }

    await commentStore.deleteComments(event, dreamId, idsToDelete);
    var newCount = await feedCommentCount.adjustCommentCount(event, dreamId, -idsToDelete.length);
    return { statusCode: 200, body: JSON.stringify({ ok: true, commentCount: newCount }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'delete_comment_failed: ' + (e && e.message) }) };
  }
};
