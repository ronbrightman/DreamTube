// netlify/functions/unpublish-dream.js
//
// POST { id, authToken } -> removes a dream from the shared feed-index blob
// (see get-feed.js). Called when a published dream is deleted or
// unpublished, so it doesn't linger in everyone else's Explore feed once
// the owner has removed it.
//
// SECURITY (fixed after review — tracker item
// publish-dream-js-trusts-client-supplied--lkppcu, same finding as
// publish-dream.js's own header comment): this file used to accept a bare
// `{ id }` with NO check at all — since a dream's public `id` is visible
// to anyone via Explore, anyone could forge a raw POST here and delete a
// stranger's dream out of the shared feed entirely.
//
// Fixed the same way publish-dream.js/block-user.js were: a verified
// `authToken` (lib/account-auth-token.js) is now required. Unlike
// publish-dream.js's ownerHandle check (compared against the CLIENT's own
// claimed field), this compares the verified token's username against the
// TARGET RECORD's own already-stored ownerHandle in the feed-index — the
// same "does the acting identity match the RECORD's own stored owner"
// idiom as claim-pending-generation.js's email-must-match-the-record check
// and js/store.js's own deleteDream ownerHandle guard. A bare valid token
// is NOT sufficient on its own here — it only proves WHO is asking, not
// that they own the record they're asking to delete; without this second
// check, any signed-in account's own perfectly valid token could unpublish
// anyone else's dream just by knowing its id.
//
// A target id that doesn't exist in the feed at all is treated as a
// harmless no-op (ok:true), same as before this fix — there's no
// ownership to check against a record that isn't there, and js/store.js's
// removePublishedDreamFromFeed is fire-and-forget either way.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as publish-dream.js/block-user.js):
//   E1 method_not_allowed       — verb other than POST
//   E2 invalid_json             — POST body wasn't valid JSON
//   E3 id_required              — `id` missing/blank
//   E4 auth_token_required      — `authToken` missing/blank
//   E5 invalid_or_expired_token — authToken didn't verify — same "200,
//                                   ok:false, business outcome" shape as
//                                   publish-dream.js's own E5/block-user.js's
//                                   E6 (see those files' comments for why)
//   E6 not_owner                — the verified token's username doesn't
//                                   match the target record's own stored
//                                   ownerHandle — the actual
//                                   unpublish-someone-else's-dream case
//                                   this fix closes. A real 4xx, not the
//                                   E5 "business as usual" shape.

var { connectLambda, getStore } = require('@netlify/blobs');
var accountAuthToken = require('./lib/account-auth-token');

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

  if (!payload.id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: id_required' }) };
  }
  var authToken = (payload.authToken || '').trim();
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: auth_token_required' }) };
  }

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E5: invalid_or_expired_token' }) };
  }

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    var target = feed.find(function (d) { return d.id === payload.id; });

    // No record to unpublish -- harmless no-op, see this file's header
    // comment. Nothing to check ownership against.
    if (!target) {
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // See this file's own header comment -- must match the RECORD's own
    // stored owner, not just be any validly-signed-in account.
    if (stripAt(target.ownerHandle).toLowerCase() !== auth.username.toLowerCase()) {
      return { statusCode: 403, body: JSON.stringify({ error: 'E6: not_owner' }) };
    }

    var filtered = feed.filter(function (d) { return d.id !== payload.id; });
    await store.setJSON('feed-index', filtered);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'unpublish_failed: ' + (e && e.message) }) };
  }
};
