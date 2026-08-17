// netlify/functions/create-checkout-session-dodo.js
//
// POST { email, pack } -> creates a Dodo Payments Checkout Session for a
// one-time DreamTube token-pack purchase and returns { url } for the
// client to redirect the browser to. `pack` is one of "pack099",
// "pack199", "pack499", "pack999" (300 tokens / $0.99 one-time starter,
//
// DREAMER PASS (subscription): POST { email, plan: "dreamer_pass" } instead
// creates a checkout for the $9.99/month Dreamer Pass (3-day free trial),
// referencing DODO_PRODUCT_DREAMER_PASS. Dodo decides one-time-vs-
// subscription entirely from the product config (the Pass product carries a
// recurring price + its own trial), so this sends the SAME product_cart
// shape — no subscription_data/trial param needed (the trial lives on the
// product; subscription_data.trial_period_days only OVERRIDES it). The
// 3000-token monthly grant and the trial's 100/day claim boost are applied
// entirely server-side (dodo-webhook.js + lib/entitlements.js), never here.
// See lib/entitlements.js's DREAMER PASS doc block.
//
// DREAMER PASS VARIANTS (OPTIONAL `passVariant`): the SAME 3,000-token/month
// pass can be checked out at three different price/trial configurations,
// selected by an OPTIONAL `passVariant` field on the subscription request —
// one of "freetrial" (default), "notrial", "trial50". Each maps to its own
// Dodo product via its own env var (see PASS_VARIANT_ENV below); the
// price/trial differences live ENTIRELY on the Dodo product config (same
// model as the single-product path above — no subscription_data/trial param
// is ever sent for any variant). An absent/empty/unknown passVariant resolves
// to "freetrial", so every existing caller behaves byte-for-byte as before.
// The 3,000-token monthly grant is identical across all three variants (a
// fixed server constant, never derived from the variant).
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
//   E4 email_and_pack_required (email_required on the subscription path — no pack there)
//   E5 invalid_pack           — pack wasn't "pack099", "pack199", "pack499", or "pack999" (pack path only)
//   E6 missing_product_id     — DODO_PRODUCT_PACK_STARTER300/_SMALL500/_MEDIUM1500/_LARGE4000 (pack path), or the resolved Dreamer Pass variant's env var — DODO_PRODUCT_DREAMER_PASS (freetrial, default) / DODO_PRODUCT_DREAMER_PASS_NOTRIAL (notrial) / DODO_PRODUCT_DREAMER_PASS_TRIAL50 (trial50) (subscription path) — not configured
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
// ── Returning-buyer prefill: real password verification before attaching a
//    stored Dodo customer_id / enabling saved payment methods (tracker item
//    for-product-repeat-purchase-friction-dod-b6pzs6, founder decision
//    2026-07-28) ──
// An OPTIONAL `password` field alongside `email`/`pack`. This is NEVER a
// requirement for checkout to proceed — a missing or wrong password simply
// falls back to exactly today's existing behavior (a bare `{email: email}`
// customer object, no saved-methods flag, no error surfaced) — this is a
// friction-reduction feature layered on top of the purchase flow, not an
// auth gate on the flow itself. See lib/entitlements.js's dodoCustomerId
// doc comment and dodo-webhook.js's header comment for where the stored
// customer id itself comes from.
//
// WHY THIS GATE EXISTS AT ALL (the security gap an earlier build+review
// round on this same tracker item correctly caught and held for founder
// sign-off before shipping): Dodo Payments auto-attaches ANY incoming
// checkout to an existing customer purely by EMAIL MATCH — this function
// already accepts a bare, unverified client-supplied `email` (an existing,
// accepted tradeoff for token bookkeeping — see the header comment above).
// Unconditionally passing a stored customer_id + show_saved_payment_methods
// off that bare email would let anyone who knows or guesses a real user's
// email see THAT PERSON's saved payment methods surface at checkout, with
// no password, no rate limit. The fix: only ever attach customer_id /
// enable show_saved_payment_methods once the caller has proven, via a REAL
// password check, that they actually ARE the account holder for that email
// — otherwise this endpoint behaves exactly as it always has.
//
// Reuses accountStore.verifyLogin — the exact same real-password-check
// primitive create-session-transfer.js already uses for an equivalent
// "this needs to actually be the real account owner" bar (see that file's
// own header comment) — including its per-IP + per-account-identifier
// rate limiting on the password check itself (this endpoint is otherwise
// unauthenticated and public, so a password field here is a guessable-
// secret surface exactly like that file's own). Rate-limited attempts
// degrade the SAME way a wrong/missing password does: silently fall back
// to the bare-email checkout, never a 4xx/5xx that would block the actual
// purchase over an anti-abuse check on an optional convenience feature.
//
// Client-side, shop.html supplies this from the CURRENTLY signed-in
// account's own already-cached local password (state.accounts[key].password
// via a new DreamStore.getCachedPassword() helper) — the exact same "no new
// re-auth prompt, the password is already on hand" shape js/store.js's
// mintSessionTransferToken already uses for create-session-transfer.js. A
// signed-out visitor, or one whose local session has no cached password
// (e.g. an account established purely via a session-transfer token), simply
// sends no password at all and gets today's unchanged checkout.
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
var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');

