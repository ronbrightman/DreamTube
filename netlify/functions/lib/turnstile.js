// netlify/functions/lib/turnstile.js
//
// Cloudflare Turnstile server-side verification — the real half of
// generate-video.js's E113 guardrail (see that file's error-code doc
// block for exactly when/why it runs). A baseline bot-abuse layer: free,
// low build cost, stops naive scripted abuse. Doesn't stop a determined
// attacker alone, but is a cheap complement to the existing E109 rate
// limit / E110 spend cap / E112 token gate — per the founder-approved
// anti-abuse-guardrails research recommendation this exists to implement.
//
// This module is a pure verification helper — it has no opinion on
// whether the check should actually be enforced. generate-video.js
// itself decides that, based on whether TURNSTILE_SECRET_KEY is
// configured (see docs/TURNSTILE_SETUP.md): this function is only ever
// called once that's already been confirmed non-placeholder, so it does
// not repeat that check itself.
//
// Cloudflare's siteverify endpoint (confirmed against
// developers.cloudflare.com/turnstile/get-started/server-side-validation,
// 2026-07) accepts either JSON or form-encoded bodies; JSON is used here
// to match every other outbound POST this codebase makes (callFal,
// meta-capi.js, prompt-condenser.js). Request shape: { secret, response,
// remoteip }; `remoteip` is optional and doesn't affect the verification
// result, but is passed through anyway since generate-video.js already
// resolves the client's IP for rate-limit.js regardless. Response shape:
// { success: boolean, "error-codes": string[], challenge_ts, hostname,
// action, cdata } — only `success` and the first `error-codes` entry (for
// a short, safe-to-echo failure reason) are used here.

var SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verifies a client-supplied Turnstile token against Cloudflare's
 * siteverify endpoint.
 *
 * @param {string|null|undefined} token - the client's `turnstileToken` from the request body.
 * @param {string} secretKey - TURNSTILE_SECRET_KEY. Caller must already have confirmed this is configured (non-empty, non-placeholder) before calling.
 * @param {string} [remoteIp] - the requesting client's best-effort IP (see rate-limit.js's clientIp), passed through opportunistically.
 * @returns {Promise<{success: boolean, reason: string|null}>} `reason` is
 *   always null on success. On failure it's a short machine string (a
 *   Cloudflare error-code, or one of 'missing_token'/'verification_failed'/
 *   'network_error...') safe to embed directly in the E113 error message —
 *   never the raw Cloudflare response structure.
 */
async function verify(token, secretKey, remoteIp) {
  if (!token) return { success: false, reason: 'missing_token' };

  try {
    var res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secretKey, response: token, remoteip: remoteIp || undefined })
    });

    var data = null;
    try { data = await res.json(); } catch (e) { /* handled below via data===null */ }

    if (!res.ok || !data || data.success !== true) {
      var codes = data && Array.isArray(data['error-codes']) ? data['error-codes'] : null;
      return { success: false, reason: (codes && codes[0]) || 'verification_failed' };
    }

    return { success: true, reason: null };
  } catch (e) {
    return { success: false, reason: 'network_error' + (e && e.message ? ': ' + e.message : '') };
  }
}

module.exports = { verify: verify, SITEVERIFY_URL: SITEVERIFY_URL };
