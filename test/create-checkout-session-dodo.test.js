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
// tokens, one-time starter), pack199 ($2.99/500), pack499 ($4.99/1000,
// "Most popular"), pack999 ($9.99/2500, "Best value") — replaces the
// previous pack100/pack300/pack700 lineup entirely. mockBlobs is needed
// now (it wasn't before) because the starter-pack E9 one-time-enforcement
// guard reads the buyer's entitlement record via lib/entitlements.js's
// getTokenStatus.
//
// Also covers the returning-buyer prefill's password-verification gate
// (tracker item for-product-repeat-purchase-friction-dod-b6pzs6): mock-blobs
// backs the account-store/entitlements lookups this gate now performs, same
// convention as test/session-transfer.test.js for its equivalent real-
// password check.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var accountStore = require('../netlify/functions/lib/account-store');
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

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.8.0.' + ipCounter;
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
  delete process.env.MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IP_PER_DAY;
  delete process.env.MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IDENTIFIER_PER_DAY;
  delete process.env.DODO_PRODUCT_DREAMER_PASS;
  delete process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL;
  delete process.env.DODO_PRODUCT_DREAMER_PASS_TRIAL50;
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
  assert.equal(sentBody.metadata.dreamtube_price, 2.99);
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

test('pack499 maps to DODO_PRODUCT_PACK_MEDIUM1500 and carries 1000 tokens/$4.99 in metadata', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack499' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack499_test');
  assert.equal(sentBody.metadata.dreamtube_tokens, 1000);
  assert.equal(sentBody.metadata.dreamtube_price, 4.99);
  assert.equal(sentBody.metadata.dreamtube_starter, false);
});

test('pack999 maps to DODO_PRODUCT_PACK_LARGE4000 and carries 2500 tokens/$9.99 in metadata', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack999' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack999_test');
  assert.equal(sentBody.metadata.dreamtube_tokens, 2500);
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

// ============================================================================
// Returning-buyer prefill — real password verification before attaching a
// stored Dodo customer_id / enabling show_saved_payment_methods (tracker item
// for-product-repeat-purchase-friction-dod-b6pzs6, founder decision
// 2026-07-28). See this file's own header comment for the full security
// reasoning this section proves out: Dodo auto-attaches ANY checkout to an
// existing customer purely by EMAIL MATCH, so this must NEVER fire off a
// bare, unverified email — only after a real password check.
//
// Uses pack199 throughout (not pack099, the one-time starter SKU) so these
// tests exercise ONLY the password-verification gate, never entangling with
// the separate E9 starter-pack-one-time-use enforcement tested above —
// none of these accounts ever stamp firstPackPurchaseAt.
// ============================================================================

test('SECURITY REGRESSION: checkout WITHOUT a password never attaches customer_id or enables saved payment methods, even when a dodoCustomerId is already on file for this email', async function () {
  await accountStore.createAccount({}, { username: 'nopwbuyer', password: 'realpassword1', email: 'nopwbuyer@example.com' });
  await entitlements.setEntitlement({}, 'nopwbuyer@example.com', { dodoCustomerId: 'cus_existing_123' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'nopwbuyer@example.com', pack: 'pack199' } }));
  assert.equal(res.statusCode, 200);

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'nopwbuyer@example.com' }, 'no password supplied -- must be the plain bare-email customer object, never customer_id');
  assert.equal(sentBody.show_saved_payment_methods, undefined, 'must not enable saved payment methods without a verified password');
});

test('checkout WITH the correct password DOES attach the stored dodoCustomerId and enables show_saved_payment_methods', async function () {
  await accountStore.createAccount({}, { username: 'realbuyer', password: 'correctpw123', email: 'realbuyer@example.com' });
  await entitlements.setEntitlement({}, 'realbuyer@example.com', { dodoCustomerId: 'cus_realbuyer_456' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'realbuyer@example.com', pack: 'pack199', password: 'correctpw123' } }));
  assert.equal(res.statusCode, 200);

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { customer_id: 'cus_realbuyer_456' }, 'a verified password + an on-file dodoCustomerId must attach the existing Dodo customer, not a bare email');
  assert.equal(sentBody.show_saved_payment_methods, true);
});

