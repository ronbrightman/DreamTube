// netlify/functions/request-password-reset.js
//
// POST { email } -> looks up whether a real, server-side account
// (lib/account-store.js) is registered under this email and, if so,
// generates a random reset token, stores it (with a 30-minute expiry) in
// Blobs, and emails a reset link via Resend.
//
// This used to require { username, email } and had NO account database of
// its own to check against — it just blindly emailed whatever address it
// was given, on the assumption the CALLER (login.html's forgot-password
// handler) had already confirmed a matching account existed by checking
// the current browser's localStorage first. That client-side gate was
// exactly the bug this whole change fixes: a visitor on a different device
// than the one their account was created on has no local match to find, so
// forgot-password silently did nothing for them. Now that account-store.js
// is a real, cross-device account database, the existence check belongs
// here instead — the caller no longer needs to (and no longer can) tell
// this function to skip it. See AGENT_POLICY.md / tracker.html's
// now-resolved accounts-dont-sync-across-devices item for the full story.
//
// Anti-enumeration: this function returns the exact same
// { ok:true } response (same status code, same body, every code path from
// the format checks onward) whether or not `email` actually matches an
// account, and whether or not the Resend send itself succeeds for one that
// does — so nothing about the response can be used to probe which emails
// have accounts. This is stricter than the old version needed to be: that
// one could get away with a plain 200 either way because the CALLER
// already knew (via its own local check) whether an account existed before
// ever making the request; now that the request itself carries the
// existence question, this function must swallow every outcome past the
// format checks into one identical response, including its own unexpected
// errors (logged server-side via console.error for ops visibility, never
// surfaced to the caller in a way that would differ from the "no match"
// case). login.html's UI already shows the same generic "if an account
// with that email exists, check your inbox" copy regardless — this just
// makes the backend actually match that promise instead of relying on the
// client never asking when it shouldn't.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 email_required
//   E4 missing_api_key       — RESEND_API_KEY not configured in this
//                               environment. Safe to return distinctly
//                               (unlike everything past this point): this
//                               is a fixed environment fact, not something
//                               that varies by which email was requested,
//                               so it can never leak per-account existence.
//
// Timing side-channel (explicitly addressed, not left silent): the
// response body/status is identical either way, but the matched-account
// path does real extra work (a Blobs write + an outbound HTTPS call to
// Resend) that the no-match path doesn't — a measurable wall-clock
// difference an attacker could use to infer account existence even though
// the response itself never does. DUMMY_DELAY_MS below burns roughly
// comparable wall-clock time on the no-match path for exactly this reason.
// This is a heuristic, not a real fix: real network latency to Resend
// varies request to request, so a fixed delay narrows the gap rather than
// closing it byte-for-byte — accepted as good enough here given the actual
// stakes (this only narrows down "which email", never exposes a password
// or token, and still requires an attacker to have email addresses to
// probe in the first place), rather than building real constant-time
// infrastructure for one endpoint.

var { connectLambda, getStore } = require('@netlify/blobs');
var crypto = require('crypto');
var accountStore = require('./lib/account-store');

var RESET_STORE = 'dreamtube-password-resets';
var RESET_TTL_MS = 30 * 60 * 1000;
var RESEND_API_BASE = 'https://api.resend.com/emails';
// Works out of the box with any Resend account, no domain verification
// needed — swap for a verified custom domain address once one is set up.
var FROM_ADDRESS = 'DreamTube <onboarding@resend.dev>';

// See the "Timing side-channel" doc block above. Rough order-of-magnitude
// match for the matched-account path's Blobs write + Resend HTTPS call.
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
  // anti-enumeration note above for why even an unexpected internal error
  // is swallowed rather than surfaced with a different shape/status.
  try {
    var account = await accountStore.getByEmail(event, email);
    if (account) {
      var token = crypto.randomBytes(32).toString('hex');
      var host = event.headers['x-forwarded-host'] || event.headers.host;
      var resetUrl = 'https://' + host + '/login.html?reset=' + token;

      connectLambda(event);
      var store = getStore(RESET_STORE);
      await store.setJSON(token, { username: account.username, email: account.email, expiresAt: Date.now() + RESET_TTL_MS });

      try {
        var res = await fetch(RESEND_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: [account.email],
            subject: 'Reset your DreamTube password',
            html: '<p>Someone (hopefully you) asked to reset the password for the DreamTube account <b>' + account.username + '</b>.</p>' +
              '<p><a href="' + resetUrl + '">Click here to set a new password</a>. This link works for 30 minutes.</p>' +
              '<p>If you didn\'t request this, you can safely ignore this email.</p>'
          })
        });
        if (!res.ok) console.error('request-password-reset: Resend rejected the send', res.status);
      } catch (sendErr) {
        console.error('request-password-reset: Resend send failed', sendErr);
      }
    } else {
      // No match — see the "Timing side-channel" doc block above for why
      // this branch deliberately burns comparable wall-clock time instead
      // of returning almost immediately.
      await sleep(DUMMY_DELAY_MS);
    }
  } catch (e) {
    console.error('request-password-reset: unexpected error', e);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
