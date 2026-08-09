// netlify/functions/follow-user.js
//
// POST { authToken, targetHandle, action? } -> { ok:true, following:bool } | { ok:false, error }
//
// Follow/unfollow toggle — Social Layer v2 slice 3 ("follow" —
// docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Mirrors block-user.js's
// own POST half almost exactly (VERIFIED authToken resolves the acting
// account — see that file's own SECURITY header comment for the full "why"
// a bare client-supplied username is a real problem for a PUBLIC-handle
// action like this one, not honest MVP scope): a bare-username POST would
// let anyone who knows a victim's handle silently follow/unfollow on their
// behalf, and — since a follow toggle also moves the TARGET's own private
// follower count (lib/follow-store.js) — forging the follower side would
// let anyone inflate/deflate someone else's count with zero real engagement
// behind it.
//
// `action` is `"follow"` (default, if omitted) or `"unfollow"` — same
// two-verb-in-one-POST shape as block-user.js's own `action` field, rather
// than a bare boolean.
//
// Following yourself is rejected (E5) — same reasoning as block-user.js's
// own E5 cannot_block_self: there's no reason a real client would ever need
// to follow its own account, and rejecting it outright avoids a following-
// list/follower-count entry that would only ever have to be special-cased
// elsewhere. u.html never even renders a Follow button on your own profile
// (see that page's own isOwner check) — a real client should never even
// reach this.
//
// Delegates the actual toggle + follower-count adjustment to
// lib/follow-store.js's setFollowing — see that file's own header comment
// for the two-separate-keys-not-one-atomic-write shape and its accepted RMW
// race posture.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as block-user.js):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 auth_token_required
//   E4 target_handle_required
//   E5 cannot_follow_self       — targetHandle (case-insensitive) resolves
//                                    to the same account the token verified
//   E6 invalid_or_expired_token — same "200, ok:false, business outcome"
//                                    shape this codebase already uses for
//                                    token verification elsewhere

var accountAuthToken = require('./lib/account-auth-token');
var followStore = require('./lib/follow-store');

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

  var authToken = (payload.authToken || '').trim();
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: auth_token_required' }) };
  }

  var targetHandle = (payload.targetHandle || '').trim();
  if (!targetHandle) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: target_handle_required' }) };
  }

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E6: invalid_or_expired_token' }) };
  }

  if (stripAt(targetHandle).toLowerCase() === stripAt(auth.username).toLowerCase()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: cannot_follow_self' }) };
  }

  var action = payload.action === 'unfollow' ? 'unfollow' : 'follow';

  try {
    var result = await followStore.setFollowing(event, auth.username, targetHandle, action === 'follow');
    return { statusCode: 200, body: JSON.stringify({ ok: true, following: result.following }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'follow_toggle_failed: ' + (e && e.message) }) };
  }
};
