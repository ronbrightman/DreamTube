// netlify/functions/create-session-transfer.js
//
// POST { username, password } -> mints a single-use, ~15-minute session-
// transfer token (lib/session-transfer-token.js) that lets an ALREADY
// validly-signed-in user carry that session into a real external browser
// when escaping a Facebook/Instagram in-app webview via the host app's
// own "open in browser" action (see js/store.js's
// maintainSessionTransferUrl, called from processing.html/result.html) —
// localStorage doesn't cross from the webview into the real browser, so
// without this the user lands there signed OUT.
//
// AUTHENTICATION (read carefully — this is the load-bearing security
// decision in this whole feature): requires the account's REAL, CURRENT
// password, verified via accountStore.verifyLogin — the exact same bar
// account-login.js itself uses. This is deliberately NOT the "bare
// client-trusted email" boundary admin-paywall-toggle.js documents for
// its own POST (a single hardcoded OWNER_EMAIL gating one narrow,
// non-identity action, or generate-video.js's own per-request email that
// only ever touches a token balance keyed to that email). A session-
// transfer token, once minted, lets its holder become FULLY logged in AS
// WHATEVER ACCOUNT IT NAMES (see verify-session-transfer.js) — able to
// publish/unpublish/delete that account's dreams, spend its tokens,
// change its email, etc. That is a meaningfully BIGGER grant than
// anything a bare client-claimed email/username unlocks anywhere else in
// this codebase. Every account's @handle is public (shown on every
// Explore feed row) — see send-first-dream-email.js's own identical
// reasoning and its own review-fixed history, which this mirrors
// directly. Skipping a real password check here would let ANYONE mint a
// token that signs them in as any known username, with zero
// authentication — a genuine account-takeover vector. This is exactly
// the "grants more than the accepted client-trusted-identity boundary"
// case this feature's own build task asked to be caught rather than
// built around, so this endpoint requires a real password instead of the
// bare-email shape the task sketched. js/store.js's
// mintSessionTransferToken() supplies the password from THIS account's
// own already-cached local credential (state.accounts[key].password —
// the same plaintext-local account model send-first-dream-email.js's own
// client call site already relies on), so this adds no new re-auth
// prompt for the legitimate caller — it only ever runs silently, in the
// background, for an account that is already genuinely signed in on this
// device.
//
// Once verified, the token is minted for the VERIFIED record's OWN
// username/email (verifyLogin's return shape) — never the raw,
// unverified client-supplied username, and email is never taken from the
// client at all.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_fields      — username/password not both present
//   E4 incorrect_password  — real account-login.js-grade check failed (or
//                             no server-side account record exists at
//                             all — a legacy, never-backfilled local-only
//                             account degrades the same way: no token,
//                             client falls back to no session-transfer
//                             URL, exactly as if this feature didn't run)
//   E5 rate_limited         — see rate-limiting note below

var accountStore = require('./lib/account-store');
var sessionTransferToken = require('./lib/session-transfer-token');
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

  var username = (payload.username || '').trim();
  var password = typeof payload.password === 'string' ? payload.password : '';
  if (!username || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }

  // Round-2 review fix: a per-IP-only cap doesn't stop an attacker who
  // knows a target's @handle (public on every Explore row) from
  // password-guessing that ONE account by rotating IPs, up to the per-IP
  // cap on each one — exactly the gap account-login.js's own two-bucket
  // design exists to close, and this endpoint checks a password against
  // the same real account, so it needs the same two buckets, not a
  // lighter one. The earlier "no legitimate high-frequency per-account
  // traffic to distinguish from an attack" reasoning was backwards: that
  // absence is a reason for a STRICTER per-identifier cap, not none.
  var maxPerIpPerDay = parseInt(process.env.MAX_SESSION_TRANSFER_ATTEMPTS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 100;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_SESSION_TRANSFER_ATTEMPTS_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 30;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'session-transfer-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E5: rate_limited' }) };
  }
  // Same canonical-username-resolution shape as account-login.js's own
  // identifierKey (falls back to the raw, lowercased input if no account
  // resolves at all, so an attacker can't dodge this bucket by guessing a
  // username that happens not to exist).
  var canonicalAccount = await accountStore.getByUsername(event, username);
  var identifierKey = canonicalAccount ? canonicalAccount.username : username.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'session-transfer-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E5: rate_limited' }) };
  }

  try {
    var loginCheck = await accountStore.verifyLogin(event, username, password, canonicalAccount ? { record: canonicalAccount } : undefined);
    if (!loginCheck.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: incorrect_password' }) };
    }
    var account = loginCheck.record;
    var token = await sessionTransferToken.createToken(event, account.username, account.email || null);
    return { statusCode: 200, body: JSON.stringify({ ok: true, token: token }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'create_session_transfer_failed: ' + (e && e.message) }) };
  }
};
