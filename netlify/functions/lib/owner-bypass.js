// netlify/functions/lib/owner-bypass.js
//
// SAFE owner bypass for the per-IP/per-email GENERATION rate-limit counters
// only -- tracker.html's for-product-founder-hit-the-per-ip-gener-7mjq2l
// item: the founder hit E409 ("too many generations from this network
// today") testing his own product, because MAX_GENERATIONS_PER_IP_PER_DAY
// (lib/rate-limit.js) has never had any owner exemption -- an audit
// confirmed no bypass exists on any generation gate today. This module is
// the fix, built to the task's own explicit, non-negotiable shape:
//
//   - Verifying "is this really the owner" must NEVER be client-supplied
//     email alone (the pattern admin-paywall-toggle.js/owner-topup-
//     tokens.js already use for their own, lower-stakes controls -- see
//     each file's own header comment). Unlike those two, this bypass sits
//     directly upstream of REAL fal.ai generation spend -- an attacker who
//     simply claimed OWNER_EMAIL in a request body would get free,
//     rate-limit-uncapped real generation spend, bounded ONLY by the
//     unconditional E112/E412 token gate and DAILY_SPEND_CAP_USD shared
//     with every other caller. That's strictly MORE dangerous than this
//     codebase's existing "trust the client email" tradeoff, not a lateral
//     move -- so this reuses the REAL, server-verified password check
//     instead (lib/account-store.js's verifyLogin, the exact pattern
//     send-first-dream-email.js just shipped in commit c6a7152).
//   - This module ONLY ever gates issuance of a short-lived bypass TOKEN --
//     it has no idea what the token is later used for, and holds no
//     reference to spend-guard.js/entitlements.js at all. The actual scope
//     limit (rate-limit counters only -- never the token-balance gate,
//     never DAILY_SPEND_CAP_USD) is enforced entirely at the call sites in
//     generate-video.js/generate-image.js/lib/entitlements.js, which never
//     pass any bypass signal anywhere near spend-guard.js's
//     checkAndReserve -- see those files' own comments for exactly where
//     the line is drawn.
//
// netlify/functions/verify-owner-bypass.js is the only intended caller of
// verifyOwnerCredentials/createBypassToken -- see that file for the actual
// HTTP endpoint, its own rate limiting (password-guessing protection, same
// two-bucket shape as account-login.js), and its error codes.
//
// TOKEN: a random 32-byte value (crypto.randomBytes, same shape as
// lib/dream-share-token.js's/lib/pending-dream-token.js's own tokens --
// not a JWT/HMAC construction; this codebase has no existing signing-
// secret convention and inventing one for a single feature would be new,
// unnecessary machinery), stored in a dedicated Blobs store
// ("dreamtube-owner-bypass-tokens") with a short TTL. SHORT-lived per the
// task's own instruction -- unlike dream-share-token.js's 30-day "come
// back whenever" link, this is a standing exemption from a security
// control, so it should need to be re-earned regularly rather than linger
// client-side indefinitely. 12 hours: long enough to cover one real
// testing session without the founder re-entering his password every few
// generations, short enough that a leaked/stale token (copied out of
// localStorage, a stale browser tab left open) stops working well within a
// day.
//
// Revisitable (not single-use) within its TTL, same reasoning as
// dream-share-token.js's own verifyToken -- a token is meant to be sent
// with EVERY generation request during the session, not consumed once.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var accountStore = require('./account-store');
var { normalizeEmail } = require('./entitlements');

var STORE_NAME = 'dreamtube-owner-bypass-tokens';
var TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Checks `username`/`password` against the REAL, server-side account store
 * (lib/account-store.js's verifyLogin -- the same real-password bar
 * account-login.js already uses for ordinary login) AND that the resolved
 * account's own on-file email matches OWNER_EMAIL (normalized). Returns
 * { ok:true, record } or { ok:false, error }, error one of:
 *   'owner_not_configured' -- OWNER_EMAIL isn't set in this environment,
 *                             so no request could ever be authorized
 *   'not_found'            -- no account under that username/email at all
 *   'incorrect_password'   -- account found, password didn't match
 *   'not_owner'            -- password matched a REAL account, but that
 *                             account's own email isn't OWNER_EMAIL -- a
 *                             genuine, correctly-authenticated user who
 *                             simply isn't the owner
 *
 * Never treats a client-supplied `email` field as authoritative -- there
 * isn't one in this function's contract at all. Ownership is decided
 * entirely from the account record verifyLogin resolves server-side,
 * exactly like send-first-dream-email.js resolves the send-to address
 * rather than trusting anything the client claims.
 */
async function verifyOwnerCredentials(event, username, password) {
  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) return { ok: false, error: 'owner_not_configured' };

  var loginCheck = await accountStore.verifyLogin(event, username, password);
  if (!loginCheck.ok) return { ok: false, error: loginCheck.error };

  if (normalizeEmail(loginCheck.record.email) !== ownerEmail) {
    return { ok: false, error: 'not_owner' };
  }
  return { ok: true, record: loginCheck.record };
}

/**
 * Mints + stores a fresh short-lived bypass token. Returns
 * { token, expiresAt }. Only ever meant to be called after
 * verifyOwnerCredentials has already returned ok:true -- this function
 * itself performs no auth check, it just issues a credential once the
 * caller has already established the request is really the owner.
 */
async function createBypassToken(event) {
  var token = crypto.randomBytes(32).toString('hex');
  var expiresAt = Date.now() + TTL_MS;
  connectLambda(event);
  await store().setJSON(token, { createdAt: Date.now(), expiresAt: expiresAt });
  return { token: token, expiresAt: expiresAt };
}

/**
 * Checks whether `token` is a live (previously issued, unexpired) owner
 * bypass token. Returns { ok:true } or { ok:false } -- deliberately fails
 * CLOSED on anything unexpected (missing/malformed/expired token, or no
 * token at all): "bypass active" only ever comes from an explicit, live
 * record here, never assumed. Revisitable -- does NOT delete the token on
 * a successful check, see header comment for why (meant to be sent with
 * every generation request during the session).
 */
async function verifyBypassToken(event, token) {
  if (!token || typeof token !== 'string') return { ok: false };
  connectLambda(event);
  var record = await store().get(token, { type: 'json' });
  if (!record || !record.expiresAt || record.expiresAt < Date.now()) return { ok: false };
  return { ok: true };
}

module.exports = { STORE_NAME, TTL_MS, verifyOwnerCredentials, createBypassToken, verifyBypassToken };
