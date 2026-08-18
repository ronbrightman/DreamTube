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

/**
 * Runs `fn` (an async function) with console.log replaced by a recording
 * stub, returning `{ result, lines }` where `lines` is every console.log
 * call made during `fn`'s execution, each joined the same way
 * test/effective-config-logging.test.js's requireFreshCapturingLogs already
 * does. Used below to assert dodo-webhook.js's logSubEvent() diagnostic
 * calls (conversion.meta_capi_failed[...]/conversion.posthog_failed[...])
 * actually fire with the right content when a vendor call fails — restores
 * the real console.log afterward no matter what.
 */
async function captureConsoleLogsDuring(fn) {
  var lines = [];
  var realLog = console.log;
  console.log = function () {
    lines.push(Array.prototype.slice.call(arguments).join(' '));
  };
  try {
    var result = await fn();
    return { result: result, lines: lines };
  } finally {
    console.log = realLog;
  }
}

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.DODO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.DODO_PRODUCT_PACK_STARTER300 = 'pdt_pack099_test';
  process.env.DODO_PRODUCT_PACK_SMALL500 = 'pdt_pack199_test';
  process.env.DODO_PRODUCT_PACK_MEDIUM1500 = 'pdt_pack499_test';
  process.env.DODO_PRODUCT_PACK_LARGE4000 = 'pdt_pack999_test';
  process.env.DODO_PRODUCT_DREAMER_PASS = 'pdt_dreamer_pass_test';
  process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL = 'pdt_dreamer_pass_notrial_test';
  process.env.DODO_PRODUCT_DREAMER_PASS_TRIAL50 = 'pdt_dreamer_pass_trial50_test';
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
  delete process.env.DODO_PRODUCT_DREAMER_PASS;
  delete process.env.DODO_PRODUCT_DREAMER_PASS_NOTRIAL;
  delete process.env.DODO_PRODUCT_DREAMER_PASS_TRIAL50;
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

// ===== fbc/fbp ad-attribution threading (tracker item
// for-product-for-manager-purchase-meta-ro-nfrfl5, item 2): create-checkout-
// session-dodo.js carries a checkout's fbc/fbp through Dodo's metadata as
// dreamtube_fbc/dreamtube_fbp, echoed back verbatim on this payment --
// firePurchaseConversion must read them back and forward them to Meta CAPI's
// sendCapiEvent, so a purchase can actually be attributed to the ad that
// drove it. Purely additive: absence must never break the conversion fire
// or the credit. =====

test('payment.succeeded carrying metadata.dreamtube_fbc/dreamtube_fbp forwards them to Meta CAPI\'s user_data.fbc/fbp', async function () {
  await seedZeroBalance('purchasefbc@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_fbc_1',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_fbc', email: 'purchasefbc@example.com' },
    metadata: { dreamtube_event_id: 'evt-fbc-pack', dreamtube_fbc: 'fb.1.1700000000000.IwAR0abc', dreamtube_fbp: 'fb.1.1700000000000.999888777' }
  })));

  assert.equal(spies.metaCalls.length, 1);
  var userData = spies.metaCalls[0].body.data[0].user_data;
  assert.equal(userData.fbc, 'fb.1.1700000000000.IwAR0abc');
  assert.equal(userData.fbp, 'fb.1.1700000000000.999888777');
});

test('payment.succeeded with NO metadata.dreamtube_fbc/dreamtube_fbp still fires Purchase normally, with no fbc/fbp key on user_data -- absence must never break the conversion or the credit', async function () {
  await seedZeroBalance('purchasenofbc@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_no_fbc_1',
    product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
    customer: { customer_id: 'cus_nofbc', email: 'purchasenofbc@example.com' },
    metadata: { dreamtube_event_id: 'evt-no-fbc-pack' }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'purchasenofbc@example.com');
  assert.equal(record.tokens.balance, 300, 'the credit must land regardless of fbc/fbp being absent');

  assert.equal(spies.metaCalls.length, 1, 'the Purchase conversion must still fire');
  var userData = spies.metaCalls[0].body.data[0].user_data;
  assert.equal(userData.fbc, undefined, 'sendCapiEvent must not send a fbc key at all when none was provided');
  assert.equal(userData.fbp, undefined);
});

