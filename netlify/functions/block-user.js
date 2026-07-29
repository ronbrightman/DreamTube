// netlify/functions/block-user.js
//
// GET  ?username=...                              -> { blockedHandles: [...] }
// POST { username, blockedHandle, action? }        -> { ok: true, blockedHandles: [...] }
//
// The server-side durability half of tracker item
// for-product-public-feed-safety-in-app-re-ppuw77's "block user" feature —
// see lib/block-store.js's own header comment for the full storage
// design/reasoning. `username` is the BLOCKING account's own (client-
// claimed, already-signed-in) username — same trust model as
// save-push-subscription.js's identical `username` param (no server-side
// session exists in this codebase at all — see that file's own header
// comment for the fuller precedent this follows).
//
// GET is used to hydrate a signed-in account's blocklist on a device that
// doesn't already have it locally (a fresh browser, or one that was
// cleared) — see js/store.js's syncBlockedHandlesFromServer.
//
// POST `action` is `"block"` (default, if omitted) or `"unblock"`.
// Blocking yourself is rejected (E5) — there's no reason a real client
// would ever need to hide its own dreams from its own feed, and silently
// no-op'ing this instead of a real check hides trivial client-side bugs
// (e.g. a caller accidentally passing its own handle) rather than
// surfacing them.
//
// Combined GET+POST in one function — same "one small file, one verb-
// dispatch switch" shape as admin-paywall-toggle.js, rather than splitting
// into two files the way get-support-messages.js/submit-support-message.js
// (a heavier, PII-bearing pair) did — this endpoint's GET has no
// meaningfully different sensitivity/shape concern from its POST that
// would justify a second file.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js):
//   E1 method_not_allowed   — verb other than GET/POST
//   E2 invalid_json         — POST body wasn't valid JSON
//   E3 username_required    — `username` missing/blank (GET or POST)
//   E4 blocked_handle_required — POST body's `blockedHandle` missing/blank
//   E5 cannot_block_self    — POST body's `blockedHandle` (handle form,
//                              case-insensitive) resolves to the same
//                              account as `username`

var blockStore = require('./lib/block-store');

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') {
    var queryUsername = (event.queryStringParameters && event.queryStringParameters.username) || '';
    if (!queryUsername.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E3: username_required' }) };
    }
    var blockedHandles = await blockStore.getBlockedHandles(event, queryUsername);
    return { statusCode: 200, body: JSON.stringify({ blockedHandles: blockedHandles }) };
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

  var username = (payload.username || '').trim();
  if (!username) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: username_required' }) };
  }

  var blockedHandle = (payload.blockedHandle || '').trim();
  if (!blockedHandle) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: blocked_handle_required' }) };
  }

  if (stripAt(blockedHandle).toLowerCase() === stripAt(username).toLowerCase()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: cannot_block_self' }) };
  }

  var action = payload.action === 'unblock' ? 'unblock' : 'block';
  var result = action === 'unblock'
    ? await blockStore.removeBlockedHandle(event, username, blockedHandle)
    : await blockStore.addBlockedHandle(event, username, blockedHandle);

  if (!result.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: 'block_write_failed: ' + result.error }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, blockedHandles: result.blockedHandles }) };
};
