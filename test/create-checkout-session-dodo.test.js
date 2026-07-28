// test/create-checkout-session-dodo.test.js
//
// Covers netlify/functions/create-checkout-session-dodo.js: creating a
// one-time-purchase Dodo Checkout Session for a token pack. Exercises
// every error path (E1-E7) plus the success path, stubbing global.fetch
// the same way generate-video-gate.test.js stubs fal.ai's call — the
// `dodopayments` SDK makes its HTTP request via the global `fetch`, so
// intercepting it there avoids needing real Dodo credentials or network
// access.
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
  return fakeEvent(Object.assign({ method: 'POST', body: { email: 'buyer@example.com', pack: 'pack100' } }, overrides));
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
  process.env.DODO_PRODUCT_PACK_100 = 'pdt_pack100_test';
  process.env.DODO_PRODUCT_PACK_300 = 'pdt_pack300_test';
  process.env.DODO_PRODUCT_PACK_700 = 'pdt_pack700_test';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.DODO_API_KEY;
  delete process.env.DODO_PRODUCT_PACK_100;
  delete process.env.DODO_PRODUCT_PACK_300;
  delete process.env.DODO_PRODUCT_PACK_700;
  delete process.env.MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IP_PER_DAY;
  delete process.env.MAX_CHECKOUT_PASSWORD_ATTEMPTS_PER_IDENTIFIER_PER_DAY;
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
  var res = await handler(reqEvent({ body: { pack: 'pack100' } }));
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

test('valid pack but its product id env var is not configured -> 500 E6', async function () {
  delete process.env.DODO_PRODUCT_PACK_300;
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack300' } }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E6: missing_product_id: DODO_PRODUCT_PACK_300/);
});

test('an unconfigured pack does not affect the other two packs (each pack degrades independently)', async function () {
  stubFetchCapture();
  delete process.env.DODO_PRODUCT_PACK_700;
  var res100 = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack100' } }));
  assert.equal(res100.statusCode, 200, 'pack100 must still work even though pack700 is unconfigured');
  var res700 = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack700' } }));
  assert.equal(res700.statusCode, 500);
  assert.match(JSON.parse(res700.body).error, /^E6: missing_product_id: DODO_PRODUCT_PACK_700/);
});

test('valid request -> 200 with checkout url + session id, sends the right product/customer to Dodo', async function () {
  var captured = stubFetchCapture({ session_id: 'cks_abc', checkout_url: 'https://checkout.dodopayments.com/cks_abc' });
  var res = await handler(reqEvent({ body: { email: '  Buyer@Example.com  ', pack: 'pack100' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.url, 'https://checkout.dodopayments.com/cks_abc');
  assert.equal(body.sessionId, 'cks_abc');

  assert.equal(captured.calls.length, 1);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack100_test');
  assert.equal(sentBody.product_cart[0].quantity, 1);
  // Email is normalized (trimmed + lowercased) before being sent, same as
  // every other email in this codebase.
  assert.equal(sentBody.customer.email, 'buyer@example.com');
  assert.equal(sentBody.metadata.dreamtube_email, 'buyer@example.com');
  assert.equal(sentBody.metadata.dreamtube_pack, 'pack100');
  assert.equal(sentBody.metadata.dreamtube_tokens, 100);
  // Phase 1 reporting instrumentation's shared Purchase-dedup id (review
  // finding: this exact link previously existed in code but was never
  // actually wired -- the endpoint's response has to genuinely carry the
  // SAME id it embeds in Dodo's metadata, or dodo-webhook.js's own
  // server-side Purchase fire silently falls back to a fresh, non-
  // deduping id).
  assert.equal(sentBody.metadata.dreamtube_price, 2.99);
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

test('pack300 maps to DODO_PRODUCT_PACK_300 and carries 300 tokens in metadata', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack300' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack300_test');
  assert.equal(sentBody.metadata.dreamtube_tokens, 300);
});

test('pack700 maps to DODO_PRODUCT_PACK_700 and carries 700 tokens in metadata', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack700' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack700_test');
  assert.equal(sentBody.metadata.dreamtube_tokens, 700);
});

test('default return/cancel URLs point back to shop.html, derived from the request host', async function () {
  var captured = stubFetchCapture();
  await handler(fakeEvent({
    method: 'POST',
    headers: { host: 'dreamtube1.netlify.app' },
    body: { email: 'buyer@example.com', pack: 'pack100' }
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
    body: { email: 'buyer@example.com', pack: 'pack100', successUrl: '/processing.html?checkout=success', cancelUrl: '/style.html?checkout=cancelled' }
  }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.return_url, 'https://dreamtube1.netlify.app/processing.html?checkout=success');
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
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack100', successUrl: 'https://evil.example.com/steal' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
  assert.equal(captured.calls.length, 0, 'must reject before ever creating a real Dodo checkout session');
});

test('SECURITY: a cross-origin absolute cancelUrl is rejected -> 400 E8', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack100', cancelUrl: 'https://evil.example.com/steal' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
});

test('SECURITY: a same-origin absolute successUrl is still rejected — relative-path-only, not merely same-origin', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack100', successUrl: 'https://dreamtube1.netlify.app/processing.html' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
});

