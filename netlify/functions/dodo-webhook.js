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
//
// ---------------------------------------------------------------------
// Server-side Purchase conversion (P0 reporting instrumentation — tracker
// item for-product-phase-1-reporting-instrument-kjlh46, founder-greenlit
// 2026-07-26): shop.html's client-side purchase_completed/Purchase fire
// (see that file's handleCheckoutReturn) only ever fires if the buyer's
// browser actually lands back on ?checkout=success with its
// dreamtube_pending_purchase sessionStorage marker still present — a
// reload, a cross-device return, or a closed tab after paying all miss it
// entirely. This handler is Dodo's own durable, signature-verified
// confirmation that a payment actually happened, so it's the trustworthy
// place to fire Purchase too, to BOTH PostHog and Meta CAPI, deduped
// against the client-side fire via a event_id shared through Dodo's
// metadata (minted once, in create-checkout-session-dodo.js, at checkout
// creation time — see that file's own comment). See
// docs/EVENT_TAXONOMY.md's Purchase entry for the full mechanics.
//
// This fires only when a credit ACTUALLY happens this call (see
// creditResult.credited below) — a redelivered webhook for an
// already-fully-processed payment_id must not double-report revenue just
// because it double-acknowledges the balance side as a safe no-op. It's
// wrapped in its own try/catch, entirely separate from the try/catch
// around creditTokenPackOnce, so a PostHog/Meta failure can NEVER turn a
// successful token credit into a 500 (which would make Dodo redeliver and
// double-credit) — "analytics must never break the app" applies just as
// much to a webhook as it does to a page.
// ---------------------------------------------------------------------

var crypto = require('crypto');
var DodoPayments = require('dodopayments').default;
var entitlements = require('./lib/entitlements');
var accountStore = require('./lib/account-store');
var posthogCapture = require('./lib/posthog-capture');
var metaCapi = require('./lib/meta-capi');

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
// vars, not from a hardcoded table).
var PACK_TOKENS = { pack100: 100, pack500: 500 };

// USD price per pack — same mirrored-copy reasoning as PACK_TOKENS above,
// and same fallback role: create-checkout-session-dodo.js's own
// PACK_PRICES is the primary source of truth via metadata.dreamtube_price;
// this local copy only matters if that metadata is ever missing (a
// purchase made before this field existed) AND the product_id -> pack
// mapping below also fails to resolve — see resolvePackPrice.
var PACK_PRICES = { pack100: 1.99, pack500: 8.95 };

/**
 * Resolves how many tokens a completed Payment should credit.
 *
 * Prefers matching the payment's product_cart[0].product_id against the
 * same DODO_PRODUCT_PACK_100/DODO_PRODUCT_PACK_500 env vars
 * create-checkout-session-dodo.js uses to create the checkout in the first
 * place — this is the authoritative, current mapping and needs no
 * cooperation from the payload itself. Falls back to the metadata
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
    if (productId === process.env.DODO_PRODUCT_PACK_500) return PACK_TOKENS.pack500;
  }
  var metaTokens = payment.metadata && payment.metadata.dreamtube_tokens;
  var parsed = typeof metaTokens === 'number' ? metaTokens : parseInt(metaTokens, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolves the USD price a completed Payment's pack corresponds to, for the
 * Purchase conversion's `value` — NEVER trusts anything the client itself
 * could have supplied, same "don't trust the client for money" reasoning
 * every other server-side amount in this codebase already follows. Mirrors
 * resolvePackTokens exactly: prefers matching product_cart[0].product_id
 * against the current DODO_PRODUCT_PACK_100/500 env vars (the authoritative,
 * current mapping), falling back to the metadata.dreamtube_price
 * create-checkout-session-dodo.js attached at checkout time. Returns
 * undefined if neither resolves — callers must treat that as "can't
 * determine what to report" and skip firing Purchase entirely, rather than
 * guess or send a zero/placeholder value that would corrupt revenue
 * reporting.
 */
