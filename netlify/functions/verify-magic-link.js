// netlify/functions/verify-magic-link.js
//
// POST { token, consume } -> checks a magic-link token stored by
// request-magic-link.js (or generated for the SMS day-1 reminder by
// schedule-reminder.js — same token store, same verification, either
// source works here identically). With consume defaulting to true
// (there's no "peek" step for a magic link the way verify-password-
// reset.js has a preview screen — clicking the link IS the login) this
// deletes the token so it can't be reused and returns the account's
// username/email so the caller (login.html) can complete a real login.
//
// On a successful verify, also best-effort cancels any pending day-1 SMS
// reminder for this account (see lib/account-store.js's
// pendingReminderSid field and schedule-reminder.js's
// cancelPendingReminder) — clicking a magic link IS logging in, same as
// account-login.js's password path, so the same "don't text someone who
// already came back" rule applies here too. No-ops cleanly if Twilio
// isn't configured or there's nothing pending; never lets a cancel
// failure affect the magic-link login response itself.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 token_required
//   E4 invalid_or_expired

var accountStore = require('./lib/account-store');
var magicLink = require('./lib/magic-link');
var reminder = require('./schedule-reminder');

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

  var consume = payload.consume !== false;

  try {
    var result = await magicLink.verifyToken(event, token, consume);
    if (!result.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired' }) };
    }

    // Best-effort: cancel any pending reminder now that this counts as a
    // real login. Never blocks/breaks the magic-link login itself if
    // this fails for any reason (Twilio not configured, lookup/cancel
    // throwing, etc.) — see cancelPendingReminder's own comment.
    try {
      var account = await accountStore.getByUsername(event, result.username);
      if (account) await reminder.cancelPendingReminder(event, account);
    } catch (cancelErr) {
      console.error('verify-magic-link: cancelPendingReminder failed (non-fatal)', cancelErr);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, username: result.username, email: result.email }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'verify_failed: ' + (e && e.message) }) };
  }
};
