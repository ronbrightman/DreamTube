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
//
// Dreamer Pass server-side conversion (tracker item
// for-product-build-conversion-tracking-fo-k5ow3q): the pack-purchase
// Purchase conversion above has always fired for every credited token pack;
// this closes the matching gap for the Dreamer Pass SUBSCRIPTION, which has
// been LIVE FOR EVERYONE since 2026-08-09 (see the "Dreamer Pass is LIVE
// FOR EVERYONE" comment in shop.html) with NO conversion event of its own
// until this change — real customers have been able to subscribe with this
// revenue going completely untracked in Meta CAPI/PostHog the whole time.
// See fireDreamerPassConversion (a sibling of firePurchaseConversion, not a
// generalization of it — see that function's own doc comment for why) and
// its two call sites: handleDreamerPassPayment (the first real charge —
// fires Meta's 'Subscribe') and handleSubscriptionEvent's
// subscription.renewed branch (every later charge — fires Meta's
// 'Purchase', standard Meta convention for a subscription's later charges).
// Both gate on the SAME `credited: true` dedup contract the pack path uses.
// See docs/EVENT_TAXONOMY.md's Subscribe/Purchase (Dreamer Pass) entry.
// ---------------------------------------------------------------------
//
// Analytics failure visibility (found investigating real Dreamer Pass
// revenue reported by PostHog but not Meta CAPI over 08-12/13/14): both
// firePurchaseConversion and fireDreamerPassConversion fire PostHog and Meta
// CAPI via `await Promise.all([...])` but, until this fix, never inspected
// the resolved results — lib/posthog-capture.js's captureEvent and
// lib/meta-capi.js's sendCapiEvent both follow this codebase's "analytics
// never throws" convention (returning `{ ok:false, error }` on any failure
// instead), so a failed send was completely silent: the token credit/grant
// above had already succeeded, the webhook still returned 200, and nothing
// logged which vendor failed or why. Both functions now check
// `results[0]`/`results[1]` after the Promise.all and, on `ok:false`, call
// the existing logSubEvent() helper (defined further down, function-hoisted
// so it's callable from up here) with the failed vendor, the conversion
// type/Meta event name, the (already-redacted — see lib/meta-capi.js's
// redactToken) error string, and the payment_id to correlate against the
// real Dodo charge. Purely additive logging — it can never affect the
// credit/grant already applied or these functions' own never-throws
// contract (the outer try/catch is unchanged).
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
    // fbc/fbp (tracker item for-product-for-manager-purchase-meta-ro-nfrfl5,
    // item 2): Meta's own first-party click/browser cookies, captured
    // client-side by shop.html and threaded through here via create-checkout-
    // session-dodo.js's metadata, echoed back verbatim by Dodo on this
    // payment. Forwarded to sendCapiEvent below exactly as received — never
    // fabricated, and undefined/missing is a normal, expected case (organic
    // traffic, ad blocker, a purchase that predates this metadata field).
    var fbc = payment.metadata && payment.metadata.dreamtube_fbc;
    var fbp = payment.metadata && payment.metadata.dreamtube_fbp;

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

    var results = await Promise.all([
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
        fbc: fbc,
        fbp: fbp,
        custom_data: { value: price, currency: 'USD' }
      })
    ]);
    // Neither vendor call throws (both return { ok:false, error } on any
    // failure instead) -- so without this, a failed Meta/PostHog send was
    // completely invisible: the token credit above already succeeded, the
    // webhook still returns 200, and nothing logs which vendor failed or why.
    // That's a real visibility gap, not just cosmetic -- it's exactly how a
    // Meta CAPI outage/misconfig can silently zero out ad-platform purchase
    // reporting for real, paying customers while PostHog keeps looking fine.
    // Purely additive: logSubEvent only logs (console.log, already
    // exception-safe internally), it can never affect the credit already
    // granted or this function's own never-throws contract. sendCapiEvent's
    // own error strings are already redacted via redactToken before it
    // returns them (see lib/meta-capi.js), so nothing secret reaches here.
    var postHogResult = results[0];
    var metaResult = results[1];
    if (metaResult && metaResult.ok === false) {
      logSubEvent('conversion.meta_capi_failed[pack_purchase]', {
        payment_id: payment.payment_id || null,
        email: payEmail || null,
        pack: pack,
        error: metaResult.error
      });
    }
    if (postHogResult && postHogResult.ok === false) {
      logSubEvent('conversion.posthog_failed[pack_purchase]', {
        payment_id: payment.payment_id || null,
        email: payEmail || null,
        pack: pack,
        error: postHogResult.error
      });
    }
  } catch (e) {
    // analytics must never break the app -- the token credit above has
    // already happened and must not be undone or fail because of this.
  }
}

