// netlify/functions/dodo-webhook.js
//
// POST (from Dodo Payments, not the DreamTube client) — verifies the
// webhook signature (DODO_WEBHOOK_SECRET) and, for subscription lifecycle
// events, writes/updates a record in the "dreamtube-entitlements" Blobs
// store via lib/entitlements.js, keyed by normalized email (see that
// file's header for why email, not a new user-id). This is the Dodo
// Payments equivalent of stripe-webhook.js — same role (durable source of
// truth for entitlement; unlike a client-side "I just paid" signal, it
// can't be spoofed and it's the only path that ever hears about
// renewals/cancellations), different vendor payload shape.
//
// Dodo's webhooks follow the Standard Webhooks specification (the same
// spec Svix/Resend/Polar.sh use), verified here via the official
// `dodopayments` npm SDK's `client.webhooks.unwrap()` — analogous to
// stripe-webhook.js's `stripe.webhooks.constructEvent()`. Three headers
// carry the signature: webhook-id, webhook-timestamp, webhook-signature.
//
// Handled events: every `subscription.*` event type Dodo sends
// (subscription.active, subscription.renewed, subscription.updated,
// subscription.plan_changed, subscription.update_payment_method,
// subscription.on_hold, subscription.cancelled, subscription.expired,
// subscription.failed — confirmed against the current `dodopayments` SDK's
// generated type definitions, since docs.dodopayments.com's prose pages
// didn't consistently enumerate the full list). Unlike Stripe, where
// checkout.session.completed and customer.subscription.* carry different
// object shapes and have to be handled as separate cases, EVERY Dodo
// subscription.* event's `data` field is the *same* full Subscription
// object, already carrying its own current `status` — so instead of
// hardcoding "this event type means active, that one means inactive" per
// event name (fragile if Dodo adds another subscription.* event later),
// this handler reads `data.status` directly off whichever subscription.*
// event arrived and maps that status to entitlement `active`. That's
// simpler than Stripe's approach and, because it's driven by the
// authoritative current status rather than an event-name guess, at least
// as correct.
//
// Any event type outside the subscription.* family (payment.*, refund.*,
// dispute.*, credit.*, license_key.*, entitlement_grant.*,
// abandoned_checkout.*, dunning.*) is acknowledged (200) and ignored —
// same reasoning as stripe-webhook.js: dashboards commonly have many
// event types enabled on one endpoint, and silently ignoring the ones we
// don't act on is correct, not a bug. DreamTube's entitlement model is a
// simple "does this email have an active subscription" flag; it doesn't
// need per-payment or dispute-level detail.
//
// Setting up the actual Dodo webhook endpoint (dashboard config, choosing
// which events to send, copying the signing key into
// DODO_WEBHOOK_SECRET) is the founder's own step — see
// docs/PAYWALL_SETUP.md. Nothing here can be exercised end-to-end without
// that; written correct-by-inspection against Dodo Payments' current
// Node SDK and public API docs (docs.dodopayments.com).
//
// Error codes (local to this function, same reasoning as
// stripe-webhook.js for why this isn't part of the E1xx/E2xx
// generation-flow chain):
//   E1 method_not_allowed
//   E2 missing_webhook_secret    — DODO_WEBHOOK_SECRET not configured in this environment
//   E3 missing_signature_headers — request was missing one or more of webhook-id/webhook-timestamp/webhook-signature (not really from Dodo)
//   E4 signature_verification_failed — headers present but didn't verify (wrong secret, tampered/replayed body, stale timestamp, etc.)
//   E5 processing_failed         — signature verified, but writing the entitlement failed (Blobs error, etc.);
//                                  returns 500 deliberately so Dodo retries delivery, since our own
//                                  Blobs write is what failed, not the event itself being invalid

var DodoPayments = require('dodopayments').default;
var { setEntitlement } = require('./lib/entitlements');

/** Best-effort: Netlify may base64-encode the body depending on how the request arrived; the Standard Webhooks signature check needs the exact raw bytes either way. */
function rawBody(event) {
  return event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
}

/** Case-insensitive header lookup — Netlify usually lowercases incoming header names, but don't assume it. */
function getHeader(event, name) {
  var headers = event.headers || {};
  var lower = name.toLowerCase();
  var key = Object.keys(headers).find(function (k) { return k.toLowerCase() === lower; });
  return key ? headers[key] : undefined;
}

var ACTIVE_STATUSES = ['active'];

/**
 * Resolves the plan name ("monthly"/"yearly") for a subscription event.
 * Prefers matching the payload's product_id against the same
 * DODO_PRODUCT_MONTHLY/DODO_PRODUCT_YEARLY env vars
 * create-checkout-session-dodo.js uses to create the checkout in the first
 * place — this is the authoritative mapping and needs no cooperation from
 * the payload itself. Falls back to the metadata create-checkout-session-
 * dodo.js attached at checkout time, for the rare case those env vars have
 * changed since the subscription was created. Returns undefined (not
 * written) if neither resolves, matching setEntitlement's
 * drop-undefined-keys behavior so an unresolved plan on one event can't
 * blank out a plan value a previous event already recorded.
 */
function resolvePlan(subscription) {
  if (subscription.product_id) {
    if (subscription.product_id === process.env.DODO_PRODUCT_MONTHLY) return 'monthly';
    if (subscription.product_id === process.env.DODO_PRODUCT_YEARLY) return 'yearly';
  }
  return (subscription.metadata && subscription.metadata.dreamtube_plan) || undefined;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var webhookSecret = process.env.DODO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_webhook_secret' }) };
  }

  var webhookId = getHeader(event, 'webhook-id');
  var webhookTimestamp = getHeader(event, 'webhook-timestamp');
  var webhookSignature = getHeader(event, 'webhook-signature');
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_signature_headers' }) };
  }

  var client = new DodoPayments({
    bearerToken: process.env.DODO_API_KEY || 'unused-for-webhook-verification',
    environment: process.env.DODO_ENVIRONMENT || 'live_mode'
  });

  var dodoEvent;
  try {
    dodoEvent = client.webhooks.unwrap(rawBody(event), {
      headers: {
        'webhook-id': webhookId,
        'webhook-timestamp': webhookTimestamp,
        'webhook-signature': webhookSignature
      },
      key: webhookSecret
    });
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: signature_verification_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }

  try {
    if (typeof dodoEvent.type === 'string' && dodoEvent.type.indexOf('subscription.') === 0) {
      var subscription = dodoEvent.data || {};
      var subEmail = subscription.customer && subscription.customer.email;
      // Fallback for the (unexpected, but not worth crashing over) case
      // where a subscription payload arrives without its customer block —
      // the metadata create-checkout-session-dodo.js attaches at checkout
      // time carries the email independently of Dodo's own customer object.
      if (!subEmail) subEmail = subscription.metadata && subscription.metadata.dreamtube_email;

      if (subEmail) {
        await setEntitlement(event, subEmail, {
          active: ACTIVE_STATUSES.indexOf(subscription.status) !== -1,
          plan: resolvePlan(subscription),
          dodoCustomerId: (subscription.customer && subscription.customer.customer_id) || undefined,
          dodoSubscriptionId: subscription.subscription_id || undefined
        });
      }
    }
    // Any other event type (payment.*, refund.*, dispute.*, credit.*,
    // license_key.*, entitlement_grant.*, abandoned_checkout.*,
    // dunning.*): acknowledged below, no action taken.

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E5: processing_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