// Same two-bucket (per-IP + per-account-identifier) shape and same default
// magnitudes as create-session-transfer.js's own rate limiting on its
// equivalent real-password check — see that file's own doc comment for why
// BOTH buckets are needed (a per-IP-only cap alone would let an attacker
// who knows a target's email guess that ONE account's password by rotating
// IPs). Separate env vars/bucket names from that file's own, since this
// gates a different endpoint with its own independent quota.
var DEFAULT_MAX_PASSWORD_ATTEMPTS_PER_IP_PER_DAY = 100;
var DEFAULT_MAX_PASSWORD_ATTEMPTS_PER_IDENTIFIER_PER_DAY = 30;

// Token amount per pack — mirrors the pricing shown in shop.html ("The
// Vault"): 300 tokens/$0.99 (one-time starter), 500 tokens/$1.99, 1500
// tokens/$4.99 ("Most popular"), 4000 tokens/$9.99 ("Best value") —
// founder-approved 2026-08-02, tracker item
// for-product-build-ship-today-founder-app-zn9zyy. The actual dollar
// amount charged lives entirely on the Dodo product configured for each
// env var below, not here; this amount is only used for the metadata
// fallback dodo-webhook.js reads if its product_id -> pack mapping ever
// changes after a purchase was made (see that file's resolvePackTokens).
var PACK_TOKENS = { pack099: 300, pack199: 500, pack499: 1000, pack999: 2500 };

// USD price per pack, mirrors shop.html's own PACK_INFO map — used only for
// the metadata.dreamtube_price fallback below, the same "belt-and-
// suspenders" role dreamtube_tokens already plays for resolvePackTokens.
// dodo-webhook.js's own resolvePackPrice prefers matching the payment's
// actual product_id against DODO_PRODUCT_PACK_* first (this is only the
// fallback path), so this never needs to be the source of truth for what
// Dodo actually charged.
var PACK_PRICES = { pack099: 0.99, pack199: 2.99, pack499: 4.99, pack999: 9.99 };

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

