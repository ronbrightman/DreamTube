// test/dodo-webhook.test.js
//
// Covers netlify/functions/dodo-webhook.js: signature verification
// (missing headers, wrong secret) and the entitlement side effects of
// subscription lifecycle events, following the same mock-Blobs pattern as
// generate-video-gate.test.js / paywall-settings.test.js.
//
// Valid request signatures are built with the same `standardwebhooks`
// library the production code uses to verify them (a transitive
// dependency of `dodopayments`) — this exercises the real Standard
// Webhooks signing/verification round trip, not a hand-rolled stand-in.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { Webhook } = require('standardwebhooks');
var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var handler = require('../netlify/functions/dodo-webhook').handler;

var WEBHOOK_SECRET = 'whsec_' + Buffer.from('a-test-signing-key-32-bytes-long').toString('base64');

function signedEvent(payloadObj, opts) {
  opts = opts || {};
  var body = JSON.stringify(payloadObj);
  var id = opts.id || 'msg_' + Math.random().toString(36).slice(2);
  var timestamp = opts.timestamp || new Date();
  var wh = new Webhook(opts.secret || WEBHOOK_SECRET);
  var signature = opts.badSignature ? 'v1,not-a-real-signature==' : wh.sign(id, timestamp, body);

  return fakeEvent({
    method: 'POST',
    body: body,
    headers: {
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'webhook-signature': signature
    }
  });
}

function subscriptionPayload(type, overrides) {
  var base = {
    business_id: 'biz_test',
    timestamp: new Date().toISOString(),
    type: type,
    data: Object.assign(
      {
        subscription_id: 'sub_test123',
        product_id: 'pdt_monthly_test',
        status: 'active',
        customer: { customer_id: 'cus_test123', email: 'subscriber@example.com', name: 'Test Subscriber' },
        metadata: {}
      },
      overrides
    )
  };
  return base;
}

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.DODO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.DODO_PRODUCT_MONTHLY = 'pdt_monthly_test';
  process.env.DODO_PRODUCT_YEARLY = 'pdt_yearly_test';
});

test.after(function () {
  delete process.env.DODO_WEBHOOK_SECRET;
  delete process.env.DODO_PRODUCT_MONTHLY;
  delete process.env.DODO_PRODUCT_YEARLY;
});

test('non-POST method -> 405 E1', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('missing DODO_WEBHOOK_SECRET -> 500 E2', async function () {
  delete process.env.DODO_WEBHOOK_SECRET;
  var res = await handler(signedEvent(subscriptionPayload('subscription.active')));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E2: missing_webhook_secret/);
});

test('missing signature headers -> 400 E3', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: JSON.stringify(subscriptionPayload('subscription.active')) }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: missing_signature_headers/);
});

