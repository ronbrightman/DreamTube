// netlify/functions/lib/fal-webhook-verify.js
//
// Verifies the ED25519 signature on an incoming fal.ai queue webhook
// callback (see dream-webhook.js) — confirmed against fal's own docs
// (https://docs.fal.ai/model-endpoints/webhooks, fetched 2026-07-24):
//
//   Headers on every webhook POST:
//     X-Fal-Webhook-Request-Id, X-Fal-Webhook-User-Id,
//     X-Fal-Webhook-Timestamp (unix epoch seconds), X-Fal-Webhook-Signature
//     (hex-encoded).
//   Verification:
//     1. Timestamp must be within ±300s of now (replay protection).
//     2. message = requestId + "\n" + userId + "\n" + timestamp + "\n" +
//        sha256(raw request body bytes) [hex], each header value taken as-is.
//     3. Signature is ED25519 over that message (UTF-8), verified against
//        any key in fal's JWKS (https://rest.alpha.fal.ai/.well-known/jwks.json
//        — public keys, base64url-encoded, JWK `x` field) — valid if ANY
//        key verifies it (fal rotates keys; there is no single "the" key).
//
// Split out from dream-webhook.js so the pure verification logic (timestamp
// check, message construction, ED25519 verify against a given key list) is
// unit-testable with a locally-generated test keypair (see
// test/dream-webhook.test.js) without any real network call to fal's JWKS
// endpoint in every test — fetchJwks() below is the one function tests
// stub out.

var crypto = require('crypto');

var JWKS_URL = 'https://rest.alpha.fal.ai/.well-known/jwks.json';
var MAX_CLOCK_SKEW_SECONDS = 300;

// Short-TTL in-memory cache (review finding, fixed) — fetchJwks() used to
// hit the network on EVERY single webhook delivery with no caching at
// all, so a transient fal JWKS outage/hiccup lasting longer than fal's own
// webhook retry window (10 attempts over ~2h, per fal's docs) could
// permanently prevent an otherwise-legitimate webhook from ever being
// trusted — every retry would independently re-fail the same fetch.
// Caching for a while, and falling back to a still-cached (if stale) key
// set on a fetch failure rather than throwing outright, closes that gap.
// Module-level (persists only for a warm Netlify Function instance's
// lifetime — a cold start just re-fetches once, no different from
// before this existed). TTL chosen well under fal's own documented JWKS
// max-24h cache guidance, short enough that a real key rotation is still
// picked up promptly.
var JWKS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
var cachedJwks = null;
var cachedAt = 0;

/**
 * Fetches fal's current JWKS, serving a cached copy for up to
 * JWKS_CACHE_TTL_MS. On a fetch failure, falls back to a still-cached
 * (even if past its TTL) key set rather than failing verification
 * outright — see the header comment above for the outage-resilience
 * reasoning. Only throws if there's truly nothing cached yet AND the
 * fetch itself failed.
 */
async function fetchJwks() {
  var now = Date.now();
  if (cachedJwks && (now - cachedAt) < JWKS_CACHE_TTL_MS) {
    return cachedJwks;
  }
  try {
    var res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error('jwks_fetch_failed: http ' + res.status);
    var data = await res.json();
    var keys = Array.isArray(data && data.keys) ? data.keys : [];
    cachedJwks = keys;
    cachedAt = now;
    return keys;
  } catch (e) {
    if (cachedJwks) {
      console.warn('fal-webhook-verify: JWKS refetch failed, serving stale cache (' + (e && e.message) + ')');
      return cachedJwks;
    }
    throw e;
  }
}

/** Test-only: clears the module-level JWKS cache so each test file's own keypair/fetch stub starts from a known-empty cache rather than depending on process/module-load isolation between test files. Harmless in production (nothing calls this outside test/dream-webhook.test.js). */
function resetJwksCacheForTests() {
  cachedJwks = null;
  cachedAt = 0;
}

/** Converts a JWKS OKP/Ed25519 entry's base64url `x` field into a Node KeyObject usable with crypto.verify. */
function publicKeyFromJwk(jwk) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
}

/**
 * Verifies a webhook request's signature. `headers` should be the raw
 * lowercased-or-not header map from the Lambda event (this reads both
 * cases defensively, matching this codebase's existing header-reading
 * convention in rate-limit.js/lib/magic-link.js); `rawBody` is the exact
 * request body string fal sent (must be the untouched raw bytes/string —
 * signing covers the raw body, not a re-serialized JSON.stringify of the
 * parsed object, which could differ in whitespace/key order).
 *
 * @param {object} headers
 * @param {string} rawBody
 * @param {Array<object>} jwks - array of JWK entries (as fetchJwks() returns)
 * @param {number} [nowSeconds] - override "now" for deterministic tests
 * @returns {{ ok: boolean, error: string|null }}
 */
function verifySignature(headers, rawBody, jwks, nowSeconds) {
  headers = headers || {};
  function h(name) {
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  }

  var requestId = h('X-Fal-Webhook-Request-Id');
  var userId = h('X-Fal-Webhook-User-Id');
  var timestamp = h('X-Fal-Webhook-Timestamp');
  var signatureHex = h('X-Fal-Webhook-Signature');

  if (!requestId || !userId || !timestamp || !signatureHex) {
    return { ok: false, error: 'missing_signature_headers' };
  }

  var now = typeof nowSeconds === 'number' ? nowSeconds : Math.floor(Date.now() / 1000);
  var ts = parseInt(timestamp, 10);
  if (!isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, error: 'timestamp_out_of_range' };
  }

  var bodyHash = crypto.createHash('sha256').update(Buffer.from(rawBody || '', 'utf8')).digest('hex');
  var message = Buffer.from([requestId, userId, timestamp, bodyHash].join('\n'), 'utf8');

  var signature;
  try {
    signature = Buffer.from(signatureHex, 'hex');
  } catch (e) {
    return { ok: false, error: 'malformed_signature' };
  }

  var keys = Array.isArray(jwks) ? jwks : [];
  for (var i = 0; i < keys.length; i++) {
    try {
      var publicKey = publicKeyFromJwk(keys[i]);
      if (crypto.verify(null, message, publicKey, signature)) {
        return { ok: true, error: null };
      }
    } catch (e) {
      // A malformed/unsupported JWKS entry shouldn't abort checking the
      // rest of the key set — just skip it and keep trying.
      continue;
    }
  }
  return { ok: false, error: 'signature_verification_failed' };
}

module.exports = { fetchJwks, verifySignature, publicKeyFromJwk, resetJwksCacheForTests, JWKS_URL, MAX_CLOCK_SKEW_SECONDS };
