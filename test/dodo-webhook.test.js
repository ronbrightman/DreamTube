// test/dodo-webhook.test.js
//
// Covers netlify/functions/dodo-webhook.js: signature verification
// (missing headers, wrong secret) and the token-crediting side effects of
// a confirmed `payment.succeeded` event, following the same mock-Blobs
// pattern as generate-video-gate.test.js / paywall-settings.test.js.
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

/**
 * Seeds an email with an existing, zero-balance token record before a
 * webhook fires — isolates a test's balance assertion to just the credit
 * this test is checking, instead of also having to account for
 * lib/entitlements.js's own separate 220-token first-ever-read signup
 * grant (which addTokens' underlying syncTokens would otherwise apply
 * automatically to a genuinely brand-new email, since it has never been
 * read before). That signup grant is real, correct, unrelated production
 * behavior — it's covered by its own tests in entitlements-tokens.test.js
 * — this helper just keeps it out of these webhook-specific assertions.
 *
 * ALSO stamps `firstPackPurchaseAt` (in the past) so this account is
 * treated as already having completed a pack purchase before — this keeps
 * the tests in THIS file focused purely on crediting/dedup mechanics
 * without being confounded by the separate +50% first-purchase bonus (see
 * lib/entitlements.js's creditTokenPackAmountOnce), which has its own
 * dedicated tests further down. Same "isolate the thing this test is
 * actually checking" reasoning as the signup-grant isolation above.
 */
async function seedZeroBalance(email) {
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 0, lastGrantAt: Date.now() },
    firstPackPurchaseAt: Date.now() - 999999999
  });
}

/** Seeds a genuinely brand-new-to-purchasing account (zero balance, no prior pack purchase) — used by the first-purchase-bonus tests below, where seedZeroBalance's own firstPackPurchaseAt seed would defeat the very thing being tested. */
async function seedZeroBalanceNoPriorPurchase(email) {
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0, lastGrantAt: Date.now() } });
}

function paymentPayload(overrides) {
  return {
    business_id: 'biz_test',
    timestamp: new Date().toISOString(),
    type: 'payment.succeeded',
    data: Object.assign(
      {
        payment_id: 'pay_test123',
        product_cart: [{ product_id: 'pdt_pack100_test', quantity: 1 }],
        customer: { customer_id: 'cus_test123', email: 'buyer@example.com', name: 'Test Buyer' },
        metadata: {},
        total_amount: 199,
        currency: 'USD'
      },
      overrides
    )
  };
}

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.DODO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.DODO_PRODUCT_PACK_100 = 'pdt_pack100_test';
  process.env.DODO_PRODUCT_PACK_300 = 'pdt_pack300_test';
  process.env.DODO_PRODUCT_PACK_700 = 'pdt_pack700_test';
});

test.after(function () {
  delete process.env.DODO_WEBHOOK_SECRET;
  delete process.env.DODO_PRODUCT_PACK_100;
  delete process.env.DODO_PRODUCT_PACK_300;
  delete process.env.DODO_PRODUCT_PACK_700;
});

test('non-POST method -> 405 E1', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('missing DODO_WEBHOOK_SECRET -> 500 E2', async function () {
  delete process.env.DODO_WEBHOOK_SECRET;
  var res = await handler(signedEvent(paymentPayload()));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E2: missing_webhook_secret/);
});

test('missing signature headers -> 400 E3', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: JSON.stringify(paymentPayload()) }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: missing_signature_headers/);
});

