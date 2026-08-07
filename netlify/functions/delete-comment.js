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

    await commentStore.deleteComment(event, dreamId, commentId);
    var newCount = await feedCommentCount.adjustCommentCount(event, dreamId, -1);
    return { statusCode: 200, body: JSON.stringify({ ok: true, commentCount: newCount }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'delete_comment_failed: ' + (e && e.message) }) };
  }
};
