// netlify/functions/track-conversion.js
//
// POST { event_name, event_id, event_source_url, email?, external_id?,
//        fbc?, fbp?, custom_data? }
// -> forwards a server-side conversion event to Meta's Conversions API
// via lib/meta-capi.js. This endpoint's entire reason to exist is keeping
// META_CAPI_ACCESS_TOKEN server-side only — it is never sent to, and
// never readable by, client-side code; see lib/meta-capi.js's header for
// the full picture of what gets hashed vs. sent as-is.
//
// event_name is restricted to a fixed allowlist (see ALLOWED_EVENT_NAMES
// below) — this is NOT a general-purpose event-forwarding proxy, and
// anything outside the four events DreamTube actually tracks is rejected
// with E4 rather than silently forwarded to Meta.
//
// event_id is required and must be supplied by the caller (never
// generated here) — the whole point is that the client's matching
// fbq('track', ...) call for the SAME user action shares the exact same
// event_id (see js/analytics-config.js's fireMetaConversion, the one
// place that pairing happens), so Meta's Pixel+CAPI deduplication
// (matches on event_id + event_name) collapses the two into a single
// counted conversion instead of double-counting — this is exactly why
// Event ID was selected as a parameter when CAPI access was set up.
//
// client_ip_address/client_user_agent are pulled from the request itself
// (never trusted from the client body) via the same header extraction
// generate-video.js's rate limiting already uses — see
// lib/rate-limit.js's clientIp().
//
// Error codes (local to this function — a new, standalone function, same
// reasoning as create-checkout-session.js/stripe-webhook.js for why this
// isn't part of the generate-video.js/video-status.js E1xx/E2xx chain):
//   E1 method_not_allowed
//   E2 missing_access_token       — META_CAPI_ACCESS_TOKEN not configured in this environment
//   E3 invalid_json
//   E4 invalid_event_name         — not one of the allowed event names
//   E5 event_id_and_source_url_required
//   E6 meta_capi_request_failed   — Meta rejected the event, or the request otherwise failed
//                                    (see lib/meta-capi.js — the underlying error text is
//                                    already redacted of the access token before it reaches here)

var metaCapi = require('./lib/meta-capi');
var rateLimit = require('./lib/rate-limit');

var ALLOWED_EVENT_NAMES = ['CompleteRegistration', 'InitiateCheckout', 'Purchase', 'Subscribe'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  if (!process.env.META_CAPI_ACCESS_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_access_token' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  var eventName = ((payload && payload.event_name) || '').trim();
  if (ALLOWED_EVENT_NAMES.indexOf(eventName) === -1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: invalid_event_name' }) };
  }

  var eventId = ((payload && payload.event_id) || '').trim();
  var eventSourceUrl = ((payload && payload.event_source_url) || '').trim();
  if (!eventId || !eventSourceUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: event_id_and_source_url_required' }) };
  }

  var headers = event.headers || {};
  var clientIp = rateLimit.clientIp(event);
  var clientUserAgent = headers['user-agent'] || headers['User-Agent'] || '';

  var result = await metaCapi.sendCapiEvent({
    event_name: eventName,
    event_id: eventId,
    event_source_url: eventSourceUrl,
    email: payload.email,
    external_id: payload.external_id,
    fbc: payload.fbc,
    fbp: payload.fbp,
    custom_data: payload.custom_data,
    client_ip_address: clientIp,
    client_user_agent: clientUserAgent
  });

  if (!result.ok) {
    return { statusCode: result.statusCode || 502, body: JSON.stringify({ error: 'E6: meta_capi_request_failed' + (result.error ? ': ' + result.error : '') }) };
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