test('pack199 resolves price 2.99 for the Purchase event, and starter:false', async function () {
  await seedZeroBalance('purchase300@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(paymentPayload({
    payment_id: 'pay_analytics_300',
    product_cart: [{ product_id: 'pdt_pack199_test', quantity: 1 }],
    customer: { customer_id: 'cus_300a', email: 'purchase300@example.com' },
    metadata: { dreamtube_event_id: 'evt-300' }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.value, 2.99);
  assert.equal(spies.posthogCalls[0].body.properties.starter, false);
  assert.equal(spies.metaCalls[0].body.data[0].custom_data.value, 2.99);
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

test('a PostHog capture failure never blocks the token credit or the webhook\'s 200 response, and IS logged for visibility', async function () {
  await seedZeroBalance('posthogdown@example.com');
  var spies = installAnalyticsFetchSpy({ posthogFails: true });
  var captured = await captureConsoleLogsDuring(function () {
    return handler(signedEvent(paymentPayload({
      payment_id: 'pay_posthog_down',
      product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
      customer: { customer_id: 'cus_phd', email: 'posthogdown@example.com' },
      metadata: { dreamtube_event_id: 'evt-ph-down' }
    })));
  });
  var res = captured.result;
  assert.equal(res.statusCode, 200, 'a PostHog failure must never surface as a webhook failure');
  var record = await entitlements.getEntitlement({}, 'posthogdown@example.com');
  assert.equal(record.tokens.balance, 300, 'the token credit must still have landed');
  assert.equal(spies.metaCalls.length, 1, 'the Meta CAPI call must still have been attempted independent of the PostHog failure');

  // The bug this closes: a silently-swallowed vendor failure with zero
  // visibility. Prove the failure IS now logged, with the vendor, the
  // conversion type, the payment_id to correlate it, and the real error text
  // (never the raw access token -- there's none to leak on the PostHog path).
  var failureLine = captured.lines.find(function (l) { return l.indexOf('conversion.posthog_failed[pack_purchase]') !== -1; });
  assert.ok(failureLine, 'a PostHog failure must produce a conversion.posthog_failed[pack_purchase] log line -- got: ' + JSON.stringify(captured.lines));
  assert.match(failureLine, /"payment_id":"pay_posthog_down"/);
  assert.match(failureLine, /"email":"posthogdown@example\.com"/);
  assert.match(failureLine, /posthog_request_failed/, 'the real PostHog error text must be logged');
  // The Meta side succeeded in this test -- must NOT also log a Meta failure.
  assert.ok(!captured.lines.some(function (l) { return l.indexOf('conversion.meta_capi_failed') !== -1; }), 'no Meta failure occurred, so no Meta failure log line should appear');
});

test('a Meta CAPI failure never blocks the token credit or the webhook\'s 200 response, and IS logged for visibility (never with the raw access token)', async function () {
  await seedZeroBalance('metadown@example.com');
  var spies = installAnalyticsFetchSpy({ metaFails: true });
  var captured = await captureConsoleLogsDuring(function () {
    return handler(signedEvent(paymentPayload({
      payment_id: 'pay_meta_down',
      product_cart: [{ product_id: 'pdt_pack099_test', quantity: 1 }],
      customer: { customer_id: 'cus_md', email: 'metadown@example.com' },
      metadata: { dreamtube_event_id: 'evt-meta-down' }
    })));
  });
  var res = captured.result;
  assert.equal(res.statusCode, 200, 'a Meta CAPI failure must never surface as a webhook failure');
  var record = await entitlements.getEntitlement({}, 'metadown@example.com');
  assert.equal(record.tokens.balance, 300, 'the token credit must still have landed');
  assert.equal(spies.posthogCalls.length, 1, 'the PostHog call must still have been attempted independent of the Meta failure');

  // Same visibility proof as the PostHog case above, for the exact bug this
  // whole change targets: real Dreamer Pass/pack revenue landing in PostHog
  // while Meta CAPI silently failed with nothing logged anywhere.
  var failureLine = captured.lines.find(function (l) { return l.indexOf('conversion.meta_capi_failed[pack_purchase]') !== -1; });
  assert.ok(failureLine, 'a Meta CAPI failure must produce a conversion.meta_capi_failed[pack_purchase] log line -- got: ' + JSON.stringify(captured.lines));
  assert.match(failureLine, /"payment_id":"pay_meta_down"/);
  assert.match(failureLine, /"email":"metadown@example\.com"/);
  assert.match(failureLine, /meta down/, 'the real Meta error message must be logged');
  assert.ok(failureLine.indexOf(REAL_META_TOKEN) === -1, 'the raw Meta access token must NEVER appear in a log line');
  assert.ok(!captured.lines.some(function (l) { return l.indexOf('conversion.posthog_failed') !== -1; }), 'no PostHog failure occurred, so no PostHog failure log line should appear');
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

test('payment.succeeded for pack499 credits 1000 tokens', async function () {
  await seedZeroBalance('499buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_499',
    product_cart: [{ product_id: 'pdt_pack499_test', quantity: 1 }],
    customer: { customer_id: 'cus_499', email: '499buyer@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, '499buyer@example.com');
  assert.equal(record.tokens.balance, 1000);
});

test('payment.succeeded for pack999 credits 2500 tokens', async function () {
  await seedZeroBalance('700buyer@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_700',
    product_cart: [{ product_id: 'pdt_pack999_test', quantity: 1 }],
    customer: { customer_id: 'cus_700', email: '700buyer@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, '700buyer@example.com');
  assert.equal(record.tokens.balance, 2500);
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

test('pack999\'s first-ever purchase also credits the plain 2500 base tokens -- no bonus regardless of pack size', async function () {
  await seedZeroBalanceNoPriorPurchase('firstbonus700@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_first_bonus_700',
    product_cart: [{ product_id: 'pdt_pack999_test', quantity: 1 }],
    customer: { customer_id: 'cus_first_bonus_700', email: 'firstbonus700@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'firstbonus700@example.com');
  assert.equal(record.tokens.balance, 2500, 'plain base amount, no +50% bonus');
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
    metadata: { dreamtube_event_id: 'evt-starter-flag-fallback', dreamtube_tokens: 500, dreamtube_price: 2.99 }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.starter, false, 'an unresolvable starter flag must fail toward false, never undefined -- this is an analytics dimension on an otherwise-fully-resolvable event, not worth losing the whole Purchase fire over');
});

// ============================================================================
// Dreamer Pass — the $9.99/month subscription (3-day free trial). Covers the
// subscription lifecycle events + the 3000-token monthly lump grant added to
// dodo-webhook.js. See lib/entitlements.js's DREAMER PASS doc block and this
// handler's own "Dreamer Pass subscription handling" section.
//
// DREAMER_PASS_MONTHLY = 3000 (the fixed monthly lump), keyed to the same
// constant the code uses so a retune flows through here automatically.
// ============================================================================
var DREAMER_PASS_MONTHLY = entitlements.DREAMER_PASS_MONTHLY_TOKENS;

/** A Dreamer Pass subscription CHARGE arriving as payment.succeeded (product_id matches DODO_PRODUCT_DREAMER_PASS, plus a subscription_id). */
function passPaymentPayload(overrides) {
  return {
    business_id: 'biz_test',
    timestamp: new Date().toISOString(),
    type: 'payment.succeeded',
    data: Object.assign({
      payment_id: 'pay_pass_1',
      subscription_id: 'sub_pass_1',
      product_cart: [{ product_id: 'pdt_dreamer_pass_test', quantity: 1 }],
      customer: { customer_id: 'cus_pass_1', email: 'passbuyer@example.com' },
      metadata: { dreamtube_plan: 'dreamer_pass' },
      total_amount: 999,
      currency: 'USD'
    }, overrides)
  };
}

/** A subscription.* lifecycle event carrying a Subscription object. */
function subEvent(type, dataOverrides) {
  return {
    business_id: 'biz_test',
    timestamp: new Date().toISOString(),
    type: type,
    data: Object.assign({
      subscription_id: 'sub_pass_1',
      product_id: 'pdt_dreamer_pass_test',
      status: 'active',
      customer: { customer_id: 'cus_pass_1', email: 'passbuyer@example.com' }
    }, dataOverrides)
  };
}

var DAY_MS = 24 * 60 * 60 * 1000;

// ----- trial start: subscription.active(trialing) enables the 100/day boost -----

test('subscription.active with a trialing status + trial end enables the 100/day daily-claim boost and stores trialEnd', async function () {
  var email = 'trialstart@example.com';
  var trialEnd = Date.now() + 3 * DAY_MS;
  var res = await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing',
    trial_end_date: new Date(trialEnd).toISOString(),
    customer: { customer_id: 'cus_ts', email: email }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.subscription.status, 'trialing');
  assert.ok(record.subscription.trialEnd, 'trialEnd stored so the boost window is bounded');
  assert.equal(record.active, true);

  // The daily claim is now boosted to 100.
  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 100, 'a live trial boosts the daily claim to 100');
  var claim = await entitlements.claimDailyTokens({}, email);
  assert.equal(claim.amountClaimed, 100);
});

test('subscription.active with no resolvable trial end still caps the trial boost to a bounded window', async function () {
  var email = 'trialnoend@example.com';
  var before = Date.now();
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing',
    customer: { customer_id: 'cus_tne', email: email }
  })));
  var record = await entitlements.getEntitlement({}, email);
  assert.ok(record.subscription.trialEnd >= before + entitlements.TRIAL_WINDOW_MS - 5000, 'boost capped to ~now + the 3-day window even without a payload trial end');
});

// ----- a subscription payment grants exactly 3000 ONCE -----

test('a Dreamer Pass payment.succeeded grants exactly 3000 tokens, marks the account active (ending the trial boost), and does not touch the pack path', async function () {
  await seedZeroBalance('passbuyer@example.com');
  // Put the account into a trial first, then charge it.
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing', trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    customer: { customer_id: 'cus_pass_1', email: 'passbuyer@example.com' }
  })));

  var res = await handler(signedEvent(passPaymentPayload({ payment_id: 'pay_pass_grant' })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'passbuyer@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'the full 3000-token monthly lump lands up front');
  assert.equal(record.subscription.status, 'active', 'a real charge flips the subscription to active');
  // Trial boost is now off: the daily claim reverts to 20.
  var status = await entitlements.getTokenStatus({}, 'passbuyer@example.com');
  assert.equal(status.dailyClaimAmount, 20, 'a paid subscriber is not trialing -> normal 20 claim');
});

test('a $0 trial-start Dreamer Pass payment.succeeded grants NOTHING and keeps the account trialing (does not hand over a free month or end the trial) — founder repro 2026-08-09', async function () {
  await seedZeroBalance('passtrial@example.com');
  // Trial begins: subscription.active with status trialing.
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing', trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    customer: { customer_id: 'cus_trial', email: 'passtrial@example.com' }
  })));
  // Dodo ALSO sends a $0 payment.succeeded at trial start (total_amount 0).
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_trial_zero', total_amount: 0,
    customer: { customer_id: 'cus_trial', email: 'passtrial@example.com' }
  })));
  assert.equal(res.statusCode, 200, 'the $0 event is still acknowledged');

  var record = await entitlements.getEntitlement({}, 'passtrial@example.com');
  assert.equal(record.tokens.balance, 0, 'a $0 trial-start payment must NOT grant the 3000');
  assert.equal(record.subscription.status, 'trialing', 'the $0 payment must not flip the account out of trialing');
  var status = await entitlements.getTokenStatus({}, 'passtrial@example.com');
  assert.equal(status.dailyClaimAmount, 100, 'still trialing -> the 100/day boost stays intact');
});

test('a redelivered Dreamer Pass payment.succeeded (same payment_id) does NOT double-grant the 3000', async function () {
  await seedZeroBalance('passredeliver@example.com');
  var payload = passPaymentPayload({
    payment_id: 'pay_pass_redeliver',
    customer: { customer_id: 'cus_pr', email: 'passredeliver@example.com' }
  });
  var res1 = await handler(signedEvent(payload, { id: 'msg_pass_1' }));
  assert.equal(res1.statusCode, 200);
  var afterFirst = await entitlements.getEntitlement({}, 'passredeliver@example.com');
  assert.equal(afterFirst.tokens.balance, DREAMER_PASS_MONTHLY);

  var res2 = await handler(signedEvent(payload, { id: 'msg_pass_2' }));
  assert.equal(res2.statusCode, 200);
  var afterSecond = await entitlements.getEntitlement({}, 'passredeliver@example.com');
  assert.equal(afterSecond.tokens.balance, DREAMER_PASS_MONTHLY, 'a redelivered subscription charge must credit the 3000 only once');
});

test('a monthly RENEWAL charge (a new payment_id) grants another 3000', async function () {
  await seedZeroBalance('passrenew@example.com');
  await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_month1',
    customer: { customer_id: 'cus_prn', email: 'passrenew@example.com' }
  })));
  var afterM1 = await entitlements.getEntitlement({}, 'passrenew@example.com');
  assert.equal(afterM1.tokens.balance, DREAMER_PASS_MONTHLY);

  // Next month's charge -> a fresh payment_id -> another lump.
  await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_month2',
    customer: { customer_id: 'cus_prn', email: 'passrenew@example.com' }
  })));
  var afterM2 = await entitlements.getEntitlement({}, 'passrenew@example.com');
  assert.equal(afterM2.tokens.balance, DREAMER_PASS_MONTHLY * 2, 'a genuine renewal (new payment_id) grants another 3000');
});

test('subscription.renewed carrying a payment_id grants that charge\'s 3000, deduped against a payment.succeeded for the same charge', async function () {
  await seedZeroBalance('renewevent@example.com');
  var sharedPaymentId = 'pay_shared_charge';
  // The renewal arrives BOTH as a subscription.renewed and a payment.succeeded
  // for the same underlying charge (same payment_id) — exactly ONE 3000.
  await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: sharedPaymentId,
    customer: { customer_id: 'cus_re', email: 'renewevent@example.com' }
  })));
  var afterRenewed = await entitlements.getEntitlement({}, 'renewevent@example.com');
  assert.equal(afterRenewed.tokens.balance, DREAMER_PASS_MONTHLY, 'subscription.renewed with a payment_id grants the charge');

  await handler(signedEvent(passPaymentPayload({
    payment_id: sharedPaymentId,
    customer: { customer_id: 'cus_re', email: 'renewevent@example.com' }
  })));
  var afterBoth = await entitlements.getEntitlement({}, 'renewevent@example.com');
  assert.equal(afterBoth.tokens.balance, DREAMER_PASS_MONTHLY, 'a payment.succeeded sharing the SAME payment_id must not add a second 3000');
});

test('subscription.renewed with NO payment_id updates state but does not grant (the payment.succeeded is the grant path)', async function () {
  await seedZeroBalance('renewnopayid@example.com');
  await handler(signedEvent(subEvent('subscription.renewed', {
    customer: { customer_id: 'cus_rnp', email: 'renewnopayid@example.com' }
    // no payment_id
  })));
  var record = await entitlements.getEntitlement({}, 'renewnopayid@example.com');
  assert.equal(record.tokens.balance, 0, 'no payment_id -> no grant off the state event alone (avoids a non-idempotent grant)');
  assert.equal(record.subscription.status, 'active');
});

// ----- cancel / expire / on_hold clears the boost + state -----

