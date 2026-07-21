// netlify/functions/lib/meta-capi.js
//
// Shared helper for sending events to Meta's Conversions API (CAPI) —
// server-side event tracking that complements (and, via a shared
// event_id, de-duplicates against) the client-side Meta Pixel snippet
// already on every page — see js/analytics-config.js's META_PIXEL_ID and
// each page's fbq('init', ...)/fbq('track', 'PageView') block. Not a
// Netlify Function itself — a plain module required by
// track-conversion.js (the client-facing endpoint) and stripe-webhook.js
// (the server-to-server Purchase/Subscribe path, dormant until real
// payment goes live — see that file's own comment), matching this
// codebase's existing "self-contained function, shared bits in a plain
// require()" pattern (entitlements.js, rate-limit.js, etc.) rather than
// introducing a build step.
//
// The Pixel ID is required directly from js/analytics-config.js — the
// same public constant already client-side there — rather than
// hardcoded again here as a second copy of the literal, so there's
// exactly one place it lives (previously both files hardcoded
// '2464464964036457' independently, a silent-drift risk if the Pixel is
// ever rotated and only one copy gets updated; see that file's own
// comment on the UMD-lite guard that makes the require() below safe).
// Pixel IDs aren't secret, only the access token is. That token is read
// here exclusively from process.env.META_CAPI_ACCESS_TOKEN, set directly
// in Netlify's environment variables by the founder (never hardcoded,
// never sent to the client) — same convention as
// FAL_KEY/STRIPE_SECRET_KEY elsewhere in this directory.
//
// PII hashing, per Meta's CAPI spec for user_data
// (https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters):
// email is lowercased, trimmed, then SHA-256 hex digested before being
// sent as `em` — Meta requires this. external_id's hashing requirement is
// more ambiguous across Meta's own docs (some describe it as an opaque,
// already-non-PII identifier that doesn't strictly need hashing) — the
// conservative choice is taken here: hash it exactly the same way as
// email, rather than assume it's safe to send raw. fbc/fbp are NOT
// hashed — they're Meta's own first-party click/browser cookie IDs, not
// raw PII, and Meta's spec sends them as-is.
//
// Error handling follows this repo's existing outbound-fetch convention
// (see generate-video.js's callFal / create-checkout-session.js): a
// non-2xx response from Meta is distinguished from the fetch call itself
// throwing (network failure before any response came back), and this
// helper never talks in HTTP status codes of its own — { ok, error } (or
// { ok, result }) only, so callers decide what to surface. The access
// token lives in the request URL's query string, so any error text that
// might echo the URL back (network-layer errors sometimes do) is passed
// through redactToken() first — this must never leak into a response or
// log line reachable by the client, which is this whole file's reason to
// exist as a separate, server-only module.

var crypto = require('crypto');

var PIXEL_ID = require('../../../js/analytics-config').META_PIXEL_ID;
var CAPI_BASE = 'https://graph.facebook.com/v21.0';

/** Lowercase + trim + SHA-256 hex digest, per Meta's hashing spec for user_data fields (em, external_id). Returns null for empty/missing input so callers can omit the field entirely rather than hash an empty string. */
function hash(value) {
  var normalized = (value || '').toString().trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** Strips every occurrence of `secret` (raw and URI-encoded) out of `text`, so an outbound error message can never carry the access token back to a caller. */
function redactToken(text, secret) {
  if (!text || !secret) return text;
  var redacted = text.split(secret).join('[REDACTED]');
  try {
    redacted = redacted.split(encodeURIComponent(secret)).join('[REDACTED]');
  } catch (e) { /* encodeURIComponent shouldn't throw here, but never let redaction itself break error handling */ }
  return redacted;
}

/**
 * Sends one event to Meta's CAPI. `params`:
 *   event_name        (required) — one of Meta's standard event names
 *   event_id           (required) — shared with the matching client-side
 *                       fbq('track', ...) call for Pixel+CAPI dedup
 *   event_source_url   (optional) — the page/flow the event happened on;
 *                       omitted entirely when not supplied (e.g. the
 *                       stripe-webhook.js path, which has no browser URL
 *                       to point at) rather than sent empty
 *   event_time         (optional) — Unix seconds; defaults to now
 *   email               (optional, raw — hashed here into user_data.em)
 *   external_id         (optional, raw — hashed here, see header comment)
 *   fbc, fbp            (optional, sent as-is — see header comment)
 *   client_ip_address, client_user_agent (optional, passed through as-is)
 *   custom_data         (optional object, passed through as-is)
 * Returns { ok: true, result } or { ok: false, error, statusCode? }.
 */
async function sendCapiEvent(params) {
  params = params || {};

  var accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!accessToken) {
    return { ok: false, error: 'missing_access_token' };
  }

  var userData = {};
  var hashedEmail = hash(params.email);
  if (hashedEmail) userData.em = hashedEmail;
  var hashedExternalId = hash(params.external_id);
  if (hashedExternalId) userData.external_id = hashedExternalId;
  if (params.fbc) userData.fbc = params.fbc;
  if (params.fbp) userData.fbp = params.fbp;
  if (params.client_ip_address) userData.client_ip_address = params.client_ip_address;
  if (params.client_user_agent) userData.client_user_agent = params.client_user_agent;

  var eventPayload = {
    event_name: params.event_name,
    event_time: params.event_time || Math.floor(Date.now() / 1000),
    event_id: params.event_id,
    action_source: 'website',
    user_data: userData
  };
  if (params.event_source_url) eventPayload.event_source_url = params.event_source_url;
  if (params.custom_data) eventPayload.custom_data = params.custom_data;

  var url = CAPI_BASE + '/' + PIXEL_ID + '/events?access_token=' + encodeURIComponent(accessToken);

  try {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [eventPayload] })
    });

    var data = await res.json();

    if (!res.ok) {
      var message = (data && data.error && data.error.message) || 'meta_capi_request_failed';
      return { ok: false, statusCode: res.status, error: redactToken(message, accessToken) };
    }

    return { ok: true, result: data };
  } catch (e) {
    var failureMessage = 'meta_capi_network_failure' + (e && e.message ? ': ' + e.message : '');
    return { ok: false, error: redactToken(failureMessage, accessToken) };
  }
}

module.exports = { sendCapiEvent: sendCapiEvent, hash: hash, redactToken: redactToken, PIXEL_ID: PIXEL_ID };
