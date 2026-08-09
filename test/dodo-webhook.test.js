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
// See test/helpers/fetch-double.js -- marks this file's own fetch double so
// lib/posthog-capture.js's test-process guard lets its analytics fires reach it.
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');
var entitlements = require('../netlify/functions/lib/entitlements');
var accountStore = require('../netlify/functions/lib/account-store');
var analyticsConfig = require('../js/analytics-config');
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
 * lib/entitlements.js's own separate 320-token first-ever-read signup
 * grant (which addTokens' underlying syncTokens would otherwise apply
 * automatically to a genuinely brand-new email, since it has never been
 * read before). That signup grant is real, correct, unrelated production
 * behavior — it's covered by its own tests in entitlements-tokens.test.js
 * — this helper just keeps it out of these webhook-specific assertions.
 *
 * Also stamps `firstPackPurchaseAt` (in the past), matching what a real
 * account with a prior purchase would already have on its record. This no
 * longer changes the CREDITED AMOUNT (the +50% first-purchase bonus that
 * used to key off this field is retired entirely — see
 * lib/entitlements.js's creditTokenPackAmountOnce doc comment; every
 * credit in this file is now the plain base token count regardless of
 * this field), but is kept as a realistic default record shape.
 */
async function seedZeroBalance(email) {
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 0, lastClaimAt: Date.now() },
    firstPackPurchaseAt: Date.now() - 999999999
  });
}

/** Seeds a genuinely brand-new-to-purchasing account (zero balance, no prior pack purchase, no firstPackPurchaseAt) — used by the "no bonus" / starter-flag tests below, which specifically care about a brand-new account's FIRST credit stamping this field for the first time. */
async function seedZeroBalanceNoPriorPurchase(email) {
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0, lastClaimAt: Date.now() } });
}

function paymentPayload(overrides) {
  return {
    business_id: 'biz_test',
    timestamp: new Date().toISOString(),
    type: 'payment.succeeded',
    data: Object.assign(
      {
        payment_id: 'pay_test123',
        product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
        customer: { customer_id: 'cus_test123', email: 'buyer@example.com', name: 'Test Buyer' },
        metadata: {},
        total_amount: 199,
        currency: 'USD'
      },
      overrides
    )
  };
}

// ===== Server-side Purchase conversion (Phase 1 reporting instrumentation,
// tracker item for-product-phase-1-reporting-instrument-kjlh46) =====
//
// dodo-webhook.js now fires analytics (PostHog + Meta CAPI, both real
// outbound fetch() calls) after EVERY successfully-credited payment.succeeded
// — including every pre-existing test above that doesn't care about
// analytics at all. POSTHOG_KEY is a real, hardcoded value (see
// js/analytics-config.js), so without a default global.fetch stub in place
// for the whole file, those pre-existing tests would each fire a real
// network call to PostHog's live endpoint the moment they credit tokens.
// installAnalyticsFetchSpy() below is that default stub (safe no-op
// success for both vendors); individual analytics-focused tests further
// down call it themselves to get back the recorded calls to assert on, or
// pass opts to simulate a vendor failure.
var realFetch = global.fetch;
var REAL_META_TOKEN = 'EAAtest-super-secret-capi-token-purchase';

function installAnalyticsFetchSpy(opts) {
  opts = opts || {};
  var posthogCalls = [];
  var metaCalls = [];
  global.fetch = async function (url, init) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') !== -1) {
      posthogCalls.push({ url: urlStr, body: init && init.body ? JSON.parse(init.body) : null });
      if (opts.posthogFails) return { ok: false, status: 500, json: async function () { return {}; }, text: async function () { return 'posthog down'; } };
      return { ok: true, status: 200, json: async function () { return {}; }, text: async function () { return 'ok'; } };
    }
    if (urlStr.indexOf('graph.facebook.com') !== -1) {
      metaCalls.push({ url: urlStr, body: init && init.body ? JSON.parse(init.body) : null });
      if (opts.metaFails) return { ok: false, status: 500, json: async function () { return { error: { message: 'meta down' } }; } };
      return { ok: true, status: 200, json: async function () { return { events_received: 1 }; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
  return { posthogCalls: posthogCalls, metaCalls: metaCalls };
}

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.DODO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.DODO_PRODUCT_PACK_STARTER300 = 'pdt_pack099_test';
  process.env.DODO_PRODUCT_PACK_SMALL500 = 'pdt_pack199_test';
  process.env.DODO_PRODUCT_PACK_MEDIUM1500 = 'pdt_pack499_test';
  process.env.DODO_PRODUCT_PACK_LARGE4000 = 'pdt_pack999_test';
  process.env.META_CAPI_ACCESS_TOKEN = REAL_META_TOKEN;
  // Default safe stub -- see the comment block above. Tests that care about
  // the actual analytics calls override this by calling
  // installAnalyticsFetchSpy() themselves.
  installAnalyticsFetchSpy();
});

