// netlify/functions/verify-password-reset.js
//
// POST { token, consume } -> checks a password-reset token stored by
// request-password-reset.js. With consume:false (default) this just peeks
// — used to decide whether to show the "set a new password" form at all.
// With consume:true it also deletes the token so it can't be reused, and
// is called right before the client applies the new password locally (see
// DreamStore.resetPasswordLocally — the actual password change happens in
// localStorage, this function only proves the link is legitimate and unused).
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 token_required
//   E4 invalid_or_expired

var { connectLambda, getStore } = require('@netlify/blobs');

var RESET_STORE = 'dreamtube-password-resets';

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

  var token = (payload.token || '').trim();
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: token_required' }) };
  }

  try {
    connectLambda(event);
    var store = getStore(RESET_STORE);
    var record = await store.get(token, { type: 'json' });

    if (!record || record.expiresAt < Date.now()) {
      if (record) await store.delete(token); // expired — clean it up while we're here
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired' }) };
    }

    if (payload.consume) await store.delete(token);

    return { statusCode: 200, body: JSON.stringify({ ok: true, username: record.username, email: record.email }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'verify_failed: ' + (e && e.message) }) };
  }
};
