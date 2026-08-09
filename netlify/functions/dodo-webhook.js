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
// Handled events: `payment.succeeded` (one-time token packs AND Dreamer Pass
// subscription charges — see the Dreamer Pass section further down) plus the
// Dreamer Pass subscription lifecycle events (subscription.active/.renewed/
// .plan_changed/.update_payment_method/.on_hold/.paused/.cancelled/.failed/
// .expired). Every other event type (payment.failed/.cancelled/.processing,
// refund.*, dispute.*, credit.*, license_key.*, entitlement_grant.*,
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
//
// Dodo customer id capture (tracker item
// for-product-repeat-purchase-friction-dod-b6pzs6): a payment.succeeded
// Payment's `customer` block also carries `customer_id` (Dodo's own
// identifier for the buyer, alongside the `email` this file already reads
// into payEmail) — passed into creditTokenPackOnce below, which threads it
// into creditTokenPackAmountOnce to be stamped onto the entitlement record
// as `dodoCustomerId` (see lib/entitlements.js's own doc comment) in the
// SAME atomic write as the token credit, whenever present. A redelivery of
// an already-committed payment doesn't reach that write again (see
// creditTokenPackOnce's early-return for a 'committed' marker) — harmless,
// since the first successful delivery already stamped it and there is
// nothing new to re-stamp. create-checkout-session-dodo.js reads this back
// on a LATER purchase to attach the checkout to the buyer's existing Dodo
// customer instead of a bare email — but only after its own real-password
// verification gate; see that file's header comment for why a bare stored
// customer id is never enough on its own to unlock that.
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
//
// "The Vault" shop redesign (founder-approved 2026-08-02, tracker item
// for-product-build-ship-today-founder-app-zn9zyy): THIS IS THE ACTUAL
// CREDITING TABLE — the value here (via resolvePackTokens below) is what a
// real webhook-confirmed purchase credits onto the buyer's balance, so
// getting these four numbers right matters more than anywhere else this
// amount is mirrored. Fresh pack ids (pack099/199/499/999), replacing
// pack100/pack300/pack700 entirely — see create-checkout-session-dodo.js's
// header comment for the full no-grandfathering reasoning (never reinterpret
// an OLD pack100/300/700 webhook record as this new lineup). No more +50%
// first-purchase bonus — retired along with the old lineup; see
// lib/entitlements.js's creditTokenPackAmountOnce doc comment.
var PACK_TOKENS = { pack099: 300, pack199: 500, pack499: 1000, pack999: 2500 };

// USD price per pack — same mirrored-copy reasoning as PACK_TOKENS above,
// and same fallback role: create-checkout-session-dodo.js's own
// PACK_PRICES is the primary source of truth via metadata.dreamtube_price;
// this local copy only matters if that metadata is ever missing (a
// purchase made before this field existed) AND the product_id -> pack
// mapping below also fails to resolve — see resolvePackPrice.
var PACK_PRICES = { pack099: 0.99, pack199: 2.99, pack499: 4.99, pack999: 9.99 };

// pack099 is the one-time starter SKU — see create-checkout-session-dodo.js's
// header comment for the one-time-per-account enforcement (checked THERE,
// before any charge happens, not here). Pulled out as a constant so
// resolveIsStarterPack below reads as "is this the starter pack", not a
// magic string.
var STARTER_PACK_ID = 'pack099';

/** Maps a pack id to its DODO_PRODUCT_PACK_* env var name (the exact names Manager handed the founder to paste, 2026-08-02, tracker item for-product-ship-the-vault-shop-now-foun-23mk4c — this internal pack099/199/499/999 id stays as originally built, only the env var name was renamed to match what's actually configured) — the authoritative, current product_id -> pack mapping every resolve* function below matches product_cart[0].product_id against first. */
var PACK_PRODUCT_ENV = {
  pack099: 'DODO_PRODUCT_PACK_STARTER300',
  pack199: 'DODO_PRODUCT_PACK_SMALL500',
  pack499: 'DODO_PRODUCT_PACK_MEDIUM1500',
  pack999: 'DODO_PRODUCT_PACK_LARGE4000'
};