/**
 * Fires the server-side Dreamer Pass subscription conversion (PostHog + Meta
 * CAPI) for a newly-credited subscription charge — a SIBLING to
 * firePurchaseConversion above, not a generalization of it, because the two
 * charge shapes genuinely differ enough that sharing one function would mean
 * threading pack-only concepts (resolvePackPrice's product_id lookup table,
 * the `starter`/`pack` fields) through a subscription call site that has
 * none of them. A token pack's `value` comes from a fixed lookup table
 * because the price is known before checkout; a Dreamer Pass charge's
 * `value` is read directly off the REAL amount already sitting on whichever
 * Dodo object the caller is holding (`amountCents`/`currency` below) — see
 * this function's callers for exactly which field on which object (Payment
 * vs. Subscription).
 *
 * `metaEventName`: 'Subscribe' for the FIRST real charge (trial-end
 * conversion or a non-trial first payment) and 'Purchase' for every
 * subsequent renewal — standard Meta convention (Subscribe = subscription
 * start, Purchase = each later charge), letting Meta's own subscription
 * value-reporting work correctly. PostHog gets one consistent event name
 * (`purchase_completed`, matching the pack path) with `subscription: true`/
 * `renewal: true/false` properties instead, since PostHog has no equivalent
 * Subscribe/Purchase distinction — growth filters on the property instead.
 *
 * `eventId` — deliberately NOT resolved the same way as the pack path's
 * `payment.metadata.dreamtube_event_id`. That field DOES exist on a
 * subscription checkout (create-checkout-session-dodo.js mints it once at
 * checkout-session creation and threads it through as
 * `metadata.dreamtube_event_id`, same as the pack path) — but a
 * subscription's metadata lives on the SUBSCRIPTION object and is echoed
 * back verbatim on EVERY event for that subscription's whole lifetime,
 * unlike a pack's metadata, which is fresh per checkout/payment. Reusing
 * that one static id across multiple distinct renewal charges would make
 * Meta's own event_id dedup collapse every renewal after the first into
 * "already seen", silently dropping real conversions from Meta's reporting
 * — the opposite of what dedup is for. So: the FIRST charge (a genuine 1:1
 * match between the checkout session that minted the id and this one first
 * charge) is the one case where the caller passes that metadata id through;
 * every renewal call passes no eventId at all, so a fresh one is minted
 * per-call here. The Dreamer Pass checkout flow IS live (shop.html's
 * `purchasePlan`, un-gated for everyone since 2026-08-09), but its own
 * client-side return-trip fire is a DIFFERENT event at a DIFFERENT moment —
 * `subscription_started` (PostHog only, no Meta CAPI pair), fired on the
 * `?checkout=success` return right after the trial STARTS (a $0
 * authorization, not a real charge) — see shop.html's `handleCheckoutReturn`.
 * There is no client-side fire for the actual first real charge (which
 * happens up to 3 days later, off a separate webhook delivery entirely) or
 * for any renewal, so neither case here has a same-event-name client fire to
 * dedupe against — this function's Subscribe/Purchase events are the only
 * place either moment is ever reported. See docs/EVENT_TAXONOMY.md's
 * Subscribe/Purchase (Dreamer Pass) entry.
 *
 * `params.paymentId` — the Dodo payment_id of the charge this conversion is
 * for (threaded through by both call sites below), used ONLY for the
 * meta_capi_failed/posthog_failed diagnostic log lines further down, to
 * correlate a logged analytics failure back to the real charge in Dodo's own
 * dashboard. Never sent to PostHog/Meta themselves and never affects the
 * grant/credit or dedup logic above, which is keyed on payment_id
 * independently (see grantDreamerPassCharge).
 *
 * `params.fbc`/`params.fbp` (tracker item
 * for-product-for-manager-purchase-meta-ro-nfrfl5, item 2) — Meta's own
 * first-party click/browser cookies, threaded through by both call sites
 * below from whichever Dodo object (Payment vs. Subscription) carries the
 * `dreamtube_fbc`/`dreamtube_fbp` metadata create-checkout-session-dodo.js
 * attached at checkout time. Forwarded to sendCapiEvent's own fbc/fbp params
 * exactly as received — undefined/missing is expected and normal (organic
 * traffic, ad blocker, a subscription that predates this metadata field),
 * never fabricated here.
 *
 * Never throws — identical contract to firePurchaseConversion: analytics
 * failure must never turn a successful token credit into a failed webhook
 * response.
 */