['subscription.cancelled', 'subscription.expired', 'subscription.on_hold', 'subscription.failed', 'subscription.paused'].forEach(function (evtType) {
  test(evtType + ' clears the active subscription state and the trial boost (daily claim reverts to 20)', async function () {
    var email = evtType.replace(/[^a-z]/g, '') + '@example.com';
    // Start in a trial (boost on), then receive the terminal event.
    await handler(signedEvent(subEvent('subscription.active', {
      status: 'trialing', trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
      customer: { customer_id: 'cus_term', email: email }
    })));
    var trialStatus = await entitlements.getTokenStatus({}, email);
    assert.equal(trialStatus.dailyClaimAmount, 100, 'boost is on during the trial');

    var res = await handler(signedEvent(subEvent(evtType, { customer: { customer_id: 'cus_term', email: email } })));
    assert.equal(res.statusCode, 200);

    var record = await entitlements.getEntitlement({}, email);
    assert.equal(record.active, false, evtType + ' must clear the active flag');
    assert.equal(entitlements.isSubscriptionActive(record.subscription), false);
    var status = await entitlements.getTokenStatus({}, email);
    assert.equal(status.dailyClaimAmount, 20, evtType + ' must revert the daily claim to 20');
    assert.equal(status.subscription.subscribed, false);
  });
});

// ----- a one-time pack still works and never grants 3000 -----

test('a one-time pack payment.succeeded (no subscription context) still credits its pack amount and never 3000', async function () {
  await seedZeroBalance('stillpack@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_still_pack',
    product_cart: [{ product_id: 'pdt_pack199_test', quantity: 1 }],
    customer: { customer_id: 'cus_sp', email: 'stillpack@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'stillpack@example.com');
  assert.equal(record.tokens.balance, 500, 'pack199 still credits 500, not 3000');
  assert.equal(record.subscription, undefined, 'a pack purchase must not create any subscription state');
});

test('a Dreamer Pass charge recognized ONLY via metadata.dreamtube_plan (product_cart rotated/absent) still grants 3000', async function () {
  await seedZeroBalance('passmeta@example.com');
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_meta',
    product_cart: [{ product_id: 'pdt_rotated_unknown', quantity: 1 }],
    customer: { customer_id: 'cus_pm', email: 'passmeta@example.com' },
    metadata: { dreamtube_plan: 'dreamer_pass' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'passmeta@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY);
});

test('a subscription-linked payment with no product match and no plan metadata is still treated as the Pass (only-subscription-product fallback) and grants 3000', async function () {
  await seedZeroBalance('passfallback@example.com');
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_fallback',
    product_cart: [{ product_id: 'pdt_rotated_unknown', quantity: 1 }],
    subscription_id: 'sub_fallback',
    customer: { customer_id: 'cus_pf', email: 'passfallback@example.com' },
    metadata: {}
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'passfallback@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'a subscription_id-bearing non-pack payment is the Pass');
});

// ----- all THREE Dreamer Pass variant product ids grant the identical pass -----
//
// The SAME 3,000-token/month pass is sold at three price/trial configs, each a
// distinct Dodo product (DODO_PRODUCT_DREAMER_PASS[_NOTRIAL|_TRIAL50] — set in
// beforeEach). A payment.succeeded carrying ANY of the three product ids must
// be recognized as the Pass and grant the identical 3000-token lump — the
// price/trial differences are Dodo's concern, never the grant's. See
// dodo-webhook.js's isDreamerPassPayment / PASS_VARIANT_ENV.

test('the freetrial variant product id (DODO_PRODUCT_DREAMER_PASS) grants exactly 3000', async function () {
  await seedZeroBalance('ftgrant@example.com');
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_ft_grant',
    product_cart: [{ product_id: 'pdt_dreamer_pass_test', quantity: 1 }],
    metadata: {}, // no plan-metadata fallback — force recognition purely by product_id
    customer: { customer_id: 'cus_ft', email: 'ftgrant@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'ftgrant@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY);
});

test('the NOTRIAL variant product id (DODO_PRODUCT_DREAMER_PASS_NOTRIAL) is recognized as the Pass and grants exactly 3000', async function () {
  await seedZeroBalance('ntgrant@example.com');
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_nt_grant',
    product_cart: [{ product_id: 'pdt_dreamer_pass_notrial_test', quantity: 1 }],
    metadata: {}, // recognized purely by the notrial product_id, no plan metadata
    customer: { customer_id: 'cus_nt', email: 'ntgrant@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'ntgrant@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'the notrial variant grants the identical 3000-token pass');
});

test('the TRIAL50 variant product id (DODO_PRODUCT_DREAMER_PASS_TRIAL50) is recognized as the Pass and grants exactly 3000', async function () {
  await seedZeroBalance('t50grant@example.com');
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_t50_grant',
    product_cart: [{ product_id: 'pdt_dreamer_pass_trial50_test', quantity: 1 }],
    metadata: {},
    customer: { customer_id: 'cus_t50', email: 't50grant@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 't50grant@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'the trial50 variant grants the identical 3000-token pass');
});

test('a subscription.renewed for the NOTRIAL variant product grants that charge\'s 3000 (variant recognized on the lifecycle path too)', async function () {
  await seedZeroBalance('ntrenew@example.com');
  await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: 'pay_nt_renew',
    product_id: 'pdt_dreamer_pass_notrial_test',
    customer: { customer_id: 'cus_ntr', email: 'ntrenew@example.com' }
  })));
  var record = await entitlements.getEntitlement({}, 'ntrenew@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY);
});

test('a pack purchase is NEVER mis-recognized as a variant pass even with all three pass env vars configured', async function () {
  await seedZeroBalance('packnotpass@example.com');
  var res = await handler(signedEvent(paymentPayload({
    payment_id: 'pay_pack_not_pass',
    product_cart: [{ product_id: 'pdt_pack499_test', quantity: 1 }],
    metadata: {},
    customer: { customer_id: 'cus_pnp', email: 'packnotpass@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'packnotpass@example.com');
  assert.equal(record.tokens.balance, 1000, 'pack499 still credits its own 1000, never the 3000 pass lump');
  assert.equal(record.subscription, undefined);
});

test('the notrial first charge fires the Subscribe conversion tagged with variant=notrial', async function () {
  await seedZeroBalance('ntconv@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_nt_conv',
    product_cart: [{ product_id: 'pdt_dreamer_pass_notrial_test', quantity: 1 }],
    total_amount: 799, // $7.99, the notrial price
    metadata: { dreamtube_pass_variant: 'notrial', dreamtube_event_id: 'evt-nt-conv' },
    customer: { customer_id: 'cus_ntc', email: 'ntconv@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  assert.equal(spies.posthogCalls.length, 1);
  var phBody = spies.posthogCalls[0].body;
  assert.equal(phBody.properties.variant, 'notrial', 'the conversion event carries which variant was bought');
  assert.equal(phBody.properties.value, 7.99, 'value is the REAL charged amount, not a hardcoded $9.99');
  assert.equal(spies.metaCalls[0].body.data[0].event_name, 'Subscribe');
});

// ============================================================================
// trial50 PAID-TRIAL abuse hole (money-critical fix). The trial50 variant is a
// $9.99/mo pass with a 50c PAID trial. Before the fix, dodo-webhook.js gated
// the Dreamer Pass 3,000-token grant on `chargedAmount > 0`, so the 50c
// trial-START charge (50 > 0) granted the FULL 3,000-token month AND flipped
// the account to 'active' immediately — a user could pay 50c, burn ~30 videos
// of fal.ai cost, and cancel, then get ANOTHER 3,000 at the $9.99 conversion.
// The fix: a trial50 charge that lands while the subscription is still trialing
// (isTrialActive, owned by subscription.active) is a trial-START and grants
// TRIAL-level access only — the 3,000 lump lands only at the first POST-trial
// (real) billing, exactly like the freetrial $0 path. The discriminator is the
// subscription's trial STATE, NOT the charged amount (Dodo's Payment payload
// carries no trial/billing_reason field). See dodo-webhook.js's
// handleDreamerPassPayment trial-start guard.
// ============================================================================

test('SECURITY (abuse hole): a trial50 50c TRIAL-START grants NOTHING, stays trialing, and does NOT flip to active — the 50c is a trial fee, not a purchase', async function () {
  var email = 'trial50start@example.com';
  await seedZeroBalance(email);
  var spies = installAnalyticsFetchSpy();
  // Trial begins: subscription.active(trialing) for the trial50 product sets
  // the 100/day boost + trialEnd (Dodo delivers this BEFORE the trial-start
  // payment.succeeded).
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing',
    product_id: 'pdt_dreamer_pass_trial50_test',
    trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    customer: { customer_id: 'cus_t50s', email: email }
  })));

  // Dodo charges the 50c trial fee -> payment.succeeded with total_amount 50
  // (> 0, which the OLD guard mistook for a real charge).
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_trial50_start',
    product_cart: [{ product_id: 'pdt_dreamer_pass_trial50_test', quantity: 1 }],
    total_amount: 50,
    metadata: { dreamtube_pass_variant: 'trial50', dreamtube_event_id: 'evt-t50-start' },
    customer: { customer_id: 'cus_t50s', email: email }
  })));
  assert.equal(res.statusCode, 200, 'the 50c trial-start is still acknowledged');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 0, 'a 50c trial-start must NOT grant the 3,000 monthly lump');
  assert.equal(record.subscription.status, 'trialing', 'the 50c trial-start must NOT flip the account out of trialing');
  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 100, 'still trialing -> the 100/day boost stays intact, granting only trial-level access');
  assert.equal(spies.posthogCalls.length, 0, 'a trial-start authorization must fire NO conversion');
  assert.equal(spies.metaCalls.length, 0);
});