test.after(function () {
  delete process.env.DODO_WEBHOOK_SECRET;
  delete process.env.DODO_PRODUCT_PACK_STARTER300;
  delete process.env.DODO_PRODUCT_PACK_SMALL500;
  delete process.env.DODO_PRODUCT_PACK_MEDIUM1500;
  delete process.env.DODO_PRODUCT_PACK_LARGE4000;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  global.fetch = realFetch;
});

test('payment.succeeded fires a server-side Purchase to BOTH PostHog and Meta CAPI, sharing the event_id from metadata.dreamtube_event_id, with value/currency/timestamp', async function () {
  await seedZeroBalance('purchaseanalytics@example.com');
  await accountStore.createAccount({}, { username: 'purchaseanalyticsuser', password: 'testpass1', email: 'purchaseanalytics@example.com' });
  var spies = installAnalyticsFetchSpy();

  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_analytics_1',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_analytics', email: 'purchaseanalytics@example.com' },
    metadata: { dreamtube_event_id: 'shared-evt-abc123' }
  })));
  assert.equal(res.statusCode, 200);

  // Credit still landed independent of any of this.
  var record = await entitlements.getEntitlement({}, 'purchaseanalytics@example.com');
  assert.equal(record.tokens.balance, 300);

  assert.equal(spies.posthogCalls.length, 1, 'expected exactly one PostHog capture call');
  var phBody = spies.posthogCalls[0].body;
  assert.equal(phBody.api_key, analyticsConfig.POSTHOG_KEY);
  assert.equal(phBody.event, 'purchase_completed');
  assert.equal(phBody.distinct_id, 'purchaseanalyticsuser', 'distinct_id must be the account USERNAME, not the email, to match the client\'s posthog.identify()');
  assert.equal(phBody.properties.value, 0.99);
  assert.equal(phBody.properties.currency, 'USD');
  assert.ok(phBody.properties.timestamp, 'properties.timestamp should be present');
  assert.equal(phBody.properties.$insert_id, 'shared-evt-abc123', 'PostHog dedup key must match the shared event_id');
  assert.ok(phBody.timestamp, 'top-level timestamp should be present');
  assert.equal(phBody.properties.starter, true, 'pack099 IS the starter pack');

  assert.equal(spies.metaCalls.length, 1, 'expected exactly one Meta CAPI call');
  var metaBody = spies.metaCalls[0].body;
  var metaEvent = metaBody.data[0];
  assert.equal(metaEvent.event_name, 'Purchase');
  assert.equal(metaEvent.event_id, 'shared-evt-abc123', 'Meta CAPI event_id must match the shared event_id used for PostHog dedup too');
  assert.equal(metaEvent.custom_data.value, 0.99);
  assert.equal(metaEvent.custom_data.currency, 'USD');
  assert.ok(metaEvent.event_time, 'event_time should be present');
});

test('pack199 resolves price 1.99 for the Purchase event, and starter:false', async function () {
  await seedZeroBalance('purchase300@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_analytics_300',
    product_cart: [{ product_id: 'pdt_pack199_test', quantity: 1 }],
    customer: { customer_id: 'cus_300a', email: 'purchase300@example.com' },
    metadata: { dreamtube_event_id: 'evt-300' }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.value, 1.99);
  assert.equal(spies.posthogCalls[0].body.properties.starter, false);
  assert.equal(spies.metaCalls[0].body.data[0].custom_data.value, 1.99);
});

test('pack499 resolves price 4.99 for the Purchase event, and starter:false', async function () {
  await seedZeroBalance('purchase499@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_analytics_499',
    product_cart: [{ product_id: 'pdt_pack499_test', quantity: 1 }],
    customer: { customer_id: 'cus_499a', email: 'purchase499@example.com' },
    metadata: { dreamtube_event_id: 'evt-499' }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.value, 4.99);
  assert.equal(spies.posthogCalls[0].body.properties.starter, false);
  assert.equal(spies.metaCalls[0].body.data[0].custom_data.value, 4.99);
});