test('SECURITY: a protocol-relative successUrl ("//evil.example.com/...") is rejected', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack100', successUrl: '//evil.example.com/steal' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
});

test('SECURITY: a scheme-prefixed successUrl without a leading slash (e.g. "javascript:...") is rejected', async function () {
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack100', successUrl: 'javascript:alert(1)' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E8: invalid_redirect_url/);
});

test('Dodo API rejects the request -> 502 E7', async function () {
  stubFetchError();
  var res = await handler(reqEvent());
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E7: dodo_request_failed/);
});

// ============================================================================
// Returning-buyer prefill — real password verification before attaching a
// stored Dodo customer_id / enabling show_saved_payment_methods (tracker item
// for-product-repeat-purchase-friction-dod-b6pzs6, founder decision
// 2026-07-28). See this file's own header comment for the full security
// reasoning this section proves out: Dodo auto-attaches ANY checkout to an
// existing customer purely by EMAIL MATCH, so this must NEVER fire off a
// bare, unverified email — only after a real password check.
// ============================================================================

test('SECURITY REGRESSION: checkout WITHOUT a password never attaches customer_id or enables saved payment methods, even when a dodoCustomerId is already on file for this email', async function () {
  await accountStore.createAccount({}, { username: 'nopwbuyer', password: 'realpassword1', email: 'nopwbuyer@example.com' });
  await entitlements.setEntitlement({}, 'nopwbuyer@example.com', { dodoCustomerId: 'cus_existing_123' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'nopwbuyer@example.com', pack: 'pack100' } }));
  assert.equal(res.statusCode, 200);

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'nopwbuyer@example.com' }, 'no password supplied -- must be the plain bare-email customer object, never customer_id');
  assert.equal(sentBody.show_saved_payment_methods, undefined, 'must not enable saved payment methods without a verified password');
});

test('checkout WITH the correct password DOES attach the stored dodoCustomerId and enables show_saved_payment_methods', async function () {
  await accountStore.createAccount({}, { username: 'realbuyer', password: 'correctpw123', email: 'realbuyer@example.com' });
  await entitlements.setEntitlement({}, 'realbuyer@example.com', { dodoCustomerId: 'cus_realbuyer_456' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'realbuyer@example.com', pack: 'pack100', password: 'correctpw123' } }));
  assert.equal(res.statusCode, 200);

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { customer_id: 'cus_realbuyer_456' }, 'a verified password + an on-file dodoCustomerId must attach the existing Dodo customer, not a bare email');
  assert.equal(sentBody.show_saved_payment_methods, true);
});

