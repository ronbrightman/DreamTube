// netlify/functions/login-with-email-code.js
//
// POST { email, code } -> the "prove you own this inbox" completion of
// register-account-passwordless.js's RESOLVE branch (tracker item
// for-product-build-passwordless-signup-fo-at2fko, security fix — see that
// file's own header comment for the full incident writeup: a bare email
// POST used to hand back a usable session with zero ownership proof; it
// no longer does, and THIS endpoint is the real access-control gate that
// replaces it).
//
// This is genuinely a LOGIN endpoint, not a "confirm my already-
// authenticated session's email" one — unlike verify-email-code.js (which
// requires an existing authToken because it's meant for an account that's
// ALREADY signed in on this device, just unverified), this endpoint has NO
// prior session at all: the mailed code itself IS the credential. Kept as
// its own file rather than folded into verify-email-code.js because the
// two have genuinely different security postures (one authenticates a new
// session, the other only ever acts on an already-proven one) — same
// "narrow, single-purpose endpoint" precedent register-account.js/
// account-login.js already set by staying separate from each other.
//
// On a correct code: marks the account verified (a successful code check
// IS ownership proof, same as verify-email-code.js's own success path) and
// mints a real lib/account-auth-token.js session, same response shape as
// account-login.js's own success.
//
// IDENTITY: resolved by EMAIL only (accountStore.getByEmail) — there is no
// authToken to resolve from yet, that's the whole point of this endpoint.
// The actual security boundary is lib/email-verification-store.js's
// verifyCode: a real 6-digit code, hashed at rest, attempt-limited
// (MAX_CODE_ATTEMPTS), constant-time compared. An email with no pending
// verification record (never signed up, or already verified/consumed) is
// collapsed into the SAME generic E4 as a wrong code — never a distinct
// "no such account" response, so this can't be used to enumerate which
// emails have DreamTube accounts.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_fields     — email/code not both present
//   E4 invalid_code        — no account for that email, no pending
//                             verification, expired, or the code itself
//                             didn't match (all collapsed — see IDENTITY
//                             note above)
//   E5 too_many_attempts   — MAX_CODE_ATTEMPTS exceeded for the pending
//                             record; the client should offer a resend
//                             (re-submitting to register-account-
//                             passwordless.js, which always sends a fresh
//                             code + resets the attempt counter) instead
//                             of another guess
//   E6 rate_limited         — MAX_EMAIL_CODE_LOGIN_ATTEMPTS_PER_IP_PER_DAY
//                             exceeded — this is now a real login
//                             endpoint, so it gets the same per-IP
//                             throttle every other unauthenticated,
//                             account-touching endpoint in this codebase
//                             has (register-account.js/account-login.js),
//                             on top of the code's own attempt-limiting.

var accountStore = require('./lib/account-store');
var emailVerificationStore = require('./lib/email-verification-store');
var accountAuthToken = require('./lib/account-auth-token');
var rateLimit = require('./lib/rate-limit');

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

  var email = (payload.email || '').trim();
  var code = (payload.code || '').trim();
  if (!email || !code) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_EMAIL_CODE_LOGIN_ATTEMPTS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'login-email-code-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited' }) };
  }

  var account = await accountStore.getByEmail(event, email);
  if (!account) {
    // Same generic shape as a wrong code -- see header comment's IDENTITY
    // note on why this must never distinguish "no account" from "wrong
    // code".
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_code' }) };
  }

  var result = await emailVerificationStore.verifyCode(event, account.username, code);
  if (!result.ok) {
    var code2 = result.error === 'too_many_attempts' ? 'E5: too_many_attempts' : 'E4: invalid_code';
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: code2 }) };
  }

  await accountStore.markEmailVerified(event, account.username);
  var authToken = await accountAuthToken.mintToken(event, account.username);
  return { statusCode: 200, body: JSON.stringify({ ok: true, username: account.username, email: account.email, authToken: authToken }) };
};