test('pack999 resolves price 9.99 for the Purchase event, and starter:false', async function () {
  await seedZeroBalance('purchase700@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_analytics_700',
    product_cart: [{ product_id: 'pdt_pack999_test', quantity: 1 }],
    customer: { customer_id: 'cus_700a', email: 'purchase700@example.com' },
    metadata: { dreamtube_event_id: 'evt-700' }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.value, 9.99);
  assert.equal(spies.posthogCalls[0].body.properties.starter, false);
  assert.equal(spies.metaCalls[0].body.data[0].custom_data.value, 9.99);
});

test('when metadata carries no dreamtube_event_id (a purchase predating this instrumentation), the Purchase event still fires with a freshly generated event_id shared between PostHog and Meta for THIS webhook fire', async function () {
  await seedZeroBalance('nolegacyid@example.com');
  var spies = installAnalyticsFetchSpy();
  var payload = paymentPayload({
    payment_id: 'pay_no_legacy_id',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_nl', email: 'nolegacyid@example.com' },
    metadata: {}
  });
  await handler(signedEvent(payload));

  assert.equal(spies.posthogCalls.length, 1);
  assert.equal(spies.metaCalls.length, 1);
  var phEventId = spies.posthogCalls[0].body.properties.$insert_id;
  var metaEventId = spies.metaCalls[0].body.data[0].event_id;
  assert.ok(phEventId, 'a fallback event_id must still be generated');
  assert.equal(phEventId, metaEventId, 'both vendors must share the SAME fallback id for this one webhook fire');
});

test('distinct_id falls back to the normalized email when no matching account record exists', async function () {
  await seedZeroBalance('noaccountrecord@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_no_account',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_na', email: 'NoAccountRecord@Example.com' },
    metadata: { dreamtube_event_id: 'evt-no-account' }
  })));
  assert.equal(spies.posthogCalls[0].body.distinct_id, 'noaccountrecord@example.com');
});

test('a PostHog capture failure never blocks the token credit or the webhook\'s 200 response', async function () {
  await seedZeroBalance('posthogdown@example.com');
  var spies = installAnalyticsFetchSpy({ posthogFails: true });
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_posthog_down',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_phd', email: 'posthogdown@example.com' },
    metadata: { dreamtube_event_id: 'evt-ph-down' }
  })));
  assert.equal(res.statusCode, 200, 'a PostHog failure must never surface as a webhook failure');
  var record = await entitlements.getEntitlement({}, 'posthogdown@example.com');
  assert.equal(record.tokens.balance, 300, 'the token credit must still have landed');
  assert.equal(spies.metaCalls.length, 1, 'the Meta CAPI call must still have been attempted independent of the PostHog failure');
});

test('a Meta CAPI failure never blocks the token credit or the webhook\'s 200 response', async function () {
  await seedZeroBalance('metadown@example.com');
  var spies = installAnalyticsFetchSpy({ metaFails: true });
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_meta_down',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_md', email: 'metadown@example.com' },
    metadata: { dreamtube_event_id: 'evt-meta-down' }
  })));
  assert.equal(res.statusCode, 200, 'a Meta CAPI failure must never surface as a webhook failure');
  var record = await entitlements.getEntitlement({}, 'metadown@example.com');
  assert.equal(record.tokens.balance, 300, 'the token credit must still have landed');
  assert.equal(spies.posthogCalls.length, 1, 'the PostHog call must still have been attempted independent of the Meta failure');
});