test('signature does not verify -> 400 E4, no tokens credited', async function () {
  var res = await handler(signedEvent(paymentPayload({ customer: { customer_id: 'cus_x', email: 'attacker@example.com' } }), { badSignature: true }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: signature_verification_failed/);
  assert.equal(await entitlements.getEntitlement({}, 'attacker@example.com'), null);
});

test('signature signed with the wrong secret -> 400 E4', async function () {
  var wrongSecret = 'whsec_' + Buffer.from('a-totally-different-32-byte-key').toString('base64');
  var res = await handler(signedEvent(paymentPayload(), { secret: wrongSecret }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: signature_verification_failed/);
});

// ----- payment.succeeded -> token credit -----

test('payment.succeeded for pack100 credits 100 tokens onto the buyer\'s balance', async function () {
  await seedZeroBalance('buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_abc',
    product_cart: [{ product_id: 'pdt_pack100_test', quantity: 1 }],
    customer: { customer_id: 'cus_abc', email: 'Buyer@Example.com' }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'buyer@example.com');
  assert.equal(record.tokens.balance, 100);
  // A token-pack purchase is a pure balance credit — it must not touch the
  // subscription-era active/plan fields at all (they don't apply here).
  assert.equal(record.active, undefined);
  assert.equal(record.plan, undefined);
});

test('payment.succeeded for pack300 credits 300 tokens', async function () {
  await seedZeroBalance('300buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_300',
    product_cart: [{ product_id: 'pdt_pack300_test', quantity: 1 }],
    customer: { customer_id: 'cus_300', email: '300buyer@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, '300buyer@example.com');
  assert.equal(record.tokens.balance, 300);
});

test('payment.succeeded for pack700 credits 700 tokens', async function () {
  await seedZeroBalance('700buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_700',
    product_cart: [{ product_id: 'pdt_pack700_test', quantity: 1 }],
    customer: { customer_id: 'cus_700', email: '700buyer@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, '700buyer@example.com');
  assert.equal(record.tokens.balance, 700);
});

test('tokens stack onto an existing balance rather than replacing it', async function () {
  await seedZeroBalance('stacker@example.com');
  await entitlements.addTokens({}, 'stacker@example.com', 50);
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_stack',
    product_cart: [{ product_id: 'pdt_pack100_test', quantity: 1 }],
    customer: { customer_id: 'cus_stack', email: 'stacker@example.com' }
  })));
  var record = await entitlements.getEntitlement({}, 'stacker@example.com');
  assert.equal(record.tokens.balance, 150);
});

test('a redelivered payment.succeeded event (same payment_id) does not double-credit', async function () {
  await seedZeroBalance('redelivered@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_redelivered',
    product_cart: [{ product_id: 'pdt_pack100_test', quantity: 1 }],
    customer: { customer_id: 'cus_r', email: 'redelivered@example.com' }
  });

  var res1 = await handler(signedEvent(payload, { id: 'msg_first' }));
  assert.equal(res1.statusCode, 200);
  var afterFirst = await entitlements.getEntitlement({}, 'redelivered@example.com');
  assert.equal(afterFirst.tokens.balance, 100);

  // Dodo redelivers the identical event (same payment_id) under a
  // different webhook message id/timestamp — the payload's payment_id is
  // what must dedupe this, not the webhook delivery's own id.
  var res2 = await handler(signedEvent(payload, { id: 'msg_second' }));
  assert.equal(res2.statusCode, 200);
  var afterSecond = await entitlements.getEntitlement({}, 'redelivered@example.com');
  assert.equal(afterSecond.tokens.balance, 100, 'balance must not double-credit on a redelivered event');
});

test('email falls back to metadata.dreamtube_email when the customer block is missing', async function () {
  await seedZeroBalance('fallback@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_fallback',
    metadata: { dreamtube_email: 'fallback@example.com', dreamtube_pack: 'pack100', dreamtube_tokens: 100 }
  });
  delete payload.data.customer;
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'fallback@example.com');
  assert.equal(record.tokens.balance, 100);
});

test('token amount falls back to metadata.dreamtube_tokens when product_cart matches no configured pack', async function () {
  await seedZeroBalance('metafallback@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_meta_fallback',
    product_cart: [{ product_id: 'pdt_some_rotated_product', quantity: 1 }],
    customer: { customer_id: 'cus_mf', email: 'metafallback@example.com' },
    metadata: { dreamtube_tokens: 500 }
  });
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'metafallback@example.com');
  assert.equal(record.tokens.balance, 500);
});

