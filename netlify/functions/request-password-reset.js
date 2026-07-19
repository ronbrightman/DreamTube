// netlify/functions/request-password-reset.js
//
// POST { username, email } -> generates a random reset token, stores it
// (with a 30-minute expiry) in Blobs, and emails a reset link via Resend.
//
// Accounts live only in each browser's localStorage (js/store.js) — this
// function has no account database of its own to check against. The
// client is responsible for only calling this when it has already found a
// local account matching the given email (see DreamStore.findAccountByEmail),
// and for showing the same "if that email is registered, check your inbox"
// message to the end user regardless of what this function actually did,
// so a missing/misconfigured account never gets revealed either way.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 username_and_email_required
//   E4 missing_api_key       — RESEND_API_KEY not configured in this environment
//   E5 email_send_failed     — Resend rejected the request

var { connectLambda, getStore } = require('@netlify/blobs');
var crypto = require('crypto');

var RESET_STORE = 'dreamtube-password-resets';
var RESET_TTL_MS = 30 * 60 * 1000;
var RESEND_API_BASE = 'https://api.resend.com/emails';
// Works out of the box with any Resend account, no domain verification
// needed — swap for a verified custom domain address once one is set up.
var FROM_ADDRESS = 'DreamTube <onboarding@resend.dev>';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E4: missing_api_key' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var username = (payload.username || '').trim();
  var email = (payload.email || '').trim();
  if (!username || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: username_and_email_required' }) };
  }

  var token = crypto.randomBytes(32).toString('hex');
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  var resetUrl = 'https://' + host + '/login.html?reset=' + token;

  try {
    connectLambda(event);
    var store = getStore(RESET_STORE);
    await store.setJSON(token, { username: username, email: email, expiresAt: Date.now() + RESET_TTL_MS });

    var res = await fetch(RESEND_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject: 'Reset your DreamTube password',
        html: '<p>Someone (hopefully you) asked to reset the password for the DreamTube account <b>' + username + '</b>.</p>' +
          '<p><a href="' + resetUrl + '">Click here to set a new password</a>. This link works for 30 minutes and only on the device where the account was created.</p>' +
          '<p>If you didn\'t request this, you can safely ignore this email.</p>'
      })
    });

    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'E5: email_send_failed' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E5: email_send_failed: ' + (e && e.message) }) };
  }
};