// ── Dreamer Pass variants (INERT PLUMBING as of this change — no shipped UI
//    passes `passVariant` yet, so every real caller today still hits the
//    default `freetrial` and behaves byte-for-byte as before) ──
// The SAME 3,000-token/month Dreamer Pass, offered at three different
// price/trial configurations that differ ONLY in how the referenced Dodo
// product is configured (recurring price + whether/what kind of trial it
// carries) — exactly the "Dodo decides sub-vs-one-time AND the trial purely
// from the product config" model this file's header comment describes, just
// extended to three product ids instead of one. Same env-var-mapping pattern
// as PACK_PRODUCT_ENV above: the product IDs are NEVER hardcoded, only the
// env var NAMES are, and each variant degrades independently to E6 if its own
// env var is unset (the founder sets each in Netlify).
//   - freetrial (EXISTING default): DODO_PRODUCT_DREAMER_PASS   — $9.99/mo, 3-day free trial
//   - notrial   (NEW):              DODO_PRODUCT_DREAMER_PASS_NOTRIAL  — $7.99/mo, no trial
//   - trial50   (NEW):              DODO_PRODUCT_DREAMER_PASS_TRIAL50  — $9.99/mo, 50c paid trial
// An absent/empty/unknown `passVariant` resolves to `freetrial`, so every
// existing caller (which sends no passVariant at all) keeps the exact same
// DODO_PRODUCT_DREAMER_PASS product and behavior it has today. The 3,000-token
// monthly grant + trial handling are entirely Dodo's/dodo-webhook.js's
// concern — the price/trial differences never reach the grant, which is a
// fixed server-side constant (entitlements.DREAMER_PASS_MONTHLY_TOKENS).
// trial50 ($1 one-time paid trial) RETIRED 2026-08-11 — Dodo couldn't deliver
// a clean one-time-$1 trial, so the trial is always the free trial. Only
// freetrial + notrial reach here now; DODO_PRODUCT_DREAMER_PASS_TRIAL50 is
// unused (founder can remove that Netlify env var).
var PASS_VARIANT_ENV = {
  freetrial: 'DODO_PRODUCT_DREAMER_PASS',
  notrial: 'DODO_PRODUCT_DREAMER_PASS_NOTRIAL'
};
var DEFAULT_PASS_VARIANT = 'freetrial';

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

  // fbc/fbp (tracker item for-product-for-manager-purchase-meta-ro-nfrfl5,
  // item 2): Meta's own first-party click/browser cookies, read client-side
  // by shop.html's getMetaCookies() (js/analytics-config.js) and sent along
  // here purely so they can be threaded through to Dodo's `metadata` below
  // and echoed back on the eventual payment/subscription webhook, where
  // dodo-webhook.js's firePurchaseConversion/fireDreamerPassConversion read
  // them back for their Meta CAPI calls — see this file's header comment
  // and dodo-webhook.js's own comment for the full chain. Purely optional,
  // attribution-only metadata: NEVER a requirement for checkout, and never
  // fabricated here if absent — only ever forwarded exactly as sent (a
  // non-string or empty value resolves to `null`, same as an absent field).
  var fbc = (typeof payload.fbc === 'string' && payload.fbc) ? payload.fbc : null;
  var fbp = (typeof payload.fbp === 'string' && payload.fbp) ? payload.fbp : null;

  // ── Dreamer Pass subscription vs. one-time token pack ──
  // The client asks for the $9.99/month Dreamer Pass with `{ plan:
  // "dreamer_pass" }` instead of a `{ pack }`. Dodo itself decides
  // one-time-vs-subscription purely from how the referenced product_id is
  // configured in the dashboard (the Dreamer Pass product carries a
  // recurring price AND its own 3-day trial) — this function sends the
  // SAME product_cart shape either way and needs no subscription-specific
  // params (verified against Dodo's Node SDK: subscription_data.trial_period_days
  // only OVERRIDES the product's own trial, and the trial already lives on
  // the product, so it is deliberately not sent). See this file's header
  // comment and lib/entitlements.js's DREAMER PASS doc block.
  var isSubscription = (payload.plan || '').trim().toLowerCase() === entitlements.DREAMER_PASS_PLAN;

  var productId;
  var passVariant;
  if (isSubscription) {
    // Subscription path: email is the only required field (there is no
    // `pack`), the product id comes from the resolved Dreamer Pass variant's
    // env var (default DODO_PRODUCT_DREAMER_PASS — see PASS_VARIANT_ENV
    // above), and the one-time-starter E9 guard deliberately does NOT apply
    // (the Pass is a recurring product, not the one-time welcome pack).
    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E4: email_required' }) };
    }
    // OPTIONAL passVariant in {freetrial, notrial, trial50}; absent/empty/
    // unknown -> freetrial, so every existing caller (none send this field
    // today) resolves to DODO_PRODUCT_DREAMER_PASS exactly as before.
    passVariant = (payload.passVariant || '').trim().toLowerCase();
    // hasOwnProperty (not a bare `!PASS_VARIANT_ENV[passVariant]`) so inherited
    // Object.prototype members can't masquerade as real variants: a crafted
    // passVariant of "__proto__" / "constructor" / "hasOwnProperty" resolves
    // through the prototype chain to a truthy value, which a bare membership
    // check would treat as a KNOWN variant and skip the freetrial fallback,
    // then feed a non-string (Object.prototype / the Object constructor) into
    // process.env[...]. Own-property-only lookup forces every unknown value —
    // those two included — down to the default freetrial variant, exactly like
    // any other unrecognized string.
    if (!Object.prototype.hasOwnProperty.call(PASS_VARIANT_ENV, passVariant)) passVariant = DEFAULT_PASS_VARIANT;
    var passEnvVar = PASS_VARIANT_ENV[passVariant];
    productId = process.env[passEnvVar];
    if (!productId) {
      // Same E6 missing_product_id error the code already returns for a
      // missing pass product — each variant degrades independently to it.
      return { statusCode: 500, body: JSON.stringify({ error: 'E6: missing_product_id: ' + passEnvVar + ' not configured' }) };
    }
  } else {
    if (!email || !pack) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E4: email_and_pack_required' }) };
    }

    var productEnvVar = PACK_PRODUCT_ENV[pack];
    if (!productEnvVar) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E5: invalid_pack' }) };
    }

    productId = process.env[productEnvVar];
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

  // ── Returning-buyer prefill gate — see this file's own header comment
  // for the full "why" ──
  //
  // `verifiedAccountOwner` only ever becomes true after a REAL password
  // check against the account for this exact email — never from the bare
  // presence of a `password` field alone. Every failure mode here (no
  // password supplied, wrong password, no account exists for this email,
  // rate-limited) leaves it false and falls straight through to today's
  // unchanged bare-email checkout below; nothing in this block ever
  // returns an error response or blocks the purchase.
  var verifiedAccountOwner = false;
  var dodoCustomerId;
  var suppliedPassword = typeof payload.password === 'string' ? payload.password : '';

  if (suppliedPassword) {
    var maxPerIpPerDay = parseInt(process.env.MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IP_PER_DAY, 10);
    if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = DEFAULT_MAX_PASSWORD_ATTEMPTS_PER_IP_PER_DAY;
    var maxPerIdentifierPerDay = parseInt(process.env.MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IDENTIFIER_PER_DAY, 10);
    if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = DEFAULT_MAX_PASSWORD_ATTEMPTS_PER_IDENTIFIER_PER_DAY;

    var ip = rateLimit.clientIp(event);
    var ipLimit = await rateLimit.checkAndIncrement(event, 'checkout-password-verify-ip', ip, maxPerIpPerDay);

    if (ipLimit.allowed) {
      // Only this one lookup is available here (the request already only
      // ever carries `email`, never a separate username) — mirrors
      // create-session-transfer.js's own canonical-account resolution,
      // just via email instead of username-then-email, since that's all
      // this endpoint has to key a rate-limit bucket/verifyLogin lookup
      // on. A rate-limited attempt never runs this lookup or the password
      // check at all — same "don't do the expensive/sensitive work past
      // an already-tripped limit" shape as create-session-transfer.js.
      var canonicalAccount = await accountStore.getByEmail(event, email);
      var identifierKey = canonicalAccount ? canonicalAccount.username : email;
      var identifierLimit = await rateLimit.checkAndIncrement(event, 'checkout-password-verify-identifier', identifierKey, maxPerIdentifierPerDay);

      if (identifierLimit.allowed) {
        var loginCheck = await accountStore.verifyLogin(event, email, suppliedPassword, { record: canonicalAccount });
        if (loginCheck.ok) {
          verifiedAccountOwner = true;
          var entitlementRecord = await entitlements.getEntitlement(event, email);
          dodoCustomerId = entitlementRecord && entitlementRecord.dodoCustomerId;
        }
      }
      // else: rate-limited on the per-account-identifier bucket — silently
      // falls back to the bare-email checkout below, exactly like a wrong
      // password would; see this file's header comment.
    }
    // else: rate-limited on the per-IP bucket — same silent fallback.
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

  try {
    var client = new DodoPayments({
      bearerToken: apiKey,
      environment: process.env.DODO_ENVIRONMENT || 'live_mode'
    });

    // Only ever attach the stored Dodo customer_id (and enable saved
    // payment methods) once BOTH a real dodoCustomerId exists for this
    // email AND the caller just proved real ownership of that email via
    // the password gate above — either one alone is not enough:
    // verifiedAccountOwner with no dodoCustomerId (a verified account that
    // simply hasn't purchased before) has nothing to attach, and a
    // dodoCustomerId with no verification is exactly the gap this whole
    // feature exists to close. Every other case (new buyer, unverified
    // request, rate-limited) is byte-for-byte today's existing bare-email
    // customer object with no saved-methods flag at all.
    var sessionParams = {
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: (verifiedAccountOwner && dodoCustomerId) ? { customer_id: dodoCustomerId } : { email: email },
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
      // Dodo billing-field reduction, explicit written assumption (review
      // finding, same tracker item as the returning-buyer prefill above):
      // the SDK also exposes a `minimal_address` checkout-session field,
      // which reads like it could reduce the address/billing fields Dodo
      // collects at checkout. Its own docs state it only applies "when
      // confirm is true" -- i.e. Dodo's inline/embedded confirm flow. This
      // codebase's checkout is the hosted-redirect flow (checkoutSessions
      // .create -> session.checkout_url, the browser redirected there, never
      // anything resembling an inline confirm) -- so minimal_address
      // plausibly does nothing for this integration. Not verified against a
      // real Dodo checkout session (no live credentials in this environment
      // -- see this file's own header comment on why nothing here can be
      // exercised end-to-end yet); deliberately NOT set here rather than set
      // on an unverified assumption that it helps. Revisit once real Dodo
      // credentials exist and this can actually be checked against a live
      // checkout session.
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
      // Subscription vs. pack metadata. For the Dreamer Pass, dreamtube_plan
      // is the tag dodo-webhook.js reads to recognize the charge as a
      // subscription payment (its primary signal is the product_id matching
      // ANY of the three Dreamer Pass variant env vars — DODO_PRODUCT_DREAMER_
      // PASS[_NOTRIAL|_TRIAL50]; this metadata is the belt-and-suspenders
      // fallback, mirroring dreamtube_pack's role on the pack path).
      // dreamtube_pass_variant additionally records WHICH variant was bought,
      // for the webhook's conversion tagging (never the grant). No
      // dreamtube_tokens/price/starter here — those are pack-specific; the
      // 3000-token monthly grant is a fixed server-side constant
      // (DREAMER_PASS_MONTHLY_TOKENS), never derived from client-influenced
      // metadata, and identical across all three variants.
      metadata: isSubscription
        ? {
            dreamtube_email: email,
            dreamtube_plan: entitlements.DREAMER_PASS_PLAN,
            // The resolved Dreamer Pass variant (freetrial|notrial|trial50) —
            // echoed back verbatim by Dodo on the subscription's events, so
            // dodo-webhook.js can tag its conversion event with which
            // price/trial variant was bought without re-deriving it. Cheap,
            // additive; the grant itself never reads this (it's a fixed
            // server constant). Always present now that the subscription path
            // resolves a variant; the default path carries 'freetrial'.
            dreamtube_pass_variant: passVariant,
            dreamtube_event_id: eventId
          }
        : {
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
    };

    // fbc/fbp — see this file's own earlier comment on the `fbc`/`fbp`
    // local vars for the full why. Added conditionally (never a placeholder
    // `null` key) so a checkout with neither cookie present produces
    // byte-identical metadata to before this change, and dodo-webhook.js's
    // eventual `metadata.dreamtube_fbc`/`dreamtube_fbp` read simply finds
    // nothing to forward — never a fabricated value.
    if (fbc) sessionParams.metadata.dreamtube_fbc = fbc;
    if (fbp) sessionParams.metadata.dreamtube_fbp = fbp;

    // Default false (Dodo's own default) unless this is a verified,
    // returning buyer with a real customer_id to attach — see the block
    // above and this file's header comment.
    if (verifiedAccountOwner && dodoCustomerId) {
      sessionParams.show_saved_payment_methods = true;
    }

    var session = await client.checkoutSessions.create(sessionParams);

    return { statusCode: 200, body: JSON.stringify({ url: session.checkout_url, sessionId: session.session_id, eventId: eventId }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'E7: dodo_request_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
