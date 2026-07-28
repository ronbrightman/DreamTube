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
var { normalizeEmail } = entitlements;
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
      metadata: {
        dreamtube_email: email,
        dreamtube_pack: pack,
        dreamtube_tokens: PACK_TOKENS[pack],
        dreamtube_price: PACK_PRICES[pack],
        dreamtube_event_id: eventId
      }
    };

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