test('missing META_CAPI_ACCESS_TOKEN: PostHog still fires, Meta CAPI is skipped gracefully, credit + 200 unaffected', async function () {
  delete process.env.META_CAPI_ACCESS_TOKEN;
  await seedZeroBalance('nometatoken@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_no_meta_token',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_nmt', email: 'nometatoken@example.com' },
    metadata: { dreamtube_event_id: 'evt-no-meta-token' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'nometatoken@example.com');
  assert.equal(record.tokens.balance, 300);
  assert.equal(spies.posthogCalls.length, 1, 'PostHog should still fire even without a Meta token configured');
  assert.equal(spies.metaCalls.length, 0, 'no Meta CAPI call should be attempted without an access token (lib/meta-capi.js returns ok:false before ever calling fetch)');
});

test('a payment with no resolvable price (unknown product_id and no metadata.dreamtube_price) skips the Purchase fire entirely, on both vendors', async function () {
  await seedZeroBalance('nopriceresolvable@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_no_price',
    product_cart: [{ product_id: 'pdt_totally_unknown', quantity: 1 }],
    customer: { customer_id: 'cus_np', email: 'nopriceresolvable@example.com' },
    metadata: { dreamtube_tokens: 100 } // resolves tokens (so the credit lands) but no price
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'nopriceresolvable@example.com');
  assert.equal(record.tokens.balance, 100, 'the credit must still land even though price is unresolvable');
  assert.equal(spies.posthogCalls.length, 0, 'must not guess a price -- no Purchase fire at all');
  assert.equal(spies.metaCalls.length, 0);
});

test('a redelivered payment.succeeded event (same payment_id, already fully credited) does NOT re-fire the Purchase analytics event on either vendor -- creditTokenPackOnce\'s credited:false must gate this, not just the balance', async function () {
  await seedZeroBalance('noreanalytics@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_redelivered_analytics',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_ra', email: 'noreanalytics@example.com' },
    metadata: { dreamtube_event_id: 'evt-redelivered' }
  });

  var spies1 = installAnalyticsFetchSpy();
  var res1 = await handler(signedEvent(payload, { id: 'msg_first_analytics' }));
  assert.equal(res1.statusCode, 200);
  assert.equal(spies1.posthogCalls.length, 1, 'the first, genuine delivery must fire Purchase once');
  assert.equal(spies1.metaCalls.length, 1);

  // Dodo redelivers the identical event under a different webhook message
  // id/timestamp -- same as the existing non-analytics redelivery test
  // above, but this one specifically proves the analytics side doesn't
  // double-fire even though the balance-dedup test already proves the
  // balance itself doesn't double-credit.
  var spies2 = installAnalyticsFetchSpy();
  var res2 = await handler(signedEvent(payload, { id: 'msg_second_analytics' }));
  assert.equal(res2.statusCode, 200);
  assert.equal(spies2.posthogCalls.length, 0, 'a redelivered, already-fully-processed payment must NOT re-fire the PostHog Purchase event');
  assert.equal(spies2.metaCalls.length, 0, 'a redelivered, already-fully-processed payment must NOT re-fire the Meta CAPI Purchase event');

  var record = await entitlements.getEntitlement({}, 'noreanalytics@example.com');
  assert.equal(record.tokens.balance, 300, 'balance must still only reflect a single credit');
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

test('payment.succeeded for pack099 (starter) credits 300 tokens onto the buyer\'s balance', async function () {
  await seedZeroBalance('buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_abc',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_abc', email: 'Buyer@Example.com' }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'buyer@example.com');
  assert.equal(record.tokens.balance, 300);
  // A token-pack purchase is a pure balance credit — it must not touch the
  // subscription-era active/plan fields at all (they don't apply here).
  assert.equal(record.active, undefined);
  assert.equal(record.plan, undefined);
});

test('payment.succeeded for pack199 credits 500 tokens', async function () {
  await seedZeroBalance('300buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_300',
    product_cart: [{ product_id: 'pdt_pack199_test', quantity: 1 }],
    customer: { customer_id: 'cus_300', email: '300buyer@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, '300buyer@example.com');
  assert.equal(record.tokens.balance, 500);
});

test('payment.succeeded for pack499 credits 1500 tokens', async function () {
  await seedZeroBalance('499buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_499',
    product_cart: [{ product_id: 'pdt_pack499_test', quantity: 1 }],
    customer: { customer_id: 'cus_499', email: '499buyer@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, '499buyer@example.com');
  assert.equal(record.tokens.balance, 1500);
});

test('payment.succeeded for pack999 credits 4000 tokens', async function () {
  await seedZeroBalance('700buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_700',
    product_cart: [{ product_id: 'pdt_pack999_test', quantity: 1 }],
    customer: { customer_id: 'cus_700', email: '700buyer@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, '700buyer@example.com');
  assert.equal(record.tokens.balance, 4000);
});

test('tokens stack onto an existing balance rather than replacing it', async function () {
  await seedZeroBalance('stacker@example.com');
  await entitlements.addTokens({}, 'stacker@example.com', 50);
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_stack',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_stack', email: 'stacker@example.com' }
  })));
  var record = await entitlements.getEntitlement({}, 'stacker@example.com');
  assert.equal(record.tokens.balance, 350, '50 (already there) + 300 (pack099 credit) = 350');
});

test('a redelivered payment.succeeded event (same payment_id) does not double-credit', async function () {
  await seedZeroBalance('redelivered@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_redelivered',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_r', email: 'redelivered@example.com' }
  });

  var res1 = await handler(signedEvent(payload, { id: 'msg_first' }));
  assert.equal(res1.statusCode, 200);
  var afterFirst = await entitlements.getEntitlement({}, 'redelivered@example.com');
  assert.equal(afterFirst.tokens.balance, 300);

  // Dodo redelivers the identical event (same payment_id) under a
  // different webhook message id/timestamp — the payload's payment_id is
  // what must dedupe this, not the webhook delivery's own id.
  var res2 = await handler(signedEvent(payload, { id: 'msg_second' }));
  assert.equal(res2.statusCode, 200);
  var afterSecond = await entitlements.getEntitlement({}, 'redelivered@example.com');
  assert.equal(afterSecond.tokens.balance, 300, 'balance must not double-credit on a redelivered event');
});

test('email falls back to metadata.dreamtube_email when the customer block is missing', async function () {
  await seedZeroBalance('fallback@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_fallback',
    metadata: { dreamtube_email: 'fallback@example.com', dreamtube_pack: 'pack099', dreamtube_tokens: 300 }
  });
  delete payload.data.customer;
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'fallback@example.com');
  assert.equal(record.tokens.balance, 300);
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

test('a payment.succeeded event with no payment_id is acknowledged (200) but credits nothing -- hardening fix, tracker item for-product-store-launch-copy-sweep-purc-m6xhkx', async function () {
  // A real Dodo Payment object always carries payment_id -- this
  // simulates the malformed/unexpected case where it's somehow absent.
  // creditTokenPackOnce used to credit unconditionally here (no way to
  // dedupe a redelivery without a payment_id); it now fails closed
  // instead, since crediting real tokens off an unverifiable event is a
  // real gap, not an acceptable "escape hatch". See that function's own
  // doc comment in lib/entitlements.js.
  await seedZeroBalance('nopayidwebhook@example.com');
  var payload = paymentPayload({
    payment_id: undefined,
    customer: { customer_id: 'cus_nopayid', email: 'nopayidwebhook@example.com' }
  });
  delete payload.data.payment_id;
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200, 'still acknowledged -- not worth Dodo redelivering something structurally missing payment_id');
  assert.deepEqual(JSON.parse(res.body), { received: true });

  var record = await entitlements.getEntitlement({}, 'nopayidwebhook@example.com');
  assert.equal(record.tokens.balance, 0, 'balance must be untouched -- nothing should have been credited');
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
      product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
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

// ----- No first-purchase bonus (retired 2026-08-02, "The Vault" redesign) -----
//
// The old +50% first-purchase bonus (Token Economy C) is gone entirely —
// every pack credits its plain base token count, on the first purchase or
// any later one, with no multiplier. firstPackPurchaseAt is STILL stamped
// (repurposed to gate the $0.99 starter pack's one-time eligibility at
// checkout-creation time — see create-checkout-session-dodo.js's own E9
// guard/tests), just no longer read by the crediting path itself. Uses
// seedZeroBalanceNoPriorPurchase (no firstPackPurchaseAt stamped) so these
// accounts are genuinely brand-new, same as the old bonus tests this
// section replaces — the point now is proving NO multiplier applies even
// for a genuinely first-ever purchase.

test('a brand-new account\'s first-ever pack099 purchase credits the plain 300 base tokens -- no +50% bonus, ever', async function () {
  await seedZeroBalanceNoPriorPurchase('firstbonus@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_first_bonus',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_first_bonus', email: 'firstbonus@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'firstbonus@example.com');
  assert.equal(record.tokens.balance, 300, 'first-ever pack purchase credits the plain base amount -- the +50% bonus is retired');
  // firstPackPurchaseAt is still stamped -- repurposed for starter-pack
  // one-time gating (see create-checkout-session-dodo.js), just no longer
  // used to compute a bonus multiplier here.
  assert.ok(record.firstPackPurchaseAt, 'firstPackPurchaseAt must still be stamped after the first purchase completes');
});

test('a SECOND purchase from the same account also credits the plain base amount -- both purchases, no multiplier on either', async function () {
  await seedZeroBalanceNoPriorPurchase('secondpurchase@example.com');
  var first = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_second_purchase_first',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_second_a', email: 'secondpurchase@example.com' }
  })));
  assert.equal(first.statusCode, 200);
  var afterFirst = await entitlements.getEntitlement({}, 'secondpurchase@example.com');
  assert.equal(afterFirst.tokens.balance, 300, 'first purchase credits the plain base amount, no bonus');

  var second = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_second_purchase_second',
    product_cart: [{ product_id: 'pdt_pack199_test', quantity: 1 }],
    customer: { customer_id: 'cus_second_b', email: 'secondpurchase@example.com' }
  })));
  assert.equal(second.statusCode, 200);
  var afterSecond = await entitlements.getEntitlement({}, 'secondpurchase@example.com');
  assert.equal(afterSecond.tokens.balance, 800, '300 (first, plain) + 500 (second, plain) = 800 -- neither purchase gets a bonus');
});

