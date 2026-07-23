// netlify/functions/lib/reminder.js
//
// The Twilio-gated piece of the identity/retention project (see
// docs/IDENTITY_RETENTION_PROJECT_SPEC.md Section 1.3). Schedules a
// day-1 SMS reminder for an account that gave a phone number + consent
// at signup, using Twilio's native ScheduleType=fixed scheduling —
// Twilio holds the timer, so DreamTube's backend stays stateless: one
// API call at signup, one cancel API call at login. No cron, no queue,
// no new scheduled-function infrastructure.
//
// A plain module — NOT a Netlify Function — same "self-contained
// function, shared bits in a plain require()" pattern lib/account-
// store.js's own header comment documents. This deliberately lives under
// lib/ (not directly in netlify/functions/) so it can never be auto-
// published as a public HTTP endpoint by Netlify's functions dir config
// (see netlify.toml: `functions = "netlify/functions"` — every top-level
// .js file directly under that folder is a live, publicly callable
// endpoint; files under lib/ are just modules other functions require()).
//
// REVIEW FINDING (fixed): this used to live at
// netlify/functions/schedule-reminder.js with its own standalone
// exports.handler (POST { usernameOrEmail }), on the reasoning that the
// spec names "schedule-reminder.js" as the unit of work for Section 1.3.
// That handler had no rate-limit.js check at all (unlike every sibling
// identity endpoint — register-account.js/account-login.js both call
// rateLimit.checkAndIncrement), was never called from any page in this
// app, and — critically — each call created a NEW, non-idempotent Twilio
// scheduled message. The moment real Twilio credentials exist, that
// combination is a live, unauthenticated way for anyone who knows/
// guesses a username or email to queue unbounded real SMS sends to that
// person's real phone number — a cost + harassment vector with no
// browser call site ever exercising it. Fixed by moving this logic here
// (no exports.handler at all, so there is no public endpoint to gate or
// forget to gate) rather than adding rate-limiting to an endpoint the
// spec never actually required and nothing in the UI calls.
//
// Exports two plain functions the real signup/login functions require()
// directly, in-process (no HTTP round trip):
//   scheduleReminderForAccount(event, record) — called from
//     register-account.js's signup path, the moment an account is
//     created with a phone + consent on file.
//   cancelPendingReminder(event, record) — called from account-login.js
//     and verify-magic-link.js the instant a real login succeeds, so
//     nobody who already came back still gets texted.
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
// Message wording: "come see your dream — tokens waiting", paired with a
// magic-link URL (see lib/magic-link.js, the same token mechanism
// request-magic-link.js uses for the email flow). This is the BUILDER's
// own call, not a founder-confirmed one — the spec (Section 1.5/2)
// explicitly leaves message tone to whoever builds this ("Your call on
// tone"), it does not say the founder signed off on specific wording.
// Promotional framing (vs. a bare transactional "here's your link") means
// this message requires the TCPA consent checkbox regardless (see
// register-account.js's `phone`/`phoneConsent` handling) — see the
// spec's Section 1.5 for that distinction.

var accountStore = require('./account-store');
var magicLink = require('./magic-link');
var twilioClient = require('./twilio-client');

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
    console.log('reminder: TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER not configured yet — skipping SMS scheduling for ' + record.username + ' (expected until Twilio/A2P 10DLC setup finishes, see docs/IDENTITY_RETENTION_PROJECT_SPEC.md)');
    return { ok: true, skipped: true, reason: 'twilio_not_configured' };
  }

  try {
    var token = await magicLink.createToken(event, record);
    var url = magicLink.buildUrl(event, token);
    var body = 'Come see your dream — tokens waiting for you: ' + url + ' Reply STOP to opt out.';

    var sendAt = new Date(Date.now() + REMINDER_DELAY_MS);
    var result = await twilioClient.scheduleSms({ to: record.phone, body: body, sendAt: sendAt });
    if (!result.ok) {
      console.error('reminder: Twilio schedule failed for ' + record.username, result.error);
      return { ok: true, skipped: true, reason: 'schedule_failed' };
    }

    await accountStore.setPendingReminderSid(event, record.username, result.sid);
    return { ok: true, sid: result.sid };
  } catch (e) {
    console.error('reminder: unexpected error scheduling reminder for ' + (record && record.username), e);
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
      console.log('reminder: cancel for ' + record.username + ' did not succeed (' + result.error + ') — clearing pendingReminderSid anyway, this login no longer needs a reminder either way');
    }
  } else {
    console.log('reminder: TWILIO not configured — skipping cancel API call for ' + record.username + ', clearing pendingReminderSid locally');
  }

  await accountStore.clearPendingReminderSid(event, record.username);
  return { ok: true };
}

module.exports = { scheduleReminderForAccount, cancelPendingReminder };
