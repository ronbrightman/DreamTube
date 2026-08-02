// netlify/functions/resend-bounce-webhook.js
//
// POST (from Resend, not the DreamTube client) — the "Bounced first sends
// flag the address as bad" half of tracker item
// for-product-build-passwordless-signup-fo-at2fko. Verifies the Svix-format
// signature Resend puts on every webhook delivery (lib/resend-webhook-
// verify.js — see that file's header comment for the exact algorithm,
// confirmed via Resend's/Svix's own docs, fetched 2026-08-02) and, on a
// real `email.bounced` event whose bounce is a hard (Permanent) bounce,
// flags the matching account's `emailBounced` via lib/account-store.js's
// markEmailBounced.
//
// SETUP THIS SANDBOX CANNOT DO ITSELF: this endpoint is written and ready,
// but Resend only ever calls it once a human with Resend dashboard access
// registers this URL (https://<host>/.netlify/functions/resend-bounce-
// webhook) as a webhook endpoint in Resend's own dashboard, subscribed to
// at least the `email.bounced` event, and RESEND_WEBHOOK_SECRET (the
// signing secret Resend generates for that endpoint) is set in this app's
// Netlify environment — same "can't do this from the sandbox" pattern this
// codebase already has for Dodo (see dodo-webhook.js's own header comment)
// and Netlify env vars generally. Until both of those happen, this
// function is unreachable (Resend never calls it) and inert — no
// behavioral risk either way.
//
// PAYLOAD SHAPE (confirmed via resend.com/docs/webhooks/emails/bounced,
// fetched 2026-08-02 — this codebase had no prior bounce-webhook
// integration to copy from):
//   {
//     type: "email.bounced",
//     data: {
//       to: ["<address>", ...],   // every impacted recipient, one send can
//                                 // theoretically list more than one
//       bounce: { type: "Permanent" | "Transient" | ..., subType, message }
//     },
//     ...
//   }
//
// HARD BOUNCES ONLY: only `bounce.type === 'Permanent'` flags the address
// — a Transient (soft) bounce (mailbox full, greylisting, a momentary
// server hiccup) is routine and does NOT mean the address is bad; flagging
// it the same way a real hard bounce would risk permanently mis-labeling a
// perfectly good address off one bad delivery attempt. This is the
// deliberate interpretation of the founder's "bounced first sends flag the
// address as bad" instruction — "first sends" is read as "the
// verification-code email specifically" (the one send this feature
// controls; every account that reaches this webhook only ever received a
// send FROM this feature, since no prior Resend webhook integration
// existed before it), and "bad" is read as a real, permanent delivery
// failure, not a transient one.
//
// NOT MATCHED TO A PARTICULAR ACCOUNT'S "FIRST" SEND SPECIFICALLY: this
// webhook has no way to know whether a given bounced send was an
// account's FIRST verification email or a later resend (Resend's payload
// carries no dreamtube-side account/attempt identity, only the raw `to`
// address) — it flags emailBounced on ANY hard bounce for a matching
// account's email, which is the simpler and strictly more useful signal
// (a hard bounce on attempt 2 means the address is exactly as bad as one
// on attempt 1) and a deliberate, documented simplification of "first
// sends" rather than an oversight.
//
// Never blocks/undoes anything already-verified: markEmailBounced only
// sets an informational flag (see account-store.js's own header comment)
// — nothing in this codebase currently REFUSES an action off
// `emailBounced`; it exists so a future pass (or a human reading
// tracker.html) has the signal on file, not to enforce anything itself
// today.
//
// Error codes:
//   E1 method_not_allowed
//   E2 missing_webhook_secret        — RESEND_WEBHOOK_SECRET not configured
//   E3 signature_verification_failed — headers missing, malformed, stale
//                                       timestamp, or didn't verify
//   E4 invalid_json                  — signature verified but the body
//                                       wasn't valid JSON (shouldn't happen
//                                       from a real Resend delivery; defense
//                                       in depth)

var accountStore = require('./lib/account-store');
var resendWebhookVerify = require('./lib/resend-webhook-verify');

/** Same base64-or-not defensive read as dodo-webhook.js/stripe-webhook.js's own identical rawBody helper — Netlify may base64-encode the body depending on how the request arrived, and signature verification needs the exact raw bytes either way. */
function rawBody(event) {
  return event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_webhook_secret' }) };
  }

  var body = rawBody(event);
  var verified = resendWebhookVerify.verifySignature(event.headers, body, secret);
  if (!verified.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: 'E3: signature_verification_failed: ' + verified.error }) };
  }

  var payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: invalid_json' }) };
  }

  // Every event type OTHER than email.bounced is acknowledged and ignored
  // — same "a dashboard commonly has many event types enabled on one
  // endpoint" reasoning dodo-webhook.js's/stripe-webhook.js's own header
  // comments already document for their equivalent unhandled-event
  // branches, not a bug.
  if (!payload || payload.type !== 'email.bounced') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: true }) };
  }

  var data = payload.data || {};
  var bounce = data.bounce || {};
  // See header comment's "HARD BOUNCES ONLY" section.
  if (bounce.type !== 'Permanent') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: true, reason: 'non_permanent_bounce' }) };
  }

  var recipients = Array.isArray(data.to) ? data.to : [];
  for (var i = 0; i < recipients.length; i++) {
    try {
      await accountStore.markEmailBounced(event, recipients[i]);
    } catch (e) {
      console.error('resend-bounce-webhook: markEmailBounced failed for a recipient (non-fatal)', e);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
