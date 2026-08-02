// test/create-checkout-session-dodo.test.js
//
// Covers netlify/functions/create-checkout-session-dodo.js: creating a
// one-time-purchase Dodo Checkout Session for a token pack. Exercises
// every error path (E1-E9) plus the success path, stubbing global.fetch
// the same way generate-video-gate.test.js stubs fal.ai's call — the
// `dodopayments` SDK makes its HTTP request via the global `fetch`, so
// intercepting it there avoids needing real Dodo credentials or network
// access.
//
// "The Vault" pack ladder (founder-approved 2026-08-02, tracker item
// for-product-build-ship-today-founder-app-zn9zyy): pack099 ($0.99/300
// tokens, one-time starter), pack199 ($1.99/500), pack499 ($4.99/1500,
// "Most popular"), pack999 ($9.99/4000, "Best value") — replaces the
// previous pack100/pack300/pack700 lineup entirely. mockBlobs is needed
// now (it wasn't before) because the starter-pack E9 one-time-enforcement
// guard reads the buyer's entitlement record via lib/entitlements.js's
// getTokenStatus.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var handler = require('../netlify/functions/create-checkout-session-dodo').handler;

var realFetch = global.fetch;

function stubFetchCapture(responseBody) {
  var captured = { calls: [] };
  global.fetch = async function (url, init) {
    captured.calls.push({ url: url, init: init });
    return new Response(JSON.stringify(responseBody || { session_id: 'cks_test123', checkout_url: 'https://checkout.dodopayments.com/cks_test123' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return captured;
}

function stubFetchError() {
  global.fetch = async function () {
    return new Response(JSON.stringify({ message: 'invalid product' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  };
}

function reqEvent(overrides) {
  return fakeEvent(Object.assign({ method: 'POST', body: { email: 'buyer@example.com', pack: 'pack099' } }, overrides));
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  process.env.DODO_API_KEY = 'test-dodo-key';
  process.env.DODO_PRODUCT_PACK_STARTER300 = 'pdt_pack099_test';
  process.env.DODO_PRODUCT_PACK_SMALL500 = 'pdt_pack199_test';
  process.env.DODO_PRODUCT_PACK_MEDIUM1500 = 'pdt_pack499_test';
  process.env.DODO_PRODUCT_PACK_LARGE4000 = 'pdt_pack999_test';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.DODO_API_KEY;
  delete process.env.DODO_PRODUCT_PACK_STARTER300;
  delete process.env.DODO_PRODUCT_PACK_SMALL500;
  delete process.env.DODO_PRODUCT_PACK_MEDIUM1500;
  delete process.env.DODO_PRODUCT_PACK_LARGE4000;
});

test('non-POST method -> 405 E1', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('missing DODO_API_KEY -> 500 E2', async function () {
  delete process.env.DODO_API_KEY;
  var res = await handler(reqEvent());
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E2: missing_api_key/);
});

test('invalid JSON body -> 400 E3', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: invalid_json/);
});

test('missing email -> 400 E4', async function () {
  var res = await handler(reqEvent({ body: { pack: 'pack099' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: email_and_pack_required/);
});

test('missing pack -> 400 E4', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: email_and_pack_required/);
});

test('invalid pack value -> 400 E5', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack9999' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E5: invalid_pack/);
});

// The RETIRED pack100/pack300/pack700 ids must be treated as invalid now —
// not silently reinterpreted as anything in the new lineup (see this
// file's own no-grandfathering header comment).
test('a RETIRED pack id (pack100) is rejected as invalid, not reinterpreted -> 400 E5', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack100' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E5: invalid_pack/);
});

test('valid pack but its product id env var is not configured -> 500 E6', async function () {
  delete process.env.DODO_PRODUCT_PACK_SMALL500;
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack199' } }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E6: missing_product_id: DODO_PRODUCT_PACK_SMALL500/);
});

test('an unconfigured pack does not affect the other packs (each pack degrades independently)', async function () {
  stubFetchCapture();
  delete process.env.DODO_PRODUCT_PACK_LARGE4000;
  var res199 = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack199' } }));
  assert.equal(res199.statusCode, 200, 'pack199 must still work even though pack999 is unconfigured');
  var res999 = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack999' } }));
  assert.equal(res999.statusCode, 500);
  assert.match(JSON.parse(res999.body).error, /^E6: missing_product_id: DODO_PRODUCT_PACK_LARGE4000/);
});

test('valid request (pack199, not the starter) -> 200 with checkout url + session id, sends the right product/customer to Dodo', async function () {
  var captured = stubFetchCapture({ session_id: 'cks_abc', checkout_url: 'https://checkout.dodopayments.com/cks_abc' });
  var res = await handler(reqEvent({ body: { email: '  Buyer@Example.com  ', pack: 'pack199' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.url, 'https://checkout.dodopayments.com/cks_abc');
  assert.equal(body.sessionId, 'cks_abc');

  assert.equal(captured.calls.length, 1);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack199_test');
  assert.equal(sentBody.product_cart[0].quantity, 1);
  // Email is normalized (trimmed + lowercased) before being sent, same as
  // every other email in this codebase.
  assert.equal(sentBody.customer.email, 'buyer@example.com');
  assert.equal(sentBody.metadata.dreamtube_email, 'buyer@example.com');
  assert.equal(sentBody.metadata.dreamtube_pack, 'pack199');
  assert.equal(sentBody.metadata.dreamtube_tokens, 500);
  assert.equal(sentBody.metadata.dreamtube_price, 1.99);
  assert.equal(sentBody.metadata.dreamtube_starter, false, 'pack199 is not the starter pack');
  // Phase 1 reporting instrumentation's shared Purchase-dedup id (review
  // finding: this exact link previously existed in code but was never
  // actually wired -- the endpoint's response has to genuinely carry the
  // SAME id it embeds in Dodo's metadata, or dodo-webhook.js's own
  // server-side Purchase fire silently falls back to a fresh, non-
  // deduping id).
  assert.ok(body.eventId, 'the response must carry an eventId for shop.html to thread into its pending-purchase marker');
  assert.equal(sentBody.metadata.dreamtube_event_id, body.eventId, 'the SAME event_id must be both returned to the client and embedded in Dodo metadata, or dodo-webhook.js\'s own Purchase fire cannot dedupe against the client-side one');
  // Founder does not want the "purchasing as a business" tax-id option
  // surfaced at checkout for consumer token-pack purchases (tracker item
  // review-the-non-mandatory-dodo-account-fi-bnw41z) -- Dodo's
  // feature_flags.allow_tax_id defaults to true, so this must be
  // explicitly disabled. Must be nested under feature_flags -- a
  // top-level allow_tax_id key is not a real CheckoutSessionCreateParams
  // field and would be silently ignored by Dodo's API (review finding).
  assert.equal(sentBody.feature_flags && sentBody.feature_flags.allow_tax_id, false, 'the business/tax-id checkout option must be explicitly disabled under feature_flags, not left at Dodo\'s default-true');
  assert.equal(sentBody.allow_tax_id, undefined, 'allow_tax_id must NOT be sent as a top-level field -- Dodo\'s API silently ignores it there, leaving the real default (true) in effect');
});

test('pack499 maps to DODO_PRODUCT_PACK_MEDIUM1500 and carries 1500 tokens/$4.99 in metadata', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack499' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack499_test');
  assert.equal(sentBody.metadata.dreamtube_tokens, 1500);
  assert.equal(sentBody.metadata.dreamtube_price, 4.99);
  assert.equal(sentBody.metadata.dreamtube_starter, false);
});

test('pack999 maps to DODO_PRODUCT_PACK_LARGE4000 and carries 4000 tokens/$9.99 in metadata', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack999' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack999_test');
  assert.equal(sentBody.metadata.dreamtube_tokens, 4000);
  assert.equal(sentBody.metadata.dreamtube_price, 9.99);
  assert.equal(sentBody.metadata.dreamtube_starter, false);
});

test('default return/cancel URLs point back to shop.html, derived from the request host', async function () {
  var captured = stubFetchCapture();
  await handler(fakeEvent({
    method: 'POST',
    headers: { host: 'dreamtube1.netlify.app' },
    body: { email: 'buyer@example.com', pack: 'pack199' }
  }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.return_url, 'https://dreamtube1.netlify.app/shop.html?checkout=success');
  assert.equal(sentBody.cancel_url, 'https://dreamtube1.netlify.app/shop.html?checkout=cancelled');
});

test('caller-supplied successUrl/cancelUrl override the defaults, resolved against this request\'s own origin', async function () {
  var captured = stubFetchCapture();
  await handler(fakeEvent({
    method: 'POST',
    headers: { host: 'dreamtube1.netlify.app' },
    body: { email: 'buyer@example.com', pack: 'pack199', successUrl: '/home.html?checkout=success', cancelUrl: '/style.html?checkout=cancelled' }
  }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.return_url, 'https://dreamtube1.netlify.app/home.html?checkout=success');
  assert.equal(sentBody.cancel_url, 'https://dreamtube1.netlify.app/style.html?checkout=cancelled');
});

// ============================================================================
// Open-redirect guard (security fix, tracker item
// for-product-build-out-of-tokens-purchase-2y8hyw) — successUrl/cancelUrl
// used to be honored completely verbatim with no validation (see this
// file's own header comment for the full story). Only a same-app-relative
// path (exactly one leading slash, no scheme, no protocol-relative "//")
// is accepted; anything else must be rejected with 400 E8, not silently
// substituted or partially trusted.
// ============================================================================

test('SECURITY: a cross-origin absolute successUrl is rejected -> 400 E8, and Dodo is never called', async function () {
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack199', successUrl: 'https://evil.example.com/steal' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
  assert.equal(captured.calls.length, 0, 'must reject before ever creating a real Dodo checkout session');
});

test('SECURITY: a cross-origin absolute cancelUrl is rejected -> 400 E8', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack199', cancelUrl: 'https://evil.example.com/steal' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
});

test('SECURITY: a same-origin absolute successUrl is still rejected — relative-path-only, not merely same-origin', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack199', successUrl: 'https://dreamtube1.netlify.app/home.html' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
});

test('SECURITY: a protocol-relative successUrl ("//evil.example.com/...") is rejected', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack199', successUrl: '//evil.example.com/steal' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
});

test('SECURITY: a scheme-prefixed successUrl without a leading slash (e.g. "javascript:...") is rejected', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack199', successUrl: 'javascript:alert(1)' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
});

