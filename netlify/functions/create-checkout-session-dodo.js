// netlify/functions/create-checkout-session-dodo.js
//
// POST { email, pack } -> creates a Dodo Payments Checkout Session for a
// one-time DreamTube token-pack purchase and returns { url } for the
// client to redirect the browser to. `pack` is "pack100", "pack300", or
// "pack700" (100 tokens / $2.99, 300 tokens / $7.99, 700 tokens / $14.99
// — "Token Economy C", founder-approved 2026-07-26 night — see
// shop.html). A user's first-ever successful pack purchase additionally
// credits +50% tokens — applied server-side by dodo-webhook.js /
// lib/entitlements.js on the confirmed payment, nothing here needs to
// know about it (this function only ever creates the checkout session,
// see below).
//
// This function only creates the Checkout Session — it does not itself
// grant any tokens. The credit is applied by dodo-webhook.js once Dodo
// confirms the payment (`payment.succeeded`), which is the durable
// source of truth, exactly like generate-video.js never trusting a
// client-side "I just generated" signal.
//
// Adapted from the original claude/dodo-payments-backend branch, which
// built this same plumbing for a *subscription* (`plan: "monthly" |
// "yearly"`) — that branch predates the token-economy pivot. DreamTube's
// monetization model is now a one-time token-pack purchase (see
// lib/entitlements.js's token-economy doc block and shop.html), not a
// recurring subscription, so this is the one-time-purchase equivalent:
// same request/response contract shape, `pack` in place of `plan`, and a
// token amount instead of a recurring plan name. Dodo's checkout API
// itself needs no separate "mode" flag for one-time vs. subscription —
// that's determined by how the referenced product_id was configured in
// the Dodo dashboard (a one-time-price product vs. a recurring-price
// product), not by anything this function sends.
//
// No product IDs or dollar amounts are hardcoded here — both come from
// environment variables the founder sets after creating the actual Dodo
// Payments one-time-purchase products in their own Dodo dashboard (see
// docs/PAYWALL_SETUP.md). This function cannot be exercised end-to-end
// until those env vars + real Dodo credentials exist; written
// correct-by-inspection against Dodo Payments' current Node SDK
// (`dodopayments` on npm, generated from their OpenAPI spec) and public
// API docs (docs.dodopayments.com).
//
// Error codes (local to this function, same reasoning as
// create-checkout-session.js for why this isn't part of the E1xx/E2xx
// generation-flow chain):
//   E1 method_not_allowed
//   E2 missing_api_key        — DODO_API_KEY not configured in this environment
//   E3 invalid_json
//   E4 email_and_pack_required
//   E5 invalid_pack           — pack wasn't "pack100", "pack300", or "pack700"
//   E6 missing_product_id     — DODO_PRODUCT_PACK_100/DODO_PRODUCT_PACK_300/DODO_PRODUCT_PACK_700 not configured for the requested pack
//   E7 dodo_request_failed    — Dodo rejected the request or it otherwise failed

var DodoPayments = require('dodopayments').default;
var { normalizeEmail } = require('./lib/entitlements');

// Token amount per pack — mirrors the pricing already shown in shop.html
// (100 tokens/$2.99, 300 tokens/$7.99, 700 tokens/$14.99 — "Token Economy
// C", founder-approved 2026-07-26 night). The actual dollar amount charged
// lives entirely on the Dodo product configured for each env var below,
// not here; this amount is only used for the metadata fallback
// dodo-webhook.js reads if its product_id -> pack mapping ever changes
// after a purchase was made (see that file's resolvePackTokens). Does NOT
// include the +50% first-purchase bonus — that's decided and applied
// entirely server-side on the webhook's crediting path (see
// lib/entitlements.js's creditTokenPackAmountOnce), never known at
// checkout-creation time.
var PACK_TOKENS = { pack100: 100, pack300: 300, pack700: 700 };

var PACK_PRODUCT_ENV = {
  pack100: 'DODO_PRODUCT_PACK_100',
  pack300: 'DODO_PRODUCT_PACK_300',
  pack700: 'DODO_PRODUCT_PACK_700'
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
  var pack = (payload.pack || '').trim().toLowerCase();
  if (!email || !pack) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: email_and_pack_required' }) };
  }

  var productEnvVar = PACK_PRODUCT_ENV[pack];
  if (!productEnvVar) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: invalid_pack' }) };
  }

  var productId = process.env[productEnvVar];
  if (!productId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E6: missing_product_id: ' + productEnvVar + ' not configured' }) };
  }

  // shop.html is the real checkout entry point (unlike the original
  // subscription branch, written before any pricing/checkout UI existed),
  // so default back there rather than a placeholder page. The caller may
  // still override both, same as create-checkout-session.js.
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  var origin = host ? ('https://' + host) : '';
  var returnUrl = payload.successUrl || (origin + '/shop.html?checkout=success');
  var cancelUrl = payload.cancelUrl || (origin + '/shop.html?checkout=cancelled');

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
      // Carries the normalized email + pack + token amount through as a
      // fallback identity/amount source alongside the webhook payload's
      // own data.customer.email and data.product_cart — belt-and-
      // suspenders, same reasoning as create-checkout-session.js's
      // metadata, and specifically load-bearing if DODO_PRODUCT_PACK_*
      // ever gets rotated between checkout creation and webhook delivery
      // (see dodo-webhook.js's resolvePackTokens).
      metadata: { dreamtube_email: email, dreamtube_pack: pack, dreamtube_tokens: PACK_TOKENS[pack] }
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.checkout_url, sessionId: session.session_id }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'E7: dodo_request_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
