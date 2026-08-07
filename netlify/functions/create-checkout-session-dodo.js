// netlify/functions/create-checkout-session-dodo.js
//
// POST { email, pack } -> creates a Dodo Payments Checkout Session for a
// one-time DreamTube token-pack purchase and returns { url } for the
// client to redirect the browser to. `pack` is one of "pack099",
// "pack199", "pack499", "pack999" (300 tokens / $0.99 one-time starter,
// 500 tokens / $1.99, 1500 tokens / $4.99 "Most popular", 4000 tokens /
// $9.99 "Best value" — see PACK_TOKENS below — see shop.html, "The
// Vault"). This is the SKU ladder built for tracker item
// for-product-build-ship-today-founder-app-zn9zyy (founder-approved
// 2026-08-02, "ship people buying tokens today"), which REPLACES the
// previous pack100/pack300/pack700 lineup (200/600/1400 tokens) and its
// +50% first-purchase bonus entirely.
//
// NO-GRANDFATHERING RULE: pack099/199/499/999 (and the
// DODO_PRODUCT_PACK_STARTER300/_SMALL500/_MEDIUM1500/_LARGE4000 env vars
// below) are DELIBERATELY fresh identifiers, never reusing pack100/300/700
// or DODO_PRODUCT_PACK_100/300/700 — even though some price points land
// near the old ones. This keeps every historical webhook/analytics record
// for the OLD packs unambiguous (a past `pack300` event always means the
// old 600-token/$7.99 pack, never gets silently reinterpreted as this new
// lineup) and means the 4 new Dodo dashboard products the founder created
// get their own fresh env vars, not a value swap under an old name. Each
// pack degrades independently until its own env var is set (E6 below) —
// same pattern the old lineup already followed.
//
// The env var NAMES themselves (STARTER300/SMALL500/MEDIUM1500/LARGE4000
// rather than this file's own internal 099/199/499/999 pack ids) match
// exactly what Manager handed the founder to paste into Netlify
// (2026-08-02, tracker item for-product-ship-the-vault-shop-now-foun-
// 23mk4c) — the internal pack099/199/499/999 identifiers stay as originally
// built (already shipped, already tested, and more informative than a
// size label since they encode the actual price), only this ENV VAR
// mapping was renamed to match the real values already pasted, rather
// than asking the founder to redo that paste under different names.
//
// pack099 (the $0.99 "starter" pack) is ONE-TIME PER ACCOUNT — see the
// E9 guard below. It replaces the old +50% first-purchase bonus mechanic
// as this shop's welcome-offer lever: instead of a bonus on top of
// whatever pack someone buys first, the discounted starter SKU itself
// becomes unavailable once this account has ever completed any pack
// purchase (see lib/entitlements.js's `firstPackPurchaseAt`/
// `hasMadeFirstPurchase` doc comments for the full "why reuse this exact
// signal, not a narrower one" reasoning). This is the ONLY server-side
// enforcement point for the one-time rule: by the time a webhook fires,
// real money has already changed hands, so refusing to credit at that
// point would mean a paying customer gets nothing — refusing to even
// CREATE the checkout session here, before any charge happens, is the
// correct place to gate it. Known, accepted narrow race (same class this
// codebase already accepts elsewhere, e.g. lib/entitlements.js's own
// documented residual races): two genuinely concurrent starter-pack
// checkout attempts from the same brand-new account, both created before
// either payment completes, could both pass this check and both go on to
// charge — bounded to a rare timing window, not something this pass adds
// distributed locking to close.
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
//   E5 invalid_pack           — pack wasn't "pack099", "pack199", "pack499", or "pack999"
//   E6 missing_product_id     — DODO_PRODUCT_PACK_STARTER300/_SMALL500/_MEDIUM1500/_LARGE4000 not configured for the requested pack
//   E7 dodo_request_failed    — Dodo rejected the request or it otherwise failed
//   E8 invalid_redirect_url   — successUrl/cancelUrl was supplied but isn't a safe relative path (see isSafeRedirectPath below)
//   E9 starter_already_used   — pack099 requested, but this account has already completed a pack purchase before (hasMadeFirstPurchase) — the one-time starter offer is no longer available to it
//   E10 (RETIRED 2026-08-07) — was email_not_verified, the gate-list
//                                "no purchases" check for unverified
//                                accounts. Removed by founder reversal the
//                                day he hit it live (payment must never
//                                block on verification — see the comment at
//                                the gate's old site below for the full
//                                reasoning). Code number retired, never
//                                reused.
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
// custom successUrl (carrying it back to home.html, formerly processing.html
// before tracker item for-product-funnel-ending-v2-founder-ins-tfuu0q
// removed that page, to auto-resume the blocked generation — see that
// file's own header comment), so this had to be closed before that
// feature could ship, not after.
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