async function fireDreamerPassConversion(event, params) {
  try {
    var payEmail = params.payEmail;
    var currency = params.currency || 'USD';

    // Server-derived only, same "don't trust the client, and don't guess"
    // posture as resolvePackPrice's own undefined-return contract — a
    // charge this handler can't resolve a real amount for skips the fire
    // entirely rather than reporting a fabricated/placeholder value.
    var amountCents = params.amountCents;
    if (!(typeof amountCents === 'number' && amountCents > 0)) return;
    var price = Math.round(amountCents) / 100;

    var eventId = params.eventId || crypto.randomBytes(16).toString('hex');
    var eventTimeMs = Date.now();
    var renewal = params.metaEventName === 'Purchase';

    // Same account-store resolution + normalized-email fallback as
    // firePurchaseConversion above — see its own comment for the full why.
    var account = await accountStore.getByEmail(event, payEmail).catch(function () { return null; });
    var distinctId = (account && account.username) || entitlements.normalizeEmail(payEmail);

    var postHogProps = {
      value: price,
      currency: currency,
      timestamp: new Date(eventTimeMs).toISOString(),
      subscription: true,
      renewal: renewal,
      plan: entitlements.DREAMER_PASS_PLAN,
      // Which price/trial variant (freetrial|notrial|trial50) this charge is
      // for — a cheap, additive analytics dimension resolved by the caller
      // (from the payment/subscription product_id, or metadata.dreamtube_pass_
      // variant). null when the caller couldn't resolve it (older records, or
      // an env var rotated post-checkout) — omitted from the props in that
      // case rather than sent as null, same "don't emit a placeholder" posture
      // as the rest of this file.
      $insert_id: eventId // PostHog's own dedup key -- see lib/posthog-capture.js header comment
    };
    if (params.variant) postHogProps.variant = params.variant;

    var results = await Promise.all([
      posthogCapture.captureEvent({
        event: 'purchase_completed',
        distinct_id: distinctId,
        properties: postHogProps,
        timestamp: eventTimeMs
      }),
      metaCapi.sendCapiEvent({
        event_name: params.metaEventName, // 'Subscribe' (first charge) or 'Purchase' (renewal) -- see doc comment above
        event_id: eventId,
        fbc: params.fbc,
        fbp: params.fbp,
        event_time: Math.floor(eventTimeMs / 1000),
        email: payEmail,
        custom_data: { value: price, currency: currency }
      })
    ]);
    // Same visibility gap as firePurchaseConversion above (see its comment
    // for the full why) -- this is the Dreamer Pass sibling, so it needs the
    // identical additive logging, tagged with which Meta event name failed
    // (Subscribe vs. Purchase) since they're two different call sites/
    // moments in the subscription lifecycle.
    var postHogResult = results[0];
    var metaResult = results[1];
    if (metaResult && metaResult.ok === false) {
      logSubEvent('conversion.meta_capi_failed[dreamer_pass_' + (params.metaEventName || 'unknown') + ']', {
        payment_id: params.paymentId || null,
        email: payEmail || null,
        renewal: renewal,
        error: metaResult.error
      });
    }
    if (postHogResult && postHogResult.ok === false) {
      logSubEvent('conversion.posthog_failed[dreamer_pass_' + (params.metaEventName || 'unknown') + ']', {
        payment_id: params.paymentId || null,
        email: payEmail || null,
        renewal: renewal,
        error: postHogResult.error
      });
    }
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
//      product_id matches ANY of the three Dreamer Pass variant env vars —
//      DODO_PRODUCT_DREAMER_PASS (freetrial) / DODO_PRODUCT_DREAMER_PASS_NOTRIAL
//      (notrial) / DODO_PRODUCT_DREAMER_PASS_TRIAL50 (trial50). All three are
//      the SAME 3,000-token/month pass — only their price/trial differ (Dodo's
//      product config), which is not the grant's concern, so all three grant
//      the identical entitlement. Fallbacks: metadata.dreamtube_plan ===
//      'dreamer_pass' (set at checkout), and — as a last resort — a payment
//      carrying a subscription_id that resolves to no known one-time pack (the
//      ONLY subscription product family in this system is the Pass, so a
//      subscription-linked non-pack payment must be it). resolvePackTokens is
//      always checked first, so a real one-time pack can never be mis-routed
//      here.
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

// The three Dreamer Pass variant env vars — the SAME 3,000-token/month pass,
// differing only in price/trial (all decided by Dodo's product config). Must
// mirror create-checkout-session-dodo.js's PASS_VARIANT_ENV exactly (kept as
// a separate copy, same reasoning as PACK_TOKENS/PACK_PRODUCT_ENV above — no
// compile-time dependency between the two functions). Recognizing a
// subscription charge matches product_cart[0].product_id against ANY of
// these; the grant is identical for all three, so no per-variant branching
// is needed past recognition. freetrial's env var is DODO_PRODUCT_DREAMER_PASS
// (the original, unchanged) so the default path is byte-for-byte as before.
var PASS_VARIANT_ENV = {
  freetrial: 'DODO_PRODUCT_DREAMER_PASS',
  notrial: 'DODO_PRODUCT_DREAMER_PASS_NOTRIAL',
  trial50: 'DODO_PRODUCT_DREAMER_PASS_TRIAL50'
};

// The default (freetrial) Dreamer Pass product id — used ONLY as the
// productId fallback stamped onto the subscription record when a lifecycle
// event's payload doesn't carry its own product_id (see handleDreamerPass-
// Payment / handleSubscriptionEvent). Recognition uses dreamerPassProductIds()
// (all three variants), not this single default.
function dreamerPassProductId() {
  return process.env.DODO_PRODUCT_DREAMER_PASS;
}

/** Every configured Dreamer Pass product id across the three variants (unset variants are skipped). */
function dreamerPassProductIds() {
  var ids = [];
  Object.keys(PASS_VARIANT_ENV).forEach(function (variant) {
    var id = process.env[PASS_VARIANT_ENV[variant]];
    if (id) ids.push(id);
  });
  return ids;
}

/** Resolves which Dreamer Pass variant (freetrial|notrial|trial50) a set of product ids belongs to, or null if none match a configured variant env var. */
function resolvePassVariant(productIds) {
  var variants = Object.keys(PASS_VARIANT_ENV);
  for (var i = 0; i < variants.length; i++) {
    var envId = process.env[PASS_VARIANT_ENV[variants[i]]];
    if (envId && productIds.indexOf(envId) !== -1) return variants[i];
  }
  return null;
}

/** All product ids carried by a Payment payload (product_cart entries plus a top-level product_id, if any). */
function paymentProductIds(payment) {
  var ids = [];
  (payment.product_cart || []).forEach(function (item) { if (item && item.product_id) ids.push(item.product_id); });
  if (payment.product_id) ids.push(payment.product_id);
  return ids;
}

/** See design point 1 above. Matches against ALL THREE Dreamer Pass variant product ids (freetrial/notrial/trial50) — every one grants the identical pass. */
function isDreamerPassPayment(payment) {
  var passIds = dreamerPassProductIds();
  if (passIds.length) {
    var productIds = paymentProductIds(payment);
    for (var i = 0; i < passIds.length; i++) {
      if (productIds.indexOf(passIds[i]) !== -1) return true;
    }
  }
  var meta = payment.metadata || {};
  if (meta.dreamtube_plan === entitlements.DREAMER_PASS_PLAN) return true;
  // Last-resort: a subscription-linked payment that is not any known pack.
  if (payment.subscription_id && !resolvePackTokens(payment)) return true;
  return false;
}

var DAY_MS = 24 * 60 * 60 * 1000;

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
// test purchase's logSubEvent() output confirms which one is real. NOTE
// (verified 2026-08-10 against the SDK's real Subscription type — see
// admin-diagnose-dodo-status.js's header): Dodo's Subscription object exposes
// NONE of these `trial_end*` fields at all (there is no native trial-end
// field, and no 'trialing' status either — the status enum is
// pending/active/on_hold/cancelled/failed/expired). So on a real Dreamer Pass
// trial this always returns null; the trial-end is instead SYNTHESIZED from
// the subscription's own first-period end (next_billing_date) — see
// resolveSynthesizedTrialEnd / firstPeriodIsTrial below. These keys are kept
// only as a belt-and-suspenders in case a future Dodo API version adds one.
function resolveTrialEnd(sub) {
  return firstResolvable(sub, ['trial_end_date', 'trial_ends_at', 'trialEndsAt', 'trial_end', 'trialEnd']);
}
function resolveNextBilling(sub) {
  return firstResolvable(sub, ['next_billing_date', 'next_billing_at', 'nextBillingDate', 'current_period_end', 'currentPeriodEnd']);
}
/** Subscription start (created_at) as epoch-ms, or null. Used with trial_period_days to synthesize a trial-end when next_billing is absent. */
function resolveSubscriptionStart(sub) {
  return firstResolvable(sub, ['created_at', 'createdAt', 'created', 'start_date', 'startedAt']);
}
/**
 * Dodo's own trial length in days for this subscription (0 = no trial), or
 * null when the field isn't present. This is Dodo's AUTHORITATIVE trial-vs-no-
 * trial signal (SubscriptionStatus has no 'trialing' state, but every
 * Subscription carries trial_period_days — see admin-diagnose-dodo-status.js's
 * header), and it does NOT depend on our product-id -> env-var mapping being
 * current, so it's preferred over resolvePassVariant for classification below.
 */
function resolveTrialPeriodDays(sub) {
  var v = sub.trial_period_days;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// A trial first-period is a known 3 days; a paid (notrial) first period is a
// full month. This bound (a trial's first period must be <= ~4 days) is only
// the LAST-RESORT discriminator, used when neither trial_period_days nor the
// resolved variant is available — see firstPeriodIsTrial below.
var TRIAL_FIRST_PERIOD_MAX_MS = 4 * DAY_MS;

/**
 * Whether this subscription's FIRST period is a trial (true), a paid period
 * (false), or can't be told (null) — the sole discriminator behind the
 * trial-state synthesis in handleSubscriptionEvent (see its doc there for the
 * full "why Dodo forces us to synthesize this" context).
 *
 * Layered, most-authoritative-first, so a mislabel is structurally hard:
 *   1. trial_period_days (Dodo-native, on the payload): > 0 => trial, 0 =>
 *      notrial. Independent of our env mapping — the strongest signal.
 *   2. resolved variant (from product_id / metadata.dreamtube_pass_variant):
 *      freetrial|trial50 have a trial, notrial does not.
 *   3. first-period length (created_at -> next_billing_date): a trial's first
 *      period is ~3 days, a paid one ~1 month; <= TRIAL_FIRST_PERIOD_MAX_MS
 *      => trial.
 * Returns null only when ALL THREE are unavailable — the caller then does NOT
 * synthesize a trial (writes 'active'), the safe direction: worst case a real
 * trial user gets 20/day instead of 100/day (a boost loss, never a money
 * leak), and a notrial sub is NEVER mislabeled trialing (which WOULD withhold
 * its 3,000 lump).
 */
function firstPeriodIsTrial(sub, variant) {
  var trialDays = resolveTrialPeriodDays(sub);
  if (trialDays !== null) return trialDays > 0;
  if (variant === 'notrial') return false;
  if (variant === 'freetrial' || variant === 'trial50') return true;
  var start = resolveSubscriptionStart(sub);
  var firstEnd = resolveNextBilling(sub);
  if (start && firstEnd && firstEnd > start) return (firstEnd - start) <= TRIAL_FIRST_PERIOD_MAX_MS;
  return null;
}

/**
 * The synthesized trial-end (epoch-ms) for a trial-start subscription.active,
 * or null if none can be resolved. Prefers Dodo's own first-period end
 * (next_billing_date / current_period_end — during a trial this IS the
 * trial-end date, per admin-diagnose-dodo-status.js), falling back to
 * created_at + trial_period_days. Deliberately requires the result to be in
 * the FUTURE: a redelivered subscription.active replays the ORIGINAL payload,
 * whose first-period end is by then in the past after the trial converted —
 * returning null there keeps a redelivery from re-opening the 100/day boost.
 */
function resolveSynthesizedTrialEnd(sub, now) {
  var end = resolveNextBilling(sub);
  if (!end) {
    var start = resolveSubscriptionStart(sub);
    var days = resolveTrialPeriodDays(sub);
    if (start && days && days > 0) end = start + days * DAY_MS;
  }
  return (end && now < end) ? end : null;
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

  // Which price/trial variant (freetrial|notrial|trial50) this charge is for —
  // resolved from the payment's product_id, falling back to the variant tag
  // create-checkout-session-dodo.js stamped in metadata. Hoisted here because
  // BOTH the trial-start guard just below AND the conversion fire further down
  // need it. Analytics-only for the fire; load-bearing for the guard.
  var passVariant = resolvePassVariant(paymentProductIds(payment)) || (payment.metadata && payment.metadata.dreamtube_pass_variant);

  // TRIAL-START vs. REAL-BILLING. A trial-start authorization must never grant
  // the 3,000 monthly tokens and must never flip the account to 'active' (which
  // would end the 100/day trial boost the instant the trial begins). The trial
  // state is owned entirely by subscription.active; the real 3,000 grant
  // happens only on the first POST-trial charge (trial-end conversion or a
  // later renewal). A subscription has TWO ways of arriving here as a
  // trial-start, and BOTH must be recognized:
  //
  //   (a) $0 amount — the free-trial (freetrial) trial-start authorization.
  //       Founder repro 2026-08-09: starting the Pass sent a $0
  //       payment.succeeded alongside subscription.active — without this guard
  //       the free trial would have granted a full month and cancelled its own
  //       trial. This guard is UNCHANGED; freetrial (whose only trial-start is
  //       $0) and notrial (no trial at all) never reach the trial50 guard below.
  //
  //   (b) A >$0 amount charged WHILE A trial50 SUBSCRIPTION IS STILL IN ITS
  //       TRIAL WINDOW — the PAID-trial trial-start: a 50c charge that is a
  //       trial fee, NOT a purchase. The discriminator here is DELIBERATELY NOT
  //       the charged amount (50c > 0 looks exactly like a real charge — that
  //       IS the abuse hole this closes: pay 50c, get the full 3,000-token
  //       month, cancel), because Dodo's Payment webhook payload carries no
  //       trial/billing_reason/trialing field at all (verified against Dodo's
  //       Node SDK Payment type — it exposes only subscription_id, total_amount,
  //       retry_attempt and the payment-intent status, nothing that marks a
  //       charge as a trial fee). The reliable signal is instead the
  //       subscription's own trial STATE — the 'trialing' status + in-future
  //       trialEnd that subscription.active writes onto this record. Dodo
  //       delivers subscription.active BEFORE the trial-start payment.succeeded
  //       (its documented ordering for every subscription flow — immediate
  //       billing and trials alike: subscription.active first, then
  //       payment.succeeded), so by the time this 50c charge is processed the
  //       record already reads trialing, and isTrialActive is true. Scoped to
  //       the trial50 variant (the ONLY variant with a paid trial) so the
  //       freetrial/notrial paths stay byte-for-byte as before.
  //
  // Resulting outcomes:
  //   - freetrial $0 trial-start        -> (a) skip (unchanged).
  //   - freetrial $9.99 / notrial $7.99 first REAL charge -> not trial50 ->
  //     grants, byte-identical to today.
  //   - trial50 50c trial-start         -> (b) skip.
  //   - trial50 $9.99 conversion / any renewal -> trial has ended (trialEnd
  //     passed) -> not isTrialActive -> grants, exactly like the freetrial
  //     conversion path (fires the 'Subscribe' conversion, below).
  // Ambiguity (missing/NaN amount) still fails toward NOT granting. Being
  // conservative here can never LOSE a real grant: subscription.renewed grants
  // every real charge too, keyed by the same payment_id (see
  // grantDreamerPassCharge), so a mis-skipped real charge is re-granted exactly
  // once. Residual (same accepted narrow class as this file's other documented
  // races): if Dodo ever delivered a trial50 50c payment.succeeded BEFORE its
  // subscription.active — contrary to its own documented ordering, and not
  // something a user can force — the record would not yet read trialing and the
  // 50c could grant. Dodo's ordering makes this a rare, non-attacker-
  // controllable reordering, not the open hole the amount-only guard was.
  var chargedAmount = Number(payment.total_amount);
  if (!(chargedAmount > 0)) {
    return; // trial-start $0 (freetrial) — subscription.active owns the state, nothing to grant
  }
  if (passVariant === 'trial50') {
    // LOW-2 HARDENING (money safety): this read MUST fail CLOSED, not open.
    // The old `.catch(function(){return null;})` swallowed a Blobs read fault
    // into `null`, which reads as "no trial in progress" and falls straight
    // through to grantDreamerPassCharge below — so a transient read error mid-
    // trial would let a 50c trial-start grant the full 3,000-token month (the
    // exact over-grant the trial50 guard exists to prevent). We instead SKIP
    // the grant on ANY read error: a mis-skipped charge is never lost, because
    // subscription.renewed re-grants every real charge keyed by the same
    // payment_id (grantDreamerPassCharge -> creditTokenPackOnce idempotency —
    // see the "NO LOST GRANT" test), so failing closed can only ever delay a
    // real grant to the renewal backstop, never lose it, while making a 50c
    // over-grant impossible.
    var existingRecord;
    try {
      existingRecord = await entitlements.getEntitlement(event, payEmail);
    } catch (readErr) {
      logSubEvent('payment.succeeded[dreamer_pass] trial50 entitlement read failed — failing CLOSED (skip grant; subscription.renewed backstops)', {
        payment_id: payment.payment_id || null,
        email: payEmail || null
      });
      return; // could not verify trial state -> never risk a 50c over-grant
    }
    if (existingRecord && entitlements.isTrialActive(existingRecord.subscription, Date.now())) {
      return; // trial50's 50c trial-start — still trialing, not a purchase
    }
  }

  var creditResult = await grantDreamerPassCharge(event, payEmail, payment.payment_id, dodoCustomerId);
  // Fire the FIRST-charge conversion (trial-end conversion, or a non-trial
  // first payment) ONLY when this call actually just credited the 3000 --
  // `credited: false` means this paymentId was already processed (a Dodo
  // redelivery), a safe no-op that must NOT re-fire a conversion (would
  // double-count revenue) -- exact same gate firePurchaseConversion's own
  // caller uses for the pack path. Meta event name is 'Subscribe' (see
  // fireDreamerPassConversion's own doc comment for why, vs. 'Purchase' on
  // a renewal). payment.total_amount is the REAL charged amount in cents
  // (chargedAmount, already resolved above) -- never a hardcoded price.
  if (creditResult && creditResult.credited) {
    await fireDreamerPassConversion(event, {
      payEmail: payEmail,
      amountCents: chargedAmount,
      currency: payment.currency,
      metaEventName: 'Subscribe',
      eventId: payment.metadata && payment.metadata.dreamtube_event_id,
      // Which price/trial variant — resolved once above (from the payment's
      // product_id, falling back to the metadata variant tag). Analytics-only
      // here; never affects the grant.
      variant: passVariant,
      // Diagnostic-only, see fireDreamerPassConversion's own doc comment.
      paymentId: payment.payment_id || null,
      // fbc/fbp — see fireDreamerPassConversion's own doc comment. Read off
      // this same payment's metadata, exactly like eventId just above.
      fbc: payment.metadata && payment.metadata.dreamtube_fbc,
      fbp: payment.metadata && payment.metadata.dreamtube_fbp
    });
  }

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
  //
  // Which Dreamer Pass variant this subscription is (freetrial|notrial|
  // trial50) — resolved once here from the payload's product_id (its metadata
  // is static across the whole lifetime, so product_id is the reliable
  // per-event signal), falling back to the variant tag. Used BOTH by the
  // trial synthesis just below AND by the renewal conversion fire further
  // down.
  var variant = resolvePassVariant(sub.product_id ? [sub.product_id] : []) || (sub.metadata && sub.metadata.dreamtube_pass_variant);

  // ── TRIAL-STATE SYNTHESIS (money-path fix, 2026-08-10; founder repro on two
  //    real Dodo subscriptions) ──
  // Dodo reports EVERY Dreamer Pass trial — the $0 freetrial AND the paid
  // trial50 — with status:'active', trialing:false, trial_end:null. It has NO
  // 'trialing' status at all (SubscriptionStatus is pending/active/on_hold/
  // cancelled/failed/expired — see admin-diagnose-dodo-status.js's header).
  // So subStatusIsTrialing() below is ALWAYS false during a real trial, and
  // without this synthesis the 100/day trial boost (entitlements.isTrialActive,
  // which requires status==='trialing') would NEVER fire — users would get the
  // normal 20/day for their whole trial (the confirmed live bug). What Dodo
  // DOES give us is the trial's end date, sitting in the subscription's own
  // first-period end (next_billing_date / current_period_end) plus its
  // trial_period_days — so for a TRIAL-start subscription.active we synthesize
  // the 'trialing' state ourselves, writing trialEnd = that first-period end,
  // regardless of Dodo's 'active' label. This makes isTrialActive true (100/day
  // fires) while the existing trial-start payment-skip (the $0 guard + the
  // trial50 isTrialActive guard in handleDreamerPassPayment) correctly withholds
  // the 3,000-token lump until the trial ends. The 3,000 lands at the REAL first
  // billing (subscription.renewed / the first full-price payment.succeeded,
  // once this trialEnd has passed -> isTrialActive false -> normal grant),
  // payment_id-idempotent so it can never double-grant.
  //
  // Scoped tightly so notrial and non-trial-start events are byte-for-byte
  // unchanged:
  //   - Only on subscription.active (the trial-start event). A renewal /
  //     plan_changed is past the trial and must not be RE-SYNTHESIZED as
  //     trialing from Dodo's payload (plan_changed carries no reliable trial
  //     info of its own). It CAN, however, still be a genuinely-mid-trial
  //     event — see the plan_changed PRESERVATION carve-out just below,
  //     which is a distinct, narrower mechanism from synthesis: it never
  //     invents a NEW trialing state from this payload, it only protects an
  //     ALREADY-synthesized one (written by an earlier subscription.active)
  //     from being wiped by this event.
  //   - Only when Dodo isn't ALREADY telling us it's trialing (explicitTrialing
  //     short-circuits — preserves the existing explicit-'trialing'-payload
  //     path and its tests exactly).
  //   - Only when firstPeriodIsTrial() is TRUE. For the notrial product
  //     (trial_period_days === 0, first period is a full paid month) it returns
  //     false, so notrial stays 'active' and its 3,000 grants immediately via
  //     its own real payment.succeeded — NEVER synthesized as trialing. An
  //     unresolvable case returns null -> also not synthesized (the safe
  //     direction; see firstPeriodIsTrial's own doc).
  var explicitTrialing = subStatusIsTrialing(sub);
  var synthesizedTrialEnd = null;
  if (!explicitTrialing && type === 'subscription.active' && firstPeriodIsTrial(sub, variant) === true) {
    synthesizedTrialEnd = resolveSynthesizedTrialEnd(sub, Date.now());
  }

  // ── plan_changed PRESERVATION (money-path fix, 2026-08-10; tracker item
  //    for-product-low-subscription-plan-change-clww6d) ──
  // Dodo can fire subscription.plan_changed WHILE the subscriber is still
  // genuinely inside their synthesized trial window (e.g. the user changes
  // something about their plan mid-trial). Before this fix, `trialing` above
  // came out false for ANY non-subscription.active type — including this one
  // — because plan_changed's payload carries no reliable trial info to
  // RE-synthesize from (see the "Scoped tightly" doc above). That wrote
  // status:'active', trialEnd:null, wiping the 100/day boost early for a
  // user who is still legitimately mid-trial (a boost loss only — see the
  // grant-path doc block further down; never a wrong charge or a withheld
  // real grant, since those are gated by separate payment_id-keyed logic).
  //
  // The fix: for plan_changed only, read the account's CURRENTLY STORED
  // subscription state (written by an earlier subscription.active, possibly
  // itself synthesized) and PRESERVE it — never re-derive it from THIS
  // payload — if it is still genuinely trialing right now. Uses
  // entitlements.isTrialActive, the exact same "status==='trialing' AND
  // trialEnd is still in the future" gate the daily-claim boost itself reads
  // live, so this can never indefinitely re-preserve a stale trialing state
  // past its real end (mirrors resolveSynthesizedTrialEnd's own "must be in
  // the future" discipline against a stale replay) — a genuinely-expired
  // trial's plan_changed still falls through to the normal 'active'/null
  // write below, same as before this fix. A notrial subscription is never
  // stored as trialing in the first place (see firstPeriodIsTrial), so
  // isTrialActive is always false for it here — completely unaffected.
  var preservedTrialEnd = null;
  if (!explicitTrialing && !synthesizedTrialEnd && type === 'subscription.plan_changed') {
    var currentRecord = await entitlements.getEntitlement(event, email);
    var currentSub = currentRecord && currentRecord.subscription;
    if (entitlements.isTrialActive(currentSub, Date.now())) {
      preservedTrialEnd = currentSub.trialEnd;
    }
  }

  var trialing = explicitTrialing || !!synthesizedTrialEnd || !!preservedTrialEnd;

  await entitlements.updateSubscription(event, email, {
    status: trialing ? 'trialing' : 'active',
    subscriptionId: sub.subscription_id,
    productId: sub.product_id || dreamerPassProductId(),
    nextBillingAt: resolveNextBilling(sub),
    currentPeriodEnd: resolveNextBilling(sub),
    // trialing WITH a resolvable end (a real payload trial_end, else the
    // synthesized first-period end, else a preserved prior trialEnd from the
    // plan_changed carve-out above) -> set it; trialing WITHOUT any
    // resolvable end -> undefined (updateSubscription keeps a prior
    // trialEnd, or caps a first sighting to now + 3 days); not trialing ->
    // null (clear).
    trialEnd: trialing ? (resolveTrialEnd(sub) || synthesizedTrialEnd || preservedTrialEnd || undefined) : null
  });

  // A renewal is also a charge — grant that charge's 3000, keyed by its own
  // payment_id so it dedups against any payment.succeeded for the same charge.
  // No-ops if this payload carries no payment_id (then payment.succeeded is
  // the grant path).
  if (type === 'subscription.renewed') {
    var creditResult = await grantDreamerPassCharge(event, email, subscriptionEventPaymentId(sub), dodoCustomerId);
    // A renewal IS a new charge -- growth wants total ad-attributed revenue
    // tracked, not just the first conversion -- so this mirrors
    // firePurchaseConversion's own "fire per confirmed newly-credited
    // payment" behavior, not a "once ever" gate. `credited: true` gate is
    // the same redelivery-safe dedup contract as the first-charge fire
    // above. Meta event name is 'Purchase' (a renewal, not a subscription
    // start -- see fireDreamerPassConversion's own doc comment). Value
    // comes from the Subscription object's own recurring_pre_tax_amount --
    // this event carries no nested Payment object with its own total_amount,
    // so this is the best real, server-derived source available for a
    // renewal. eventId is deliberately omitted (always minted fresh here)
    // -- see fireDreamerPassConversion's doc comment for why reusing
    // sub.metadata.dreamtube_event_id across renewals would be wrong.
    if (creditResult && creditResult.credited) {
      await fireDreamerPassConversion(event, {
        payEmail: email,
        amountCents: sub.recurring_pre_tax_amount,
        currency: sub.currency,
        metaEventName: 'Purchase',
        // Resolved once above (from the subscription's own product_id — its
        // metadata is static across the whole lifetime, so product_id is the
        // reliable per-renewal signal — falling back to the variant tag).
        variant: variant,
        // Diagnostic-only, see fireDreamerPassConversion's own doc comment.
        paymentId: subscriptionEventPaymentId(sub),
        // fbc/fbp — see fireDreamerPassConversion's own doc comment. The
        // subscription's metadata is static across its whole lifetime (same
        // reasoning as dreamtube_pass_variant's own fallback above), so this
        // is the original checkout's click-attribution data, still valid to
        // report on a later renewal charge.
        fbc: sub.metadata && sub.metadata.dreamtube_fbc,
        fbp: sub.metadata && sub.metadata.dreamtube_fbp
      });
    }
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
