// netlify/functions/claim-install-bonus.js
//
// POST { email } -> the "Make DreamTube yours" verified-install +100 token
// bonus (tracker item for-product-build-ship-founder-approved--9ta1j0,
// "Home round 4" — founder-approved home-mock5-x7q4.html's Make-it-yours
// setup card). Grants ONCE per account, ever, via lib/entitlements.js's
// applyAchievementGrant — the SAME idempotent write-then-verify marker
// mechanism FIRST_CLAIM_BONUS_AMOUNT/the achievement ledger already use,
// reused here rather than a parallel one-off "already claimed" flag.
//
// WHO VERIFIES THE INSTALL: the client (home.html's Make-it-yours card)
// only ever calls this once DreamStore.getInstallVerified() is already
// true — a real signal (this exact page loading in `display-mode:
// standalone`, or Android's `appinstalled` firing — see js/pwa.js) captured
// BEFORE this request is ever made, not a bare "I promise I installed it"
// checkbox. This endpoint does NOT re-verify that signal server-side (there
// is nothing server-observable about a client's display-mode) — per the
// tracker item's own explicit call: "client-attested is an accepted signal
// at this reward size" (+100 tokens, the same order of magnitude as a
// single daily claim). The real anti-abuse guard here is the SAME one
// FIRST_CLAIM_BONUS_AMOUNT already relies on: this can only ever pay out
// once per account, ever, so the worst a scripted client can do is claim it
// once early — never repeatedly.
//
// Response shapes:
//   200 { granted: true, balance }   — a genuine grant just landed.
//   200 { granted: false }           — this account already claimed it
//        (a safe, expected no-op — same "not an error" posture
//        claim-daily-tokens.js's `claimed:false` already established).
//   400 { error: 'E1: ...' } / 405 { error: ... } — malformed request.
//   429 { error: 'E4: rate_limited: ...' } — see the rate-limiting doc
//        block below.
//   500 { error: 'E5: claim_write_failed' } — applyAchievementGrant
//        genuinely exhausted its blobsRetry attempts without ever
//        confirming the write landed (see that function's own doc
//        comment) — a real, if rare, transient failure.
//
// Error codes (local to this function, same small-number-scheme convention
// as claim-daily-tokens.js — a standalone function, not part of
// generate-video.js's E1xx/E2xx generation-flow chain):
//   E1 method_not_allowed — verb other than POST
//   E2 invalid_json       — POST body wasn't valid JSON
//   E3 email_required     — no email (or one that normalizes to empty) in
//                            the body — accounts created before email was
//                            required have nothing to key this grant on;
//                            same "unidentifiable caller" posture every
//                            other entitlements.js-backed endpoint takes
//   E4 rate_limited       — MAX_CLAIMS_PER_IP_PER_DAY (or the per-email
//                            twin) exceeded for today
//   E5 claim_write_failed — see the 500 response above
//
// Rate limiting: its OWN bucket ("install-bonus-ip"/"install-bonus-email"),
// scoped separately from claim-daily-tokens.js's "claim-ip"/"claim-email"
// buckets — this is a belt-and-suspenders anti-abuse guard, NOT the real
// grant guard (applyAchievementGrant's own once-per-account marker is what
// actually stops double-crediting) — it exists only to bound a scripted
// client hammering this endpoint. A legitimate claimer needs at most one
// successful call, ever, so a modest daily cap sits comfortably above any
// real usage while still bounding an attacker.
var entitlements = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var MAX_CLAIMS_PER_IP_PER_DAY_DEFAULT = 20;
var INSTALL_BONUS_AMOUNT = 100;
var ACHIEVEMENT_ID = 'home_install_verified';

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
  var ipLimit = await rateLimit.checkAndIncrement(event, 'install-bonus-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited: too many claim attempts from this network today, try again tomorrow' }) };
  }
  var emailLimit = await rateLimit.checkAndIncrement(event, 'install-bonus-email', email, maxPerDay);
  if (!emailLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited: too many claim attempts on this account today, try again tomorrow' }) };
  }

  var result;
  try {
    result = await entitlements.applyAchievementGrant(event, email, ACHIEVEMENT_ID, { type: 'tokens', amount: INSTALL_BONUS_AMOUNT });
  } catch (e) {
    // applyAchievementGrant only ever throws on genuine blobsRetry
    // exhaustion (see its own doc comment) — everything else it handles
    // itself and returns normally.
    return { statusCode: 500, body: JSON.stringify({ error: 'E5: claim_write_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
  return { statusCode: 200, body: JSON.stringify({ granted: !!result.granted, balance: result.balance }) };
};
