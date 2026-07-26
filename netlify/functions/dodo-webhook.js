// netlify/functions/dodo-webhook.js
//
// POST (from Dodo Payments, not the DreamTube client) — verifies the
// webhook signature (DODO_WEBHOOK_SECRET) and, on a confirmed one-time
// token-pack payment, credits the buyer's token balance via
// lib/entitlements.js's creditTokenPackOnce, keyed by normalized email
// (see that file's header for why email, not a new user-id). This is the
// durable source of truth for a purchase actually having happened — unlike
// a client-side "I just paid" signal (there is none here — shop.html never
// grants tokens itself), it can't be spoofed (signature-verified) and it's
// the only path that ever hears about the payment completing at all.
//
// Adapted from the original claude/dodo-payments-backend branch, which
// built this for *subscription* lifecycle events (subscription.active,
// .renewed, .cancelled, etc., each carrying a full Subscription object).
// That branch predates the token-economy pivot — DreamTube's monetization
// model is now a one-time token-pack purchase (create-checkout-session-
// dodo.js), so the event this handler actually cares about is
// `payment.succeeded` (Dodo's one-time-payment confirmation), not any
// `subscription.*` event. `payment.succeeded`'s `data` is a Payment object
// carrying its own `customer`, `product_cart`, `metadata`, and `payment_id`
// — see resolvePackTokens below for how the token amount is derived from
// it.
//
// Dodo's webhooks follow the Standard Webhooks specification (the same
// spec Svix/Resend/Polar.sh use), verified here via the official
// `dodopayments` npm SDK's `client.webhooks.unwrap()`.  Three headers carry
// the signature: webhook-id, webhook-timestamp, webhook-signature.
//
// Handled event: `payment.succeeded` only. Every other event type
// (payment.failed/.cancelled/.processing, refund.*, dispute.*,
// subscription.* — the dormant Stripe-equivalent subscription backend has
// no Dodo counterpart wired up, and this branch never created any Dodo
// subscription products — credit.*, license_key.*, entitlement_grant.*,
// abandoned_checkout.*, dunning.*) is acknowledged (200) and ignored — same
// reasoning as stripe-webhook.js: dashboards commonly have many event types
// enabled on one endpoint, and silently ignoring the ones we don't act on
// is correct, not a bug. Notably this means a refund does NOT claw back
// already-granted tokens — out of scope for this pass (the original branch
// didn't handle refunds either); if this becomes a real problem, handle
// refund.succeeded by deducting via lib/entitlements.js's spendTokens
// (which already floors at 0, so it can never go negative even if the
// tokens were already spent).
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
//   E5 processing_failed         — signature verified, but crediting tokens failed (Blobs error, etc.);
//                                  returns 500 deliberately so Dodo retries delivery, since our own
//                                  write is what failed, not the event itself being invalid

var DodoPayments = require('dodopayments').default;
var entitlements = require('./lib/entitlements');

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

// Token amount per pack — must match create-checkout-session-dodo.js's own
// PACK_TOKENS exactly (kept as a separate copy rather than a shared import
// so this file has no compile-time dependency on that one; a mismatch
// would only matter for the metadata fallback below, since the primary
// path resolves the amount from the *current* DODO_PRODUCT_PACK_* env
// vars, not from a hardcoded table). These are BASE tokens — the +50%
// first-purchase bonus (see resolvePackTokens' caller below) is applied
// separately, per-account, by lib/entitlements.js's
// creditTokenPackAmountOnce, never baked into this table.
var PACK_TOKENS = { pack100: 100, pack300: 300, pack700: 700 };

/**
 * Resolves how many BASE tokens a completed Payment should credit (before
 * any first-purchase bonus — see creditTokenPackAmountOnce, which decides
 * and applies that separately, per-account).
 *
 * Prefers matching the payment's product_cart[0].product_id against the
 * same DODO_PRODUCT_PACK_100/DODO_PRODUCT_PACK_300/DODO_PRODUCT_PACK_700
 * env vars create-checkout-session-dodo.js uses to create the checkout in
 * the first place — this is the authoritative, current mapping and needs
 * no cooperation from the payload itself. Falls back to the metadata
 * create-checkout-session-dodo.js attached at checkout time
 * (dreamtube_tokens, a plain integer), for the case those env vars have
 * changed between checkout creation and webhook delivery. Returns
 * undefined if neither resolves — the caller treats that as "can't
 * determine what to credit" and does nothing, rather than guessing.
 */
function resolvePackTokens(payment) {
  var cart = payment.product_cart || [];
  var productId = cart.length ? cart[0].product_id : undefined;
  if (productId) {
    if (productId === process.env.DODO_PRODUCT_PACK_100) return PACK_TOKENS.pack100;
    if (productId === process.env.DODO_PRODUCT_PACK_300) return PACK_TOKENS.pack300;
    if (productId === process.env.DODO_PRODUCT_PACK_700) return PACK_TOKENS.pack700;
  }
  var metaTokens = payment.metadata && payment.metadata.dreamtube_tokens;
  var parsed = typeof metaTokens === 'number' ? metaTokens : parseInt(metaTokens, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
    if (dodoEvent.type === 'payment.succeeded') {
      var payment = dodoEvent.data || {};
      var payEmail = (payment.customer && payment.customer.email) ||
        (payment.metadata && payment.metadata.dreamtube_email);
      var tokens = resolvePackTokens(payment);

      if (payEmail && tokens) {
        await entitlements.creditTokenPackOnce(event, payEmail, payment.payment_id, tokens);
      }
      // No resolvable email, or no resolvable token amount: acknowledged
      // below, nothing credited — same "don't guess" reasoning as
      // resolvePackTokens' own undefined return.
    }
    // Any other event type: acknowledged below, no action taken.

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E5: processing_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