test('checkout WITH a correct password but NO dodoCustomerId on file yet (verified account, first-ever purchase) falls back to the bare-email customer object -- nothing to attach', async function () {
  await accountStore.createAccount({}, { username: 'firsttimebuyer', password: 'correctpw123', email: 'firsttimebuyer@example.com' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'firsttimebuyer@example.com', pack: 'pack100', password: 'correctpw123' } }));
  assert.equal(res.statusCode, 200);

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'firsttimebuyer@example.com' });
  assert.equal(sentBody.show_saved_payment_methods, undefined);
});

test('SECURITY: checkout WITH a WRONG password falls back safely to the bare-email checkout -- no error, no attach, purchase still proceeds', async function () {
  await accountStore.createAccount({}, { username: 'wrongpwbuyer', password: 'realpassword1', email: 'wrongpwbuyer@example.com' });
  await entitlements.setEntitlement({}, 'wrongpwbuyer@example.com', { dodoCustomerId: 'cus_wrongpw_789' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'wrongpwbuyer@example.com', pack: 'pack100', password: 'totally-wrong-guess' } }));
  assert.equal(res.statusCode, 200, 'a wrong password must never error out the whole checkout -- this is a friction-reduction feature, not an auth gate on the purchase itself');

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'wrongpwbuyer@example.com' });
  assert.equal(sentBody.show_saved_payment_methods, undefined);
});

test('SECURITY: a password supplied for an email with NO registered account at all falls back safely -- never attaches anything, never errors', async function () {
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'nosuchaccount@example.com', pack: 'pack100', password: 'whatever123' } }));
  assert.equal(res.statusCode, 200);

  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'nosuchaccount@example.com' });
  assert.equal(sentBody.show_saved_payment_methods, undefined);
});

test('an empty-string password is treated exactly like no password at all -- no verification attempted, no rate-limit bucket touched', async function () {
  await accountStore.createAccount({}, { username: 'emptypwbuyer', password: 'realpassword1', email: 'emptypwbuyer@example.com' });
  await entitlements.setEntitlement({}, 'emptypwbuyer@example.com', { dodoCustomerId: 'cus_empty_1' });

  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ ip: nextIp(), body: { email: 'emptypwbuyer@example.com', pack: 'pack100', password: '' } }));
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
  var first = await handler(reqEvent({ ip: ip, body: { email: 'ipcapbuyer@example.com', pack: 'pack100', password: 'realpassword1' } }));
  assert.equal(first.statusCode, 200);
  var firstBody = JSON.parse(first.body);
  assert.ok(firstBody.url, 'first attempt (within cap) must still succeed and use the verified path');

  var captured = stubFetchCapture();
  var second = await handler(reqEvent({ ip: ip, body: { email: 'ipcapbuyer@example.com', pack: 'pack100', password: 'realpassword1' } }));
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
  var first = await handler(reqEvent({ ip: nextIp(), body: { email: 'identcapbuyer@example.com', pack: 'pack100', password: 'wrong-guess-one' } }));
  assert.equal(first.statusCode, 200); // 1st of 2 allowed identifier attempts

  stubFetchCapture();
  var second = await handler(reqEvent({ ip: nextIp(), body: { email: 'identcapbuyer@example.com', pack: 'pack100', password: 'wrong-guess-two' } }));
  assert.equal(second.statusCode, 200); // still under the per-identifier cap, even from a brand-new IP each time

  // The REAL password, tried from yet another fresh IP, is now blocked by
  // the per-identifier cap regardless of correctness.
  var captured = stubFetchCapture();
  var third = await handler(reqEvent({ ip: nextIp(), body: { email: 'identcapbuyer@example.com', pack: 'pack100', password: 'realpassword1' } }));
  assert.equal(third.statusCode, 200, 'checkout itself must still succeed even though the password-verification cap was hit');
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'identcapbuyer@example.com' }, 'per-identifier cap on password attempts must block verification (falling back to bare email) regardless of rotating IPs');
});