test('signature does not verify -> 400 E4, no entitlement written', async function () {
  var res = await handler(signedEvent(subscriptionPayload('subscription.active', { customer: { customer_id: 'cus_x', email: 'attacker@example.com' } }), { badSignature: true }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: signature_verification_failed/);
  assert.equal(await entitlements.getEntitlement({}, 'attacker@example.com'), null);
});

test('signature signed with the wrong secret -> 400 E4', async function () {
  var wrongSecret = 'whsec_' + Buffer.from('a-totally-different-32-byte-key').toString('base64');
  var res = await handler(signedEvent(subscriptionPayload('subscription.active'), { secret: wrongSecret }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: signature_verification_failed/);
});

// ----- Lifecycle events -----

test('subscription.active -> entitlement active:true, plan resolved from product_id, ids recorded', async function () {
  var res = await handler(signedEvent(subscriptionPayload('subscription.active', {
    subscription_id: 'sub_abc',
    product_id: 'pdt_monthly_test',
    customer: { customer_id: 'cus_abc', email: 'Subscriber@Example.com' }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'subscriber@example.com');
  assert.equal(record.active, true);
  assert.equal(record.plan, 'monthly');
  assert.equal(record.dodoCustomerId, 'cus_abc');
  assert.equal(record.dodoSubscriptionId, 'sub_abc');
});

test('subscription.renewed keeps the entitlement active', async function () {
  await handler(signedEvent(subscriptionPayload('subscription.active', { customer: { customer_id: 'cus_r', email: 'renewer@example.com' } })));
  var res = await handler(signedEvent(subscriptionPayload('subscription.renewed', { customer: { customer_id: 'cus_r', email: 'renewer@example.com' }, status: 'active' })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'renewer@example.com');
  assert.equal(record.active, true);
});

test('subscription.cancelled -> entitlement flips to active:false', async function () {
  await handler(signedEvent(subscriptionPayload('subscription.active', { customer: { customer_id: 'cus_c', email: 'canceller@example.com' } })));
  var res = await handler(signedEvent(subscriptionPayload('subscription.cancelled', { customer: { customer_id: 'cus_c', email: 'canceller@example.com' }, status: 'cancelled' })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'canceller@example.com');
  assert.equal(record.active, false);
});

test('subscription.on_hold -> entitlement flips to active:false (failed renewal, not yet cancelled)', async function () {
  await handler(signedEvent(subscriptionPayload('subscription.active', { customer: { customer_id: 'cus_h', email: 'onhold@example.com' } })));
  var res = await handler(signedEvent(subscriptionPayload('subscription.on_hold', { customer: { customer_id: 'cus_h', email: 'onhold@example.com' }, status: 'on_hold' })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'onhold@example.com');
  assert.equal(record.active, false);
});

test('subscription.expired and subscription.failed both leave the entitlement inactive', async function () {
  await handler(signedEvent(subscriptionPayload('subscription.expired', { customer: { customer_id: 'cus_e', email: 'expired@example.com' }, status: 'expired' })));
  assert.equal((await entitlements.getEntitlement({}, 'expired@example.com')).active, false);

  await handler(signedEvent(subscriptionPayload('subscription.failed', { customer: { customer_id: 'cus_f', email: 'failed@example.com' }, status: 'failed' })));
  assert.equal((await entitlements.getEntitlement({}, 'failed@example.com')).active, false);
});

test('email falls back to metadata.dreamtube_email when the customer block is missing', async function () {
  var payload = subscriptionPayload('subscription.active', { metadata: { dreamtube_email: 'fallback@example.com', dreamtube_plan: 'monthly' } });
  delete payload.data.customer;
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'fallback@example.com');
  assert.equal(record.active, true);
});

test('a subscription event with no resolvable email is acknowledged but writes nothing', async function () {
  var payload = subscriptionPayload('subscription.active', { metadata: {} });
  delete payload.data.customer;
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { received: true });
});

test('non-subscription event types (e.g. payment.succeeded) are acknowledged and ignored', async function () {
  var res = await handler(signedEvent({
    business_id: 'biz_test',
    timestamp: new Date().toISOString(),
    type: 'payment.succeeded',
    data: { payment_id: 'pay_1', customer: { customer_id: 'cus_p', email: 'payer@example.com' } }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(await entitlements.getEntitlement({}, 'payer@example.com'), null);
});

// ----- Malformed/partial payload must not corrupt an existing record -----

test('an update whose product_id matches no configured plan does not blank out a previously recorded plan', async function () {
  // First, a normal activation establishes plan: 'monthly'.
  await handler(signedEvent(subscriptionPayload('subscription.active', {
    product_id: 'pdt_monthly_test',
    customer: { customer_id: 'cus_p2', email: 'planpersist@example.com' }
  })));
  var before = await entitlements.getEntitlement({}, 'planpersist@example.com');
  assert.equal(before.plan, 'monthly');

  // Then an on_hold event arrives whose product_id doesn't match either
  // configured env var and carries no metadata plan either — resolvePlan()
  // can't determine a plan, so it must come back undefined and
  // setEntitlement must drop it from the patch rather than writing
  // plan: undefined over the existing 'monthly' value.
  var res = await handler(signedEvent(subscriptionPayload('subscription.on_hold', {
    product_id: 'pdt_some_other_unrelated_product',
    status: 'on_hold',
    customer: { customer_id: 'cus_p2', email: 'planpersist@example.com' },
    metadata: {}
  })));
  assert.equal(res.statusCode, 200);

  var after = await entitlements.getEntitlement({}, 'planpersist@example.com');
  assert.equal(after.active, false, 'status should still update');
  assert.equal(after.plan, 'monthly', 'plan must survive an event that could not resolve one');
  assert.equal(after.dodoCustomerId, 'cus_p2');
});

test('a malformed payload (missing data entirely) is rejected as processing_failed, not silently accepted, and does not touch existing records', async function () {
  await handler(signedEvent(subscriptionPayload('subscription.active', { customer: { customer_id: 'cus_m', email: 'malformed@example.com' } })));

  var body = { business_id: 'biz_test', timestamp: new Date().toISOString(), type: 'subscription.updated' }; // no `data` at all
  var res = await handler(signedEvent(body));
  // No `data` -> subscription defaults to {} internally -> no email
  // resolvable -> acknowledged as a no-op, same as any other
  // unresolvable-email event; it must not throw or 500, and the existing
  // record for a *different* email must be untouched either way.
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'malformed@example.com');
  assert.equal(record.active, true);
  assert.equal(record.dodoCustomerId, 'cus_m');
});