test('a redelivered FIRST-purchase event (same payment_id) does not double-credit, and still applies no bonus', async function () {
  await seedZeroBalanceNoPriorPurchase('redeliveredbonus@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_redelivered_bonus',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_redelivered_bonus', email: 'redeliveredbonus@example.com' }
  });

  await handler(signedEvent(payload, { id: 'msg_bonus_first' }));
  var afterFirst = await entitlements.getEntitlement({}, 'redeliveredbonus@example.com');
  assert.equal(afterFirst.tokens.balance, 300);

  await handler(signedEvent(payload, { id: 'msg_bonus_second' }));
  var afterSecond = await entitlements.getEntitlement({}, 'redeliveredbonus@example.com');
  assert.equal(afterSecond.tokens.balance, 300, 'a redelivered event for the SAME payment_id must not double-credit');
});

// ----- dodoCustomerId capture (tracker item
// for-product-repeat-purchase-friction-dod-b6pzs6) -----

test('payment.succeeded stamps payment.customer.customer_id onto the entitlement record as dodoCustomerId', async function () {
  await seedZeroBalance('customeridcapture@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_customerid_capture',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_captured_abc', email: 'customeridcapture@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'customeridcapture@example.com');
  assert.equal(record.dodoCustomerId, 'cus_captured_abc');
  assert.equal(record.tokens.balance, 300, 'the token credit itself must be unaffected by also capturing the customer id (300 = pack099\'s base amount)');
});

