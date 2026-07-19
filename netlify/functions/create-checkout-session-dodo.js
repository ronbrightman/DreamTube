// netlify/functions/create-checkout-session-dodo.js
//
// POST { email, plan } -> creates a Dodo Payments Checkout Session for a
// DreamTube subscription and returns { url } for the client to redirect
// the browser to. `plan` is "monthly" or "yearly".
//
// This is the Dodo Payments equivalent of create-checkout-session.js
// (Stripe) — same request/response contract, so a future pricing/checkout
// UI can call whichever one is actually wired up without changing its own
// code. Both files stay in the codebase: Stripe's is dormant (Israel isn't
// one of Stripe's supported "country of operation" markets for an
// individual founder — see the founder's payment-provider research docs),
// Dodo's is the currently-intended provider. See docs/PAYWALL_SETUP.md.
//
// Like create-checkout-session.js, this function only creates the
// Checkout Session — it does not itself grant any entitlement. The
// entitlement record is written by dodo-webhook.js once Dodo confirms the
// subscription is active, which is the durable source of truth.
//
// No product IDs or dollar amounts are hardcoded here — both come from
// environment variables the founder sets after creating the actual Dodo
// Payments subscription products in their own Dodo dashboard (see
// docs/PAYWALL_SETUP.md). This function cannot be exercised end-to-end
// until those env vars + real Dodo credentials exist; written
// correct-by-inspection against Dodo Payments' current Node SDK
// (`dodopayments` on npm, generated from their OpenAPI spec) and public
// API docs (docs.dodopayments.com).
//
// Dodo's terminology differs from Stripe's in a few places worth noting:
//   - No "Price ID" concept — a checkout session's product_cart references
//     a product_id directly (Dodo prices live on the product itself).
//   - Auth is a bearer token ("API key" in their dashboard), not a
//     Stripe-style secret key with a different prefix scheme.
//   - `environment` ('live_mode' | 'test_mode') is a separate client
//     option, not implied by the key's prefix the way Stripe's is.
//
// Error codes (local to this function, same reasoning as
// create-checkout-session.js for why this isn't part of the E1xx/E2xx
// generation-flow chain):
//   E1 method_not_allowed
//   E2 missing_api_key        — DODO_API_KEY not configured in this environment
//   E3 invalid_json
//   E4 email_and_plan_required
//   E5 invalid_plan           — plan wasn't "monthly" or "yearly"
//   E6 missing_product_id     — DODO_PRODUCT_MONTHLY/DODO_PRODUCT_YEARLY not configured for the requested plan
//   E7 dodo_request_failed    — Dodo rejected the request or it otherwise failed

var DodoPayments = require('dodopayments').default;
var { normalizeEmail } = require('./lib/entitlements');

var PLAN_PRODUCT_ENV = {
  monthly: 'DODO_PRODUCT_MONTHLY',
  yearly: 'DODO_PRODUCT_YEARLY'
};

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var apiKey = process.env.DODO_API_KEY;
  if (!apiKey) {
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

  var productEnvVar = PLAN_PRODUCT_ENV[plan];
  if (!productEnvVar) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: invalid_plan' }) };
  }

  var productId = process.env[productEnvVar];
  if (!productId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E6: missing_product_id: ' + productEnvVar + ' not configured' }) };
  }

  // No dedicated checkout/pricing page exists yet (separate, later work —
  // see task boundaries), so the caller may optionally supply where to
  // send the browser after Checkout; fall back to sane same-site defaults,
  // matching create-checkout-session.js's pattern. Unlike Stripe's
  // {CHECKOUT_SESSION_ID} template var, Dodo's return_url has no
  // session-id placeholder to substitute — the session id is only known
  // from this function's own response, after the URL is already built.
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  var origin = host ? ('https://' + host) : '';
  var returnUrl = payload.successUrl || (origin + '/home.html?checkout=success');
  var cancelUrl = payload.cancelUrl || (origin + '/home.html?checkout=cancelled');

  try {
    var client = new DodoPayments({
      bearerToken: apiKey,
      environment: process.env.DODO_ENVIRONMENT || 'live_mode'
    });

    var session = await client.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email: email },
      return_url: returnUrl,
      cancel_url: cancelUrl,
      // Carries the normalized email + plan through as a fallback identity
      // source alongside the webhook payload's own data.customer.email
      // (which Dodo's Subscription object always includes directly, no
      // separate customer-lookup round trip needed the way Stripe's
      // webhook sometimes requires) — belt-and-suspenders, same reasoning
      // as create-checkout-session.js's metadata.
      metadata: { dreamtube_email: email, dreamtube_plan: plan }
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.checkout_url, sessionId: session.session_id }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'E7: dodo_request_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
