// netlify/functions/check-email.js
//
// POST { email } -> { ok:true, available:true|false }
//
// Cheap, read-only "does an account already exist under this email"
// check — added to close the money-leak in wizard.html's/start.html's
// "generate during signup" funnel (tracker item
// for-product-money-leak-blocked-signups-e-v2g1vi): both funnels used to
// fire start-pending-generation.js (a real, billed fal.ai submission) the
// moment an email was captured, fully in parallel with the signup step —
// so a blocked signup (register-account.js's E8 email_taken, discovered
// only later) had already burned a real generation for a dream nobody
// would ever own. This endpoint lets both funnels ask "is this email even
// usable" BEFORE firing that real generation, instead of only finding out
// after the money is already spent.
//
// Reuses lib/account-store.js's existing getByEmail() lookup — the exact
// same read register-account.js's createAccount() already does to decide
// email_taken — rather than reimplementing any lookup/normalization logic
// here (see that file's own header comment on why getByEmail is the
// canonical, defense-in-depth-checked way to answer "does this email
// resolve to a real account").
//
// Enumeration-safe by design: the response is ONLY { ok, available } —
// never a username, never any other account field, regardless of which
// account (if any) the email resolves to. Still, "does this email have an
// account" is itself a real user-enumeration surface (an attacker could
// script through a wordlist of addresses), so this is rate-limited
// per-IP, same shape/convention as register-account.js's own E9 (a single
// daily per-IP cap via lib/rate-limit.js — no per-identifier/per-email
// bucket, for the same reasoning register-account.js's own header comment
// gives: the thing under contention here is which addresses exist, not a
// single identifier worth bucketing separately).
//
// Error codes (local to this function, small-number scheme like
// generate-avatar.js/request-magic-link.js):
//   E1 method_not_allowed — verb other than POST
//   E2 invalid_json       — POST body wasn't valid JSON
//   E3 email_required     — missing/blank email (post-normalization)
//   E4 rate_limited        — MAX_CHECK_EMAIL_PER_IP_PER_DAY exceeded for today
//
// Callers (wizard.html's renderContact, start.html's screen-13 Continue
// handler) treat ANY non-200/malformed/rate-limited response as "resilient
// fallback" — fail OPEN to the existing behavior (proceed as if available)
// rather than blocking a real user's funnel over this ancillary check
// failing, same philosophy as start-pending-generation.js's own resilient-
// fallback comments. This file's job is only to answer correctly when it
// CAN — it is not the funnel's only line of defense (register-account.js's
// own E8 check is still authoritative and still runs regardless).

var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');

// 2x register-account.js's own MAX_REGISTRATIONS_PER_IP_PER_DAY default
// (20) rather than an unreviewed round number — this endpoint is cheaper
// per-request than a real signup (no account write), so some headroom
// above that bar is reasonable for legitimate multi-attempt use (a typo'd
// email, a funnel Back+resubmit), but it should stay in the same
// ballpark, not an order of magnitude more permissive, given this is a
// real enumeration surface with a lower per-attempt cost to an attacker
// than signup itself (review finding on
// for-product-money-leak-blocked-signups-e-v2g1vi).
var MAX_CHECK_EMAIL_PER_IP_PER_DAY_DEFAULT = 40;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E2: invalid_json' }) };
  }

  var email = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: email_required' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_CHECK_EMAIL_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = MAX_CHECK_EMAIL_PER_IP_PER_DAY_DEFAULT;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'check-email-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E4: rate_limited' }) };
  }

  // getByEmail() normalizes (entitlements.normalizeEmail — trim+lowercase,
  // the same helper register-account.js/entitlements.js already use) and
  // applies its own defense-in-depth "record.email must still match"
  // check before ever handing back a hit — see account-store.js's header
  // comment. Reused as-is, not reimplemented.
  var existing = await accountStore.getByEmail(event, email);
  return { statusCode: 200, body: JSON.stringify({ ok: true, available: !existing }) };
};