test('a trial50 FIRST REAL billing ($9.99, trial ended) grants the 3,000 and flips to active, firing the Subscribe conversion tagged variant=trial50', async function () {
  var email = 'trial50convert@example.com';
  await seedZeroBalance(email);
  // Trial has ELAPSED: status still 'trialing' from checkout, but trialEnd is
  // now in the past (the entitlements-documented "trial elapsed before a
  // webhook flipped it" state) -> isTrialActive is false -> the $9.99 charge is
  // a real billing, not a trial fee.
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing',
    product_id: 'pdt_dreamer_pass_trial50_test',
    trial_end_date: new Date(Date.now() - 1000).toISOString(),
    customer: { customer_id: 'cus_t50c', email: email }
  })));
  var spies = installAnalyticsFetchSpy();

  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_trial50_convert',
    product_cart: [{ product_id: 'pdt_dreamer_pass_trial50_test', quantity: 1 }],
    total_amount: 999,
    metadata: { dreamtube_pass_variant: 'trial50', dreamtube_event_id: 'evt-t50-convert' },
    customer: { customer_id: 'cus_t50c', email: email }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'the real $9.99 first billing grants the full 3,000-token month');
  assert.equal(record.subscription.status, 'active', 'the real charge flips the account to active');
  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 20, 'a paid subscriber is no longer trialing -> normal 20 claim');

  assert.equal(spies.posthogCalls.length, 1, 'the first REAL charge fires the conversion');
  assert.equal(spies.posthogCalls[0].body.properties.variant, 'trial50');
  assert.equal(spies.posthogCalls[0].body.properties.value, 9.99);
  assert.equal(spies.metaCalls[0].body.data[0].event_name, 'Subscribe', 'the first real trial50 charge fires Meta Subscribe (a subscription start), exactly like the freetrial conversion');
});

test('a trial50 $9.99 grant to a fresh account with NO live trial still grants 3,000 (a real charge, no trial window to suppress it)', async function () {
  // Guards the realistic post-conversion / renewal case: once trialEnd is not
  // in the future, a trial50 charge is an ordinary real billing.
  await seedZeroBalance('t50notrial@example.com');
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_t50_no_trial',
    product_cart: [{ product_id: 'pdt_dreamer_pass_trial50_test', quantity: 1 }],
    total_amount: 999,
    metadata: {},
    customer: { customer_id: 'cus_t50n', email: 't50notrial@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 't50notrial@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY);
});

test('IDEMPOTENCY: a redelivered trial50 50c trial-start (same payment_id) still grants NOTHING and never flips to active', async function () {
  var email = 'trial50redeliver@example.com';
  await seedZeroBalance(email);
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing',
    product_id: 'pdt_dreamer_pass_trial50_test',
    trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    customer: { customer_id: 'cus_t50r', email: email }
  })));
  var payload = passPaymentPayload({
    payment_id: 'pay_trial50_redeliver',
    product_cart: [{ product_id: 'pdt_dreamer_pass_trial50_test', quantity: 1 }],
    total_amount: 50,
    metadata: { dreamtube_pass_variant: 'trial50' },
    customer: { customer_id: 'cus_t50r', email: email }
  });
  await handler(signedEvent(payload, { id: 'msg_t50_1' }));
  await handler(signedEvent(payload, { id: 'msg_t50_2' }));
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 0, 'a redelivered trial-start must still grant nothing');
  assert.equal(record.subscription.status, 'trialing', 'and must keep the account trialing');
});

test('NO LOST GRANT: even if a trial50 conversion payment.succeeded arrives while the record still reads trialing (boundary), subscription.renewed still grants the 3,000 exactly once', async function () {
  var email = 'trial50backstop@example.com';
  await seedZeroBalance(email);
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing',
    product_id: 'pdt_dreamer_pass_trial50_test',
    trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    customer: { customer_id: 'cus_t50b', email: email }
  })));
  var sharedPaymentId = 'pay_trial50_backstop';
  // The conversion payment.succeeded arrives while the record still reads
  // trialing (in-future trialEnd) -> the payment path conservatively SKIPS it.
  await handler(signedEvent(passPaymentPayload({
    payment_id: sharedPaymentId,
    product_cart: [{ product_id: 'pdt_dreamer_pass_trial50_test', quantity: 1 }],
    total_amount: 999,
    metadata: { dreamtube_pass_variant: 'trial50' },
    customer: { customer_id: 'cus_t50b', email: email }
  })));
  var afterPayment = await entitlements.getEntitlement({}, email);
  assert.equal(afterPayment.tokens.balance, 0, 'the payment path skips while trialing — no grant yet');

  // subscription.renewed for the SAME charge grants the 3,000 (the backstop),
  // deduped by payment_id so the earlier skip + this grant total exactly one.
  await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: sharedPaymentId,
    product_id: 'pdt_dreamer_pass_trial50_test',
    customer: { customer_id: 'cus_t50b', email: email }
  })));
  var afterRenewed = await entitlements.getEntitlement({}, email);
  assert.equal(afterRenewed.tokens.balance, DREAMER_PASS_MONTHLY, 'subscription.renewed backstops the real conversion grant — exactly one 3,000, never lost');
});

test('freetrial is UNCHANGED by the trial50 guard: a freetrial charge while the account is trialing still grants (the guard is scoped to trial50 only)', async function () {
  var email = 'freetrialunaffected@example.com';
  await seedZeroBalance(email);
  // freetrial trial in progress (trialEnd in the future) — the trial50 guard
  // must NOT apply here.
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing',
    product_id: 'pdt_dreamer_pass_test', // freetrial product
    trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    customer: { customer_id: 'cus_ftu', email: email }
  })));
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_ft_unaffected',
    product_cart: [{ product_id: 'pdt_dreamer_pass_test', quantity: 1 }],
    total_amount: 999,
    metadata: {},
    customer: { customer_id: 'cus_ftu', email: email }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'a freetrial real charge grants 3,000 regardless of trialing state — byte-for-byte the pre-fix behavior');
  assert.equal(record.subscription.status, 'active');
});

test('LOW-2 (fail-closed): a trial50 50c trial-start whose entitlement read THROWS (Blobs fault) grants NOTHING — the read must fail closed, not open', async function () {
  // Before the LOW-2 fix, the guard read was `.catch(()=>null)`: a Blobs read
  // fault became `null`, read as "no trial in progress", and fell straight
  // through to grant the full 3,000 for a 50c trial-start. This test forces
  // exactly that read fault and asserts NOTHING is granted (fail closed). The
  // real charge is never lost — subscription.renewed backstops it (covered by
  // the "NO LOST GRANT" test above); here we only prove the 50c can't over-grant.
  var email = 'trial50readfault@example.com';
  await seedZeroBalance(email);
  // Trial begins normally (this subscription.active read/write happens BEFORE
  // the override is installed, so it succeeds and writes trialing + trialEnd).
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing',
    product_id: 'pdt_dreamer_pass_trial50_test',
    trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    customer: { customer_id: 'cus_t50rf', email: email }
  })));

  // Now make EVERY entitlements-store read throw — simulating a transient Blobs
  // read fault at exactly the moment the 50c trial-start payment.succeeded is
  // processed. The guard's getEntitlement is the first such read in the payment
  // path, so this is the read that must fail closed.
  mockBlobs.setReadOverride('dreamtube-entitlements', function () {
    throw new Error('simulated Blobs read fault');
  });
  var res;
  try {
    res = await handler(signedEvent(passPaymentPayload({
      payment_id: 'pay_trial50_readfault',
      product_cart: [{ product_id: 'pdt_dreamer_pass_trial50_test', quantity: 1 }],
      total_amount: 50,
      metadata: { dreamtube_pass_variant: 'trial50', dreamtube_event_id: 'evt-t50-readfault' },
      customer: { customer_id: 'cus_t50rf', email: email }
    })));
  } finally {
    mockBlobs.clearReadOverride('dreamtube-entitlements');
  }
  assert.equal(res.statusCode, 200, 'the webhook still acknowledges (never 5xx a Dodo redelivery)');

  // The read fault is cleared now, so this verification read succeeds.
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 0, 'fail closed: a read fault during a 50c trial-start must grant NOTHING, never the 3,000');
  assert.equal(record.subscription.status, 'trialing', 'and must not flip the account out of trialing');
});

test('notrial is UNCHANGED by the trial50 guard: a notrial first charge grants immediately (no trial window ever)', async function () {
  await seedZeroBalance('notrialunaffected@example.com');
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_nt_unaffected',
    product_cart: [{ product_id: 'pdt_dreamer_pass_notrial_test', quantity: 1 }],
    total_amount: 799,
    metadata: {},
    customer: { customer_id: 'cus_ntu', email: 'notrialunaffected@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'notrialunaffected@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'notrial has no trial -> its first charge grants immediately, unchanged');
  assert.equal(record.subscription.status, 'active');
});

test('subscription.update_payment_method is acknowledged and does not change subscription state', async function () {
  var email = 'updpay@example.com';
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'trialing', trial_end_date: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    customer: { customer_id: 'cus_up', email: email }
  })));
  var before = await entitlements.getEntitlement({}, email);
  var res = await handler(signedEvent(subEvent('subscription.update_payment_method', {
    status: undefined, customer: { customer_id: 'cus_up', email: email }
  })));
  assert.equal(res.statusCode, 200);
  var after = await entitlements.getEntitlement({}, email);
  assert.equal(after.subscription.status, before.subscription.status, 'update_payment_method must not flip a trialing account to active');
  assert.equal(after.subscription.status, 'trialing');
});

// ============================================================================
// Dreamer Pass server-side conversion tracking (tracker item
// for-product-build-conversion-tracking-fo-k5ow3q) — mirrors the pack path's
// Purchase-conversion coverage above (see "Server-side Purchase conversion"
// tests up top), for the subscription's two distinct charge shapes: the
// FIRST real charge (fires Meta 'Subscribe') and every later renewal (fires
// Meta 'Purchase'). See dodo-webhook.js's fireDreamerPassConversion doc
// comment for the full mechanics this proves.
// ============================================================================

