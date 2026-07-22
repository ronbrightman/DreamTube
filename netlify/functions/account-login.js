// netlify/functions/account-login.js
//
// POST { usernameOrEmail, password } -> the server-side login check, via
// lib/account-store.js. Resolves by username first, then by the email
// index, and checks the password against whatever account it finds. This
// is what makes login work from any device: js/store.js's login() calls
// this first now, instead of only ever checking the current browser's
// localStorage (see AGENT_POLICY.md / tracker.html's now-resolved
// accounts-dont-sync-across-devices item).
//
// Response shapes:
//   200 { ok:true, username, email }                — real match
//   200 { ok:false, error: 'E4: not_found' }          — no account under
//   200 { ok:false, error: 'E5: incorrect_password' }    that identifier
//                                                         server-side, or
//                                                         a wrong password
// Same "business outcome, not a client error" reasoning as
// verify-password-reset.js's E4/register-account.js's E7/E8 — a login
// attempt that doesn't match anything is a completely normal, expected
// response the client needs to branch on (js/store.js's login() falls back
// to a legacy local-only check specifically on E4 not_found, never on E5 —
// see that file's own comment for why that distinction matters), not a
// malformed-request error.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as register-account.js/admin-paywall-toggle.js):
//   E1 method_not_allowed  — verb other than POST
//   E2 invalid_json        — POST body wasn't valid JSON
//   E3 missing_fields      — usernameOrEmail/password not both present
//   E4 not_found           — no account matches that username or email
//   E5 incorrect_password  — account found, password didn't match it

var accountStore = require('./lib/account-store');

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

  var usernameOrEmail = (payload.usernameOrEmail || '').trim();
  var password = typeof payload.password === 'string' ? payload.password : '';
  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }

  var result = await accountStore.verifyLogin(event, usernameOrEmail, password);
  if (!result.ok) {
    var code = result.error === 'incorrect_password' ? 'E5: incorrect_password' : 'E4: not_found';
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: code }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, username: result.record.username, email: result.record.email }) };
};