test('a payment with no resolvable email is acknowledged but credits nothing', async function () {
  var payload = paymentPayload({ payment_id: 'pay_noemail', metadata: {} });
  delete payload.data.customer;
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { received: true });
});

test('a payment with no resolvable token amount is acknowledged but credits nothing', async function () {
  var payload = paymentPayload({
    payment_id: 'pay_notokens',
    product_cart: [{ product_id: 'pdt_unknown', quantity: 1 }],
    customer: { customer_id: 'cus_nt', email: 'notokens@example.com' },
    metadata: {}
  });
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200);
  assert.equal(await entitlements.getEntitlement({}, 'notokens@example.com'), null);
});

test('creditTokenPackOnce genuinely exhausting its retries (not a legitimate already-processed SKIP) surfaces as a real 500 E5 through the actual webhook handler, so Dodo redelivers', async function () {
  // The exhaustion-throws fix in lib/entitlements.js (creditTokenPackOnce /
  // creditTokenPackAmountOnce) was previously only exercised by calling
  // those functions directly (test/entitlements-token-purchases.test.js),
  // skipping the webhook layer entirely — this proves the thrown error
  // actually propagates all the way out through dodo-webhook.js's real
  // handler() and its existing try/catch, not just out of the library
  // function in isolation.
  await seedZeroBalance('exhaustionwebhook@example.com');

  // Same technique as the entitlements-level exhaustion tests: setJSON
  // still actually writes, but get() always reports "nothing here" for
  // the token-purchases store, so the write-then-verify race inside
  // creditTokenPackOnce's marker write can never confirm a winner within
  // its bounded attempts.
  mockBlobs.setReadOverride(entitlements.TOKEN_PURCHASES_STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    var res = await handler(signedEvent(paymentPayload({
      payment_id: 'pay_exhaustion_webhook',
      product_cart: [{ product_id: 'pdt_pack100_test', quantity: 1 }],
      customer: { customer_id: 'cus_exhaustion', email: 'exhaustionwebhook@example.com' }
    })));
    assert.equal(res.statusCode, 500, 'genuine exhaustion must surface as a real 500, not a 200 that leaves Dodo believing the event was handled');
    assert.match(JSON.parse(res.body).error, /^E5: processing_failed/);
  } finally {
    mockBlobs.clearReadOverride(entitlements.TOKEN_PURCHASES_STORE_NAME);
  }

  // No credit landed, and nothing durable was left claiming otherwise —
  // consistent with dodo-webhook.js's own E5 doc comment: "our own write
  // is what failed, not the event itself being invalid", so Dodo
  // redelivering is expected to (eventually) succeed once the transient
  // condition clears.
  var record = await entitlements.getEntitlement({}, 'exhaustionwebhook@example.com');
  assert.equal(record.tokens.balance, 0, 'no credit should have landed given the marker write never confirmed a winner');
});

test('non-payment.succeeded event types (payment.failed, subscription.*, refund.*) are acknowledged and ignored', async function () {
  var res1 = await handler(signedEvent({
    business_id: 'biz_test',
    timestamp: new Date().toISOString(),
    type: 'payment.failed',
    data: { payment_id: 'pay_f1', customer: { customer_id: 'cus_f1', email: 'failedpay@example.com' } }
  }));
  assert.equal(res1.statusCode, 200);
  assert.equal(await entitlements.getEntitlement({}, 'failedpay@example.com'), null);

  var res2 = await handler(signedEvent({
    business_id: 'biz_test',
    timestamp: new Date().toISOString(),
    type: 'refund.succeeded',
    data: { payment_id: 'pay_f1', customer: { customer_id: 'cus_f1', email: 'failedpay@example.com' } }
  }));
  assert.equal(res2.statusCode, 200);
  assert.equal(await entitlements.getEntitlement({}, 'failedpay@example.com'), null);
});