test('a Dreamer Pass first real charge (payment.succeeded) fires Meta Subscribe + PostHog purchase_completed, value from the REAL total_amount, sharing eventId from metadata.dreamtube_event_id', async function () {
  await seedZeroBalance('passsubscribe@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_subscribe',
    customer: { customer_id: 'cus_ps', email: 'passsubscribe@example.com' },
    total_amount: 999,
    currency: 'USD',
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-pass-subscribe' }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'passsubscribe@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'the credit itself must still land');

  assert.equal(spies.posthogCalls.length, 1, 'expected exactly one PostHog capture call');
  var phBody = spies.posthogCalls[0].body;
  assert.equal(phBody.event, 'purchase_completed');
  assert.equal(phBody.properties.value, 9.99, 'value must be the REAL charged amount (999 cents / 100), not a hardcoded constant');
  assert.equal(phBody.properties.currency, 'USD');
  assert.equal(phBody.properties.subscription, true);
  assert.equal(phBody.properties.renewal, false, 'the FIRST charge is not a renewal');
  assert.equal(phBody.properties.plan, entitlements.DREAMER_PASS_PLAN);
  assert.equal(phBody.properties.$insert_id, 'evt-pass-subscribe', 'shares the eventId minted at subscription checkout creation');

  assert.equal(spies.metaCalls.length, 1, 'expected exactly one Meta CAPI call');
  var metaEvent = spies.metaCalls[0].body.data[0];
  assert.equal(metaEvent.event_name, 'Subscribe', 'the FIRST Dreamer Pass charge must fire Meta Subscribe, not Purchase');
  assert.equal(metaEvent.event_id, 'evt-pass-subscribe');
  assert.equal(metaEvent.custom_data.value, 9.99);
  assert.equal(metaEvent.custom_data.currency, 'USD');
});

test('a Dreamer Pass charge value scales with the REAL total_amount -- proving it is server-derived, not a hardcoded $9.99 constant', async function () {
  await seedZeroBalance('passvaluederiv@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_value_deriv',
    customer: { customer_id: 'cus_pvd', email: 'passvaluederiv@example.com' },
    total_amount: 499, // a hypothetical different real charged amount -- never trust a fixed constant
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-pass-value-deriv' }
  })));
  assert.equal(spies.posthogCalls[0].body.properties.value, 4.99, 'value must reflect whatever total_amount the Payment object actually carries, not a fixed $9.99 constant');
  assert.equal(spies.metaCalls[0].body.data[0].custom_data.value, 4.99);
});

test('a Dreamer Pass FIRST charge carrying metadata.dreamtube_fbc/dreamtube_fbp forwards them to Meta CAPI\'s user_data.fbc/fbp on the Subscribe event', async function () {
  await seedZeroBalance('passfbcsubscribe@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_fbc_subscribe',
    customer: { customer_id: 'cus_pfs', email: 'passfbcsubscribe@example.com' },
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-pass-fbc-subscribe', dreamtube_fbc: 'fb.1.1700000000000.subscribefbc', dreamtube_fbp: 'fb.1.1700000000000.subscribefbp' }
  })));

  assert.equal(spies.metaCalls.length, 1);
  var userData = spies.metaCalls[0].body.data[0].user_data;
  assert.equal(userData.fbc, 'fb.1.1700000000000.subscribefbc');
  assert.equal(userData.fbp, 'fb.1.1700000000000.subscribefbp');
});

test('a Dreamer Pass FIRST charge with no metadata.dreamtube_fbc/dreamtube_fbp still fires Subscribe normally, with no fbc/fbp on user_data', async function () {
  await seedZeroBalance('passnofbcsubscribe@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_no_fbc_subscribe',
    customer: { customer_id: 'cus_pnfs', email: 'passnofbcsubscribe@example.com' },
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-pass-no-fbc-subscribe' }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, 'passnofbcsubscribe@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'the credit must land regardless of fbc/fbp being absent');

  assert.equal(spies.metaCalls.length, 1, 'the Subscribe conversion must still fire');
  var userData = spies.metaCalls[0].body.data[0].user_data;
  assert.equal(userData.fbc, undefined);
  assert.equal(userData.fbp, undefined);
});

test('a $0 trial-start Dreamer Pass payment.succeeded fires NO conversion on either vendor (not a real charge)', async function () {
  await seedZeroBalance('passtrialconv@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_trial_conv', total_amount: 0,
    customer: { customer_id: 'cus_ptc', email: 'passtrialconv@example.com' }
  })));
  assert.equal(res.statusCode, 200);
  assert.equal(spies.posthogCalls.length, 0, 'a $0 trial-start authorization must never fire a conversion');
  assert.equal(spies.metaCalls.length, 0);
});

test('a redelivered Dreamer Pass first-charge event (same payment_id) does NOT re-fire the Subscribe conversion', async function () {
  await seedZeroBalance('passredeliverconv@example.com');
  var payload = passPaymentPayload({
    payment_id: 'pay_pass_redeliver_conv',
    customer: { customer_id: 'cus_prc', email: 'passredeliverconv@example.com' },
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-pass-redeliver' }
  });

  var spies1 = installAnalyticsFetchSpy();
  await handler(signedEvent(payload, { id: 'msg_pass_conv_first' }));
  assert.equal(spies1.posthogCalls.length, 1, 'the first, genuine delivery must fire Subscribe once');
  assert.equal(spies1.metaCalls.length, 1);

  var spies2 = installAnalyticsFetchSpy();
  await handler(signedEvent(payload, { id: 'msg_pass_conv_second' }));
  assert.equal(spies2.posthogCalls.length, 0, 'a redelivered, already-processed Dreamer Pass charge must NOT re-fire Subscribe');
  assert.equal(spies2.metaCalls.length, 0, 'a redelivered, already-processed Dreamer Pass charge must NOT re-fire the Meta CAPI event');
});

test('a Dreamer Pass RENEWAL (subscription.renewed) fires Meta Purchase + PostHog purchase_completed with renewal:true, value from the subscription\'s recurring_pre_tax_amount, and a FRESH eventId each time (never reused across renewals)', async function () {
  await seedZeroBalance('passrenewconv@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: 'pay_renew_conv_1',
    customer: { customer_id: 'cus_prn2', email: 'passrenewconv@example.com' },
    recurring_pre_tax_amount: 999,
    currency: 'USD',
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-static-sub-level' }
  })));
  assert.equal(res.statusCode, 200);

  assert.equal(spies.posthogCalls.length, 1);
  var phBody = spies.posthogCalls[0].body;
  assert.equal(phBody.properties.value, 9.99, 'value from recurring_pre_tax_amount (999 cents / 100)');
  assert.equal(phBody.properties.subscription, true);
  assert.equal(phBody.properties.renewal, true, 'a renewal charge must be tagged renewal:true');
  assert.notEqual(phBody.properties.$insert_id, 'evt-static-sub-level', 'must NOT reuse the static subscription-level metadata eventId -- would collapse every renewal into one Meta-deduped event');

  assert.equal(spies.metaCalls.length, 1);
  var metaEvent = spies.metaCalls[0].body.data[0];
  assert.equal(metaEvent.event_name, 'Purchase', 'a RENEWAL charge must fire Meta Purchase, not Subscribe');
  assert.equal(metaEvent.custom_data.value, 9.99);

  // Fire a SECOND renewal (a new payment_id, same subscription/metadata) and
  // prove its eventId differs from the first renewal's -- each is a distinct
  // conversion and must not collide via a reused static id.
  var spies2 = installAnalyticsFetchSpy();
  await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: 'pay_renew_conv_2',
    customer: { customer_id: 'cus_prn2', email: 'passrenewconv@example.com' },
    recurring_pre_tax_amount: 999,
    currency: 'USD',
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-static-sub-level' }
  })));
  assert.equal(spies2.posthogCalls.length, 1, 'a second, genuinely new renewal charge must fire its own conversion');
  assert.notEqual(spies2.posthogCalls[0].body.properties.$insert_id, phBody.properties.$insert_id, 'each renewal must get its own distinct eventId, never the shared subscription-level metadata one');
});

test('a Dreamer Pass RENEWAL reads fbc/fbp off the SUBSCRIPTION\'s own (static, lifetime) metadata.dreamtube_fbc/dreamtube_fbp and forwards them to Meta CAPI\'s user_data', async function () {
  await seedZeroBalance('passrenewfbc@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: 'pay_renew_fbc_1',
    customer: { customer_id: 'cus_prfbc', email: 'passrenewfbc@example.com' },
    recurring_pre_tax_amount: 999,
    currency: 'USD',
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-static-sub-level-fbc', dreamtube_fbc: 'fb.1.1700000000000.renewfbc', dreamtube_fbp: 'fb.1.1700000000000.renewfbp' }
  })));

  assert.equal(spies.metaCalls.length, 1);
  var userData = spies.metaCalls[0].body.data[0].user_data;
  assert.equal(userData.fbc, 'fb.1.1700000000000.renewfbc');
  assert.equal(userData.fbp, 'fb.1.1700000000000.renewfbp');
});

test('a Dreamer Pass RENEWAL with no metadata.dreamtube_fbc/dreamtube_fbp still fires Purchase normally, with no fbc/fbp on user_data', async function () {
  await seedZeroBalance('passrenewnofbc@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: 'pay_renew_no_fbc_1',
    customer: { customer_id: 'cus_prnofbc', email: 'passrenewnofbc@example.com' },
    recurring_pre_tax_amount: 999,
    currency: 'USD'
  })));
  assert.equal(res.statusCode, 200);

  assert.equal(spies.metaCalls.length, 1, 'the renewal conversion must still fire');
  var userData = spies.metaCalls[0].body.data[0].user_data;
  assert.equal(userData.fbc, undefined);
  assert.equal(userData.fbp, undefined);
});