/**
 * Resolves which pack id (pack099/199/499/999) a completed Payment's
 * product_cart[0].product_id corresponds to, matching against the SAME
 * DODO_PRODUCT_PACK_* env vars create-checkout-session-dodo.js used to
 * create the checkout in the first place — the authoritative, current
 * mapping, needing no cooperation from the payload itself. Returns
 * undefined if nothing matches (e.g. those env vars were rotated between
 * checkout creation and webhook delivery) — callers fall back to
 * metadata in that case, same "don't guess" posture as resolvePackTokens/
 * resolvePackPrice below.
 */
function resolvePackId(payment) {
  var cart = payment.product_cart || [];
  var productId = cart.length ? cart[0].product_id : undefined;
  if (!productId) return undefined;
  var packIds = Object.keys(PACK_PRODUCT_ENV);
  for (var i = 0; i < packIds.length; i++) {
    if (productId === process.env[PACK_PRODUCT_ENV[packIds[i]]]) return packIds[i];
  }
  return undefined;
}

/**
 * Resolves how many BASE tokens a completed Payment should credit. Prefers
 * matching the payment's product_cart[0].product_id against the current
 * DODO_PRODUCT_PACK_* env vars (via resolvePackId above) — this is the
 * authoritative, current mapping. Falls back to the metadata
 * create-checkout-session-dodo.js attached at checkout time
 * (dreamtube_tokens, a plain integer), for the case those env vars have
 * changed between checkout creation and webhook delivery. Returns
 * undefined if neither resolves — the caller treats that as "can't
 * determine what to credit" and does nothing, rather than guessing.
 */
