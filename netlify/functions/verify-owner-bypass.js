// netlify/functions/verify-owner-bypass.js
//
// POST { username, password } -> mints a short-lived owner bypass token
// (see lib/owner-bypass.js) that generate-video.js/generate-image.js honor
// to skip ONLY the per-IP/per-email generation rate-limit counters
// (lib/rate-limit.js's checkAndIncrement calls, scopes 'ip'/'email') and
// the token-init per-IP cap inside lib/entitlements.js's syncTokens -- see
// those files' own comments for exactly what does and does NOT get
// bypassed. Never touches the E112/E412 token-balance gate or
// DAILY_SPEND_CAP_USD (lib/spend-guard.js) -- those stay absolute for
// every caller, owner included, no exceptions. See lib/owner-bypass.js's
// header comment for the full reasoning behind that split.
//
// Real password check via lib/account-store.js's verifyLogin, not a
// client-claimed email -- see lib/owner-bypass.js's header comment for why
// this endpoint can't reuse admin-paywall-toggle.js's/owner-topup-
// tokens.js's lighter "trust the client's email" pattern: those gate a
// boolean flag flip and a self-top-up of the owner's OWN balance, this
// gates an exemption from the control that bounds real fal.ai spend for
// EVERY caller.
//
// Response shapes:
//   200 { ok:true, token, expiresAt }  -- real owner, real password match.
//         `token` is opaque (see lib/owner-bypass.js) and `expiresAt` is
//         an epoch-ms timestamp the client can use to know when to
//         re-verify -- see js/store.js's verifyOwnerBypass/
//         getOwnerBypassToken for how the client stores and re-sends it.
//   403 { ok:false, error: 'E5: forbidden' } -- covers every
//         verifyOwnerCredentials failure (owner_not_configured, not_found,
//         incorrect_password, not_owner) without distinguishing which --
//         same "don't help an attacker enumerate accounts" reasoning
//         send-first-dream-email.js's own single E5 already uses for its
//         own not_found/incorrect_password pair.
//   429 { ok:false, error: 'E4: rate_limited...' } -- see rate-limiting
//         doc block below.
//
// Rate limited on TWO buckets (per-IP AND per-identifier), same shape and
// reasoning as account-login.js's own rate limiting: this is an anonymous
// endpoint checking a caller-supplied password against ONE specific,
// high-value account (the owner's), so the risk isn't just "one source
// hammering the endpoint" but specifically unlimited password-guessing
// against that one account, from anywhere. Both buckets run
// unconditionally, before verifyOwnerCredentials is ever called, so a
// request already over either cap never even reaches the account store.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as account-login.js/admin-paywall-toggle.js):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_fields  -- username/password not both present
//   E4 rate_limited     -- MAX_OWNER_BYPASS_VERIFY_PER_IP_PER_DAY or
//                           MAX_OWNER_BYPASS_VERIFY_PER_IDENTIFIER_PER_DAY
//                           exceeded for today
//   E5 forbidden        -- OWNER_EMAIL not configured, no matching
//                           account, wrong password, or a real account
//                           that simply isn't the owner

var ownerBypass = require('./lib/owner-bypass');
var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');

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

  var username = typeof payload.username === 'string' ? payload.username.trim() : '';
  var password = typeof payload.password === 'string' ? payload.password : '';
  if (!username || !password) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: missing_fields' }) };
  }

  var maxPerIpPerDay = parseInt(process.env.MAX_OWNER_BYPASS_VERIFY_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_OWNER_BYPASS_VERIFY_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'owner-bypass-verify-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E4: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  // Per-identifier bucket keyed on the CANONICAL account (username-then-
  // email resolution, same as account-login.js's own identifierKey) rather
  // than the raw string, for the identical reason that file documents: an
  // attacker who knows both the owner's username and email would otherwise
  // get two independent buckets for the same account.
  var canonicalAccount = await accountStore.getByUsername(event, username);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, username);
  var identifierKey = canonicalAccount ? canonicalAccount.username : username.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'owner-bypass-verify-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E4: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var result = await ownerBypass.verifyOwnerCredentials(event, username, password);
  if (!result.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var issued = await ownerBypass.createBypassToken(event);
  return { statusCode: 200, body: JSON.stringify({ ok: true, token: issued.token, expiresAt: issued.expiresAt }) };
};
