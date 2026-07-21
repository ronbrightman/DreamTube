// test/stripe-webhook.test.js
//
// Covers netlify/functions/stripe-webhook.js: signature verification, the
// entitlement write on checkout.session.completed /
// customer.subscription.updated / customer.subscription.deleted (via
// lib/entitlements.js, mocked the same way test/generate-video-gate.test.js
// mocks @netlify/blobs), and — the piece with no prior coverage at all —
// the Meta CAPI Purchase/Subscribe wiring inside the
// checkout.session.completed handler (see that file's own "genuinely
// wired, currently dormant" comment block).
//
// Real signatures: rather than mocking the `stripe` module, this uses
// Stripe's own stripe.webhooks.generateTestHeaderString() test helper to
// produce a real, valid `stripe-signature` header for a known webhook
// secret — the same HMAC verification stripe-webhook.js's
// stripe.webhooks.constructEvent() performs runs for real here, no
// shortcuts. (`new Stripe(secretKey)` itself makes no network call —
// constructEvent is pure local HMAC verification — so a fake
// STRIPE_SECRET_KEY is fine for every test in this file.)
//
// Meta CAPI is covered via a fetch-spy (global.fetch), the same
// convention test/meta-capi.test.js already uses for asserting exactly
// what sendCapiEvent() sends to graph.facebook.com — that's the only way
// to assert what sendCapiEvent() was called with from outside
// lib/meta-capi.js, since it has no exported spy hook of its own.
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var Stripe = require('stripe');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var FAKE_STRIPE_SECRET_KEY = 'sk_test_fake_for_local_construction_only';
var WEBHOOK_SECRET = 'whsec_test_secret_123';
var REAL_CAPI_TOKEN = 'EAAtest-stripe-webhook-capi-token';

var realFetch = global.fetch;
var stripeForSigning = new Stripe(FAKE_STRIPE_SECRET_KEY);

function withEnv(vars, fn) {
  var previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; });
  Object.keys(vars).forEach(function (k) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  });
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      Object.keys(previous).forEach(function (k) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      });
    });
}

/** Spies on global.fetch so tests can assert exactly what sendCapiEvent() sent to Meta, without a real network call. */
function installFetchSpy() {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async function () { return { events_received: 1 }; } };
  };
  return calls;
}

/** Builds a fakeEvent carrying a real, valid stripe-signature header for the given event payload — signed with WEBHOOK_SECRET, matched by STRIPE_WEBHOOK_SECRET in every test below. */
function stripeWebhookEvent(type, dataObject, opts) {
  opts = opts || {};
  var payload = JSON.stringify({
    id: 'evt_test_' + crypto.randomUUID(),
    type: type,
    data: { object: dataObject }
  });
  var header = opts.signature !== undefined
    ? opts.signature
    : stripeForSigning.webhooks.generateTestHeaderString({ payload: payload, secret: opts.secret || WEBHOOK_SECRET });
  var headers = Object.assign({}, opts.headers || {});
  if (header !== null) headers['stripe-signature'] = header;
  return fakeEvent({ method: 'POST', headers: headers, body: payload });
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  process.env.STRIPE_SECRET_KEY = FAKE_STRIPE_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.META_CAPI_ACCESS_TOKEN;
});
test.after(function () {
  global.fetch = realFetch;
});

// ----- Request-shape / signature guards -----

test('stripe-webhook.js: wrong HTTP method rejected E1', async function () {
  var handler = require('../netlify/functions/stripe-webhook').handler;
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('stripe-webhook.js: missing STRIPE_WEBHOOK_SECRET fails E2 before touching the body', function () {
  return withEnv({ STRIPE_WEBHOOK_SECRET: undefined }, async function () {
    var handler = require('../netlify/functions/stripe-webhook').handler;
    var res = await handler(stripeWebhookEvent('checkout.session.completed', {}));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_webhook_secret/);
  });
});

test('stripe-webhook.js: missing stripe-signature header rejected E3', async function () {
  var handler = require('../netlify/functions/stripe-webhook').handler;
  var res = await handler(stripeWebhookEvent('checkout.session.completed', {}, { signature: null }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: missing_signature_header/);
});

test('stripe-webhook.js: a signature that does not verify (wrong secret) is rejected E4', async function () {
  var handler = require('../netlify/functions/stripe-webhook').handler;
  var res = await handler(stripeWebhookEvent('checkout.session.completed', {}, { secret: 'whsec_totally_different' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: signature_verification_failed/);
});

test('stripe-webhook.js: an unhandled event type is acknowledged 200 with no entitlement write and no Meta call', async function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_CAPI_TOKEN }, async function () {
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/stripe-webhook').handler;
    var res = await handler(stripeWebhookEvent('payment_intent.succeeded', { id: 'pi_1' }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { received: true });
    assert.equal(calls.length, 0);
  });
});

// ----- checkout.session.completed: entitlement write -----

test('stripe-webhook.js: checkout.session.completed activates the entitlement for the session email', async function () {
  var entitlements = require('../netlify/functions/lib/entitlements');
  var handler = require('../netlify/functions/stripe-webhook').handler;
  var email = 'buyer@example.com';
  var res = await handler(stripeWebhookEvent('checkout.session.completed', {
    customer_details: { email: email },
    customer: 'cus_123',
    subscription: 'sub_123',
    metadata: { dreamtube_plan: 'monthly' }
  }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.active, true);
  assert.equal(record.plan, 'monthly');
  assert.equal(record.stripeCustomerId, 'cus_123');
  assert.equal(record.stripeSubscriptionId, 'sub_123');
});

test('stripe-webhook.js: checkout.session.completed with no resolvable email writes nothing and fires no Meta call', async function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_CAPI_TOKEN }, async function () {
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/stripe-webhook').handler;
    var res = await handler(stripeWebhookEvent('checkout.session.completed', { customer: 'cus_noemail' }));
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 0);
  });
});

