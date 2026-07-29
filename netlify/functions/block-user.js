// netlify/functions/block-user.js
//
// GET  ?authToken=...                                -> { ok:true, blockedHandles:[...] } | { ok:false, error }
// POST { authToken, blockedHandle, action? }          -> { ok:true, blockedHandles:[...] } | { ok:false, error }
//
// The server-side durability half of tracker item
// for-product-public-feed-safety-in-app-re-ppuw77's "block user" feature —
// see lib/block-store.js's own header comment for the full storage
// design/reasoning.
//
// SECURITY (fixed after review — an earlier version of this file trusted a
// bare client-supplied `username` string, same shape as save-push-
// subscription.js's identical-looking param): the acting account is now
// resolved from a VERIFIED `authToken` (lib/account-auth-token.js, minted
// only at a real server-side login/signup success — see that file's own
// header comment), never from a bare claim. This action is different from
// save-push-subscription.js's own bare-username trust (whose worst case is
// only a misdirected push notification): this app's usernames/handles are
// PUBLIC — shown on every Explore card — so a bare-username GET would have
// let anyone enumerate any account's blocklist, and a bare-username POST
// would have let anyone who knows a victim's handle silently unblock
// someone on their behalf, defeating the entire point of the feature.
// Requiring a verified token instead means only a browser that has
// actually completed a real login/signup for that specific account can
// read or change its blocklist. `username` is deliberately NOT accepted as
// an input at all anymore — the acting account is 100% derived from
// authToken server-side, so there is no client-supplied identity field
// left here to spoof.
//
// GET is used to hydrate a signed-in account's blocklist on a device that
// doesn't already have it locally (a fresh browser, or one that was
// cleared) — see js/store.js's syncBlockedHandlesFromServer.
//
// POST `action` is `"block"` (default, if omitted) or `"unblock"`.
// Blocking yourself is rejected (E5) — there's no reason a real client
// would ever need to hide its own dreams from its own feed.
//
// Combined GET+POST in one function — same "one small file, one verb-
// dispatch switch" shape as admin-paywall-toggle.js, rather than splitting
// into two files.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js):
//   E1 method_not_allowed       — verb other than GET/POST
//   E2 invalid_json             — POST body wasn't valid JSON
//   E3 auth_token_required      — `authToken` missing/blank (GET query
//                                   param or POST body field)
//   E4 blocked_handle_required  — POST body's `blockedHandle` missing/blank
//   E5 cannot_block_self        — POST body's `blockedHandle` (handle
//                                   form, case-insensitive) resolves to the
//                                   same account the token verified
//   E6 invalid_or_expired_token — authToken didn't verify (unknown,
//                                   expired, or never issued) — same "200,
//                                   ok:false, treat as a normal business
//                                   outcome" shape this codebase already
//                                   uses for token verification elsewhere
//                                   (get-shared-dream.js/
//                                   verify-session-transfer.js), not a
//                                   4xx/5xx

var blockStore = require('./lib/block-store');
var accountAuthToken = require('./lib/account-auth-token');

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') {
    var queryToken = ((event.queryStringParameters && event.queryStringParameters.authToken) || '').trim();
    if (!queryToken) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: auth_token_required' }) };
    }
    var getAuth = await accountAuthToken.verifyToken(event, queryToken);
    if (!getAuth.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E6: invalid_or_expired_token' }) };
    }
    var blockedHandles = await blockStore.getBlockedHandles(event, getAuth.username);
    return { statusCode: 200, body: JSON.stringify({ ok: true, blockedHandles: blockedHandles }) };
  }

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

  var blockedHandle = (payload.blockedHandle || '').trim();
  if (!blockedHandle) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: blocked_handle_required' }) };
  }

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E6: invalid_or_expired_token' }) };
  }

  if (stripAt(blockedHandle).toLowerCase() === stripAt(auth.username).toLowerCase()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: cannot_block_self' }) };
  }

  var action = payload.action === 'unblock' ? 'unblock' : 'block';
  var result = action === 'unblock'
    ? await blockStore.removeBlockedHandle(event, auth.username, blockedHandle)
    : await blockStore.addBlockedHandle(event, auth.username, blockedHandle);

  if (!result.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: 'block_write_failed: ' + result.error }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, blockedHandles: result.blockedHandles }) };
};