function resolvePackTokens(payment) {
  var packId = resolvePackId(payment);
  if (packId) return PACK_TOKENS[packId];
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
 * against the current DODO_PRODUCT_PACK_* env vars (via resolvePackId),
 * falling back to the metadata.dreamtube_price create-checkout-session-
 * dodo.js attached at checkout time. Returns undefined if neither
 * resolves — callers must treat that as "can't determine what to report"
 * and skip firing Purchase entirely, rather than guess or send a
 * zero/placeholder value that would corrupt revenue reporting.
 */
function resolvePackPrice(payment) {
  var packId = resolvePackId(payment);
  if (packId) return PACK_PRICES[packId];
  var metaPrice = payment.metadata && payment.metadata.dreamtube_price;
  var parsed = typeof metaPrice === 'number' ? metaPrice : parseFloat(metaPrice);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolves whether a completed Payment's pack is the one-time starter
 * (pack099), for the Purchase conversion event's `starter` flag (tracker
 * item for-product-build-ship-today-founder-app-zn9zyy, item 5 — "so
 * growth can measure starter-pack conversion specifically"). Prefers the
 * same authoritative product_cart[0].product_id match resolvePackId uses;
 * falls back to metadata.dreamtube_starter (a real boolean, echoed back
 * verbatim by Dodo — see create-checkout-session-dodo.js), then to
 * metadata.dreamtube_pack === 'pack099' as a last resort. Always resolves
 * to a real boolean (never undefined) — unlike resolvePackTokens/
 * resolvePackPrice, an unresolvable case here fails toward `false` rather
 * than skipping the whole event: `starter` is a nice-to-have analytics
 * dimension on an event that's otherwise fully resolvable, not something
 * worth losing the entire Purchase conversion over.
 */
function resolveIsStarterPack(payment) {
  var packId = resolvePackId(payment);
  if (packId) return packId === STARTER_PACK_ID;
  var meta = payment.metadata || {};
  if (typeof meta.dreamtube_starter === 'boolean') return meta.dreamtube_starter;
  if (typeof meta.dreamtube_starter === 'string') return meta.dreamtube_starter === 'true';
  return meta.dreamtube_pack === STARTER_PACK_ID;
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
    // `starter` (tracker item for-product-build-ship-today-founder-app-
    // zn9zyy, item 5): true only for the one-time $0.99 starter pack — see
    // resolveIsStarterPack's own doc comment. Lets growth measure
    // starter-pack conversion specifically from this same durable
    // server-side event, without needing a second query joined against
    // pack ids.
    var starter = resolveIsStarterPack(payment);

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
      starter: starter,
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

// ============================================================================
// Dreamer Pass subscription handling ($9.99/month, 3-day free trial —
// founder-approved). See lib/entitlements.js's DREAMER PASS doc block for the
// two token effects (100/day trial claim boost; 3000-token lump per paid
// charge) and the `subscription` record shape this writes.
// ----------------------------------------------------------------------------
// TWO defensive design points, because Dodo's exact trial->paid event
// ordering and per-event payload field names are under-documented (the human
// test-purchase will confirm the real shapes from the logSubEvent() output
// below — see this file's LOGGING note):
//
//   1. RECOGNIZING a subscription charge. Primary signal: the payment's
//      product_id matches DODO_PRODUCT_DREAMER_PASS. Fallbacks:
//      metadata.dreamtube_plan === 'dreamer_pass' (set at checkout), and — as
//      a last resort — a payment carrying a subscription_id that resolves to
//      no known one-time pack (the ONLY subscription product in this system
//      is the Pass, so a subscription-linked non-pack payment must be it).
//      resolvePackTokens is always checked first, so a real one-time pack can
//      never be mis-routed here.
//
//   2. GRANTING exactly once per charge. The 3000-token lump is granted via
//      the SAME creditTokenPackOnce path a pack uses, keyed by the Dodo
//      payment_id — so a redelivered webhook, OR both a `payment.succeeded`
//      and a `subscription.renewed` firing for the SAME charge (they share a
//      payment_id), collapse to exactly ONE 3000 grant. Subscription STATE
//      writes (updateSubscription) are idempotent overwrites and need no such
//      dedup.
// ============================================================================

// Which subscription.* event types map to a terminal (no-longer-subscribed)
// state — clearing `active` and the trial boost by writing this status.
var TERMINAL_SUBSCRIPTION_STATUS = {
  'subscription.on_hold': 'on_hold',
  'subscription.paused': 'paused',
  'subscription.cancelled': 'cancelled',
  'subscription.failed': 'failed',
  'subscription.expired': 'expired'
};

// Every subscription.* event this handler acts on (or, for
// update_payment_method, merely logs).
var SUBSCRIPTION_EVENT_TYPES = {
  'subscription.active': true,
  'subscription.renewed': true,
  'subscription.plan_changed': true,
  'subscription.update_payment_method': true,
  'subscription.on_hold': true,
  'subscription.paused': true,
  'subscription.cancelled': true,
  'subscription.failed': true,
  'subscription.expired': true
};

function dreamerPassProductId() {
  return process.env.DODO_PRODUCT_DREAMER_PASS;
}

/** All product ids carried by a Payment payload (product_cart entries plus a top-level product_id, if any). */
function paymentProductIds(payment) {
  var ids = [];
  (payment.product_cart || []).forEach(function (item) { if (item && item.product_id) ids.push(item.product_id); });
  if (payment.product_id) ids.push(payment.product_id);
  return ids;
}

/** See design point 1 above. */
function isDreamerPassPayment(payment) {
  var passId = dreamerPassProductId();
  if (passId && paymentProductIds(payment).indexOf(passId) !== -1) return true;
  var meta = payment.metadata || {};
  if (meta.dreamtube_plan === entitlements.DREAMER_PASS_PLAN) return true;
  // Last-resort: a subscription-linked payment that is not any known pack.
  if (payment.subscription_id && !resolvePackTokens(payment)) return true;
  return false;
}

/** Coerces a Dodo timestamp (ISO string, epoch-seconds, or epoch-ms) to epoch-ms, or null. */
function resolveEpochMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // >1e12 already ms; else treat as seconds
  if (typeof v === 'string') { var t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** First of `keys` on `obj` that resolves to a real epoch-ms, or null. */
function firstResolvable(obj, keys) {
  for (var i = 0; i < keys.length; i++) { var ms = resolveEpochMs(obj[keys[i]]); if (ms) return ms; }
  return null;
}

// Field names are guesses across Dodo's documented + plausible shapes — the
// test purchase's logSubEvent() output confirms which one is real.
function resolveTrialEnd(sub) {
  return firstResolvable(sub, ['trial_end_date', 'trial_ends_at', 'trialEndsAt', 'trial_end', 'trialEnd']);
}
function resolveNextBilling(sub) {
  return firstResolvable(sub, ['next_billing_date', 'next_billing_at', 'nextBillingDate', 'current_period_end', 'currentPeriodEnd']);
}
function subStatusIsTrialing(sub) {
  var status = (sub.status || '').toLowerCase();
  if (status === 'trialing' || status === 'trial' || status === 'on_trial') return true;
  if (sub.trialing === true) return true;
  var te = resolveTrialEnd(sub);
  return !!(te && Date.now() < te);
}
function subscriptionEmail(sub) {
  return (sub.customer && sub.customer.email) || (sub.metadata && sub.metadata.dreamtube_email);
}
function subscriptionEventPaymentId(sub) {
  return sub.payment_id || sub.latest_payment_id || sub.last_payment_id || (sub.payment && sub.payment.payment_id) || null;
}
function subscriptionDodoCustomerId(sub) {
  return sub.customer && sub.customer.customer_id;
}

/** Logs an event's key (non-secret) fields so the human can read the real Dodo sequence/shapes in Netlify function logs during the test purchase. */
function logSubEvent(type, fields) {
  try { console.log('dodo-webhook: ' + type + ' ' + JSON.stringify(fields)); } catch (e) { /* never let logging break the webhook */ }
}

/**
 * Grants the 3000-token Dreamer Pass monthly lump for one charge, idempotently
 * keyed by `paymentId` — reuses creditTokenPackOnce exactly as a pack does, so
 * a redelivery or a duplicate event (payment.succeeded + subscription.renewed
 * sharing a payment_id) never double-grants. No-ops when email or paymentId is
 * missing (nothing safe to key a dedup on — same posture as the pack path).
 */
async function grantDreamerPassCharge(event, email, paymentId, dodoCustomerId) {
  if (!email || !paymentId) return { credited: false };
  return entitlements.creditTokenPackOnce(event, email, paymentId, entitlements.DREAMER_PASS_MONTHLY_TOKENS, dodoCustomerId);
}

/** Handles a `payment.succeeded` that is a Dreamer Pass charge (initial trial-end charge or a renewal that arrives as a payment): grant 3000 once, mark the account active (ending any trial boost). */
async function handleDreamerPassPayment(event, payment) {
  var payEmail = (payment.customer && payment.customer.email) || (payment.metadata && payment.metadata.dreamtube_email);
  var dodoCustomerId = payment.customer && payment.customer.customer_id;
  logSubEvent('payment.succeeded[dreamer_pass]', {
    payment_id: payment.payment_id || null,
    subscription_id: payment.subscription_id || null,
    product_ids: paymentProductIds(payment),
    email: payEmail || null,
    total_amount: payment.total_amount,
    currency: payment.currency
  });
  if (!payEmail) return; // acknowledged, nothing credited — same "don't guess" posture as the pack path

  // A $0 payment is the trial-START authorization, NOT a real charge. It must
  // never grant the 3,000 monthly tokens, and must never flip the account to
  // 'active' (which would end the 100/day trial boost the instant the trial
  // begins). The trial state is owned entirely by subscription.active; the real
  // 3,000 grant happens only on the first >$0 charge (trial-end conversion or a
  // renewal). Founder repro 2026-08-09: starting the Pass sent a $0
  // payment.succeeded alongside subscription.active — without this guard the
  // free trial would have granted a full month and cancelled its own trial.
  // Ambiguity (missing/NaN amount) fails toward NOT granting: a genuine paid
  // charge is also covered by subscription.renewed's own grant (deduped by
  // payment_id), so skipping here can never lose a real grant.
  var chargedAmount = Number(payment.total_amount);
  if (!(chargedAmount > 0)) {
    return; // trial-start $0 — subscription.active owns the state, nothing to grant
  }

  await grantDreamerPassCharge(event, payEmail, payment.payment_id, dodoCustomerId);

  // A real charge means paying, not trialing — status 'active' + trialEnd:null
  // ends the 100/day boost even if no subscription.active/renewed state event
  // fires. Idempotent overwrite; richer data from a state event merges on top.
  await entitlements.updateSubscription(event, payEmail, {
    status: 'active',
    subscriptionId: payment.subscription_id,
    productId: dreamerPassProductId(),
    trialEnd: null
  });
}

/** Handles every subscription.* lifecycle event: writes the resulting subscription state (and, for a renewal, grants that charge's 3000). */
async function handleSubscriptionEvent(event, type, sub) {
  var email = subscriptionEmail(sub);
  var dodoCustomerId = subscriptionDodoCustomerId(sub);
  logSubEvent(type, {
    subscription_id: sub.subscription_id || null,
    product_id: sub.product_id || null,
    status: sub.status || null,
    email: email || null,
    trial_end: resolveTrialEnd(sub),
    next_billing: resolveNextBilling(sub),
    payment_id: subscriptionEventPaymentId(sub)
  });

  // update_payment_method carries no reliable status and must not risk
  // flipping a trialing account to 'active' (which would end the boost early)
  // — log only, change no state.
  if (type === 'subscription.update_payment_method') return;

  if (!email) return; // can't key subscription state without an identity

  if (TERMINAL_SUBSCRIPTION_STATUS[type]) {
    // cancel/expire/on_hold/paused/failed: clear the active state + trial
    // boost by writing the terminal status (isTrialActive/isSubscriptionActive
    // both go false). trialEnd:null explicitly ends any lingering boost.
    await entitlements.updateSubscription(event, email, {
      status: TERMINAL_SUBSCRIPTION_STATUS[type],
      subscriptionId: sub.subscription_id,
      productId: sub.product_id || dreamerPassProductId(),
      trialEnd: null
    });
    return;
  }

  // active / renewed / plan_changed: live subscription state.
  var trialing = subStatusIsTrialing(sub);
  await entitlements.updateSubscription(event, email, {
    status: trialing ? 'trialing' : 'active',
    subscriptionId: sub.subscription_id,
    productId: sub.product_id || dreamerPassProductId(),
    nextBillingAt: resolveNextBilling(sub),
    currentPeriodEnd: resolveNextBilling(sub),
    // trialing WITH a resolvable end -> set it; trialing WITHOUT -> undefined
    // (updateSubscription keeps a prior trialEnd, or caps a first sighting to
    // now + 3 days); not trialing -> null (clear).
    trialEnd: trialing ? (resolveTrialEnd(sub) || undefined) : null
  });

  // A renewal is also a charge — grant that charge's 3000, keyed by its own
  // payment_id so it dedups against any payment.succeeded for the same charge.
  // No-ops if this payload carries no payment_id (then payment.succeeded is
  // the grant path).
  if (type === 'subscription.renewed') {
    await grantDreamerPassCharge(event, email, subscriptionEventPaymentId(sub), dodoCustomerId);
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

      // Dreamer Pass subscription charge vs. one-time token pack. Checked
      // FIRST (resolvePackTokens is consulted inside isDreamerPassPayment's
      // own last-resort branch, so a genuine pack can never be mis-routed
      // here) — a subscription charge grants the fixed 3000-token monthly
      // lump, not a pack amount. See this file's Dreamer Pass section.
      if (isDreamerPassPayment(payment)) {
        await handleDreamerPassPayment(event, payment);
        return { statusCode: 200, body: JSON.stringify({ received: true }) };
      }

      var payEmail = (payment.customer && payment.customer.email) ||
        (payment.metadata && payment.metadata.dreamtube_email);
      var dodoCustomerId = payment.customer && payment.customer.customer_id;
      var tokens = resolvePackTokens(payment);

      if (payEmail && tokens) {
        // dodoCustomerId capture is threaded straight into creditTokenPackOnce
        // below (which threads it further into creditTokenPackAmountOnce),
        // NOT applied via a separate setEntitlement call here — a standalone
        // write racing spendTokens (this same record's highest-frequency
        // writer, plain and unguarded) turned out to be a genuine data-
        // integrity hazard (review round-2 finding, tracker item
        // for-product-repeat-purchase-friction-dod-b6pzs6): whichever plain
        // write landed second could silently clobber the other's field. See
        // creditTokenPackAmountOnce's own doc comment for the full mechanics
        // of why folding this into its existing atomic retryingWrite closes
        // the race instead of just narrowing it. Scoped to a genuinely
        // resolvable token-pack payment (the same `payEmail && tokens` gate
        // as the credit itself) for the same reason the original standalone
        // write was: an event this codebase can't even determine a token
        // amount for is unprocessable (see the "acknowledged, nothing
        // credited" comment further down) and must not have the side effect
        // of conjuring a brand-new, otherwise-empty entitlement record
        // purely to hold a customer id.
        var creditResult = await entitlements.creditTokenPackOnce(event, payEmail, payment.payment_id, tokens, dodoCustomerId);
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
    } else if (SUBSCRIPTION_EVENT_TYPES[dodoEvent.type]) {
      // Dreamer Pass lifecycle event — writes subscription state (and, for a
      // renewal, grants that charge's 3000). See the Dreamer Pass section.
      await handleSubscriptionEvent(event, dodoEvent.type, dodoEvent.data || {});
    }
    // Any other event type: acknowledged below, no action taken.

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E5: processing_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
