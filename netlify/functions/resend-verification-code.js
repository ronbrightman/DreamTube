// netlify/functions/resend-verification-code.js
//
// POST { authToken, auto? } -> re-sends a fresh 6-digit code + implicit-
// verification link to the calling account's own email (tracker item
// for-product-build-passwordless-signup-fo-at2fko). Used by
// js/email-verify-sheet.js's "Resend code" affordance — the original code
// sent at signup may be lost, expired (7-day TTL, see lib/email-
// verification-store.js), or simply never arrived.
//
// `auto` (optional bool, fix for tracker item for-product-bug-founder-
// repro-08-09-veri-g71t7u): set ONLY by js/email-verify-sheet.js's
// autoSendOnOpen — an automatic, no-user-action call that fires whenever
// the sheet opens, which used to genuinely double-mail a fresh code
// seconds after signup's own send with no cooldown at all. Passed through
// to verificationEmailSender.sendVerificationEmail's own `auto` opt-in
// (see that file's own header comment for the full "why opt-in, not
// unconditional" reasoning) — a manual "Resend" tap never sets this, so it
// keeps sending a genuinely fresh code every time, unaffected.
//
// IDENTITY: resolved from `authToken`, same reasoning as verify-email-
// code.js — never a bare client-claimed username, since this endpoint
// triggers a real outbound email to a real address and this app's own
// per-IP rate limit below only bounds ONE source's request volume, not
// who it's allowed to target.
//
// A no-op-if-already-verified response (not an error) — re-sending a code
// to an account that's already verified is harmless but pointless; the
// client-side sheet should never reach this state (it only ever shows for
// an unverified account), but this is defense-in-depth against a stale
// sheet/race, not a client bug worth surfacing.
//
// Rate limiting: per-IP daily cap, same lib/rate-limit.js helper every
// other public-ish endpoint here uses. Deliberately its OWN, separate
// bucket/env var from register-account.js's MAX_REGISTRATIONS_PER_IP_PER_DAY
// — this is a different action (an already-signed-in account asking for a
// resend, not a brand-new signup attempt) and shouldn't share (or be
// starved by) that budget.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 auth_token_required
//   E4 invalid_or_expired_token
//   E5 rate_limited

var accountAuthToken = require('./lib/account-auth-token');
var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');
var verificationEmailSender = require('./lib/verification-email-sender');

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

  var authToken = (payload.authToken || '').trim();
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: auth_token_required' }) };
  }

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired_token' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_VERIFICATION_RESENDS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 20;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'resend-verification-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E5: rate_limited' }) };
  }

  var account = await accountStore.getByUsername(event, auth.username);
  if (!account || !account.email) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'no_account_email' }) };
  }
  if (account.emailVerified !== false) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'already_verified' }) };
  }

  await verificationEmailSender.sendVerificationEmail(event, { username: account.username, email: account.email, auto: !!payload.auto });
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