test('checkout WITH a correct password but NO dodoCustomerId on file yet (verified account, first-ever purchase) falls back to the bare-email customer object -- nothing to attach', async function () {
  await accountStore.createAccount({}, { username: 'firsttimebuyer', password: 'correctpw123', email: 'firsttimebuyer@example.com' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'firsttimebuyer@example.com', pack: 'pack199', password: 'correctpw123' } }));
  assert.equal(res.statusCode, 200);

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'firsttimebuyer@example.com' });
  assert.equal(sentBody.show_saved_payment_methods, undefined);
});

test('SECURITY: checkout WITH a WRONG password falls back safely to the bare-email checkout -- no error, no attach, purchase still proceeds', async function () {
  await accountStore.createAccount({}, { username: 'wrongpwbuyer', password: 'realpassword1', email: 'wrongpwbuyer@example.com' });
  await entitlements.setEntitlement({}, 'wrongpwbuyer@example.com', { dodoCustomerId: 'cus_wrongpw_789' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'wrongpwbuyer@example.com', pack: 'pack199', password: 'totally-wrong-guess' } }));
  assert.equal(res.statusCode, 200, 'a wrong password must never error out the whole checkout -- this is a friction-reduction feature, not an auth gate on the purchase itself');

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'wrongpwbuyer@example.com' });
  assert.equal(sentBody.show_saved_payment_methods, undefined);
});

test('SECURITY: a password supplied for an email with NO registered account at all falls back safely -- never attaches anything, never errors', async function () {
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'nosuchaccount@example.com', pack: 'pack199', password: 'whatever123' } }));
  assert.equal(res.statusCode, 200);

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'nosuchaccount@example.com' });
  assert.equal(sentBody.show_saved_payment_methods, undefined);
});

test('an empty-string password is treated exactly like no password at all -- no verification attempted, no rate-limit bucket touched', async function () {
  await accountStore.createAccount({}, { username: 'emptypwbuyer', password: 'realpassword1', email: 'emptypwbuyer@example.com' });
  await entitlements.setEntitlement({}, 'emptypwbuyer@example.com', { dodoCustomerId: 'cus_empty_1' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'emptypwbuyer@example.com', pack: 'pack199', password: '' } }));
  assert.equal(res.statusCode, 200);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'emptypwbuyer@example.com' });
});

// ----- Rate limiting on the password-verification check itself, mirroring
// create-session-transfer.js's own two-bucket (per-IP + per-account-
// identifier) rate limiting on its equivalent real-password check -----

test('exceeding MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IP_PER_DAY silently falls back to the bare-email checkout (never a 4xx/5xx) once the per-IP cap on password attempts is hit', async function () {
  process.env.MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IP_PER_DAY = '1';
  await accountStore.createAccount({}, { username: 'ipcapbuyer', password: 'realpassword1', email: 'ipcapbuyer@example.com' });
  await entitlements.setEntitlement({}, 'ipcapbuyer@example.com', { dodoCustomerId: 'cus_ipcap_1' });

  var ip = nextIp();
  stubFetchCapture();
  var first = await handler(reqEvent({ ip: ip, body: { email: 'ipcapbuyer@example.com', pack: 'pack199', password: 'realpassword1' } }));
  assert.equal(first.statusCode, 200);
  var firstBody = JSON.parse(first.body);
  assert.ok(firstBody.url, 'first attempt (within cap) must still succeed and use the verified path');

  var captured = stubFetchCapture();
  var second = await handler(reqEvent({ ip: ip, body: { email: 'ipcapbuyer@example.com', pack: 'pack199', password: 'realpassword1' } }));
  assert.equal(second.statusCode, 200, 'a rate-limited password check must never block the underlying checkout itself');
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'ipcapbuyer@example.com' }, 'once the per-IP password-check cap is hit, this call must fall back to the bare-email checkout exactly like an unverified request');
  assert.equal(sentBody.show_saved_payment_methods, undefined);
});

