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
//   429 { ok:false, error: 'E9: rate_limited: ...' } — see the rate-
//                                                       limiting doc block
//                                                       below. Deliberately
//                                                       carries ok:false on
//                                                       the 429 (unlike
//                                                       generate-video.js/
//                                                       track-conversion.js's
//                                                       bare {error:...} 429
//                                                       shape) so js/
//                                                       store.js's signup()
//                                                       — which branches on
//                                                       data.ok, not on HTTP
//                                                       status — never
//                                                       mistakes it for a
//                                                       malformed response
//                                                       and falls back to a
//                                                       local-only account
//                                                       that was never
//                                                       actually checked/
//                                                       created server-side
//                                                       (see that function's
//                                                       own explicit
//                                                       rate_limited
//                                                       handling).
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
//   E9 rate_limited         — MAX_REGISTRATIONS_PER_IP_PER_DAY exceeded for today
//
// Optional `phone`/`phoneConsent` fields (identity/retention project,
// see docs/IDENTITY_RETENTION_PROJECT_SPEC.md Sections 1.1/1.4): both
// are entirely optional and NEVER block or fail signup either way — a
// phone number is only ever stored on the account record (with a
// phoneConsentAt timestamp) when BOTH a non-empty `phone` string AND
// `phoneConsent === true` are present on the same request, exactly
// mirroring the signup UI's unchecked-by-default consent checkbox
// (login.html/start.html — see those files' own comments). No format
// validation is applied to `phone` beyond trimming — an obviously
// malformed value simply won't reach anyone real once Twilio is
// configured (schedule-reminder.js's own Twilio call would fail
// harmlessly), and rejecting signup over it would violate "never block
// signup on this".
//
// The moment an account IS created with a phone + consent on file, this
// function also best-effort schedules the day-1 SMS reminder (see
// schedule-reminder.js's scheduleReminderForAccount) — Twilio-gated, and
// never allowed to fail or delay this response past its own errors (see
// that function's own header comment for the full no-op-until-Twilio-
// is-configured story).
// Rate limiting: this is a brand-new, fully anonymous, unauthenticated
// endpoint, so it gets the same per-IP daily cap every other public
// endpoint in this codebase has (generate-video.js, interpret-dream.js,
// track-conversion.js) — see lib/rate-limit.js. No per-identifier bucket
// here (unlike account-login.js's login attempts): a signup's username is
// exactly what's under uniqueness contention, so an attacker enumerating
// usernames wouldn't reuse the same identifier the way a login brute-force
// would, and the per-IP cap already bounds how many signup attempts (of
// any username) one source can make per day.

var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');
var scheduleReminder = require('./schedule-reminder');

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

  var maxPerDay = parseInt(process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 20;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'register-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E9: rate_limited: too many signups from this network today, try again tomorrow' }) };
  }

  var phone = typeof payload.phone === 'string' ? payload.phone.trim() : '';
  var phoneConsent = payload.phoneConsent === true;
  var accountFields = { username: username, password: password, email: email };
  if (phone && phoneConsent) {
    accountFields.phone = phone;
    accountFields.phoneConsentAt = Date.now();
  }

  var result = await accountStore.createAccount(event, accountFields);
  if (!result.ok) {
    var code = result.error === 'email_taken' ? 'E8: email_taken' : 'E7: username_taken';
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: code }) };
  }

  // Best-effort day-1 SMS reminder scheduling — only attempted when a
  // phone + consent were actually captured above. Never allowed to fail
  // this signup response; see scheduleReminderForAccount's own comment
  // for the full Twilio-gated no-op story.
  if (result.record.phone) {
    try {
      await scheduleReminder.scheduleReminderForAccount(event, result.record);
    } catch (e) {
      console.error('register-account: scheduleReminderForAccount threw (non-fatal)', e);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, username: result.record.username, email: result.record.email }) };
};
