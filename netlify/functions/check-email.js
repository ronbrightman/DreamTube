// netlify/functions/check-email.js
//
// POST { email } -> { ok:true, available:true|false, deliverable:true|false }
//
// Cheap, read-only "does an account already exist under this email" check
// — added to close the money-leak in wizard.html's/start.html's "generate
// during signup" funnel (tracker item
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
// `deliverable` (tracker item for-product-signup-email-micro-step-foun-
// ns8uve): a lightweight, no-vendor MX/A/AAAA existence check on the
// email's domain — see lib/email-domain-check.js's own header comment for
// the full reasoning (fail-open by design; only a domain with NEITHER an
// MX NOR an A/AAAA record reports false). Bundled into this SAME round
// trip (run in parallel with the account-availability lookup below via
// Promise.all, not a second request) rather than a separate endpoint,
// since both callers (start.html's screen-13 email step, wizard.html's
// Contact step) need both answers at the exact same "should we advance
// past the email field" decision point, and there is no reason to make a
// visitor wait on two sequential network round trips for one decision.
// A malformed address with no extractable domain (should already be
// caught client-side by the format check both callers run first, but
// checked here too as defense-in-depth) skips the DNS lookup entirely and
// reports deliverable:false directly.
//
// Enumeration-safe by design: the response is ONLY { ok, available,
// deliverable } — never a username, never any other account field,
// regardless of which account (if any) the email resolves to. Still,
// "does this email have an account" is itself a real user-enumeration
// surface (an attacker could script through a wordlist of addresses), so
// this is rate-limited per-IP, same shape/convention as
// register-account.js's own E9 (a single daily per-IP cap via
// lib/rate-limit.js — no per-identifier/per-email bucket, for the same
// reasoning register-account.js's own header comment gives: the thing
// under contention here is which addresses exist, not a single
// identifier worth bucketing separately).
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
var emailDomainCheck = require('./lib/email-domain-check');

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
  //
  // Domain extraction for the deliverability check: a malformed address
  // with no '@' or an empty domain portion (the client-side format check
  // in start.html/wizard.html should already have caught this before ever
  // calling here — this is defense-in-depth, same posture as this
  // codebase's other duplicated format checks) skips the DNS lookup
  // outright and reports deliverable:false directly, same end result as
  // a lookup that resolved to "no records".
  var atIndex = email.indexOf('@');
  var domain = atIndex > -1 ? email.slice(atIndex + 1).trim() : '';
  var domainLooksValid = !!domain && domain.indexOf('.') > 0;

  var results = await Promise.all([
    accountStore.getByEmail(event, email),
    domainLooksValid ? emailDomainCheck.isDomainDeliverable(domain) : Promise.resolve(false)
  ]);
  var existing = results[0];
  var deliverable = results[1];
  return { statusCode: 200, body: JSON.stringify({ ok: true, available: !existing, deliverable: deliverable }) };
};
