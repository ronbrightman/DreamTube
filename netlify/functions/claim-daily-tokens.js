// netlify/functions/claim-daily-tokens.js
//
// POST { email } -> the daily token claim (2026-07-28, founder-approved,
// replacing the old lazy background +20/24h drip in lib/entitlements.js —
// see that file's header comment for the full mechanism/history and the
// tracker items this shipped from: for-growth-research-founder-directed-
// dai-kguvk3's proposal, approved on for-product-build-the-daily-token-
// claim--fngrwd).
//
// This is a thin HTTP wrapper around lib/entitlements.js's claimDailyTokens
// — see that function's own doc comment for the actual claim/streak/
// atomic-write logic. Everything below is request validation + rate
// limiting only.
//
// Response shapes:
//   200 { claimed: true,  balance, streak, nextClaimAt } — a genuine claim
//        just landed.
//   200 { claimed: false, nextClaimAt }                  — not yet
//        claimable (the 20h rolling cooldown hasn't elapsed). This is
//        DELIBERATELY a 200, not a 4xx/E-code — a client tapping the claim
//        chip/sheet slightly early (a stale cached tokenStatus, a race with
//        another open tab) is a normal, expected outcome the UI should
//        just quietly reflect, not an error condition to log/alert on.
//   400 { error: 'E1: ...' } / 405 { error: ... } — malformed request, see
//        the error codes below.
//   429 { error: 'E4: rate_limited: ...' } — see the rate-limiting doc
//        block below.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as get-token-status.js/register-account.js — a standalone function, not
// part of generate-video.js's E1xx/E2xx generation-flow chain):
//   E1 method_not_allowed — verb other than POST
//   E2 invalid_json       — POST body wasn't valid JSON
//   E3 email_required     — no email (or one that normalizes to empty) in
//                            the body — there is nothing to key a claim on
//                            without one, same "unidentifiable caller"
//                            posture lib/entitlements.js's own functions
//                            already take
//   E4 rate_limited       — MAX_CLAIMS_PER_IP_PER_DAY (or the per-email
//                            twin) exceeded for today
//
// Rate limiting: its OWN bucket ("claim-ip"/"claim-email"), scoped
// separately from generate-video.js's/generate-image.js's "ip"/"email"
// generation buckets and register-account.js's "register-ip" bucket — same
// per-IP + per-email pairing generate-image.js's own handler uses (see that
// file). This is a belt-and-suspenders anti-abuse guard, NOT the real
// grant guard — claimDailyTokens' own 20h server-clock cooldown is what
// actually stops double-claiming (see lib/entitlements.js). The rate limit
// exists only to stop a scripted client from hammering this endpoint
// (retrying every second hoping to win a race, or probing many emails from
// one IP) — a legitimate daily claimer needs at most 1 successful call/day
// plus a small number of "not yet claimable" checks, so the default limit
// (20/day) sits comfortably above any real usage while still bounding a
// scripted attacker.
var entitlements = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var MAX_CLAIMS_PER_IP_PER_DAY_DEFAULT = 20;

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

  var email = entitlements.normalizeEmail(payload.email);
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: email_required' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_CLAIMS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = MAX_CLAIMS_PER_IP_PER_DAY_DEFAULT;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'claim-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited: too many claim attempts from this network today, try again tomorrow' }) };
  }
  var emailLimit = await rateLimit.checkAndIncrement(event, 'claim-email', email, maxPerDay);
  if (!emailLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited: too many claim attempts on this account today, try again tomorrow' }) };
  }

  var result = await entitlements.claimDailyTokens(event, email);
  return { statusCode: 200, body: JSON.stringify(result) };
};
