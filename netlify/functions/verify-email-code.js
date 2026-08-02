// netlify/functions/verify-email-code.js
//
// POST { authToken, code } -> checks a 6-digit code against the calling
// account's pending verification (lib/email-verification-store.js) and, on
// a match, marks that account's `emailVerified` true (tracker item
// for-product-build-passwordless-signup-fo-at2fko). The explicit "type the
// code back in" half of this feature's deferred-verification UI — see
// js/email-verify-sheet.js for the client-side prompt this backs.
//
// IDENTITY: resolved from `authToken` (lib/account-auth-token.js), NEVER a
// bare client-claimed username — same discipline block-user.js/
// publish-dream.js already established for exactly this reason (see
// account-auth-token.js's own header comment on why a bare username is a
// real problem for some endpoints and not others). This one qualifies:
// without this check, anyone who knows a victim's public @handle could
// brute-force-guess a 6-digit code against THEIR account and flip its
// emailVerified flag — not a takeover of the account itself, but a real,
// unauthorized state change on someone else's record that this app's own
// gate list (see account-store.js) then treats as meaningful (e.g.
// unlocking that account for purchases without its real owner ever having
// proven they own the inbox). A verified authToken is exactly the "you're
// genuinely acting as this account" proof every other privileged endpoint
// here already requires.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as verify-password-reset.js):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 auth_token_required
//   E4 invalid_or_expired_token
//   E5 code_required
//   E6 invalid_code            — no pending verification for this account,
//                                 it expired, or the code didn't match (see
//                                 lib/email-verification-store.js's
//                                 verifyCode for why these are collapsed
//                                 into one client-facing outcome — none of
//                                 them are actionable differently by the
//                                 UI beyond "that wasn't right, try again
//                                 or resend")
//   E7 too_many_attempts       — MAX_CODE_ATTEMPTS exceeded; the client
//                                 should offer a resend instead of another
//                                 guess

var accountAuthToken = require('./lib/account-auth-token');
var accountStore = require('./lib/account-store');
var emailVerificationStore = require('./lib/email-verification-store');

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

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired_token' }) };
  }

  var code = (payload.code || '').trim();
  if (!code) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: code_required' }) };
  }

  var result = await emailVerificationStore.verifyCode(event, auth.username, code);
  if (!result.ok) {
    var code2 = result.error === 'too_many_attempts' ? 'E7: too_many_attempts' : 'E6: invalid_code';
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: code2 }) };
  }

  await accountStore.markEmailVerified(event, auth.username);
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
