// netlify/functions/create-checkout-session-dodo.js
//
// POST { email, pack } -> creates a Dodo Payments Checkout Session for a
// one-time DreamTube token-pack purchase and returns { url } for the
// client to redirect the browser to. `pack` is "pack100" or "pack500"
// (100 tokens / $1.99, 500 tokens / $8.95 — see shop.html).
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
//   E5 invalid_pack           — pack wasn't "pack100" or "pack500"
//   E6 missing_product_id     — DODO_PRODUCT_PACK_100/DODO_PRODUCT_PACK_500 not configured for the requested pack
//   E7 dodo_request_failed    — Dodo rejected the request or it otherwise failed

var crypto = require('crypto');
var DodoPayments = require('dodopayments').default;
var { normalizeEmail } = require('./lib/entitlements');

// Token amount per pack — mirrors the pricing already shown in shop.html
// (100 tokens/$1.99, 500 tokens/$8.95). The actual dollar amount charged
// lives entirely on the Dodo product configured for each env var below,
// not here; this amount is only used for the metadata fallback
// dodo-webhook.js reads if its product_id -> pack mapping ever changes
// after a purchase was made (see that file's resolvePackTokens).
var PACK_TOKENS = { pack100: 100, pack500: 500 };

// USD price per pack, mirrors shop.html's own PACK_INFO map — used only for
// the metadata.dreamtube_price fallback below, the same "belt-and-
// suspenders" role dreamtube_tokens already plays for resolvePackTokens.
// dodo-webhook.js's own resolvePackPrice prefers matching the payment's
// actual product_id against DODO_PRODUCT_PACK_* first (this is only the
// fallback path), so this never needs to be the source of truth for what
// Dodo actually charged.
var PACK_PRICES = { pack100: 1.99, pack500: 8.95 };

var PACK_PRODUCT_ENV = {
  pack100: 'DODO_PRODUCT_PACK_100',
  pack500: 'DODO_PRODUCT_PACK_500'
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

  // Shared between this checkout session and dodo-webhook.js's eventual
  // server-side Purchase fire (P0 reporting instrumentation — see
  // AGENT_POLICY.md's tracker item for-product-phase-1-reporting-
  // instrument-kjlh46) so the two Purchase events (this one's own
  // eventual client-side return-trip fire on shop.html, and the webhook's
  // durable server-side one) dedupe against each other on both PostHog
  // ($insert_id) and Meta (Pixel+CAPI event_id) — see
  // docs/EVENT_TAXONOMY.md's Purchase entry for the full mechanics. Minted
  // here (not on the client, and not in the webhook) because this is the
  // one place both eventual fires can trace back to a single shared value:
  // it's threaded through to the client via metadata below AND returned in
  // this response for shop.html to stash alongside its own pending-purchase
  // marker.
  var eventId = crypto.randomBytes(16).toString('hex');

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
      // Carries the normalized email + pack + token amount + shared
      // event_id through as a fallback identity/amount source alongside
      // the webhook payload's own data.customer.email and
      // data.product_cart — belt-and-suspenders, same reasoning as
      // create-checkout-session.js's metadata, and specifically
      // load-bearing if DODO_PRODUCT_PACK_* ever gets rotated between
      // checkout creation and webhook delivery (see dodo-webhook.js's
      // resolvePackTokens/resolvePackPrice). Dodo echoes metadata back
      // verbatim on the payment.succeeded webhook, which is how
      // dreamtube_event_id makes it from here to dodo-webhook.js.
      metadata: {
        dreamtube_email: email,
        dreamtube_pack: pack,
        dreamtube_tokens: PACK_TOKENS[pack],
        dreamtube_price: PACK_PRICES[pack],
        dreamtube_event_id: eventId
      }
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.checkout_url, sessionId: session.session_id, eventId: eventId }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'E7: dodo_request_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
