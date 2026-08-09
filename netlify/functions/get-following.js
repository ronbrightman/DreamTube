// netlify/functions/get-following.js
//
// GET ?authToken=... -> { ok:true, following:[...handles], followerCount:N } | { ok:false, error }
//
// Private, auth-gated read half of Social Layer v2 slice 3 ("follow" —
// docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Same GET-resolves-
// identity-100%-from-authToken shape as block-user.js's own GET half (see
// that file's own SECURITY header comment) — there is no `handle` query
// param at all, deliberately: this always returns the CALLING account's own
// data, never anyone else's, so accepting a separate handle param would
// just be a second, spoofable way to ask for the same thing authToken
// already answers unambiguously.
//
// Backs THREE call sites, all reading the same authenticated caller's own
// private data (design doc's own Data/API line: "Explore 'Following' chip:
// fetch own list once, filter client-side — no new backend endpoint needed
// for the filter itself beyond get-following.js"):
//   1. u.html's own Follow-button initial render — "am I already following
//      the profile I'm looking at" is `following.indexOf(profileHandle) !== -1`
//      client-side (case/'@'-insensitive), no separate per-target lookup
//      endpoint needed.
//   2. explore.html's "Following" filter chip — filters the already-loaded
//      feed client-side against this same `following` array.
//   3. profile.html's own private view — shows the owner's OWN
//      followerCount next to the existing "N published"/"M created on this
//      device" stats (design doc's own state C).
//
// LOCKED CONSTRAINT: `followerCount` here is ALWAYS the authenticated
// caller's own count — there is no way to ask this endpoint for anyone
// ELSE's. u.html (the public profile view) never calls this endpoint about
// the profile it's showing; it only ever calls it (as call site 1 above)
// to check the VIEWER's own following list. This is what makes "no public
// follower count anywhere" structurally true rather than just a UI choice
// that a future page could accidentally violate by wiring this same
// endpoint up differently.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as block-user.js):
//   E1 method_not_allowed
//   E2 auth_token_required
//   E3 invalid_or_expired_token

var accountAuthToken = require('./lib/account-auth-token');
var followStore = require('./lib/follow-store');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var queryToken = ((event.queryStringParameters && event.queryStringParameters.authToken) || '').trim();
  if (!queryToken) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E2: auth_token_required' }) };
  }

  var auth = await accountAuthToken.verifyToken(event, queryToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E3: invalid_or_expired_token' }) };
  }

  var following = await followStore.getFollowing(event, auth.username);
  var followerCount = await followStore.getFollowerCount(event, auth.username);
  return { statusCode: 200, body: JSON.stringify({ ok: true, following: following, followerCount: followerCount }) };
};