test('Dodo API rejects the request -> 502 E7', async function () {
  stubFetchError();
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack199' } }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E7: dodo_request_failed/);
});

// ============================================================================
// Starter one-time-per-account enforcement (E9) — tracker item
// for-product-build-ship-today-founder-app-zn9zyy. pack099 is a genuine
// welcome-offer SKU, not a repeatable discount: a checkout session for it
// must be refused BEFORE any charge happens (see this file's own header
// comment for why the enforcement point is here, not the webhook) once
// this account has ever completed a pack purchase before.
// ============================================================================

test('a brand-new account (never purchased) CAN start a pack099 checkout -> 200', async function () {
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'starter-eligible@example.com', pack: 'pack099' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(captured.calls.length, 1);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack099_test');
  assert.equal(sentBody.metadata.dreamtube_tokens, 300);
  assert.equal(sentBody.metadata.dreamtube_price, 0.99);
  assert.equal(sentBody.metadata.dreamtube_starter, true, 'pack099 IS the starter pack');
});

test('an account that has already completed a pack purchase before is refused a SECOND pack099 checkout -> 400 E9, Dodo never called', async function () {
  var email = 'already-bought-one@example.com';
  // Same signal a real completed purchase stamps (creditTokenPackAmountOnce
  // — see lib/entitlements.js) — simulated directly here rather than
  // routing through a full webhook credit, since what's under test is
  // THIS function's own read of that signal, not the crediting path
  // itself (that has its own dedicated tests in dodo-webhook.test.js /
  // entitlements-token-purchases.test.js).
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 500 },
    firstPackPurchaseAt: Date.now() - 999999999
  });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: email, pack: 'pack099' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E9: starter_already_used/);
  assert.equal(captured.calls.length, 0, 'must refuse BEFORE ever creating a real Dodo checkout session -- no charge should be possible for an already-ineligible starter attempt');
});