// ----- First-purchase bonus (+50%, Token Economy C) -----
//
// A user's FIRST-EVER successful pack purchase credits 1.5x the pack's
// base tokens; every purchase after that credits the plain base amount.
// Uses seedZeroBalanceNoPriorPurchase (no firstPackPurchaseAt stamped) so
// these accounts are genuinely eligible for the bonus, unlike every test
// above (which deliberately seeds firstPackPurchaseAt in the past via
// seedZeroBalance, to isolate THEIR assertions from this bonus).

test('a brand-new account\'s first pack100 purchase ever credits 150 tokens (100 base x 1.5), not 100', async function () {
  await seedZeroBalanceNoPriorPurchase('firstbonus@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_first_bonus',
    product_cart: [{ product_id: 'pdt_pack100_test', quantity: 1 }],
    customer: { customer_id: 'cus_first_bonus', email: 'firstbonus@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'firstbonus@example.com');
  assert.equal(record.tokens.balance, 150, 'first-ever pack purchase must credit 1.5x the base 100 tokens');
  assert.ok(record.firstPackPurchaseAt, 'firstPackPurchaseAt must be stamped after the first purchase completes');
});

test('a SECOND purchase from the same account does not get the bonus again — plain base tokens only', async function () {
  await seedZeroBalanceNoPriorPurchase('secondpurchase@example.com');
  var first = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_second_purchase_first',
    product_cart: [{ product_id: 'pdt_pack100_test', quantity: 1 }],
    customer: { customer_id: 'cus_second_a', email: 'secondpurchase@example.com' }
  })));
  assert.equal(first.statusCode, 200);
  var afterFirst = await entitlements.getEntitlement({}, 'secondpurchase@example.com');
  assert.equal(afterFirst.tokens.balance, 150, 'first purchase still gets the bonus: 100 x 1.5');

  var second = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_second_purchase_second',
    product_cart: [{ product_id: 'pdt_pack300_test', quantity: 1 }],
    customer: { customer_id: 'cus_second_b', email: 'secondpurchase@example.com' }
  })));
  assert.equal(second.statusCode, 200);
  var afterSecond = await entitlements.getEntitlement({}, 'secondpurchase@example.com');
  assert.equal(afterSecond.tokens.balance, 450, '150 (after first, bonused) + 300 (second purchase, base only, no bonus) = 450');
});

test('a redelivered FIRST-purchase event (same payment_id) does not re-apply the bonus a second time', async function () {
  await seedZeroBalanceNoPriorPurchase('redeliveredbonus@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_redelivered_bonus',
    product_cart: [{ product_id: 'pdt_pack100_test', quantity: 1 }],
    customer: { customer_id: 'cus_redelivered_bonus', email: 'redeliveredbonus@example.com' }
  });

  await handler(signedEvent(payload, { id: 'msg_bonus_first' }));
  var afterFirst = await entitlements.getEntitlement({}, 'redeliveredbonus@example.com');
  assert.equal(afterFirst.tokens.balance, 150);

  await handler(signedEvent(payload, { id: 'msg_bonus_second' }));
  var afterSecond = await entitlements.getEntitlement({}, 'redeliveredbonus@example.com');
  assert.equal(afterSecond.tokens.balance, 150, 'a redelivered event for the SAME payment_id must not double-apply the bonus or the credit');
});

test('pack700\'s first purchase credits 1050 tokens (700 base x 1.5)', async function () {
  await seedZeroBalanceNoPriorPurchase('firstbonus700@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_first_bonus_700',
    product_cart: [{ product_id: 'pdt_pack700_test', quantity: 1 }],
    customer: { customer_id: 'cus_first_bonus_700', email: 'firstbonus700@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'firstbonus700@example.com');
  assert.equal(record.tokens.balance, 1050, '700 base x 1.5 = 1050');
});