test('a redelivered payment.succeeded event re-stamps the SAME dodoCustomerId (a harmless no-op), and does not affect the balance dedup', async function () {
  await seedZeroBalance('customeridredelivered@example.com');
  var payload = paymentPayload({
    payment_id: 'pay_customerid_redelivered',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_redelivered_id', email: 'customeridredelivered@example.com' }
  });

  await handler(signedEvent(payload, { id: 'msg_cid_first' }));
  var afterFirst = await entitlements.getEntitlement({}, 'customeridredelivered@example.com');
  assert.equal(afterFirst.dodoCustomerId, 'cus_redelivered_id');
  assert.equal(afterFirst.tokens.balance, 300);

  await handler(signedEvent(payload, { id: 'msg_cid_second' }));
  var afterSecond = await entitlements.getEntitlement({}, 'customeridredelivered@example.com');
  assert.equal(afterSecond.dodoCustomerId, 'cus_redelivered_id');
  assert.equal(afterSecond.tokens.balance, 300, 'balance must still not double-credit on the redelivery');
});

test('a LATER purchase under a NEW dodo customer_id overwrites the previously stored one with the latest value', async function () {
  await seedZeroBalance('customeridrotates@example.com');
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_customerid_rotate_1',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_old_id', email: 'customeridrotates@example.com' }
  })));
  var afterFirst = await entitlements.getEntitlement({}, 'customeridrotates@example.com');
  assert.equal(afterFirst.dodoCustomerId, 'cus_old_id');

  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_customerid_rotate_2',
    product_cart: [{ product_id: 'pdt_pack199_test', quantity: 1 }],
    customer: { customer_id: 'cus_new_id', email: 'customeridrotates@example.com' }
  })));
  var afterSecond = await entitlements.getEntitlement({}, 'customeridrotates@example.com');
  assert.equal(afterSecond.dodoCustomerId, 'cus_new_id', 'the most recent purchase\'s customer_id must be what\'s on file');
});

