// netlify/functions/lib/resend-webhook-verify.js
//
// Verifies the Svix-format HMAC signature Resend puts on every outgoing
// webhook delivery (used by resend-bounce-webhook.js). Resend's webhook
// system is built on Svix (confirmed via Resend's own docs — "Managing
// Webhooks", resend.com/docs/webhooks/introduction, and Svix's own manual-
// verification docs, docs.svix.com/receiving/verifying-payloads/how-manual
// — fetched 2026-08-02, since this codebase had no prior bounce-webhook
// integration to copy from):
//
//   Headers on every webhook POST: svix-id, svix-timestamp, svix-signature.
//   Verification:
//     1. secret = the part of RESEND_WEBHOOK_SECRET after its "whsec_"
//        prefix, base64-decoded — this is the actual HMAC key, not the raw
//        env var string.
//     2. signedContent = "<svix-id>.<svix-timestamp>.<raw request body>"
//        (svix-id and svix-timestamp taken verbatim from their headers,
//        joined with a literal "." — the body must be the untouched raw
//        bytes, same "signing covers the raw body, not a re-serialized
//        JSON.stringify" caveat lib/fal-webhook-verify.js's own header
//        comment already makes for a structurally identical reason).
//     3. expectedSignature = base64(HMAC-SHA256(secret, signedContent)).
//     4. svix-signature is a space-delimited list of "v1,<base64
//        signature>" entries (Svix rotates/supports multiple signing
//        versions) — valid if expectedSignature constant-time-matches ANY
//        entry's signature portion (after stripping its "v1," prefix).
//   Replay protection: svix-timestamp must be within a small clock-skew
//   window of "now" — same MAX_CLOCK_SKEW_SECONDS reasoning/value as
//   lib/fal-webhook-verify.js's own identical check.
//
// Split out into its own pure-verification module for the same reason
// lib/fal-webhook-verify.js is: unit-testable against a locally-computed
// HMAC (see test/resend-bounce-webhook.test.js) with no real network call
// or real Resend webhook secret needed.

var crypto = require('crypto');

var MAX_CLOCK_SKEW_SECONDS = 300;
var SECRET_PREFIX = 'whsec_';

/**
 * Verifies a Resend/Svix webhook request. `headers` is the raw
 * lowercased-or-not header map from the Lambda event (read both cases
 * defensively — see lib/fal-webhook-verify.js's identical `h()` helper for
 * the same reasoning); `rawBody` is the exact string Resend sent (must be
 * untouched, not a re-serialized JSON.stringify — see header comment);
 * `secret` is the raw RESEND_WEBHOOK_SECRET env var value, "whsec_..."
 * prefix and all.
 *
 * @returns {{ ok: boolean, error: string|null }}
 */
function verifySignature(headers, rawBody, secret, nowSeconds) {
  headers = headers || {};
  function h(name) {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  }

  if (!secret || typeof secret !== 'string' || secret.indexOf(SECRET_PREFIX) !== 0) {
    return { ok: false, error: 'missing_or_malformed_secret' };
  }

  var svixId = h('svix-id');
  var svixTimestamp = h('svix-timestamp');
  var svixSignature = h('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, error: 'missing_signature_headers' };
  }

  var now = typeof nowSeconds === 'number' ? nowSeconds : Math.floor(Date.now() / 1000);
  var ts = parseInt(svixTimestamp, 10);
  if (!isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, error: 'timestamp_out_of_range' };
  }

  var key;
  try {
    key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  } catch (e) {
    return { ok: false, error: 'malformed_secret' };
  }
  if (!key.length) return { ok: false, error: 'malformed_secret' };

  var signedContent = svixId + '.' + svixTimestamp + '.' + (rawBody || '');
  var expected = crypto.createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');
  var expectedBuf = Buffer.from(expected, 'base64');

  var candidates = String(svixSignature).split(' ');
  for (var i = 0; i < candidates.length; i++) {
    var entry = candidates[i];
    var commaIdx = entry.indexOf(',');
    var raw = commaIdx === -1 ? entry : entry.slice(commaIdx + 1);
    var candidateBuf;
    try {
      candidateBuf = Buffer.from(raw, 'base64');
    } catch (e) {
      continue;
    }
    if (candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true, error: null };
    }
  }
  return { ok: false, error: 'signature_verification_failed' };
}

module.exports = { verifySignature, MAX_CLOCK_SKEW_SECONDS, SECRET_PREFIX };
