// netlify/functions/verify-session-transfer.js
//
// POST { token } -> verifies + consumes (exactly once — see lib/session-
// transfer-token.js) a session-transfer token minted by create-session-
// transfer.js, returning { ok:true, username, email } — deliberately the
// SAME response shape as account-login.js's own success response, so
// js/store.js's consumeSessionTransferTokenFromUrlSync can commit that
// identity as a local session using the exact same logic path login()
// already commits a server-confirmed login through. No password is
// checked (or needed) here — the password was already checked once, at
// MINT time, by create-session-transfer.js (see that file's own header
// comment for why that check is the real security boundary of this whole
// feature).
//
// An invalid/expired/already-consumed token is a DELIBERATE, silent
// no-op — always 200 { ok:false }, never a 4xx/5xx the client would treat
// as a real error to surface. This endpoint is hit on every load of
// processing.html/result.html that happens to carry a ?bt= param at all
// — including a stale/bookmarked URL, a second tab racing the same
// single-use token, or someone just guessing random hex strings — and
// every one of those must fall through to the ordinary signed-out flow
// with zero visible error, per this feature's own spec.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 token_required

var sessionTransferToken = require('./lib/session-transfer-token');

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
    var result = await sessionTransferToken.verifyAndConsumeToken(event, token);
    if (!result.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, username: result.username, email: result.email }) };
  } catch (e) {
    // Even a genuine server error must degrade to the same silent no-op
    // as an invalid token — see header comment.
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