test('a payment whose customer block carries no customer_id (or no customer block at all) leaves dodoCustomerId untouched -- must not stamp undefined/null over a previously stored value', async function () {
  await seedZeroBalance('nocustomerid@example.com');
  await entitlements.setEntitlement({}, 'nocustomerid@example.com', { dodoCustomerId: 'cus_preexisting' });

  // Deliberately does not override product_cart, so this credits via
  // paymentPayload's own default product_cart (pdt_pack099_test -> pack099
  // -> 300 tokens), NOT via the metadata.dreamtube_tokens fallback --
  // resolvePackTokens' product-id branch always wins first when the
  // product_cart resolves (see that function's own doc comment). Kept
  // metadata.dreamtube_tokens numerically consistent with the credited
  // amount anyway so it doesn't mislead a future reader.
  var payload = paymentPayload({
    payment_id: 'pay_no_customer_id',
    metadata: { dreamtube_email: 'nocustomerid@example.com', dreamtube_pack: 'pack099', dreamtube_tokens: 300 }
  });
  delete payload.data.customer;
  var res = await handler(signedEvent(payload));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'nocustomerid@example.com');
  assert.equal(record.dodoCustomerId, 'cus_preexisting', 'setEntitlement\'s own undefined-key-dropping merge must leave the prior value intact, not blank it out');
  assert.equal(record.tokens.balance, 300, 'the credit itself must still land even with no customer block present');
});

test('pack999\'s first-ever purchase also credits the plain 4000 base tokens -- no bonus regardless of pack size', async function () {
  await seedZeroBalanceNoPriorPurchase('firstbonus700@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_first_bonus_700',
    product_cart: [{ product_id: 'pdt_pack999_test', quantity: 1 }],
    customer: { customer_id: 'cus_first_bonus_700', email: 'firstbonus700@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'firstbonus700@example.com');
  assert.equal(record.tokens.balance, 4000, 'plain base amount, no +50% bonus');
});

// ----- `starter` flag on the Purchase conversion event (tracker item
// for-product-build-ship-today-founder-app-zn9zyy, item 5) -----

test('the Purchase event\'s `starter` flag is true for pack099 and false for every other pack, on both PostHog and resolveIsStarterPack\'s product_cart match', async function () {
  await seedZeroBalance('starterflagcart@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_starter_flag_cart',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_starter_flag', email: 'starterflagcart@example.com' },
    metadata: { dreamtube_event_id: 'evt-starter-flag-cart' }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.starter, true);
});

test('the Purchase event\'s `starter` flag falls back to metadata.dreamtube_starter when product_cart matches no configured pack (env var rotated after checkout creation)', async function () {
  await seedZeroBalance('starterflagmeta@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_starter_flag_meta',
    product_cart: [{ product_id: 'pdt_some_rotated_product', quantity: 1 }],
    customer: { customer_id: 'cus_starter_flag_meta', email: 'starterflagmeta@example.com' },
    metadata: { dreamtube_event_id: 'evt-starter-flag-meta', dreamtube_tokens: 300, dreamtube_price: 0.99, dreamtube_starter: true }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.starter, true, 'must fall back to metadata.dreamtube_starter when the product_cart match fails');
});

test('the Purchase event\'s `starter` flag defaults to false (never undefined) when neither product_cart nor metadata resolve it', async function () {
  await seedZeroBalance('starterflagfallback@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_starter_flag_fallback',
    product_cart: [{ product_id: 'pdt_some_rotated_product', quantity: 1 }],
    customer: { customer_id: 'cus_starter_flag_fallback', email: 'starterflagfallback@example.com' },
    metadata: { dreamtube_event_id: 'evt-starter-flag-fallback', dreamtube_tokens: 500, dreamtube_price: 1.99 }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.starter, false, 'an unresolvable starter flag must fail toward false, never undefined -- this is an analytics dimension on an otherwise-fully-resolvable event, not worth losing the whole Purchase fire over');
});
