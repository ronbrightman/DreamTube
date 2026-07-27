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
//   E8 invalid_redirect_url   — successUrl/cancelUrl was supplied but isn't a safe relative path (see isSafeRedirectPath below)
//
// ── Open-redirect guard on successUrl/cancelUrl (security fix, added for
//    tracker item for-product-build-out-of-tokens-purchase-2y8hyw) ──
// Until this fix, `payload.successUrl`/`payload.cancelUrl` were honored
// completely verbatim with no validation at all — an internal audit
// flagged this as a live open-redirect surface (an attacker-controlled
// checkout link could send a paying user's browser anywhere after
// checkout). It stayed latent only because no real caller ever actually
// constructed a custom value here — shop.html always omits both fields,
// relying on the defaults below. The out-of-tokens purchase sheet
// (js/purchase-sheet.js) is the FIRST real caller to pass a genuine
// custom successUrl (carrying it back to processing.html to auto-resume
// the blocked generation, see that file's own header comment), so this
// had to be closed before that feature could ship, not after.
// isSafeRedirectPath enforces "relative path only" — not just
// "same-origin", which would still mean trusting this function's own
// derivation of `origin` (below) from request headers (x-forwarded-host/
// host), an attacker-influenceable value in a misconfigured proxy setup.
// A same-app-origin-relative PATH sidesteps that trust question entirely:
// it can only ever resolve against whatever origin this function itself
// already computed, never anywhere else. Every legitimate caller in this
// codebase (js/purchase-sheet.js) only ever needs a same-app path
// anyway — there is no real use case for an absolute or protocol-
// relative successUrl/cancelUrl today.
var REDIRECT_PATH_RE = /^\/(?!\/)/; // exactly one leading slash, not "//..." (protocol-relative)
var REDIRECT_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/; // defense in depth — belt-and-suspenders with the leading-slash check above, in case some exotic input could otherwise still parse as an absolute/scheme URL downstream
var REDIRECT_CONTROL_CHAR_RE = /[\x00-\x1f\\]/; // defense in depth — reject embedded CR/LF/tab/other control chars and backslashes, in case any downstream consumer treats them differently than this function's own leading-slash/scheme checks assume
function isSafeRedirectPath(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (!REDIRECT_PATH_RE.test(candidate)) return false;
  if (REDIRECT_SCHEME_RE.test(candidate)) return false;
  if (REDIRECT_CONTROL_CHAR_RE.test(candidate)) return false;
  return true;
}

var crypto = require('crypto');
var DodoPayments = require('dodopayments').default;
var entitlements = require('./lib/entitlements');
var normalizeEmail = entitlements.normalizeEmail;

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

