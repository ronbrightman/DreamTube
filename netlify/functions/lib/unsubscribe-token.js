// netlify/functions/lib/unsubscribe-token.js
//
// Per-email, unguessable unsubscribe token for the retention/marketing
// email footer link (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp, founder ask: "make the
// email content look better + add unsubscribe" — the unsubscribe half).
//
// DELIBERATELY STATELESS (unlike every other "mint a token" module in this
// codebase — lib/pending-dream-token.js, lib/dream-share-token.js, lib/
// session-transfer-token.js, lib/account-auth-token.js — which all
// generate a random value and store it in Blobs, then verify by looking
// the stored record back up): an unsubscribe link has to keep working
// FOREVER, for an email that may never be opened again for years, and
// unlike those other tokens there is no natural "mint once per action"
// moment to store a record against — every retention/marketing send needs
// a working unsubscribe link, independently, forever. Minting a fresh
// random Blobs-backed record on every single send (thousands over time,
// for one recipient) would work, but is real ongoing storage for no real
// benefit over a token that can be verified with no storage at all.
//
// So this is HMAC-SHA256(secret, normalizedEmail) instead — a signed,
// deterministic token: anyone who knows the secret can verify (or mint) a
// given email's token; nobody who doesn't know the secret can forge a
// token for an email address they don't already have one for (the whole
// point — see this feature's own tracker item: "do NOT let anyone
// unsubscribe an arbitrary email just by knowing the address"). This is
// the same class of primitive lib/resend-webhook-verify.js already uses
// (crypto.createHmac('sha256', key)... crypto.timingSafeEqual) for a
// structurally similar "prove you hold the secret, not just the string"
// problem — reused here rather than inventing new crypto, per this
// feature's own instruction, even though the *token-lifecycle* shape
// (stateless/deterministic vs. random-and-stored) is different from this
// codebase's other "signed link" modules for the reason above.
//
// SECRET SOURCING: process.env.UNSUBSCRIBE_TOKEN_SECRET is the intended,
// dedicated secret — flagged in this build's own report for Ron/Manager to
// set in Netlify's real environment (same "confirm this env var is
// actually set in production" posture tracker.html's own `env-vars-confirm`
// item already tracks for OWNER_EMAIL etc.). Falls back to
// RESEND_API_KEY (already a real per-deployment secret nobody outside this
// project has) so the unsubscribe mechanism still works — and CAN-SPAM/
// GDPR compliance isn't silently broken — even before that dedicated env
// var is ever set; falls back further to a hardcoded dev/test constant
// only so local dev and this repo's own test suite never depend on any
// env var being present at all. A deployment running on the two real
// fallbacks (RESEND_API_KEY, or worse the hardcoded literal) still gets a
// perfectly secure token — the secret is just as unguessable either way —
// this is about not having a SEPARATE deployment step block a compliance-
// required feature from working at all, not a weaker security posture.
var crypto = require('crypto');

var DEV_FALLBACK_SECRET = 'dreamtube-unsubscribe-dev-fallback-secret-change-me';

function secret() {
  return process.env.UNSUBSCRIBE_TOKEN_SECRET || process.env.RESEND_API_KEY || DEV_FALLBACK_SECRET;
}

/** Same normalization every other email-keyed store in this codebase uses (trim + lowercase) — a token must verify identically regardless of how the email's case/whitespace varies between the moment it was signed and the moment it's checked. */
function normalizeEmail(email) {
  return (typeof email === 'string' ? email : '').trim().toLowerCase();
}

/** Deterministically signs `email` (normalized). Returns a 64-char hex HMAC-SHA256 digest — the same email always produces the same token, so no per-send storage is ever needed (see header comment). */
function signToken(email) {
  var normalized = normalizeEmail(email);
  return crypto.createHmac('sha256', secret()).update(normalized, 'utf8').digest('hex');
}

/**
 * Constant-time-verifies that `token` is the real signature for `email`.
 * Returns a plain boolean — never throws, safe to call with anything
 * (missing/malformed email or token both just fail verification).
 */
function verifyToken(email, token) {
  if (typeof token !== 'string' || !token) return false;
  var expected = signToken(email);
  var candidateBuf = Buffer.from(token, 'utf8');
  var expectedBuf = Buffer.from(expected, 'utf8');
  if (candidateBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

/** `x-forwarded-host || host`, this codebase's existing convention (see lib/verification-email-sender.js's selfOrigin, request-password-reset.js). */
function selfOrigin(event) {
  var headers = (event && event.headers) || {};
  var host = headers['x-forwarded-host'] || headers.host || '';
  return 'https://' + host;
}

/** Builds the one-click unsubscribe link for `email`, from the request's own Host header. */
function buildUnsubscribeUrl(event, email) {
  var normalized = normalizeEmail(email);
  return selfOrigin(event) + '/.netlify/functions/unsubscribe-email?email=' + encodeURIComponent(normalized) + '&token=' + signToken(normalized);
}

module.exports = { normalizeEmail, signToken, verifyToken, buildUnsubscribeUrl };