test('a REPEATED attempt at the starter pack does not double-grant or bypass the one-time rule -- every attempt after the first purchase is refused, not just the first retry', async function () {
  var email = 'repeat-starter-attempts@example.com';
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 100 },
    firstPackPurchaseAt: Date.now() - 999999999
  });

  var captured = stubFetchCapture();
  for (var i = 0; i < 3; i++) {
    var res = await handler(reqEvent({ body: { email: email, pack: 'pack099' } }));
    assert.equal(res.statusCode, 400, 'attempt #' + (i + 1) + ' must also be refused');
    assert.match(JSON.parse(res.body).error, /^E9: starter_already_used/);
  }
  assert.equal(captured.calls.length, 0, 'no attempt should ever have reached Dodo');
});

test('the starter-pack eligibility check does NOT run (no extra Blobs read) for non-starter packs', async function () {
  // A non-starter pack must work purely off env-var configuration -- no
  // entitlement lookup at all. Proven by seeding a read override that
  // throws if ever called for this store -- a pack199 checkout must never
  // trigger it.
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function () {
    throw new Error('entitlement store should never be read for a non-starter pack checkout');
  });
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'no-lookup-needed@example.com', pack: 'pack199' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(captured.calls.length, 1);
  mockBlobs.clearReadOverride(entitlements.STORE_NAME);
});

test('E9 is checked before the missing-product-id guard would even matter for a DIFFERENT pack -- an ineligible pack099 attempt is still E9, not confused with any other pack\'s own configuration state', async function () {
  var email = 'e9-precedence@example.com';
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 50 },
    firstPackPurchaseAt: Date.now() - 999999999
  });
  var res = await handler(reqEvent({ body: { email: email, pack: 'pack099' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E9:/);
});
