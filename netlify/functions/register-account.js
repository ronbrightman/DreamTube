// netlify/functions/register-account.js
//
// POST { username, password, email } -> creates a real, server-side account
// record via lib/account-store.js. This is the authoritative uniqueness
// check now: a signup attempt for a username OR email that's already
// registered — from ANY device — is rejected here, rather than only ever
// being checked against whatever's in the current browser's localStorage
// (see js/store.js's signup(), which still also writes a local mirror on
// success so nothing about the *original* device's dream/character logic
// changes). See AGENT_POLICY.md / tracker.html's now-resolved
// accounts-dont-sync-across-devices item for the full story.
//
// Validation mirrors js/store.js's own signup() rules exactly (same
// minimums, same order) so a server-side rejection reads identically to
// the client-side one a real user already sees today — this is a second,
// authoritative check behind the client's own validation, not a stricter
// or different one.
//
// Response shapes:
//   200 { ok:true, username, email }               — account created
//   200 { ok:false, error: 'E7: username_taken' }   — collision, not a
//   200 { ok:false, error: 'E8: email_taken' }         client/shape error
// A real 4xx is reserved for the caller not even sending a well-formed
// request at all (E1-E6 below) — "someone already has this name" is a
// normal, expected business outcome the client needs to branch on and
// show inline (same shape as verify-password-reset.js's E4
// invalid_or_expired), not a client bug.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js/owner-topup-tokens.js):
//   E1 method_not_allowed   — verb other than POST
//   E2 invalid_json         — POST body wasn't valid JSON
//   E3 missing_fields       — username/password/email not all present
//   E4 invalid_username     — username shorter than 3 characters
//   E5 invalid_password     — password shorter than 8 characters
//   E6 invalid_email        — not a plausible email address
//   E7 username_taken       — already registered under a different account
//   E8 email_taken          — already registered under a different account

var accountStore = require('./lib/account-store');

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  var username = (payload.username || '').trim();
  var password = typeof payload.password === 'string' ? payload.password : '';
  var email = (payload.email || '').trim();

  if (!username || !password || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }
  if (username.length < 3) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: invalid_username' }) };
  }
  if (password.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: invalid_password' }) };
  }
  if (!EMAIL_RE.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E6: invalid_email' }) };
  }

  var result = await accountStore.createAccount(event, { username: username, password: password, email: email });
  if (!result.ok) {
    var code = result.error === 'email_taken' ? 'E8: email_taken' : 'E7: username_taken';
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: code }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, username: result.record.username, email: result.record.email }) };
};
