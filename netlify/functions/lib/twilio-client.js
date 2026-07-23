// netlify/functions/lib/twilio-client.js
//
// Thin wrapper around Twilio's REST API for scheduling/canceling the
// day-1 SMS reminder (see ../schedule-reminder.js). Real Twilio
// credentials don't exist in this environment yet — the founder's A2P
// 10DLC registration is still pending (his own no-EIN Sole Proprietor
// path may not qualify without a US/Canada address; being worked out
// with Twilio support — see docs/IDENTITY_RETENTION_PROJECT_SPEC.md
// Section 2). This mirrors js/analytics-config.js's placeholder-key
// pattern for POSTHOG_KEY/META_PIXEL_ID: every call below goes through
// isConfigured() first and cleanly no-ops (never throws, never blocks a
// caller) whenever the three required env vars aren't ALL set to real,
// non-placeholder values. The moment TWILIO_ACCOUNT_SID/
// TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER are set for real in Netlify's
// environment, this activates automatically — no code change needed
// anywhere in this file or its callers.
//
// Required env vars (all three, or this stays a no-op):
//   TWILIO_ACCOUNT_SID  — starts with "AC..." in a real account
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER — the Twilio number to send from, E.164 (+1...)
//
// No twilio npm package — this repo has no build step / dependency
// bundling beyond what's already in package.json (see CLAUDE.md), and
// Twilio's Messages API is a plain REST endpoint, so a direct fetch()
// with HTTP Basic Auth (accountSid:authToken) avoids adding a new
// dependency for what's only a couple of small calls.

var TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/** True only when a value is a non-empty string that isn't an obviously-unfilled placeholder (e.g. "REPLACE_WITH_..."). Same shape as looksLikePlaceholder-style checks this codebase already uses for other still-pending vendor keys. */
function looksLikePlaceholder(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  return /^(REPLACE_WITH_|YOUR_|TODO|CHANGE_ME|PLACEHOLDER)/i.test(value.trim());
}

/**
 * True only when all three required env vars are present and none of
 * them looks like a leftover placeholder. This is the single gate every
 * function in this file (and schedule-reminder.js, which calls this
 * indirectly) checks before ever attempting a real Twilio API call —
 * see the header comment above for why this is safe to ship now.
 */
function isConfigured() {
  var sid = process.env.TWILIO_ACCOUNT_SID;
  var token = process.env.TWILIO_AUTH_TOKEN;
  var from = process.env.TWILIO_PHONE_NUMBER;
  return !looksLikePlaceholder(sid) && !looksLikePlaceholder(token) && !looksLikePlaceholder(from);
}

function authHeader() {
  var sid = process.env.TWILIO_ACCOUNT_SID;
  var token = process.env.TWILIO_AUTH_TOKEN;
  return 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
}

/**
 * Schedules an SMS via Twilio's native ScheduleType=fixed scheduling —
 * Twilio holds the timer, this backend stays stateless (see
 * schedule-reminder.js's header comment for the full mechanic). `opts`
 * is { to, body, sendAt } where sendAt is a real Date. Returns
 * { ok:true, sid } on success, { ok:false, skipped:true,
 * error:'twilio_not_configured' } when the env vars above aren't set
 * (never throws), or { ok:false, error } on a genuine Twilio API
 * failure.
 */
async function scheduleSms(opts) {
  if (!isConfigured()) {
    console.log('twilio-client: TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER not configured yet — skipping SMS scheduling (expected until the founder finishes Twilio/A2P 10DLC setup, see docs/IDENTITY_RETENTION_PROJECT_SPEC.md)');
    return { ok: false, skipped: true, error: 'twilio_not_configured' };
  }

  var sid = process.env.TWILIO_ACCOUNT_SID;
  var from = process.env.TWILIO_PHONE_NUMBER;

  try {
    var params = new URLSearchParams({
      To: opts.to,
      From: from,
      Body: opts.body,
      ScheduleType: 'fixed',
      SendAt: opts.sendAt.toISOString()
    });

    var res = await fetch(TWILIO_API_BASE + '/Accounts/' + sid + '/Messages.json', {
      method: 'POST',
      headers: {
        'Authorization': authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      console.error('twilio-client: schedule SMS failed', res.status, data && data.message);
      return { ok: false, error: 'twilio_schedule_failed' };
    }
    return { ok: true, sid: data.sid };
  } catch (e) {
    console.error('twilio-client: schedule SMS threw', e && e.message);
    return { ok: false, error: 'twilio_schedule_failed' };
  }
}

/**
 * Cancels a previously-scheduled message by SID (e.g. the user logged in
 * before it fired). Twilio cancels a scheduled message by updating its
 * Status to "canceled". No-ops cleanly (same shape as scheduleSms above)
 * when Twilio isn't configured — returns { ok:false, skipped:true }
 * rather than throwing, since not having Twilio configured yet is
 * expected, not an error condition.
 */
async function cancelSms(sid) {
  if (!isConfigured()) {
    console.log('twilio-client: TWILIO not configured — skipping cancel for sid ' + sid);
    return { ok: false, skipped: true, error: 'twilio_not_configured' };
  }
  if (!sid) return { ok: false, error: 'no_sid' };

  var accountSid = process.env.TWILIO_ACCOUNT_SID;
  try {
    var res = await fetch(TWILIO_API_BASE + '/Accounts/' + accountSid + '/Messages/' + sid + '.json', {
      method: 'POST',
      headers: {
        'Authorization': authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ Status: 'canceled' }).toString()
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      // A message that already sent (or was already canceled) can't be
      // canceled again — Twilio errors on that, which is a completely
      // normal, expected outcome here (the reminder simply beat the
      // login), not a real failure worth surfacing loudly.
      console.log('twilio-client: cancel SMS ' + sid + ' returned ' + res.status + ' (likely already sent — expected)', data && data.message);
      return { ok: false, error: 'twilio_cancel_failed' };
    }
    return { ok: true };
  } catch (e) {
    console.error('twilio-client: cancel SMS threw', e && e.message);
    return { ok: false, error: 'twilio_cancel_failed' };
  }
}

module.exports = { isConfigured, scheduleSms, cancelSms };
