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
//   200 { claimed: true,  balance, streak, nextClaimAt, amountClaimed } —
//        a genuine claim just landed. amountClaimed (2026-07-28 first-
//        claim-bonus amendment — see lib/entitlements.js's
//        FIRST_CLAIM_BONUS_AMOUNT doc comment) is the REAL amount just
//        credited (100 on a genuine first-ever claim for this account, 20
//        otherwise) — the client shows this, never assumes a flat 20.
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
//   500 { error: 'E5: claim_write_failed' } — claimDailyTokens genuinely
//        exhausted its blobsRetry attempts without ever confirming the
//        write landed (see that function's own doc comment) — a real,
//        if rare, transient failure, not a normal "not yet claimable"
//        outcome. The client's existing "Couldn't claim right now — try
//        again in a moment" copy already covers this.
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
//   E5 claim_write_failed — see the 500 response above
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
//
// FIRST-EVER-CLAIM EXEMPTION (2026-08-05, round 2 of tracker item
// for-product-p1-urgent-fresh-signup-can-d-qhrrqy — founder-hit fresh-
// signup dead-end). Round 1 closed the permanent-0 hole in syncTokens'
// init branch (see entitlements.js), on the documented assumption that a
// capped-at-signup account's relief valve is "it can still claim its
// first +100 immediately". That relief valve turned out to be blockable
// by THIS SAME "claim-ip" bucket above — shared across every claim ANY
// account makes from an IP, whether a genuine daily repeat or a
// never-before-claimed brand-new account. A founder (or any user behind a
// shared/CGNAT/mobile-carrier IP — our paid traffic is mobile webview)
// doing several same-day test signups can burn through this bucket on
// OTHER accounts' activity alone, then hit 429 on the ONE claim that was
// actually supposed to rescue a capped signup.
//
// Fix: a request whose email has NEVER completed ANY daily claim before
// (entitlements.isFirstEverClaimEligible — see that function's own doc
// comment) is checked against SEPARATE, more generous buckets
// ("claim-ip-first"/"claim-email-first") instead of the general
// "claim-ip"/"claim-email" ones. Deliberately NOT an unconditional
// exemption (unlimited first claims per IP would reopen exactly the kind
// of per-IP farming surface MAX_TOKEN_GRANTS_PER_IP_PER_DAY exists to
// close) — still bounded, just by a higher, purpose-fit ceiling. Why this
// is safe to size more generously than the general bucket:
//   1. This exemption only ever applies to an account's OWN literal
//      first-ever claim — the moment it lands, `firstClaimAt`/
//      `tokens.lastClaimAt` are stamped (see claimDailyTokens), and every
//      later attempt for that SAME email is a real repeat, correctly
//      routed to the tighter general buckets. There's no way to reuse
//      this bucket twice for one account.
//   2. Farming still requires farming brand-new EMAILS in the first
//      place — client-side signup is free (js/store.js), but each new
//      email's tokens still funnel through syncTokens' own init branch,
//      and a farmed account only ever gets FIRST_CLAIM_BONUS_AMOUNT (100
//      tokens) via this path, never the 320-token signup grant (which
//      stays gated by MAX_TOKEN_GRANTS_PER_IP_PER_DAY, default 5,
//      untouched by this change) — meaningfully lower stakes than the
//      init cap this bucket sits downstream of, matching this file's own
//      FIRST_CLAIM_BONUS_AMOUNT doc comment's existing reasoning for why
//      the bonus itself was never bound BY the general claim-ip bucket in
//      the first place.
//   3. The per-EMAIL twin ("claim-email-first") still bounds retry-
//      hammering any ONE email's first-claim race, same shape as the
//      general claim-email bucket already does for repeats.
var entitlements = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var MAX_CLAIMS_PER_IP_PER_DAY_DEFAULT = 20;
var MAX_FIRST_CLAIMS_PER_IP_PER_DAY_DEFAULT = 50;

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

  var maxFirstClaimsPerDay = parseInt(process.env.MAX_FIRST_CLAIMS_PER_IP_PER_DAY, 10);
  if (!maxFirstClaimsPerDay || maxFirstClaimsPerDay <= 0) maxFirstClaimsPerDay = MAX_FIRST_CLAIMS_PER_IP_PER_DAY_DEFAULT;

  // See this file's header comment ("FIRST-EVER-CLAIM EXEMPTION") for the
  // full reasoning. A stale read here (this record's real claim history
  // hasn't propagated to THIS read yet) can only ever misroute a request
  // to the wrong bucket, never change what claimDailyTokens itself
  // actually grants — that decision is remade fresh, off its own read,
  // independently of this.
  var isFirstEverClaim = entitlements.isFirstEverClaimEligible(await entitlements.getEntitlement(event, email));
  var ipScope = isFirstEverClaim ? 'claim-ip-first' : 'claim-ip';
  var emailScope = isFirstEverClaim ? 'claim-email-first' : 'claim-email';
  var scopedLimit = isFirstEverClaim ? maxFirstClaimsPerDay : maxPerDay;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, ipScope, ip, scopedLimit);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited: too many claim attempts from this network today, try again tomorrow' }) };
  }
  var emailLimit = await rateLimit.checkAndIncrement(event, emailScope, email, scopedLimit);
  if (!emailLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited: too many claim attempts on this account today, try again tomorrow' }) };
  }

  var result;
  try {
    result = await entitlements.claimDailyTokens(event, email);
  } catch (e) {
    // claimDailyTokens only ever throws on genuine blobsRetry exhaustion
    // (see its own doc comment) — everything else it handles itself and
    // returns normally (including "not yet claimable", a 200, not this).
    return { statusCode: 500, body: JSON.stringify({ error: 'E5: claim_write_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
  return { statusCode: 200, body: JSON.stringify(result) };
};