test('exceeding MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IDENTIFIER_PER_DAY throttles repeated password guesses against ONE account even from rotating IPs, same round-2 review fix as create-session-transfer.js', async function () {
  process.env.MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IDENTIFIER_PER_DAY = '2';
  await accountStore.createAccount({}, { username: 'identcapbuyer', password: 'realpassword1', email: 'identcapbuyer@example.com' });
  await entitlements.setEntitlement({}, 'identcapbuyer@example.com', { dodoCustomerId: 'cus_identcap_1' });

  stubFetchCapture();
  var first = await handler(reqEvent({ ip: nextIp(), body: { email: 'identcapbuyer@example.com', pack: 'pack199', password: 'wrong-guess-one' } }));
  assert.equal(first.statusCode, 200); // 1st of 2 allowed identifier attempts

  stubFetchCapture();
  var second = await handler(reqEvent({ ip: nextIp(), body: { email: 'identcapbuyer@example.com', pack: 'pack199', password: 'wrong-guess-two' } }));
  assert.equal(second.statusCode, 200); // still under the per-identifier cap, even from a brand-new IP each time

  // The REAL password, tried from yet another fresh IP, is now blocked by
  // the per-identifier cap regardless of correctness.
  var captured = stubFetchCapture();
  var third = await handler(reqEvent({ ip: nextIp(), body: { email: 'identcapbuyer@example.com', pack: 'pack199', password: 'realpassword1' } }));
  assert.equal(third.statusCode, 200, 'checkout itself must still succeed even though the password-verification cap was hit');
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'identcapbuyer@example.com' }, 'per-identifier cap on password attempts must block verification (falling back to bare email) regardless of rotating IPs');
});

// ============================================================================
// Dreamer Pass subscription checkout — POST { email, plan: "dreamer_pass" }
// creates a Dodo checkout referencing DODO_PRODUCT_DREAMER_PASS. Dodo decides
// subscription-vs-one-time from the product config, so this sends the SAME
// product_cart shape as a pack (no subscription_data param). See this file's
// header comment and create-checkout-session-dodo.js's DREAMER PASS note.
// ============================================================================

test('a Dreamer Pass checkout references DODO_PRODUCT_DREAMER_PASS and returns a checkout url', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_dreamer_pass_test';
  var captured = stubFetchCapture({ session_id: 'cks_pass', checkout_url: 'https://checkout.dodopayments.com/cks_pass' });
  var res = await handler(reqEvent({ body: { email: '  Sub@Example.com  ', plan: 'dreamer_pass' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.url, 'https://checkout.dodopayments.com/cks_pass');

  assert.equal(captured.calls.length, 1);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_dreamer_pass_test');
  assert.equal(sentBody.product_cart[0].quantity, 1);
  assert.equal(sentBody.customer.email, 'sub@example.com', 'email normalized');
  assert.equal(sentBody.metadata.dreamtube_plan, 'dreamer_pass', 'the plan tag dodo-webhook.js reads as a fallback signal');
  assert.equal(sentBody.metadata.dreamtube_pack, undefined, 'no pack metadata on a subscription checkout');
  assert.equal(sentBody.metadata.dreamtube_tokens, undefined, 'no per-pack token count -- the 3000 monthly grant is a fixed server constant');
  assert.ok(sentBody.metadata.dreamtube_event_id, 'still carries a shared event_id');
  // No subscription_data param -- the trial lives on the product itself.
  assert.equal(sentBody.subscription_data, undefined);
  // Consumer checkout: business/tax-id option still disabled.
  assert.equal(sentBody.feature_flags.allow_tax_id, false);
  delete process.env.DODO_PRODUCT_DREAMER_PASS;
});

test('a Dreamer Pass checkout with DODO_PRODUCT_DREAMER_PASS unset -> 500 E6 (E6-style missing-product error), Dodo never called', async function () {
  delete process.env.DODO_PRODUCT_DREAMER_PASS;
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'sub@example.com', plan: 'dreamer_pass' } }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E6: missing_product_id: DODO_PRODUCT_DREAMER_PASS/);
  assert.equal(captured.calls.length, 0);
});

