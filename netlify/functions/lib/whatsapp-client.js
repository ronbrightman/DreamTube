// netlify/functions/lib/whatsapp-client.js
//
// Thin wrapper around the WhatsApp Business Cloud API, for the abandoned-
// dream re-engagement send's optional WhatsApp leg (see dream-webhook.js
// and docs/IDENTITY_RETENTION_PROJECT_SPEC.md's pivot note: Twilio SMS is
// abandoned — non-US/Canada solo founder, no EIN, A2P 10DLC unavailable —
// WhatsApp is far more international-friendly and there's already a
// WhatsApp Business asset per the growth session, but no real API
// integration exists in this codebase yet).
//
// Per this task's own instruction: build the email path fully functional
// (see dream-webhook.js's Resend send) and treat WhatsApp sending as a
// stub/TODO behind a config check, NOT block the feature on it — email
// alone already solves the core retention problem. This file mirrors
// lib/twilio-client.js's exact "isConfigured() gate, never throws, clean
// no-op until real credentials exist" shape (that file's own pattern, not
// its Twilio-specific code — nothing here calls Twilio or touches
// lib/reminder.js, which stays untouched/unused, per this task's explicit
// instruction not to resurrect that piece).
//
// Required env vars (both, or this stays a no-op):
//   WHATSAPP_BUSINESS_PHONE_ID — the Cloud API "Phone number ID" for the
//     founder's WhatsApp Business number.
//   WHATSAPP_ACCESS_TOKEN — a Meta Graph API access token with
//     whatsapp_business_messaging permission.
//
// TODO (real integration, not yet wired): WhatsApp Business Cloud API
// requires sending an approved MESSAGE TEMPLATE for the first message to
// someone who hasn't messaged the business number first (a 24-hour
// "customer service window" rule) — sendMessage below is a plain free-form
// text call, which will be REJECTED by the real API for a first contact
// until a template is created and approved in Meta Business Manager. This
// is real setup work (a human, vendor-facing step — creating/submitting a
// template for approval), not something this stub can wire around, so
// isConfigured() staying false is the safe, expected state until that
// exists; do not flip WHATSAPP_ACCESS_TOKEN on without also having an
// approved template and updating sendMessage to use it.

var GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

function looksLikePlaceholder(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  return /^(REPLACE_WITH_|YOUR_|TODO|CHANGE_ME|PLACEHOLDER)/i.test(value.trim());
}

function isConfigured() {
  var phoneId = process.env.WHATSAPP_BUSINESS_PHONE_ID;
  var token = process.env.WHATSAPP_ACCESS_TOKEN;
  return !looksLikePlaceholder(phoneId) && !looksLikePlaceholder(token);
}

/**
 * Sends a plain text WhatsApp message. Never throws — always resolves —
 * mirroring twilio-client.js's own contract so callers (dream-webhook.js)
 * can treat this identically to the email send's best-effort shape:
 *   { ok:true, skipped:true, reason:'not_configured' } — the expected
 *     state until WHATSAPP_BUSINESS_PHONE_ID/WHATSAPP_ACCESS_TOKEN are
 *     real AND an approved message template exists (see the TODO above).
 *   { ok:true, skipped:true, reason:'send_failed' } — configured, but the
 *     real API call itself failed.
 *   { ok:true, messageId } — sent for real.
 * `to` should be E.164 (e.g. "+15551234567"); `body` is the plain message
 * text (see the TODO above for why this needs to become a template call
 * before it can actually work in production).
 */
async function sendMessage(to, body) {
  if (!to) return { ok: true, skipped: true, reason: 'no_recipient' };
  if (!isConfigured()) {
    console.log('whatsapp-client: WHATSAPP_BUSINESS_PHONE_ID/WHATSAPP_ACCESS_TOKEN not configured — skipping WhatsApp send (expected until the founder wires up a real WhatsApp Business Cloud API integration + approved message template, see this file\'s header TODO)');
    return { ok: true, skipped: true, reason: 'not_configured' };
  }

  try {
    var phoneId = process.env.WHATSAPP_BUSINESS_PHONE_ID;
    var token = process.env.WHATSAPP_ACCESS_TOKEN;
    var res = await fetch(GRAPH_API_BASE + '/' + phoneId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: body }
      })
    });
    var data = await res.json();
    if (!res.ok) {
      console.error('whatsapp-client: send failed', res.status, data);
      return { ok: true, skipped: true, reason: 'send_failed' };
    }
    var messageId = data && data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, messageId: messageId || null };
  } catch (e) {
    console.error('whatsapp-client: unexpected error', e);
    return { ok: true, skipped: true, reason: 'unexpected_error' };
  }
}

module.exports = { isConfigured, sendMessage };
