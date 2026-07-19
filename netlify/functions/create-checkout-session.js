// netlify/functions/create-checkout-session.js
//
// POST { email, plan } -> creates a Stripe Checkout Session for a
// DreamTube subscription and returns { url } for the client to redirect
// the browser to. `plan` is "monthly" or "yearly".
//
// This function only creates the Checkout Session — it does not itself
// grant any entitlement. The entitlement record is written by
// stripe-webhook.js once Stripe confirms the payment (checkout.session.completed),
// which is the durable source of truth. (A future checkout-success page
// can additionally call Stripe's Checkout Session retrieve API directly
// on return, to close the well-documented webhook-arrival race — see
// docs/PAYWALL_SETUP.md — but that page doesn't exist yet; out of scope
// here per the task boundaries: this is backend plumbing only, no
// checkout/pricing UI.)
//
// No Price IDs or dollar amounts are hardcoded here — both come from
// environment variables the founder sets after creating the actual
// Stripe product/prices in their own Stripe Dashboard (see
// docs/PAYWALL_SETUP.md). This function cannot be exercised end-to-end
// until those env vars + a real Stripe account exist; written
// correct-by-inspection against Stripe's current Checkout Session API.
//
// Error codes (local to this function — this is a new, standalone
// function, not part of generate-video.js/video-status.js's E1xx/E2xx
// generation-flow chain, so it gets its own small-number scheme, same
// pattern as request-password-reset.js):
//   E1 method_not_allowed
//   E2 missing_api_key        — STRIPE_SECRET_KEY not configured in this environment
//   E3 invalid_json
//   E4 email_and_plan_required
//   E5 invalid_plan           — plan wasn't "monthly" or "yearly"
//   E6 missing_price_id       — STRIPE_PRICE_MONTHLY/STRIPE_PRICE_YEARLY not configured for the requested plan
//   E7 stripe_request_failed  — Stripe rejected or the request otherwise failed

var Stripe = require('stripe');
var { normalizeEmail } = require('./lib/entitlements');

var PLAN_PRICE_ENV = {
  monthly: 'STRIPE_PRICE_MONTHLY',
  yearly: 'STRIPE_PRICE_YEARLY'
};

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_api_key' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  var email = normalizeEmail(payload.email);
  var plan = (payload.plan || '').trim().toLowerCase();
  if (!email || !plan) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: email_and_plan_required' }) };
  }

  var priceEnvVar = PLAN_PRICE_ENV[plan];
  if (!priceEnvVar) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: invalid_plan' }) };
  }

  var priceId = process.env[priceEnvVar];
  if (!priceId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E6: missing_price_id: ' + priceEnvVar + ' not configured' }) };
  }

  // No dedicated checkout/pricing page exists yet (separate, later work —
  // see task boundaries), so the caller may optionally supply where to
  // send the browser after Checkout; fall back to sane same-site defaults
  // so this function is already usable once that page exists, without a
  // required contract change.
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  var origin = host ? ('https://' + host) : '';
  var successUrl = payload.successUrl || (origin + '/home.html?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  var cancelUrl = payload.cancelUrl || (origin + '/home.html?checkout=cancelled');

  try {
    var stripe = new Stripe(secretKey);
    var session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Carries the normalized email through to the webhook as a fallback
      // identity source alongside customer_details.email — belt-and-
      // suspenders in case Stripe ever lets the customer edit their email
      // mid-checkout (metadata is untouched by that; customer_details is
      // whatever the buyer actually typed).
      metadata: { dreamtube_email: email, dreamtube_plan: plan },
      subscription_data: { metadata: { dreamtube_email: email, dreamtube_plan: plan } }
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url, sessionId: session.id }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'E7: stripe_request_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
