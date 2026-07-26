// test/create-checkout-session-dodo.test.js
//
// Covers netlify/functions/create-checkout-session-dodo.js: creating a
// one-time-purchase Dodo Checkout Session for a token pack. Exercises
// every error path (E1-E7) plus the success path, stubbing global.fetch
// the same way generate-video-gate.test.js stubs fal.ai's call — the
// `dodopayments` SDK makes its HTTP request via the global `fetch`, so
// intercepting it there avoids needing real Dodo credentials or network
// access.

var test = require('node:test');
var assert = require('node:assert/strict');

var { fakeEvent } = require('./helpers/fake-event');
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
  process.env.DODO_API_KEY = 'test-dodo-key';
  process.env.DODO_PRODUCT_PACK_100 = 'pdt_pack100_test';
  process.env.DODO_PRODUCT_PACK_500 = 'pdt_pack500_test';
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.DODO_API_KEY;
  delete process.env.DODO_PRODUCT_PACK_100;
  delete process.env.DODO_PRODUCT_PACK_500;
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
  delete process.env.DODO_PRODUCT_PACK_500;
  var res = await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack500' } }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E6: missing_product_id: DODO_PRODUCT_PACK_500/);
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
  assert.equal(sentBody.metadata.dreamtube_price, 1.99);
  assert.ok(body.eventId, 'the response must carry an eventId for shop.html to thread into its pending-purchase marker');
  assert.equal(sentBody.metadata.dreamtube_event_id, body.eventId, 'the SAME event_id must be both returned to the client and embedded in Dodo metadata, or dodo-webhook.js\'s own Purchase fire cannot dedupe against the client-side one');
});

test('pack500 maps to DODO_PRODUCT_PACK_500 and carries 500 tokens in metadata', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack500' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.product_cart[0].product_id, 'pdt_pack500_test');
  assert.equal(sentBody.metadata.dreamtube_tokens, 500);
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

test('caller-supplied successUrl/cancelUrl override the defaults', async function () {
  var captured = stubFetchCapture();
  await handler(reqEvent({ body: { email: 'buyer@example.com', pack: 'pack100', successUrl: 'https://example.com/ok', cancelUrl: 'https://example.com/no' } }));
  var sentBody = JSON.parse(captured.calls[0].init.body);
  assert.equal(sentBody.return_url, 'https://example.com/ok');
  assert.equal(sentBody.cancel_url, 'https://example.com/no');
});

test('Dodo API rejects the request -> 502 E7', async function () {
  stubFetchError();
  var res = await handler(reqEvent());
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /^E7: dodo_request_failed/);
});
