// netlify/functions/request-magic-link.js
//
// POST { email } -> looks up whether a real, server-side account
// (lib/account-store.js) is registered under this email and, if so,
// generates a short-lived (15 min), single-use magic-link token (see
// lib/magic-link.js — the SAME token mechanism ../schedule-reminder.js's
// SMS reminder reuses for its own link), and emails a login link via
// Resend. Parallel structure to request-password-reset.js — read that
// file's header comment for the full anti-enumeration/timing-side-
// channel reasoning; it applies here identically, just for "log in"
// instead of "reset your password".
//
// Anti-enumeration: same exact { ok:true } response every code path from
// the format checks onward, whether or not `email` matches an account —
// see request-password-reset.js's own header comment for the complete
// reasoning (this file mirrors it).
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 email_required
//   E4 missing_api_key — RESEND_API_KEY not configured in this
//                         environment. Safe to return distinctly (unlike
//                         everything past this point): a fixed
//                         environment fact, not something that varies by
//                         which email was requested.
//
// Timing side-channel: same DUMMY_DELAY_MS heuristic as
// request-password-reset.js, for the exact same reason (the matched path
// does a real Blobs write + Resend call the no-match path doesn't).

var { connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var magicLink = require('./lib/magic-link');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Works out of the box with any Resend account, no domain verification
// needed — same address request-password-reset.js already uses.
var FROM_ADDRESS = 'DreamTube <onboarding@resend.dev>';

var DUMMY_DELAY_MS = 250;
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

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

  var email = (payload.email || '').trim();
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: email_required' }) };
  }

  // From here on, every path returns the same { ok:true } — see the
  // anti-enumeration note above.
  try {
    var account = await accountStore.getByEmail(event, email);
    if (account) {
      var token = await magicLink.createToken(event, account);
      var url = magicLink.buildUrl(event, token);

      connectLambda(event); // no-op if already connected — matches request-password-reset.js's own call shape
      try {
        var res = await fetch(RESEND_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: [account.email],
            subject: 'Your DreamTube login link',
            html: '<p>Tap below to log in to DreamTube as <b>' + account.username + '</b> — no password needed.</p>' +
              '<p><a href="' + url + '">Log in to DreamTube</a>. This link works for 15 minutes and can only be used once.</p>' +
              '<p>If you didn\'t request this, you can safely ignore this email.</p>'
          })
        });
        if (!res.ok) console.error('request-magic-link: Resend rejected the send', res.status);
      } catch (sendErr) {
        console.error('request-magic-link: Resend send failed', sendErr);
      }
    } else {
      // No match — see the "Timing side-channel" doc block above.
      await sleep(DUMMY_DELAY_MS);
    }
  } catch (e) {
    console.error('request-magic-link: unexpected error', e);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