function resolvePackPrice(payment) {
  var cart = payment.product_cart || [];
  var productId = cart.length ? cart[0].product_id : undefined;
  if (productId) {
    if (productId === process.env.DODO_PRODUCT_PACK_100) return PACK_PRICES.pack100;
    if (productId === process.env.DODO_PRODUCT_PACK_500) return PACK_PRICES.pack500;
  }
  var metaPrice = payment.metadata && payment.metadata.dreamtube_price;
  var parsed = typeof metaPrice === 'number' ? metaPrice : parseFloat(metaPrice);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Fires the server-side Purchase conversion (PostHog + Meta CAPI) for a
 * confirmed, credited token-pack payment — see the header comment's
 * "Server-side Purchase conversion" section for the full why. Never
 * throws: every failure (price unresolvable, PostHog/Meta unreachable, no
 * matching local account) is swallowed, since this must never turn a
 * successful token credit into a failed webhook response.
 */
async function firePurchaseConversion(event, payment, payEmail, tokens) {
  try {
    var price = resolvePackPrice(payment);
    if (price == null) return; // can't determine what to report — don't guess, same as resolvePackTokens' own undefined-return contract

    // Shared with shop.html's own client-side Purchase fire (see
    // handleCheckoutReturn) via Dodo's echoed-back metadata — this is what
    // lets PostHog ($insert_id) and Meta (Pixel+CAPI event_id) dedupe the
    // two fires into one counted conversion instead of double-counting. A
    // payment that predates this metadata field (or one that otherwise
    // never carried it) falls back to a fresh id — this specific Purchase
    // simply won't have a client-side counterpart to dedupe against, which
    // is the correct, non-guessing behavior rather than fabricating a
    // shared id that was never actually shared.
    var eventId = (payment.metadata && payment.metadata.dreamtube_event_id) || crypto.randomBytes(16).toString('hex');
    var eventTimeMs = Date.now();
    var pack = payment.metadata && payment.metadata.dreamtube_pack;

    // distinct_id must match what the client's posthog.identify() used —
    // the account's raw username, not its email (see
    // lib/posthog-capture.js's header comment). Resolved via the real
    // server-side account store; falls back to the normalized email itself
    // (better than dropping the event) for the rare case no matching
    // account record exists (e.g. a legacy/local-only account that was
    // never backfilled server-side — see js/store.js's
    // backfillAccountServerSide).
    var account = await accountStore.getByEmail(event, payEmail).catch(function () { return null; });
    var distinctId = (account && account.username) || entitlements.normalizeEmail(payEmail);

    var postHogProps = {
      value: price,
      currency: 'USD',
      timestamp: new Date(eventTimeMs).toISOString(),
      pack: pack,
      tokens: tokens,
      $insert_id: eventId // PostHog's own dedup key -- see lib/posthog-capture.js header comment
    };

    await Promise.all([
      posthogCapture.captureEvent({
        event: 'purchase_completed',
        distinct_id: distinctId,
        properties: postHogProps,
        timestamp: eventTimeMs
      }),
      metaCapi.sendCapiEvent({
        event_name: 'Purchase',
        event_id: eventId,
        event_time: Math.floor(eventTimeMs / 1000),
        email: payEmail,
        custom_data: { value: price, currency: 'USD' }
      })
    ]);
  } catch (e) {
    // analytics must never break the app -- the token credit above has
    // already happened and must not be undone or fail because of this.
  }
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
        var creditResult = await entitlements.creditTokenPackOnce(event, payEmail, payment.payment_id, tokens);
        // creditTokenPackOnce's own doc comment flags `credited: true` as
        // exactly the signal a caller should gate a one-time side effect
        // on (a receipt email, an analytics event) — `credited: false`
        // means this paymentId was already fully processed (a genuine
        // Dodo redelivery of an already-committed payment, or a duplicate
        // resume), a safe no-op for the BALANCE but NOT a new purchase to
        // report. Firing Purchase unconditionally here (ignoring this
        // return value) would double-report revenue on every redelivered
        // webhook — the exact thing event_id dedup is meant to prevent,
        // just from this codebase's own webhook re-firing itself rather
        // than a client/server dedup gap. Never allowed to affect this
        // handler's response either way — see firePurchaseConversion's own
        // doc comment and the header comment's "Server-side Purchase
        // conversion" section above.
        if (creditResult && creditResult.credited) {
          await firePurchaseConversion(event, payment, payEmail, tokens);
        }
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
