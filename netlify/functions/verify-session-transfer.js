// netlify/functions/verify-session-transfer.js
//
// POST { token } -> verifies + consumes (exactly once — see lib/session-
// transfer-token.js) a session-transfer token minted by create-session-
// transfer.js, returning { ok:true, username, email, authToken } —
// deliberately the SAME response shape as account-login.js's own success
// response, so js/store.js's consumeSessionTransferTokenFromUrlSync can
// commit that identity as a local session using the exact same logic path
// login() already commits a server-confirmed login through. No password is
// checked (or needed) here — the password was already checked once, at
// MINT time, by create-session-transfer.js (see that file's own header
// comment for why that check is the real security boundary of this whole
// feature).
//
// authToken (tracker item publish-dream-js-trusts-client-supplied--lkppcu,
// found in review of that item's own fix): this endpoint resolves a REAL,
// already server-verified identity — exactly the same trust level as
// account-login.js's own success branch (the password check already
// happened, just earlier, at create-session-transfer.js's mint time) — so
// it mints a fresh lib/account-auth-token.js token here too, the same way
// account-login.js/register-account.js do on their own real-verification
// successes. Before this fix, a session established via this transfer flow
// (the FB/IG in-app-webview-escape "open in browser" link — see
// js/store.js's commitTransferredSession) had a genuinely signed-in
// state.user with NO authToken at all, which silently broke Publish for
// that flow: js/store.js's syncPublishedDreamToFeed is the ONLY path a
// dream ever reaches the shared feed through, and publish-dream.js now
// requires a verified authToken — so a null token here wasn't a "degrade
// gracefully, sync just skipped" edge case the way it is for
// blockUser/unblockUser, it was a silent, total, permanent failure to
// ever publish, for a live, currently-shipped flow.
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
var accountAuthToken = require('./lib/account-auth-token');

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
    var authToken = await accountAuthToken.mintToken(event, result.username);
    return { statusCode: 200, body: JSON.stringify({ ok: true, username: result.username, email: result.email, authToken: authToken }) };
  } catch (e) {
    // Even a genuine server error must degrade to the same silent no-op
    // as an invalid token — see header comment.
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
