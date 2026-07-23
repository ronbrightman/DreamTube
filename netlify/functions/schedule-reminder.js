// netlify/functions/schedule-reminder.js
//
// The Twilio-gated piece of the identity/retention project (see
// docs/IDENTITY_RETENTION_PROJECT_SPEC.md Section 1.3). Schedules a
// day-1 SMS reminder for an account that gave a phone number + consent
// at signup, using Twilio's native ScheduleType=fixed scheduling —
// Twilio holds the timer, so DreamTube's backend stays stateless: one
// API call at signup, one cancel API call at login. No cron, no queue,
// no new scheduled-function infrastructure.
//
// Exports two plain functions other functions require() directly — same
// "self-contained function, shared bits in a plain require()" pattern
// lib/account-store.js's own header comment documents, just co-located
// in this file (rather than lib/) since the spec itself names this file
// as the unit of work for Section 1.3:
//   scheduleReminderForAccount(event, record) — called from
//     register-account.js's signup path, in-process (no extra HTTP round
//     trip within the same request) the moment an account is created
//     with a phone + consent on file.
//   cancelPendingReminder(event, record) — called from account-login.js
//     and verify-magic-link.js the instant a real login succeeds, so
//     nobody who already came back still gets texted.
// exports.handler below is this file's OWN Netlify Function entry point
// (POST { usernameOrEmail }), for a standalone/manual-retry call path —
// the actual signup/login call sites above go through the plain
// functions directly, not this HTTP handler, so signup/login each stay a
// single request/response cycle.
//
// TWILIO-GATED, GRACEFUL NO-OP: TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/
// TWILIO_PHONE_NUMBER don't exist as real values in this environment yet
// — the founder's A2P 10DLC registration is still pending. Every path
// below goes through lib/twilio-client.js, which checks isConfigured()
// first and never throws — see that file's own header comment for the
// exact "safe to ship now, activates automatically once real env vars
// land" pattern, mirrored from js/analytics-config.js's
// POSTHOG_KEY/META_PIXEL_ID placeholder handling. Signup and login must
// never fail or degrade because Twilio isn't wired up yet — every
// function here always resolves (never rejects) and reports
// { skipped:true } rather than surfacing an error in that case.
//
// Message wording: the founder-confirmed promotional framing — "come
// see your dream, tokens waiting" — paired with a magic-link URL (see
// lib/magic-link.js, the same token mechanism request-magic-link.js
// uses for the email flow). Promotional framing means this message
// requires the TCPA consent checkbox (see register-account.js's
// `phone`/`phoneConsent` handling) regardless of the transactional-vs-
// marketing distinction — see the spec's Section 1.5.

var accountStore = require('./lib/account-store');
var magicLink = require('./lib/magic-link');
var twilioClient = require('./lib/twilio-client');

var REMINDER_DELAY_MS = 24 * 60 * 60 * 1000; // +24h — the spec's day-1 reminder

/**
 * Schedules the day-1 reminder for a freshly-created account that has a
 * phone on file (record.phone — see lib/account-store.js; only ever set
 * when signup also captured consent, see register-account.js). Never
 * throws — always resolves { ok:true, ... } — since a failed/skipped SMS
 * schedule must never fail the signup that triggered it:
 *   - { ok:true, skipped:true, reason:'no_phone_on_file' } — nothing to
 *     text.
 *   - { ok:true, skipped:true, reason:'twilio_not_configured' } — the
 *     expected state until the founder's Twilio/A2P 10DLC setup lands.
 *   - { ok:true, skipped:true, reason:'schedule_failed' } — Twilio IS
 *     configured but the real API call itself failed.
 *   - { ok:true, sid } — scheduled for real; sid is also persisted onto
 *     the account record as pendingReminderSid.
 */
async function scheduleReminderForAccount(event, record) {
  if (!record || !record.phone) {
    return { ok: true, skipped: true, reason: 'no_phone_on_file' };
  }
  if (!twilioClient.isConfigured()) {
    console.log('schedule-reminder: TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER not configured yet — skipping SMS scheduling for ' + record.username + ' (expected until Twilio/A2P 10DLC setup finishes, see docs/IDENTITY_RETENTION_PROJECT_SPEC.md)');
    return { ok: true, skipped: true, reason: 'twilio_not_configured' };
  }

  try {
    var token = await magicLink.createToken(event, record);
    var url = magicLink.buildUrl(event, token);
    var body = 'Come see your dream — tokens waiting for you: ' + url + ' Reply STOP to opt out.';

    var sendAt = new Date(Date.now() + REMINDER_DELAY_MS);
    var result = await twilioClient.scheduleSms({ to: record.phone, body: body, sendAt: sendAt });
    if (!result.ok) {
      console.error('schedule-reminder: Twilio schedule failed for ' + record.username, result.error);
      return { ok: true, skipped: true, reason: 'schedule_failed' };
    }

    await accountStore.setPendingReminderSid(event, record.username, result.sid);
    return { ok: true, sid: result.sid };
  } catch (e) {
    console.error('schedule-reminder: unexpected error scheduling reminder for ' + (record && record.username), e);
    return { ok: true, skipped: true, reason: 'unexpected_error' };
  }
}

/**
 * Cancels a pending reminder (if any) the moment a real login happens —
 * called from account-login.js and verify-magic-link.js. Never throws.
 * No-ops cleanly (returns { ok:true, skipped:true, ... }) if there's no
 * pendingReminderSid on file, or Twilio isn't configured. Always clears
 * the field locally regardless of whether the Twilio cancel call itself
 * succeeded (most common real case: the reminder already sent before
 * this login happened, which Twilio reports as a cancel failure but is a
 * completely normal outcome) — this function must never block or fail
 * the login that triggered it.
 */
async function cancelPendingReminder(event, record) {
  if (!record || !record.pendingReminderSid) {
    return { ok: true, skipped: true, reason: 'no_pending_reminder' };
  }

  var sid = record.pendingReminderSid;
  if (twilioClient.isConfigured()) {
    var result = await twilioClient.cancelSms(sid);
    if (!result.ok) {
      console.log('schedule-reminder: cancel for ' + record.username + ' did not succeed (' + result.error + ') — clearing pendingReminderSid anyway, this login no longer needs a reminder either way');
    }
  } else {
    console.log('schedule-reminder: TWILIO not configured — skipping cancel API call for ' + record.username + ', clearing pendingReminderSid locally');
  }

  await accountStore.clearPendingReminderSid(event, record.username);
  return { ok: true };
}

// ---------------------------------------------------------------------
// Netlify Function entry point — POST { usernameOrEmail }. Not the path
// register-account.js/account-login.js actually use for the real signup/
// login flows (they call the plain functions above directly, in-process,
// to keep each request a single round trip) — this exists as a
// standalone, independently-callable endpoint matching the spec's own
// naming for this piece of work, useful for a manual retry/diagnostic
// call if a scheduling attempt is ever suspected to have been missed.
// ---------------------------------------------------------------------

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
  if (!usernameOrEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: username_or_email_required' }) };
  }

  var record = await accountStore.getByUsername(event, usernameOrEmail);
  if (!record) record = await accountStore.getByEmail(event, usernameOrEmail);
  if (!record) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: not_found' }) };
  }

  var result = await scheduleReminderForAccount(event, record);
  return { statusCode: 200, body: JSON.stringify(result) };
};

module.exports.scheduleReminderForAccount = scheduleReminderForAccount;
module.exports.cancelPendingReminder = cancelPendingReminder;