test('a redelivered Dreamer Pass renewal (subscription.renewed then payment.succeeded sharing the SAME payment_id) fires the conversion only ONCE', async function () {
  await seedZeroBalance('passrenewdedup@example.com');
  var sharedPaymentId = 'pay_renew_dedup_shared';
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: sharedPaymentId,
    customer: { customer_id: 'cus_prd', email: 'passrenewdedup@example.com' },
    recurring_pre_tax_amount: 999,
    currency: 'USD'
  })));
  assert.equal(spies.posthogCalls.length, 1, 'the genuine renewal fires once');
  assert.equal(spies.metaCalls.length, 1);

  var spies2 = installAnalyticsFetchSpy();
  await handler(signedEvent(passPaymentPayload({
    payment_id: sharedPaymentId,
    customer: { customer_id: 'cus_prd', email: 'passrenewdedup@example.com' }
  })));
  assert.equal(spies2.posthogCalls.length, 0, 'a payment.succeeded sharing the SAME payment_id as an already-credited renewal must not double-fire the conversion');
  assert.equal(spies2.metaCalls.length, 0);
});

test('subscription.renewed with NO payment_id (no credit -> credited:false path) fires NO conversion', async function () {
  await seedZeroBalance('passrenewnoidconv@example.com');
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(subEvent('subscription.renewed', {
    customer: { customer_id: 'cus_prni', email: 'passrenewnoidconv@example.com' },
    recurring_pre_tax_amount: 999,
    currency: 'USD'
    // no payment_id
  })));
  assert.equal(spies.posthogCalls.length, 0, 'no payment_id means no credit, which means no conversion to report');
  assert.equal(spies.metaCalls.length, 0);
});

test('a Dreamer Pass renewal with no resolvable recurring_pre_tax_amount skips the conversion fire entirely -- never guesses a value', async function () {
  await seedZeroBalance('passrenewnoamount@example.com');
  var spies = installAnalyticsFetchSpy();
  var res = await handler(signedEvent(subEvent('subscription.renewed', {
    payment_id: 'pay_renew_no_amount',
    customer: { customer_id: 'cus_prna', email: 'passrenewnoamount@example.com' }
    // no recurring_pre_tax_amount at all
  })));
  assert.equal(res.statusCode, 200);
  // The credit itself still lands (grantDreamerPassCharge doesn't need a price)...
  var record = await entitlements.getEntitlement({}, 'passrenewnoamount@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'the token credit must still land even though the price is unresolvable');
  // ...but no conversion is reported, since there's no real amount to guess.
  assert.equal(spies.posthogCalls.length, 0, 'must not guess a value -- no conversion fire at all');
  assert.equal(spies.metaCalls.length, 0);
});

test('a Meta CAPI / PostHog failure on the Dreamer Pass conversion never blocks the token credit or the webhook\'s 200 response, and BOTH are logged for visibility with the failing Meta event name', async function () {
  await seedZeroBalance('passconvdown@example.com');
  var spies = installAnalyticsFetchSpy({ posthogFails: true, metaFails: true });
  var captured = await captureConsoleLogsDuring(function () {
    return handler(signedEvent(passPaymentPayload({
      payment_id: 'pay_pass_conv_down',
      customer: { customer_id: 'cus_pcd', email: 'passconvdown@example.com' },
      metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-pass-down' }
    })));
  });
  var res = captured.result;
  assert.equal(res.statusCode, 200, 'an analytics failure must never surface as a webhook failure');
  var record = await entitlements.getEntitlement({}, 'passconvdown@example.com');
  assert.equal(record.tokens.balance, DREAMER_PASS_MONTHLY, 'the token credit must still have landed');

  // Same visibility fix as the pack-purchase path above, for
  // fireDreamerPassConversion's own Promise.all -- this is the FIRST charge
  // (Subscribe), so the log line must identify it as such, and carry the
  // payment_id to correlate against the real Dodo charge.
  var metaLine = captured.lines.find(function (l) { return l.indexOf('conversion.meta_capi_failed[dreamer_pass_Subscribe]') !== -1; });
  assert.ok(metaLine, 'a Meta CAPI failure on the Dreamer Pass FIRST charge must log conversion.meta_capi_failed[dreamer_pass_Subscribe] -- got: ' + JSON.stringify(captured.lines));
  assert.match(metaLine, /"payment_id":"pay_pass_conv_down"/);
  assert.match(metaLine, /"email":"passconvdown@example\.com"/);
  assert.match(metaLine, /meta down/);
  assert.ok(metaLine.indexOf(REAL_META_TOKEN) === -1, 'the raw Meta access token must NEVER appear in a log line');

  var postHogLine = captured.lines.find(function (l) { return l.indexOf('conversion.posthog_failed[dreamer_pass_Subscribe]') !== -1; });
  assert.ok(postHogLine, 'a PostHog failure on the Dreamer Pass FIRST charge must log conversion.posthog_failed[dreamer_pass_Subscribe] -- got: ' + JSON.stringify(captured.lines));
  assert.match(postHogLine, /"payment_id":"pay_pass_conv_down"/);
});

test('a Meta CAPI failure on a Dreamer Pass RENEWAL is logged tagged dreamer_pass_Purchase (not Subscribe), correlated by payment_id', async function () {
  await seedZeroBalance('passrenewconvdown@example.com');
  installAnalyticsFetchSpy({ metaFails: true });
  var captured = await captureConsoleLogsDuring(function () {
    return handler(signedEvent(subEvent('subscription.renewed', {
      payment_id: 'pay_renew_conv_down',
      customer: { customer_id: 'cus_prcd', email: 'passrenewconvdown@example.com' },
      recurring_pre_tax_amount: 999,
      currency: 'USD'
    })));
  });
  assert.equal(captured.result.statusCode, 200, 'an analytics failure must never surface as a webhook failure');

  var metaLine = captured.lines.find(function (l) { return l.indexOf('conversion.meta_capi_failed[dreamer_pass_Purchase]') !== -1; });
  assert.ok(metaLine, 'a Meta CAPI failure on a Dreamer Pass RENEWAL must log conversion.meta_capi_failed[dreamer_pass_Purchase], not Subscribe -- got: ' + JSON.stringify(captured.lines));
  assert.match(metaLine, /"payment_id":"pay_renew_conv_down"/, 'the renewal\'s own payment_id must be logged, to correlate against the real Dodo charge');
});

test('the Dreamer Pass conversion\'s distinct_id resolves the same way as the pack path -- account username, falling back to normalized email', async function () {
  await seedZeroBalance('passdistinctid@example.com');
  await accountStore.createAccount({}, { username: 'passdistinctiduser', password: 'testpass1', email: 'passdistinctid@example.com' });
  var spies = installAnalyticsFetchSpy();
  await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_pass_distinct',
    customer: { customer_id: 'cus_pdi', email: 'passdistinctid@example.com' },
    metadata: { dreamtube_plan: 'dreamer_pass', dreamtube_event_id: 'evt-pass-distinct' }
  })));
  assert.equal(spies.posthogCalls[0].body.distinct_id, 'passdistinctiduser');
});

// ============================================================================
// TRIAL-STATE SYNTHESIS (money-path fix, 2026-08-10 — founder repro on two real
// Dodo subscriptions). The confirmed live bug: Dodo reports EVERY Dreamer Pass
// trial — the $0 freetrial AND the paid trial50 — with status:'active',
// trialing:false, trial_end:null. It has NO 'trialing' status at all. So the
// 100/day trial boost (entitlements.isTrialActive, which requires
// status==='trialing') NEVER fired during a trial — users got the normal
// 20/day. The fix: for a TRIAL-start subscription.active we synthesize the
// 'trialing' state ourselves, writing trialEnd = Dodo's own first-period end
// (next_billing_date / current_period_end), while the notrial product (which
// has NO trial) is never synthesized and grants its 3,000 immediately. See
// dodo-webhook.js's handleSubscriptionEvent TRIAL-STATE SYNTHESIS block and
// firstPeriodIsTrial / resolveSynthesizedTrialEnd.
//
// These payloads model Dodo's REAL shape: status:'active' (NOT overridden to
// trialing), trialing:false, no trial_end field, but a real trial_period_days
// + next_billing_date (the trial-end date). Contrast the earlier tests above,
// which fed an explicit status:'trialing' Dodo does not actually send.
// ============================================================================

test('REAL DODO BUG (free trial): a freetrial subscription.active arriving status:active/trialing:false/trial_end:null is SYNTHESIZED as trialing from currentPeriodEnd — 100/day fires, trialEnd = next_billing_date, and NO 3,000 lump lands', async function () {
  var email = 'realfreetrial@example.com';
  await seedZeroBalance(email);
  var trialEnd = Date.now() + 3 * DAY_MS;
  var res = await handler(signedEvent(subEvent('subscription.active', {
    status: 'active',            // Dodo's REAL label during a trial (no 'trialing' status exists)
    trialing: false,             // Dodo's REAL label
    // no trial_end field at all — Dodo's Subscription doesn't expose one
    trial_period_days: 3,
    created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(), // = the 3-day trial end
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_rft', email: email }
  })));
  assert.equal(res.statusCode, 200);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.subscription.status, 'trialing', 'we synthesize trialing despite Dodo saying active');
  assert.equal(record.subscription.trialEnd, trialEnd, 'trialEnd = Dodo\'s own first-period end (next_billing_date)');
  assert.equal(record.active, true);
  assert.equal(record.tokens.balance, 0, 'no 3,000 lump during the trial');

  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 100, 'THE FIX: the 100/day boost fires during the trial, not 20');
});

