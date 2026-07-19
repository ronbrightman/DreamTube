// netlify/functions/stripe-webhook.js
//
// POST (from Stripe, not the DreamTube client) — verifies the Stripe
// webhook signature (STRIPE_WEBHOOK_SECRET) and, for the events that
// matter to entitlement, writes/updates a record in the
// "dreamtube-entitlements" Blobs store via lib/entitlements.js, keyed by
// normalized email (see that file's header for why email, not a new
// user-id). This webhook is the durable source of truth for entitlement
// — unlike a client-side "I just paid" signal, it can't be spoofed
// (signature-verified) and it's the only path that ever hears about
// renewals/cancellations, which don't happen on any success page.
//
// Handled events (minimum set the task calls for):
//   checkout.session.completed   -> create/activate the entitlement
//   customer.subscription.updated -> sync active/inactive + plan from the
//                                     subscription's current status
//   customer.subscription.deleted -> deactivate the entitlement
// Any other event type is acknowledged (200) and ignored — Stripe
// dashboards commonly have many event types enabled on one endpoint;
// silently ignoring the ones we don't act on is the correct behavior,
// not a bug.
//
// Setting up the actual Stripe webhook endpoint (Dashboard config,
// choosing which events to send, copying the signing secret into
// STRIPE_WEBHOOK_SECRET) is the founder's own step — see
// docs/PAYWALL_SETUP.md. Nothing here can be exercised end-to-end
// without that; written correct-by-inspection against Stripe's current
// webhook-verification API.
//
// Error codes (local to this function, same reasoning as
// create-checkout-session.js for why this isn't part of the E1xx/E2xx
// generation-flow chain):
//   E1 method_not_allowed
//   E2 missing_webhook_secret   — STRIPE_WEBHOOK_SECRET not configured in this environment
//   E3 missing_signature_header — request had no stripe-signature header (not really from Stripe)
//   E4 signature_verification_failed — signature present but didn't verify (wrong secret, tampered/replayed body, etc.)
//   E5 processing_failed        — signature verified, but writing the entitlement failed (Blobs error, etc.);
//                                 returns 500 deliberately so Stripe retries delivery, since our own
//                                 Blobs write is what failed, not the event itself being invalid

var Stripe = require('stripe');
var { setEntitlement } = require('./lib/entitlements');

/** Best-effort: Netlify may base64-encode the body depending on how the request arrived; Stripe's signature check needs the exact raw bytes either way. */
function rawBody(event) {
  return event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
}

var ACTIVE_STATUSES = ['active', 'trialing'];

/**
 * Resolves the email an incoming subscription-object event applies to.
 * Subscriptions created via create-checkout-session.js carry
 * dreamtube_email in their own metadata (set at creation time via
 * subscription_data.metadata), which survives independently of the
 * checkout session that created them — that's the primary path. Falls
 * back to looking the customer up directly for any subscription that
 * didn't go through our checkout endpoint (e.g. created by hand in the
 * Stripe Dashboard).
 */
async function resolveEmailForSubscription(stripe, subscription) {
  var metaEmail = subscription.metadata && subscription.metadata.dreamtube_email;
  if (metaEmail) return metaEmail;

  if (!subscription.customer) return null;
  var customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  var customer = await stripe.customers.retrieve(customerId);
  return customer && !customer.deleted ? customer.email : null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_webhook_secret' }) };
  }

  var signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!signature) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_signature_header' }) };
  }

  var stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
  var stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody(event), signature, webhookSecret);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: signature_verification_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      var session = stripeEvent.data.object;
      var sessionEmail =
        (session.customer_details && session.customer_details.email) ||
        session.customer_email ||
        (session.metadata && session.metadata.dreamtube_email);

      if (sessionEmail) {
        await setEntitlement(event, sessionEmail, {
          active: true,
          plan: (session.metadata && session.metadata.dreamtube_plan) || undefined,
          stripeCustomerId: session.customer || undefined,
          stripeSubscriptionId: session.subscription || undefined
        });
      }
    } else if (stripeEvent.type === 'customer.subscription.updated' || stripeEvent.type === 'customer.subscription.deleted') {
      var subscription = stripeEvent.data.object;
      var subEmail = await resolveEmailForSubscription(stripe, subscription);

      if (subEmail) {
        var active = stripeEvent.type === 'customer.subscription.deleted'
          ? false
          : ACTIVE_STATUSES.indexOf(subscription.status) !== -1;

        await setEntitlement(event, subEmail, {
          active: active,
          plan: (subscription.metadata && subscription.metadata.dreamtube_plan) || undefined,
          stripeCustomerId: subscription.customer || undefined,
          stripeSubscriptionId: subscription.id || undefined
        });
      }
    }
    // Any other event type: acknowledged below, no action taken.

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E5: processing_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