// USD price per pack, mirrors shop.html's own PACK_INFO map — used only for
// the metadata.dreamtube_price fallback below, the same "belt-and-
// suspenders" role dreamtube_tokens already plays for resolvePackTokens.
// dodo-webhook.js's own resolvePackPrice prefers matching the payment's
// actual product_id against DODO_PRODUCT_PACK_* first (this is only the
// fallback path), so this never needs to be the source of truth for what
// Dodo actually charged.
var PACK_PRICES = { pack100: 2.99, pack300: 7.99, pack700: 14.99 };

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
  // still override both — js/purchase-sheet.js does exactly this to send
  // a blocked-action checkout back to processing.html for auto-resume —
  // but only with a same-app-relative path; see isSafeRedirectPath's own
  // doc comment above for why this is checked here, server-side, rather
  // than trusted from the client.
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  var origin = host ? ('https://' + host) : '';
  var returnUrl = origin + '/shop.html?checkout=success';
  if (payload.successUrl) {
    if (!isSafeRedirectPath(payload.successUrl)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E8: invalid_redirect_url: successUrl must be a relative path' }) };
    }
    returnUrl = origin + payload.successUrl;
  }
  var cancelUrl = origin + '/shop.html?checkout=cancelled';
  if (payload.cancelUrl) {
    if (!isSafeRedirectPath(payload.cancelUrl)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E8: invalid_redirect_url: cancelUrl must be a relative path' }) };
    }
    cancelUrl = origin + payload.cancelUrl;
  }

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

  // ── Repeat-purchase friction fix (tracker item
  //    for-product-repeat-purchase-friction-dod-b6pzs6) ──
  // Researched directly against the `dodopayments` npm package's own
  // shipped TypeScript types (node_modules/dodopayments/resources/
  // payments.d.ts) rather than assumed: a checkout session's `customer`
  // field accepts EITHER `{ customer_id }` (AttachExistingCustomer — attach
  // to a customer Dodo already has on file) or `{ email, name?,
  // phone_number? }` (NewCustomer — always creates/collects a customer
  // fresh). If dodo-webhook.js has already recorded a Dodo customer id for
  // this email from a prior purchase (lib/entitlements.js's
  // recordDodoCustomerId/getDodoCustomerId — stamped from the
  // payment.succeeded webhook's own `customer.customer_id`), attach to
  // THAT existing customer instead of the bare-email shape, so Dodo
  // recognizes the buyer as already-known (their name/phone are already on
  // file with that customer record) rather than collecting them fresh as
  // if this were a brand-new customer. A brand-new buyer (no stored id
  // yet) gets exactly the prior email-only behavior — nothing changes for
  // them.
  //
  // What this does NOT solve: Dodo's Customer object has no billing-
  // address field at all (confirmed via both the SDK's Customer/
  // CustomerLimitedDetails types and docs.dodopayments.com) — billing
  // address is a per-checkout-session concern with nothing to reuse across
  // sessions, customer id or not. `minimal_address: true` below is the
  // real, separately-documented lever for that (confirmed applicable to
  // this hosted checkout_url flow, not just an embedded/inline-confirm
  // flow, per docs.dodopayments.com's v1.66.0 changelog): it reduces
  // billing-address collection down to just country (always required for
  // tax) plus zip/postal code where the buyer's region needs it for tax,
  // dropping street/city/state entirely. Dodo enforces country
  // unconditionally as merchant of record; there is no way to make even
  // that fully optional, nor is there a dashboard setting this codebase
  // could instead rely on for either of these — both are request
  // parameters, applied here.
  //
  // `show_saved_payment_methods: true` is the third, independent lever:
  // Dodo's own doc comment for it is literally "Display saved payment
  // methods of a returning customer" — harmless to always set (a brand-new
  // customer simply has none to show yet).
  //
  // Honestly flagged, not assumed: docs.dodopayments.com does not
  // explicitly confirm that AttachExistingCustomer suppresses the
  // name/phone fields in the checkout UI itself (only that it's the SDK's
  // documented mechanism for identifying a returning customer, distinct
  // from NewCustomer's fresh-collection shape) — see
  // lib/entitlements.js's own doc block above recordDodoCustomerId for the
  // full reasoning on why this should still help.
  var dodoCustomerId = await entitlements.getDodoCustomerId(event, email);
  var customerField = dodoCustomerId ? { customer_id: dodoCustomerId } : { email: email };

  var sessionParams = {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: customerField,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    minimal_address: true,
    show_saved_payment_methods: true,
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
  };

  try {
    var client = new DodoPayments({
      bearerToken: apiKey,
      environment: process.env.DODO_ENVIRONMENT || 'live_mode'
    });

    var session;
    try {
      session = await client.checkoutSessions.create(sessionParams);
    } catch (attachErr) {
      // Conservative fallback, ONLY for the existing-customer-attach path:
      // a stored dodoCustomerId could in principle be stale (e.g. the
      // customer record was deleted on Dodo's own dashboard between
      // purchases) — rather than let a caching optimization ever block a
      // real purchase, retry once with the exact prior plain-email
      // behavior before giving up. A brand-new buyer (no dodoCustomerId,
      // so already on the plain-email path) gets no retry here — a
      // failure there is a real, non-retryable problem (bad product id,
      // bad API key, etc.) and must surface as E7 exactly as before this
      // change.
      if (!dodoCustomerId) throw attachErr;
      session = await client.checkoutSessions.create(Object.assign({}, sessionParams, { customer: { email: email } }));
    }

    return { statusCode: 200, body: JSON.stringify({ url: session.checkout_url, sessionId: session.session_id, eventId: eventId }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'E7: dodo_request_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