test('a Dreamer Pass checkout with no email -> 400 E4 (email required)', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_dreamer_pass_test';
  var res = await handler(reqEvent({ body: { plan: 'dreamer_pass' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4/);
  delete process.env.DODO_PRODUCT_DREAMER_PASS;
});

test('the subscription path does NOT apply the starter-pack E9 one-time guard, even for an account that already purchased', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_dreamer_pass_test';
  // An account that has completed a pack purchase would be refused pack099
  // (E9) -- but the Dreamer Pass is a separate recurring product, never gated
  // by that one-time-starter rule.
  await entitlements.setEntitlement({}, 'alreadybought@example.com', {
    tokens: { balance: 500 }, firstPackPurchaseAt: Date.now() - 999999999
  });
  var captured = stubFetchCapture({ session_id: 'cks_pass2', checkout_url: 'https://checkout.dodopayments.com/cks_pass2' });
  var res = await handler(reqEvent({ body: { email: 'alreadybought@example.com', plan: 'dreamer_pass' } }));
  assert.equal(res.statusCode, 200, 'the subscription checkout is never blocked by the starter E9 guard');
  assert.equal(captured.calls.length, 1);
  delete process.env.DODO_PRODUCT_DREAMER_PASS;
});

// ============================================================================
// Dreamer Pass VARIANTS — the SAME 3,000-token/month pass at three
// price/trial configurations, selected by an OPTIONAL `passVariant` in
// {freetrial, notrial, trial50} on the subscription request. Each maps to its
// own DODO_PRODUCT_DREAMER_PASS[_NOTRIAL|_TRIAL50] env var (product IDs are
// never hardcoded, same pattern as the packs). Absent/empty/unknown ->
// freetrial (byte-for-byte the existing default). INERT PLUMBING: no shipped
// UI passes passVariant yet. See create-checkout-session-dodo.js's DREAMER
// PASS VARIANTS header note.
// ============================================================================

test('passVariant "freetrial" selects DODO_PRODUCT_DREAMER_PASS (same as the default) and tags metadata', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'ft@example.com', plan: 'dreamer_pass', passVariant: 'freetrial' } }));
  assert.equal(res.statusCode, 200);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pass_freetrial');
  assert.equal(sentBody.metadata.dreamtube_plan, 'dreamer_pass');
  assert.equal(sentBody.metadata.dreamtube_pass_variant, 'freetrial');
});

test('passVariant "notrial" selects DODO_PRODUCT_DREAMER_PASS_NOTRIAL', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL = 'pdt_pass_notrial';
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'nt@example.com', plan: 'dreamer_pass', passVariant: 'notrial' } }));
  assert.equal(res.statusCode, 200);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pass_notrial', 'notrial must select its OWN product, never the default');
  assert.equal(sentBody.metadata.dreamtube_pass_variant, 'notrial');
  // Same product_cart shape as every other path — Dodo derives the (absent)
  // trial from the product config, no subscription_data param sent.
  assert.equal(sentBody.subscription_data, undefined);
  assert.equal(sentBody.feature_flags.allow_tax_id, false);
});

// (The $1 "trial50" variant was RETIRED 2026-08-11 — it's no longer in
// PASS_VARIANT_ENV, so a stray trial50 request now safely falls back to the
// freetrial default, same as any unknown variant, per the test below.)

test('a subscription request with NO passVariant defaults to freetrial (DODO_PRODUCT_DREAMER_PASS), byte-for-byte the existing behavior', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  // Both new variant env vars are also set, to prove the default never
  // accidentally reaches for one of them.
  process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL = 'pdt_pass_notrial';
  process.env.DODO_PRODUCT_DREAMER_PASS_TRIAL50 = 'pdt_pass_trial50';
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'default@example.com', plan: 'dreamer_pass' } }));
  assert.equal(res.statusCode, 200);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pass_freetrial', 'no passVariant -> the freetrial default product, never a new variant');
  assert.equal(sentBody.metadata.dreamtube_pass_variant, 'freetrial', 'the resolved default is recorded as freetrial');
});

