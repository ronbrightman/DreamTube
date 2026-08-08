// netlify/functions/add-comment.js
//
// POST { dreamId, handle, authToken, text, parentId? } -> { ok:true, comment, commentCount } | { ok:false, error }
//
// Auth-gated write half of Social Layer v2 slice 2 ("comments" —
// docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Mirrors sync-profile.js's
// lib/account-auth-token.js verifyToken + reject-on-mismatch shape almost
// exactly (see that file's own header comment for the full "why") — a bare
// client-supplied handle would let anyone forge a comment as someone else,
// and comments are this app's FIRST hostile-UGC text surface (see
// js/comment-sheet.js's own esc()-on-render half of that mitigation), so
// trusting an unverified handle here is a real problem, not honest MVP
// scope.
//
// `handle` is still accepted from the client (rather than only ever
// trusting the token's own normalized username) for the identical reason
// sync-profile.js documents: verifyToken only ever hands back a lowercased
// username, and the real-cased handle (matching every dream's own
// ownerHandle / every OTHER comment's own handle on the shared feed) has
// no other server-side source. Rejected (E9), not silently corrected, on
// a case-insensitive mismatch against the verified token's username — same
// posture as sync-profile.js's own E6.
//
// Server-side validation, independent of whatever js/comment-sheet.js's own
// live counter already enforced client-side (never trust client-side-only
// validation): trimmed, non-empty, <=300 chars.
//
// Rate-limited per verified ACCOUNT via lib/rate-limit.js's checkAndIncrement
// (the same per-day-bucket mechanism report-dream.js already established)
// — per-account rather than report-dream.js's own per-IP scope, because this
// endpoint is never reachable without a verified identity by the time
// rate-limiting is even checked, so the account is the identifier that
// actually deters spam here (unlike report-dream.js, which stays anonymous-
// friendly and so has no account to key on).
//
// Denormalizes commentCount onto the shared feed record via
// lib/feed-comment-count.js's adjustCommentCount — see that module's own
// header comment for the accepted read-modify-write race (same as
// like-dream.js's likes counter) and its NOT-FOUND -> null, best-effort
// posture: if the dream isn't found in the feed, the comment itself is
// still stored (comment-store.js is the source of truth for actual
// content) and this function simply returns commentCount: null rather than
// failing the whole request over a denormalized read-optimization.
//
// THREADING, one level deep (tracker item
// for-product-founder-go-08-07-add-threadi-zb3j26 — reply-to-comment on top
// of slice 2's flat comments): `parentId` is optional. When present it must
// name a comment that (a) already exists on THIS SAME dreamId's own comment
// list, and (b) is itself top-level (its own parentId is null/absent) —
// both checked against a fresh read of comment-store.js's real current
// list, never trusted from the client. A reply-to-a-reply is REJECTED
// (E12), not silently flattened to the same top-level parent — rejecting is
// the simpler of the two options the tracker item explicitly left open, and
// js/comment-sheet.js's own client-side guard (no Reply action rendered on
// a reply row) means a real client should never even trigger E12 in
// practice; server enforcement exists purely against a hostile/non-standard
// client. A parentId naming a comment that exists but on a DIFFERENT dream
// is also rejected — E11 covers both "no such id at all" and "exists, just
// not on this dream", since the lookup is scoped to this dreamId's own list
// from the start (see comment-store.js's own per-dream-record storage
// shape) — there's no cross-dream id space to accidentally match into.
// Stored on the comment record as `parentId: <id>|null` — see
// lib/comment-store.js's own header comment for the additive-field
// precedent (lib/moderation-store.js's `targetType`) this follows.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as sync-profile.js):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 dream_id_required
//   E4 handle_required
//   E5 auth_token_required
//   E6 comment_required          — empty/whitespace-only after trim
//   E7 comment_too_long          — over MAX_COMMENT_CHARS (300) after trim
//   E8 invalid_or_expired_token  — same "200, ok:false, business outcome"
//                                    shape sync-profile.js's own E5 uses
//   E9 owner_mismatch            — the verified token's username doesn't
//                                    match the request's claimed handle
//   E10 rate_limited             — MAX_COMMENTS_PER_ACCOUNT_PER_DAY exceeded (429)
//   E11 parent_comment_not_found — parentId given but no such comment exists
//                                    on this dreamId's own comment list
//   E12 reply_to_reply_not_allowed — parentId names a comment that is
//                                    itself a reply (one-level-deep limit)

var { connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var accountAuthToken = require('./lib/account-auth-token');
var commentStore = require('./lib/comment-store');
var feedCommentCount = require('./lib/feed-comment-count');
var rateLimit = require('./lib/rate-limit');

var MAX_COMMENT_CHARS = 300;
var MAX_COMMENTS_PER_ACCOUNT_PER_DAY_DEFAULT = 50;

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
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

  var handle = (typeof payload.handle === 'string' ? payload.handle : '').trim();
  if (!handle) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: handle_required' }) };
  }

  var authToken = (payload.authToken || '').trim();
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: auth_token_required' }) };
  }

  var text = (typeof payload.text === 'string' ? payload.text : '').trim();
  if (!text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E6: comment_required' }) };
  }
  if (text.length > MAX_COMMENT_CHARS) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E7: comment_too_long' }) };
  }

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E8: invalid_or_expired_token' }) };
  }

  // See this file's own header comment for why the client's handle case is
  // trusted (once verified to belong to the right account) rather than
  // reconstructed from the token's normalized username.
  if (stripAt(handle).toLowerCase() !== auth.username.toLowerCase()) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E9: owner_mismatch' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_COMMENTS_PER_ACCOUNT_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = MAX_COMMENTS_PER_ACCOUNT_PER_DAY_DEFAULT;
  var limit = await rateLimit.checkAndIncrement(event, 'add-comment-account', auth.username, maxPerDay);
  if (!limit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E10: rate_limited' }) };
  }

  var parentId = (typeof payload.parentId === 'string' ? payload.parentId : '').trim() || null;

  try {
    connectLambda(event);

    // See this file's own THREADING header comment for the full "why" of
    // both checks below -- done here, right before persisting, so a request
    // that was always going to fail an earlier (cheaper) gate never pays
    // for this store read.
    if (parentId) {
      var existingComments = await commentStore.getComments(event, dreamId);
      var parent = existingComments.filter(function (c) { return c.id === parentId; })[0];
      if (!parent) {
        return { statusCode: 400, body: JSON.stringify({ error: 'E11: parent_comment_not_found' }) };
      }
      if (parent.parentId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'E12: reply_to_reply_not_allowed' }) };
      }
    }

    var comment = {
      id: crypto.randomBytes(8).toString('hex'),
      handle: handle,
      text: text,
      parentId: parentId,
      createdAt: new Date().toISOString()
    };

    await commentStore.addComment(event, dreamId, comment);
    var newCount = await feedCommentCount.adjustCommentCount(event, dreamId, 1);
    return { statusCode: 200, body: JSON.stringify({ ok: true, comment: comment, commentCount: newCount }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'add_comment_failed: ' + (e && e.message) }) };
  }
};