// ----- checkout.session.completed: Meta CAPI Purchase/Subscribe wiring -----
// This is the previously-uncovered piece: stripe-webhook.js's own header
// comment calls this "genuinely wired, currently dormant" — no test
// existed confirming the wiring is actually correct.

test('stripe-webhook.js: checkout.session.completed fires exactly one Purchase and one Subscribe CAPI event, with the session email and value/currency/plan', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_CAPI_TOKEN }, async function () {
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/stripe-webhook').handler;
    var email = 'checkout-buyer@example.com';
    var res = await handler(stripeWebhookEvent('checkout.session.completed', {
      customer_details: { email: email },
      customer: 'cus_456',
      subscription: 'sub_456',
      amount_total: 1999,
      currency: 'usd',
      success_url: 'https://dreamtube.example/start.html?checkout=success',
      metadata: { dreamtube_plan: 'yearly' }
    }));
    assert.equal(res.statusCode, 200);

    // Every fetch call in this test is a CAPI call (graph.facebook.com) —
    // no other outbound fetch happens on this path.
    assert.equal(calls.length, 2, 'expected exactly one Purchase call and one Subscribe call');

    var eventNames = calls.map(function (c) { return c.body.data[0].event_name; });
    assert.deepEqual(eventNames.sort(), ['Purchase', 'Subscribe']);

    var expectedHashedEmail = crypto.createHash('sha256').update(email, 'utf8').digest('hex');
    calls.forEach(function (c) {
      var evt = c.body.data[0];
      assert.equal(evt.action_source, 'website');
      assert.equal(evt.user_data.em, expectedHashedEmail, evt.event_name + ' should carry the hashed session email');
      assert.equal(evt.event_source_url, 'https://dreamtube.example/start.html?checkout=success');
      assert.deepEqual(evt.custom_data, { value: 19.99, currency: 'USD', plan: 'yearly' });
      // Raw email must never appear in the outbound body — only its hash.
      assert.equal(JSON.stringify(c.body).indexOf(email), -1);
      // event_id present and the two events don't share one — nothing to
      // dedupe these two against (see that file's own comment), so each
      // must be independently generated.
      assert.ok(evt.event_id, 'event_id must be present');
    });
    assert.notEqual(calls[0].body.data[0].event_id, calls[1].body.data[0].event_id);
  });
});

test('stripe-webhook.js: Purchase/Subscribe custom_data omits value/currency when the session has none', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_CAPI_TOKEN }, async function () {
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/stripe-webhook').handler;
    var res = await handler(stripeWebhookEvent('checkout.session.completed', {
      customer_email: 'no-amount@example.com'
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 2);
    calls.forEach(function (c) {
      var customData = c.body.data[0].custom_data;
      assert.equal('value' in customData, false);
      assert.equal('currency' in customData, false);
      assert.equal('plan' in customData, false);
    });
  });
});

test('stripe-webhook.js: a Meta-side CAPI failure on Purchase/Subscribe is swallowed — the webhook still returns 200 (entitlement already succeeded)', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_CAPI_TOKEN }, async function () {
    global.fetch = async function () {
      return { ok: false, status: 400, json: async function () { return { error: { message: 'Invalid parameter' } }; } };
    };
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/stripe-webhook').handler;
    var email = 'capi-fails@example.com';
    var res = await handler(stripeWebhookEvent('checkout.session.completed', {
      customer_details: { email: email }
    }));
    assert.equal(res.statusCode, 200, 'a Meta-side failure must not turn into a 500 that makes Stripe retry');
    var record = await entitlements.getEntitlement({}, email);
    assert.equal(record.active, true, 'entitlement write must have already succeeded regardless of the CAPI outcome');
  });
});

test('stripe-webhook.js: no META_CAPI_ACCESS_TOKEN configured — Purchase/Subscribe fail silently (no fetch call), webhook still returns 200', async function () {
  var calls = installFetchSpy();
  var handler = require('../netlify/functions/stripe-webhook').handler;
  var res = await handler(stripeWebhookEvent('checkout.session.completed', {
    customer_details: { email: 'no-token@example.com' }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0, 'sendCapiEvent should short-circuit before any fetch when the access token is unset');
});

// ----- customer.subscription.updated / .deleted: no Meta call, entitlement only -----

test('stripe-webhook.js: customer.subscription.deleted deactivates the entitlement and fires no Meta call', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_CAPI_TOKEN }, async function () {
    var entitlements = require('../netlify/functions/lib/entitlements');
    await entitlements.setEntitlement({}, 'canceling@example.com', { active: true, plan: 'monthly' });
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/stripe-webhook').handler;
    var res = await handler(stripeWebhookEvent('customer.subscription.deleted', {
      id: 'sub_cancel',
      status: 'canceled',
      metadata: { dreamtube_email: 'canceling@example.com' }
    }));
    assert.equal(res.statusCode, 200);
    var record = await entitlements.getEntitlement({}, 'canceling@example.com');
    assert.equal(record.active, false);
    assert.equal(calls.length, 0, 'subscription lifecycle events never fire Purchase/Subscribe — only checkout.session.completed does');
  });
});