test('after a synthesized freetrial trial, the $0 trial-start payment.succeeded grants NOTHING and the 100/day boost stays intact', async function () {
  var email = 'realfreetrialzero@example.com';
  await seedZeroBalance(email);
  var trialEnd = Date.now() + 3 * DAY_MS;
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 3, created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_rftz', email: email }
  })));
  await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_real_ft_zero', total_amount: 0,
    product_cart: [{ product_id: 'pdt_dreamer_pass_test', quantity: 1 }],
    customer: { customer_id: 'cus_rftz', email: email }
  })));
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 0, 'the $0 trial-start still grants nothing (unchanged guard)');
  assert.equal(record.subscription.status, 'trialing', 'and the account stays in the synthesized trial');
  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 100, 'boost intact');
});

test('REAL DODO BUG (paid trial): a trial50 subscription.active arriving status:active is SYNTHESIZED as trialing — 100/day fires, and the $1 paid-trial charge grants NO 3,000 lump (trial50 abuse-hole guard now actually engages)', async function () {
  var email = 'realtrial50@example.com';
  await seedZeroBalance(email);
  var trialEnd = Date.now() + 3 * DAY_MS;
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 3, created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_trial50_test',
    customer: { customer_id: 'cus_rt50', email: email }
  })));
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.subscription.status, 'trialing', 'the paid trial is synthesized as trialing too');
  assert.equal(record.subscription.trialEnd, trialEnd);
  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 100, 'the paid trial also boosts to 100/day');

  // The $1 paid-trial fee lands WHILE trialing -> the trial50 guard (which
  // relies on this synthesized trialing state) skips the lump. Before this fix
  // the record read 'active', so that guard never engaged.
  await handler(signedEvent(passPaymentPayload({
    payment_id: 'pay_real_t50_start', total_amount: 100,
    product_cart: [{ product_id: 'pdt_dreamer_pass_trial50_test', quantity: 1 }],
    metadata: { dreamtube_pass_variant: 'trial50' },
    customer: { customer_id: 'cus_rt50', email: email }
  })));
  var afterCharge = await entitlements.getEntitlement({}, email);
  assert.equal(afterCharge.tokens.balance, 0, 'the $1 paid-trial fee must NOT grant the 3,000 lump');
  assert.equal(afterCharge.subscription.status, 'trialing', 'still trialing after the trial fee');
});

test('at the REAL first billing after a synthesized trial (subscription.renewed), the 3,000 lump grants exactly once and flips to active — idempotent across a redelivery', async function () {
  var email = 'realtrialrenew@example.com';
  await seedZeroBalance(email);
  var trialEnd = Date.now() + 3 * DAY_MS;
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 3, created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_rtr', email: email }
  })));
  // Trial converts: the first real billing arrives as subscription.renewed with
  // next_billing now a month out (the trial is over).
  var renewPayload = subEvent('subscription.renewed', {
    payment_id: 'pay_real_first_billing',
    product_id: 'pdt_dreamer_pass_test',
    status: 'active',
    next_billing_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    recurring_pre_tax_amount: 999, currency: 'USD',
    customer: { customer_id: 'cus_rtr', email: email }
  });
  await handler(signedEvent(renewPayload, { id: 'msg_first_billing_1' }));
  var afterFirst = await entitlements.getEntitlement({}, email);
  assert.equal(afterFirst.tokens.balance, DREAMER_PASS_MONTHLY, 'the 3,000 lands at the real first billing (isTrialActive now false)');
  assert.equal(afterFirst.subscription.status, 'active', 'trial over -> active');
  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 20, 'paid subscriber -> normal 20/day');

  await handler(signedEvent(renewPayload, { id: 'msg_first_billing_2' }));
  var afterRedeliver = await entitlements.getEntitlement({}, email);
  assert.equal(afterRedeliver.tokens.balance, DREAMER_PASS_MONTHLY, 'a redelivered first billing must not add a second 3,000');
});

test('notrial subscription.active is NEVER synthesized as trialing (trial_period_days 0) — stays active, and its own immediate payment.succeeded grants 3,000 exactly once (idempotent)', async function () {
  var email = 'realnotrial@example.com';
  await seedZeroBalance(email);
  // notrial: Dodo reports active, trial_period_days 0, first period a full month.
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 0,
    created_at: new Date().toISOString(),
    next_billing_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    product_id: 'pdt_dreamer_pass_notrial_test',
    customer: { customer_id: 'cus_rnt', email: email }
  })));
  var afterActive = await entitlements.getEntitlement({}, email);
  assert.equal(afterActive.subscription.status, 'active', 'notrial must NEVER be synthesized as trialing');
  assert.equal(afterActive.subscription.trialEnd, null, 'no trial end for a no-trial sub');
  assert.equal(afterActive.tokens.balance, 0, 'no lump yet — the immediate charge grants it, not the state event');
  var s1 = await entitlements.getTokenStatus({}, email);
  assert.equal(s1.dailyClaimAmount, 20, 'notrial is never boosted to 100');

  // The immediate real $7.99 charge grants the 3,000 up front (no 3-day wait).
  var payPayload = passPaymentPayload({
    payment_id: 'pay_real_notrial_charge',
    product_cart: [{ product_id: 'pdt_dreamer_pass_notrial_test', quantity: 1 }],
    total_amount: 799,
    metadata: { dreamtube_pass_variant: 'notrial' },
    customer: { customer_id: 'cus_rnt', email: email }
  });
  await handler(signedEvent(payPayload, { id: 'msg_nt_charge_1' }));
  var afterCharge = await entitlements.getEntitlement({}, email);
  assert.equal(afterCharge.tokens.balance, DREAMER_PASS_MONTHLY, 'notrial grants its 3,000 immediately');
  assert.equal(afterCharge.subscription.status, 'active');

  await handler(signedEvent(payPayload, { id: 'msg_nt_charge_2' }));
  var afterRedeliver = await entitlements.getEntitlement({}, email);
  assert.equal(afterRedeliver.tokens.balance, DREAMER_PASS_MONTHLY, 'a redelivered notrial charge must not double-grant');
});

test('trial discrimination falls back to the product VARIANT when trial_period_days is absent: a freetrial subscription.active with no trial_period_days still synthesizes trialing', async function () {
  var email = 'variantfallback@example.com';
  await seedZeroBalance(email);
  var trialEnd = Date.now() + 3 * DAY_MS;
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    // NO trial_period_days at all
    created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test', // freetrial -> has a trial
    customer: { customer_id: 'cus_vf', email: email }
  })));
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.subscription.status, 'trialing', 'variant (freetrial) resolves the trial when trial_period_days is missing');
  assert.equal(record.subscription.trialEnd, trialEnd);
});

test('trial discrimination LAST-RESORT falls back to first-period LENGTH: no trial_period_days and an unrecognized product_id — ~3 days out reads trial, ~1 month out reads paid', async function () {
  // ~3 days out -> trial
  var shortEmail = 'lengthshort@example.com';
  await seedZeroBalance(shortEmail);
  var trialEnd = Date.now() + 3 * DAY_MS;
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_rotated_unknown_variant', // resolves to no known variant
    metadata: {},
    customer: { customer_id: 'cus_ls', email: shortEmail }
  })));
  var shortRec = await entitlements.getEntitlement({}, shortEmail);
  assert.equal(shortRec.subscription.status, 'trialing', 'a ~3-day first period reads as a trial by length');

  // ~1 month out -> paid period (not a trial)
  var longEmail = 'lengthlong@example.com';
  await seedZeroBalance(longEmail);
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    created_at: new Date().toISOString(),
    next_billing_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    product_id: 'pdt_rotated_unknown_variant',
    metadata: {},
    customer: { customer_id: 'cus_ll', email: longEmail }
  })));
  var longRec = await entitlements.getEntitlement({}, longEmail);
  assert.equal(longRec.subscription.status, 'active', 'a ~1-month first period reads as a paid period, not a trial');
  assert.equal(longRec.subscription.trialEnd, null);
});

test('a redelivered subscription.active (replaying the ORIGINAL, now-elapsed first-period end) does NOT re-open the trial boost', async function () {
  var email = 'redeliveractive@example.com';
  await seedZeroBalance(email);
  // A redelivery arriving after the trial converted replays the original
  // payload, whose first-period end is by now in the PAST.
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 3,
    created_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    next_billing_date: new Date(Date.now() - 1000).toISOString(), // trial end already passed
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_rda', email: email }
  })));
  var record = await entitlements.getEntitlement({}, email);
  assert.notEqual(record.subscription.status, 'trialing', 'a past first-period end must not synthesize a live trial');
  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 20, 'no boost re-opened by a stale redelivery');
});

// ============================================================================
// plan_changed PRESERVATION (money-path fix, 2026-08-10; tracker item
// for-product-low-subscription-plan-change-clww6d). subscription.plan_changed
// carries no reliable trial info of its own, so before this fix it ALWAYS
// wrote status:'active', trialEnd:null — even when the account was still
// genuinely inside its synthesized trial window — silently ending the 100/day
// boost early. The fix: a plan_changed event now reads the account's
// CURRENTLY STORED subscription state and preserves it if still genuinely
// trialing (trialEnd in the future); a genuinely-elapsed trial still
// correctly transitions to 'active'; notrial (never trialing) is unaffected.
// ============================================================================