test('an unknown passVariant value falls back to freetrial (default), never an error', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'unknown@example.com', plan: 'dreamer_pass', passVariant: 'bogus_variant' } }));
  assert.equal(res.statusCode, 200);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pass_freetrial', 'an unknown variant must resolve to the safe default, not 4xx');
  assert.equal(sentBody.metadata.dreamtube_pass_variant, 'freetrial');
});

test('an empty-string passVariant resolves to freetrial (default)', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'empty@example.com', plan: 'dreamer_pass', passVariant: '' } }));
  assert.equal(res.statusCode, 200);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pass_freetrial');
});

test('passVariant is case/whitespace-insensitive ("  NoTrial  " -> notrial)', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL = 'pdt_pass_notrial';
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'ws@example.com', plan: 'dreamer_pass', passVariant: '  NoTrial  ' } }));
  assert.equal(res.statusCode, 200);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pass_notrial');
  assert.equal(sentBody.metadata.dreamtube_pass_variant, 'notrial');
});

test('a requested variant whose env var is unset -> 500 E6 naming THAT variant\'s env var, Dodo never called', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  delete process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL; // notrial requested but unconfigured
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'missing@example.com', plan: 'dreamer_pass', passVariant: 'notrial' } }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E6: missing_product_id: DODO_PRODUCT_DREAMER_PASS_NOTRIAL/);
  assert.equal(captured.calls.length, 0, 'must not create a Dodo checkout when the requested variant is unconfigured');
});

test('a retired/unknown variant (e.g. trial50) falls back to the freetrial default, never E6', async function () {
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'retired50@example.com', plan: 'dreamer_pass', passVariant: 'trial50' } }));
  assert.equal(res.statusCode, 200, 'retired trial50 is now an unknown variant -> safe freetrial default');
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pass_freetrial');
  assert.equal(sentBody.metadata.dreamtube_pass_variant, 'freetrial');
});

test('requesting a NEW variant does not fall back to the default product even when the default IS configured', async function () {
  // Regression guard: an unconfigured notrial must E6, NOT silently sell the
  // freetrial product — the price/trial the buyer selected would be wrong.
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
  delete process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL;
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'nofallback@example.com', plan: 'dreamer_pass', passVariant: 'notrial' } }));
  assert.equal(res.statusCode, 500, 'an unconfigured variant must fail, never quietly substitute the default product');
  assert.equal(captured.calls.length, 0);
});

// ----- LOW-1 hardening: prototype-chain-safe variant lookup -----
//
// The variant membership check uses Object.prototype.hasOwnProperty.call, NOT
// a bare `!PASS_VARIANT_ENV[passVariant]`. A bare check reads through the
// prototype chain, so a crafted passVariant of "__proto__" / "constructor" /
// "hasOwnProperty" would resolve to an inherited (truthy) Object.prototype
// member, be mistaken for a KNOWN variant, skip the freetrial fallback, and
// then feed a non-string (Object.prototype, or the Object constructor) into
// process.env[...]. These prove every such crafted value falls back to the
// safe freetrial default and sells the correct product — never errors, never
// leaks a bogus product id.

['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf'].forEach(function (crafted) {
  test('SECURITY: a prototype-chain passVariant ("' + crafted + '") falls back to freetrial, selling the default product — never treated as a known variant', async function () {
    process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_pass_freetrial';
    // Both new variant env vars set too, to prove the crafted value never
    // reaches for one of them either.
    process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL = 'pdt_pass_notrial';
    process.env.DODO_PRODUCT_DREAMER_PASS_TRIAL50 = 'pdt_pass_trial50';
    var captured = stubFetchCapture();
    var res = await handler(reqEvent({ body: { email: 'proto@example.com', plan: 'dreamer_pass', passVariant: crafted } }));
    assert.equal(res.statusCode, 200, 'a crafted prototype-member variant must resolve to the safe default, not 4xx/5xx');
    var sentBody = JSON.parse(captured.calls[0].init.body);
    assert.equal(sentBody.product_cart[0].product_id, 'pdt_pass_freetrial', 'must sell the freetrial default product, never a value pulled off the prototype chain');
    assert.equal(sentBody.metadata.dreamtube_pass_variant, 'freetrial', 'the resolved variant must be the safe freetrial default');
  });
});