// Token amount per pack — mirrors the pricing shown in shop.html ("The
// Vault"): 300 tokens/$0.99 (one-time starter), 500 tokens/$1.99, 1500
// tokens/$4.99 ("Most popular"), 4000 tokens/$9.99 ("Best value") —
// founder-approved 2026-08-02, tracker item
// for-product-build-ship-today-founder-app-zn9zyy. The actual dollar
// amount charged lives entirely on the Dodo product configured for each
// env var below, not here; this amount is only used for the metadata
// fallback dodo-webhook.js reads if its product_id -> pack mapping ever
// changes after a purchase was made (see that file's resolvePackTokens).
var PACK_TOKENS = { pack099: 300, pack199: 500, pack499: 1500, pack999: 4000 };

// USD price per pack, mirrors shop.html's own PACK_INFO map — used only for
// the metadata.dreamtube_price fallback below, the same "belt-and-
// suspenders" role dreamtube_tokens already plays for resolvePackTokens.
// dodo-webhook.js's own resolvePackPrice prefers matching the payment's
// actual product_id against DODO_PRODUCT_PACK_* first (this is only the
// fallback path), so this never needs to be the source of truth for what
// Dodo actually charged.
var PACK_PRICES = { pack099: 0.99, pack199: 1.99, pack499: 4.99, pack999: 9.99 };

// The one-time starter pack's own id — pulled out as a constant (rather
// than a literal string check below) so the E9 guard reads as "the
// starter pack", not a magic string repeated in two places.
var STARTER_PACK_ID = 'pack099';

var PACK_PRODUCT_ENV = {
  pack099: 'DODO_PRODUCT_PACK_STARTER300',
  pack199: 'DODO_PRODUCT_PACK_SMALL500',
  pack499: 'DODO_PRODUCT_PACK_MEDIUM1500',
  pack999: 'DODO_PRODUCT_PACK_LARGE4000'
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

  // Starter one-time-per-account enforcement (see this file's header
  // comment) — only ever checked for pack099, so every other pack incurs
  // no extra read/latency. Reads the SAME signal the old +50%
  // first-purchase bonus used to key off (hasMadeFirstPurchase, derived
  // from firstPackPurchaseAt) — see lib/entitlements.js's doc comments on
  // both for the full "why this exact field, not a new one" reasoning.
  if (pack === STARTER_PACK_ID) {
    var tokenStatus = await entitlements.getTokenStatus(event, email);
    if (tokenStatus && tokenStatus.hasMadeFirstPurchase) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E9: starter_already_used' }) };
    }
  }

  // GATE REMOVED (founder reversal 2026-08-07, overriding his own earlier
  // "no purchases" gate-list instruction — his words on hitting it live:
  // "why do you block payment with this email verification gate at the
  // wrong place???"): an unverified email must NEVER block the payment
  // moment. The gate protected almost nothing — the purchased tokens land
  // on the logged-in account regardless of whether its email has a typo,
  // and Dodo collects its own receipt email at checkout — while refusing
  // a customer with money in hand. Verification is now prompted SOFTLY
  // after a successful purchase instead (shop.html's ?checkout=success
  // return leg opens js/email-verify-sheet.js when the account is still
  // unverified). The E10 code is RETIRED, never reused — see the error-
  // code doc comment above. The publish gate (lib/account-store.js GATE
  // LIST item 2) is unchanged: the public feed is a real spam surface;
  // a paid checkout is not — abusing it costs the abuser money.

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
      // DreamTube sells token packs to individual consumers, not
      // businesses, and the founder does not want the "purchasing as a
      // business" tax-id option surfaced at all (tracker item
      // review-the-non-mandatory-dodo-account-fi-bnw41z, founder note
      // 2026-07-27). Dodo's `feature_flags.allow_tax_id` defaults to true,
      // which is what puts that checkbox on the checkout page; explicitly
      // disabling it removes the option rather than just leaving it
      // unused. Must live under `feature_flags` -- it is NOT a top-level
      // CheckoutSessionCreateParams field (see checkout-sessions.d.ts:
      // `allow_tax_id` only exists on `CheckoutSessionFlags`, referenced
      // via the `feature_flags` field; a top-level key here is silently
      // ignored by Dodo's API and would leave the real default, true, in
      // effect).
      feature_flags: { allow_tax_id: false },
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
        dreamtube_event_id: eventId,
        // Threaded through to dodo-webhook.js so its own Purchase
        // conversion event can carry a `starter: true/false` flag (see
        // that file's firePurchaseConversion) for growth to measure
        // starter-pack conversion specifically — same "known at checkout
        // creation, cheaper to carry through metadata than re-derive
        // later" reasoning as every other dreamtube_* field here (mirrors
        // dreamtube_tokens/dreamtube_price's own existing non-string
        // metadata values, echoed back verbatim by Dodo on
        // payment.succeeded).
        dreamtube_starter: pack === STARTER_PACK_ID
      }
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.checkout_url, sessionId: session.session_id, eventId: eventId }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'E7: dodo_request_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