test('subscription.plan_changed during a still-future synthesized trial PRESERVES the trialing state and 100/day boost (does not wipe it to active)', async function () {
  var email = 'planchangemidtrial@example.com';
  await seedZeroBalance(email);
  var trialEnd = Date.now() + 3 * DAY_MS;
  // Trial starts via the real Dodo shape (status:'active', no trial_end field
  // of its own) — same as the trial-synthesis tests above.
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 3, created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pcmt', email: email }
  })));
  var beforeChange = await entitlements.getEntitlement({}, email);
  assert.equal(beforeChange.subscription.status, 'trialing', 'sanity: trial synthesized');

  // Mid-trial, Dodo fires plan_changed -- its payload carries no trial info
  // (status:'active', no trial_end/trial_period_days), same shape a real
  // plan_changed carries.
  var res = await handler(signedEvent(subEvent('subscription.plan_changed', {
    status: 'active', trialing: false,
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pcmt', email: email }
  })));
  assert.equal(res.statusCode, 200);

  var afterChange = await entitlements.getEntitlement({}, email);
  assert.equal(afterChange.subscription.status, 'trialing', 'THE FIX: plan_changed must not wipe an in-progress trial to active');
  assert.equal(afterChange.subscription.trialEnd, trialEnd, 'the prior synthesized trialEnd is preserved, not cleared');

  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 100, 'the 100/day boost survives the mid-trial plan_changed');
});

test('subscription.plan_changed AFTER a trial has genuinely ended correctly transitions to active (does not indefinitely re-preserve a stale trialing state)', async function () {
  var email = 'planchangepostrial@example.com';
  await seedZeroBalance(email);
  // Trial starts with an end date already in the past by the time
  // plan_changed arrives (simulating time passing between the two events).
  var trialEnd = Date.now() - 1000;
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 3, created_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pcpt', email: email }
  })));
  var beforeChange = await entitlements.getEntitlement({}, email);
  assert.notEqual(beforeChange.subscription.status, 'trialing', 'sanity: a past first-period end never synthesizes a live trial in the first place');

  var res = await handler(signedEvent(subEvent('subscription.plan_changed', {
    status: 'active', trialing: false,
    next_billing_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pcpt', email: email }
  })));
  assert.equal(res.statusCode, 200);

  var afterChange = await entitlements.getEntitlement({}, email);
  assert.equal(afterChange.subscription.status, 'active', 'a genuinely-elapsed trial correctly transitions to active on plan_changed');
  assert.equal(afterChange.subscription.trialEnd, null, 'trialEnd is cleared, not stuck on the stale value');

  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 20, 'no lingering 100/day boost after a genuinely-ended trial\'s plan_changed');
});

test('subscription.plan_changed for a STILL-TRIALING record whose stored trialEnd has since elapsed (never got a follow-up event) also transitions to active, not stuck preserving a stale trial', async function () {
  var email = 'planchangestaletrialing@example.com';
  await seedZeroBalance(email);
  // Trial synthesized with a short, now-elapsed window: status stays
  // 'trialing' on the stored record (no later event ever flipped it), but
  // trialEnd itself has passed by the time plan_changed arrives.
  var trialEnd = Date.now() + 150; // effectively already elapsed by the time we check below
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 3, created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pcst', email: email }
  })));
  var beforeChange = await entitlements.getEntitlement({}, email);
  assert.equal(beforeChange.subscription.status, 'trialing', 'sanity: trial synthesized and still stored as trialing');

  // Let the trialEnd actually elapse before plan_changed arrives.
  await new Promise(function (resolve) { setTimeout(resolve, 300); });

  var res = await handler(signedEvent(subEvent('subscription.plan_changed', {
    status: 'active', trialing: false,
    next_billing_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pcst', email: email }
  })));
  assert.equal(res.statusCode, 200);

  var afterChange = await entitlements.getEntitlement({}, email);
  assert.equal(afterChange.subscription.status, 'active', 'the stored trialing status alone is not enough -- trialEnd must still be in the future to preserve it');
  assert.equal(afterChange.subscription.trialEnd, null);
});

test('subscription.plan_changed for a notrial subscription is completely unaffected (never reads trialing, regression coverage for the preservation carve-out)', async function () {
  var email = 'planchangenotrial@example.com';
  await seedZeroBalance(email);
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 0,
    created_at: new Date().toISOString(),
    next_billing_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    product_id: 'pdt_dreamer_pass_notrial_test',
    customer: { customer_id: 'cus_pcnt', email: email }
  })));
  var beforeChange = await entitlements.getEntitlement({}, email);
  assert.equal(beforeChange.subscription.status, 'active', 'sanity: notrial never synthesized as trialing');

  var res = await handler(signedEvent(subEvent('subscription.plan_changed', {
    status: 'active', trialing: false,
    next_billing_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    product_id: 'pdt_dreamer_pass_notrial_test',
    customer: { customer_id: 'cus_pcnt', email: email }
  })));
  assert.equal(res.statusCode, 200);

  var afterChange = await entitlements.getEntitlement({}, email);
  assert.equal(afterChange.subscription.status, 'active', 'notrial plan_changed must never read trialing');
  assert.equal(afterChange.subscription.trialEnd, null);

  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 20, 'notrial is never boosted to 100, plan_changed included');
});

test('subscription.plan_changed when Dodo\'s payload itself explicitly claims trialing:true is unaffected by the preservation carve-out (the explicit-payload path already handles it)', async function () {
  var email = 'planchangeexplicit@example.com';
  await seedZeroBalance(email);
  var trialEnd = Date.now() + 3 * DAY_MS;
  var res = await handler(signedEvent(subEvent('subscription.plan_changed', {
    status: 'trialing',
    trial_end_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pce', email: email }
  })));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.subscription.status, 'trialing', 'an explicit trialing payload on plan_changed is honored via the pre-existing explicitTrialing path');
  assert.equal(record.subscription.trialEnd, trialEnd);
});

// ── FRESHNESS fix (recurring-pattern-pre-cas-re-69aaqh, 2026-08-17) ──
// The preservation decision above used to come from a separate
// entitlements.getEntitlement() read taken BEFORE updateSubscription's own
// CAS write started — a decision computed from that read and handed in as a
// static patch could go stale before the CAS write's own read-mutate-write
// loop even began (CAS protects a write from being LOST, not from its own
// CONTENT being built on stale data). The fix moved this decision inside
// updateSubscription's new function-form subPatch, so it's now made against
// the CAS write's own fresh read on whichever attempt actually succeeds.
// This test proves that end to end at the real dodo-webhook.js call site:
// force the CAS write's FIRST attempt to observe a stale (rejected,
// mismatched-etag) snapshot that looks like the trial already ended, and
// confirm the handler still correctly preserves the trial — because the
// decision was (re-)made from the RETRY's fresh read, not memoized from the
// stale first attempt.
test('subscription.plan_changed preservation decides from the CAS write\'s own FRESH retry read, not a stale first attempt (freshness fix regression)', async function () {
  var email = 'planchangefreshretry@example.com';
  await seedZeroBalance(email);
  var trialEnd = Date.now() + 3 * DAY_MS;
  await handler(signedEvent(subEvent('subscription.active', {
    status: 'active', trialing: false,
    trial_period_days: 3, created_at: new Date().toISOString(),
    next_billing_date: new Date(trialEnd).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pcfr', email: email }
  })));
  var beforeChange = await entitlements.getEntitlement({}, email);
  assert.equal(beforeChange.subscription.status, 'trialing', 'sanity: trial synthesized');

  // Force updateSubscription's own CAS write to reject its first attempt:
  // that attempt observes a snapshot that LOOKS like the trial already
  // ended (as if a concurrent event had landed first), with an etag that
  // can never match the real current one. The retry must fall through to
  // the real, still-trialing stored state.
  mockBlobs.setCasReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) {
      return { value: { data: { email: key, tokens: { balance: 0 }, subscription: { status: 'active', trialEnd: null } }, etag: 'stale-etag-will-never-match', metadata: {} } };
    }
    return null;
  });

  var res;
  try {
    res = await handler(signedEvent(subEvent('subscription.plan_changed', {
      status: 'active', trialing: false,
      next_billing_date: new Date(trialEnd).toISOString(),
      product_id: 'pdt_dreamer_pass_test',
      customer: { customer_id: 'cus_pcfr', email: email }
    })));
  } finally {
    mockBlobs.clearCasReadOverride(entitlements.STORE_NAME);
  }
  assert.equal(res.statusCode, 200);

  var afterChange = await entitlements.getEntitlement({}, email);
  assert.equal(afterChange.subscription.status, 'trialing', 'THE FRESHNESS FIX: the preservation decision must be re-made from the CAS retry\'s own fresh read, correctly preserving the trial even though the first (rejected) attempt looked like it had already ended');
  assert.equal(afterChange.subscription.trialEnd, trialEnd);

  var status = await entitlements.getTokenStatus({}, email);
  assert.equal(status.dailyClaimAmount, 100, 'the 100/day boost survives, proving the real committed state (not just a decision variable) reflects the fresh read');
});

// Review finding (non-blocking, 2026-08-17): the decision function's prevSub
// degrades safely to {} when the account has no prior subscription record at
// all (entitlements.isTrialActive's own null/empty guard) -- this was true
// by construction but had no explicit test proving it stays true. A
// plan_changed arriving with no preceding subscription.active on file isn't
// a normal Dodo sequence, but the code must not throw or misbehave if it
// somehow does (a redelivery race, an out-of-order webhook, etc).
test('subscription.plan_changed on an account with NO prior subscription record at all degrades safely to active/no-trial (prevSub={} case, does not throw)', async function () {
  var email = 'planchangenopriorrecord@example.com';
  await seedZeroBalance(email); // entitlement record exists, but with no `subscription` field at all

  var res = await handler(signedEvent(subEvent('subscription.plan_changed', {
    status: 'active', trialing: false,
    next_billing_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    product_id: 'pdt_dreamer_pass_test',
    customer: { customer_id: 'cus_pcnp', email: email }
  })));
  assert.equal(res.statusCode, 200, 'must not throw/500 when prevSub is {} inside the decision function');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.subscription.status, 'active', 'no prior record means nothing to preserve -- correctly falls through to active');
  assert.equal(record.subscription.trialEnd, null);
});
