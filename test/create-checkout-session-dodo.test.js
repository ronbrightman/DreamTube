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
// Also covers the returning-customer-prefill fix (tracker item
// for-product-repeat-purchase-friction-dod-b6pzs6): when
// lib/entitlements.js already has a Dodo customer id on file for this
// email (stamped by dodo-webhook.js on a prior purchase — see
// dodo-webhook.test.js for that half), this function must attach the
// checkout session to that EXISTING customer (`customer: { customer_id }`)
// instead of the plain email-only shape, plus the fallback-to-email path
// if that attach attempt itself fails (a stale/deleted stored id). Uses
// the same mock-Blobs pattern as dodo-webhook.test.js /
// generate-video-gate.test.js, since entitlements.getDodoCustomerId now
// backs this lookup.

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
  return fakeEvent(Object.assign({ method: 'POST', body: { email: 'buyer@example.com', pack: 'pack100' } }, overrides));
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
// Returning-customer prefill (tracker item
// for-product-repeat-purchase-friction-dod-b6pzs6) — see this file's own
// header comment and the inline comment above the checkoutSessions.create
// call in create-checkout-session-dodo.js for the full research/reasoning.
// ============================================================================

test('every checkout session always sets minimal_address + show_saved_payment_methods, regardless of returning-customer status', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'freshbuyer@example.com', pack: 'pack100' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.minimal_address, true, 'minimal_address must always be set — reduces billing address collection to country/zip regardless of whether this is a returning customer');
  assert.equal(sentBody.show_saved_payment_methods, true, 'show_saved_payment_methods must always be set — harmless no-op for a brand-new customer with no saved methods yet');
});

test('a brand-new buyer with no stored Dodo customer id yet still sends the plain email-based customer shape — no change from before this fix', async function () {
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'brandnew@example.com', pack: 'pack100' } }));
  assert.equal(res.statusCode, 200);
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { email: 'brandnew@example.com' }, 'no stored customer id for this email -> customer must be the plain NewCustomer{email} shape, exactly as before');
});

test('a returning buyer WITH a stored Dodo customer id sends AttachExistingCustomer{customer_id} instead of the bare email', async function () {
  await entitlements.recordDodoCustomerId({}, 'returning@example.com', 'cus_returning_123');
  var captured = stubFetchCapture();
  var res = await handler(reqEvent({ body: { email: 'returning@example.com', pack: 'pack300' } }));
  assert.equal(res.statusCode, 200);

  assert.equal(captured.calls.length, 1, 'the stored customer id must be used on the FIRST attempt — no fallback retry needed when it works');
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { customer_id: 'cus_returning_123' }, 'must attach to the existing Dodo customer by id, not send a bare email that would look like a fresh customer');
  // Everything else about the request is unaffected by which customer shape is used.
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack300_test');
  assert.equal(sentBody.metadata.dreamtube_email, 'returning@example.com');
});

test('the stored Dodo customer id lookup is normalized-email-scoped, same as every other email lookup in this codebase', async function () {
  await entitlements.recordDodoCustomerId({}, 'MixedCase@Example.com', 'cus_mixedcase');
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: '  mixedcase@example.com  ', pack: 'pack100' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.deepEqual(sentBody.customer, { customer_id: 'cus_mixedcase' }, 'the stored id must be found regardless of case/whitespace differences between how it was recorded and how this request supplied the email');
});

test('a stale/rejected stored customer id falls back to a second attempt with the plain email shape, and still succeeds', async function () {
  await entitlements.recordDodoCustomerId({}, 'staleid@example.com', 'cus_stale_deleted');
  var calls = [];
  global.fetch = async function (url, init) {
    var body = JSON.parse(init.body);
    calls.push(body);
    if (body.customer && body.customer.customer_id) {
      // Simulate Dodo rejecting a reference to a customer id that no
      // longer exists on its side.
      return new Response(JSON.stringify({ message: 'customer not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ session_id: 'cks_fallback', checkout_url: 'https://checkout.dodopayments.com/cks_fallback' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  var res = await handler(reqEvent({ body: { email: 'staleid@example.com', pack: 'pack100' } }));
  assert.equal(res.statusCode, 200, 'a stale stored customer id must not block the purchase — it must fall back and still succeed');
  var body = JSON.parse(res.body);
  assert.equal(body.url, 'https://checkout.dodopayments.com/cks_fallback');

  assert.equal(calls.length, 2, 'exactly one failed attach-by-id attempt, then one successful fallback attempt');
  assert.deepEqual(calls[0].customer, { customer_id: 'cus_stale_deleted' });
  assert.deepEqual(calls[1].customer, { email: 'staleid@example.com' }, 'the fallback attempt must use the plain email shape');
  // The fallback retry still carries every other real field (product, metadata) — it isn't a stripped-down request.
  assert.equal(calls[1].product_cart[0].product_id, 'pdt_pack100_test');
  assert.equal(calls[1].metadata.dreamtube_pack, 'pack100');
});

test('a brand-new buyer (no stored customer id, so already on the plain-email path) gets NO retry on failure — a real Dodo rejection still surfaces as 502 E7 directly', async function () {
  var calls = [];
  global.fetch = async function (url, init) {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: 'invalid product' }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  var res = await handler(reqEvent({ body: { email: 'brandnewfails@example.com', pack: 'pack100' } }));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E7: dodo_request_failed/);
  assert.equal(calls.length, 1, 'no retry should be attempted for a request that was already on the plain-email path — there is no fallback left to try');
});
