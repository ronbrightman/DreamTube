// test/reconcile-fal-cost.test.js
//
// Covers netlify/functions/reconcile-fal-cost.js's reconcileDate --
// tracker item for-product-real-per-job-fal-cost-loggin-360bxy. Mocks
// @netlify/blobs (test/helpers/mock-blobs.js, same convention as
// test/send-daily-claim-pushes.test.js -- this repo's other scheduled
// function) and global.fetch (both the fal usage API call and the PostHog
// capture call route through it -- distinguished here by URL, same spirit
// as test/dodo-webhook.test.js's multi-destination fetch spies). NEVER
// hits the real api.fal.ai or PostHog endpoints.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var realFetch = global.fetch;
var realAdminKey = process.env.FAL_ADMIN_KEY;

var reconcile = require('../netlify/functions/reconcile-fal-cost');
var falCostCategorize = require('../netlify/functions/lib/fal-cost-categorize');

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.FAL_ADMIN_KEY = 'test-admin-key';
});

test.afterEach(function () {
  global.fetch = realFetch;
  if (realAdminKey === undefined) delete process.env.FAL_ADMIN_KEY;
  else process.env.FAL_ADMIN_KEY = realAdminKey;
});

/**
 * Spies on global.fetch, routing fal's usage API and PostHog's capture API
 * to independently canned responses by URL. `falResponse`/`posthogStatus`
 * are optional overrides; sensible successful defaults are used otherwise.
 */
function installFetchSpy(opts) {
  opts = opts || {};
  var falCalls = [];
  var posthogCalls = [];
  global.fetch = async function (url, fetchOpts) {
    if (typeof url === 'string' && url.indexOf('api.fal.ai') !== -1) {
      falCalls.push({ url: url, opts: fetchOpts });
      if (opts.falThrows) throw opts.falThrows;
      if (opts.falStatus && opts.falStatus >= 300) {
        return { ok: false, status: opts.falStatus, text: async function () { return 'fal error'; } };
      }
      return {
        ok: true,
        status: 200,
        json: async function () { return opts.falBody || { time_series: [], has_more: false }; }
      };
    }
    // PostHog capture call.
    posthogCalls.push({ url: url, opts: fetchOpts, body: fetchOpts && fetchOpts.body ? JSON.parse(fetchOpts.body) : null });
    return {
      ok: (opts.posthogStatus || 200) < 300,
      status: opts.posthogStatus || 200,
      text: async function () { return 'ok'; }
    };
  };
  markInstalledFetchAsTestDouble();
  return { falCalls: falCalls, posthogCalls: posthogCalls };
}

function usageBody(records) {
  return { time_series: [{ bucket: '2026-07-30', results: records }], next_cursor: null, has_more: false };
}

test('reconcileDate: FAL_ADMIN_KEY missing -> no-op, no fal call, no Blobs write, no PostHog fire', async function () {
  delete process.env.FAL_ADMIN_KEY;
  var spies = installFetchSpy({});
  var event = fakeEvent({});

  var result = await reconcile.reconcileDate(event, '2026-07-30');

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'missing_fal_admin_key');
  assert.equal(spies.falCalls.length, 0);
  assert.equal(spies.posthogCalls.length, 0);

  var store = require('@netlify/blobs').getStore({ name: reconcile.STORE_NAME });
  assert.equal(await store.get('reconciled:2026-07-30'), undefined);
});

test('reconcileDate: successful reconciliation with real-shaped data -- splits by category, persists to Blobs, fires PostHog', async function () {
  var spies = installFetchSpy({
    falBody: usageBody([
      { endpoint_id: 'fal-ai/veo3.1/lite', unit: 'second', quantity: 8, unit_price: 0.03, cost_total: 0.24, currency: 'USD' },
      { endpoint_id: 'fal-ai/flux/dev', unit: 'image', quantity: 3, unit_price: 0.1, cost_total: 0.3, currency: 'USD' },
      { endpoint_id: 'fal-ai/whisper', unit: 'second', quantity: 20, unit_price: 0.02, cost_total: 0.4, currency: 'USD' },
      { endpoint_id: 'fal-ai/kling-video/v2/master/text-to-video', unit: 'second', quantity: 5, unit_price: 0.2, cost_total: 1.0, currency: 'USD' }
    ])
  });
  var event = fakeEvent({});

  var result = await reconcile.reconcileDate(event, '2026-07-30');

  assert.equal(result.ok, true);
  assert.equal(result.date, '2026-07-30');
  assert.equal(result.recordCount, 4);
  assert.equal(result.totalUsd, 1.94);
  assert.equal(result.byCategory[falCostCategorize.CATEGORIES.APP_VIDEO], 0.24);
  assert.equal(result.byCategory[falCostCategorize.CATEGORIES.APP_IMAGE], 0.3);
  assert.equal(result.byCategory[falCostCategorize.CATEGORIES.APP_OTHER], 0.4);
  assert.equal(result.byCategory[falCostCategorize.CATEGORIES.CREATIVE], 1.0);

  // Persisted durably to Blobs.
  var store = require('@netlify/blobs').getStore({ name: reconcile.STORE_NAME });
  var persisted = await store.get('reconciled:2026-07-30');
  assert.equal(persisted.totalUsd, 1.94);
  assert.equal(persisted.recordCount, 4);

  // Fired to PostHog once, with the per-category breakdown in properties.
  assert.equal(spies.posthogCalls.length, 1);
  var props = spies.posthogCalls[0].body.properties;
  assert.equal(spies.posthogCalls[0].body.event, 'fal_cost_reconciled_daily');
  assert.equal(props.date, '2026-07-30');
  assert.equal(props.total_usd, 1.94);
  assert.equal(props.app_video_usd, 0.24);
  assert.equal(props.app_image_usd, 0.3);
  assert.equal(props.app_other_usd, 0.4);
  assert.equal(props.creative_usd, 1.0);
  assert.equal(props.$insert_id, 'fal_cost_reconciled_daily:2026-07-30');
});

test('reconcileDate: includes an actual-vs-reserved comparison when spend-guard already has a reservation total for that date', async function () {
  var blobs = require('@netlify/blobs');
  var spendGuardStore = blobs.getStore({ name: 'dreamtube-spend-guard' });
  await spendGuardStore.setJSON('spend:2026-07-30', 2.4); // 2 reservations at $1.20 each

  installFetchSpy({
    falBody: usageBody([{ endpoint_id: 'fal-ai/veo3.1/lite', quantity: 8, unit_price: 0.03, cost_total: 1.94 }])
  });

  var result = await reconcile.reconcileDate(fakeEvent({}), '2026-07-30');

  assert.equal(result.ok, true);
  assert.equal(result.reservedUsd, 2.4);
  assert.equal(result.deltaUsd, -0.46); // round2(1.94 - 2.4), avoiding a raw floating-point comparison
});

test('reconcileDate: no prior spend-guard reservation for that date -> reservedUsd/deltaUsd are null, not a crash', async function () {
  installFetchSpy({ falBody: usageBody([{ endpoint_id: 'fal-ai/veo3.1/lite', quantity: 8, unit_price: 0.03, cost_total: 0.24 }]) });

  var result = await reconcile.reconcileDate(fakeEvent({}), '2026-07-30');

  assert.equal(result.ok, true);
  assert.equal(result.reservedUsd, null);
  assert.equal(result.deltaUsd, null);
});

test('reconcileDate: the fal API call failing -> ok:false, does not crash, does not write/corrupt any Blobs state', async function () {
  // Seed a prior day's already-reconciled record to prove it survives untouched.
  var store = require('@netlify/blobs').getStore({ name: reconcile.STORE_NAME });
  await store.setJSON('reconciled:2026-07-29', { date: '2026-07-29', totalUsd: 5, untouched: true });

  var spies = installFetchSpy({ falStatus: 500 });

  var result = await reconcile.reconcileDate(fakeEvent({}), '2026-07-30');

  assert.equal(result.ok, false);
  assert.match(result.error, /fal_usage_request_failed: 500/);
  assert.equal(await store.get('reconciled:2026-07-30'), undefined, 'must not write a partial record for the failed date');
  var priorDay = await store.get('reconciled:2026-07-29');
  assert.deepEqual(priorDay, { date: '2026-07-29', totalUsd: 5, untouched: true }, 'must not corrupt an unrelated already-persisted date');
  assert.equal(spies.posthogCalls.length, 0, 'must not fire an analytics event for a failed reconciliation');
});

test('reconcileDate: the fal API call throwing (network failure) -> ok:false, does not crash', async function () {
  installFetchSpy({ falThrows: new Error('ECONNRESET') });

  var result = await reconcile.reconcileDate(fakeEvent({}), '2026-07-30');

  assert.equal(result.ok, false);
  assert.match(result.error, /fal_usage_network_failure/);
});

test('reconcileDate: rerunning the same date is idempotent -- overwrites with the freshly recomputed total rather than accumulating', async function () {
  installFetchSpy({ falBody: usageBody([{ endpoint_id: 'fal-ai/veo3.1/lite', quantity: 8, unit_price: 0.03, cost_total: 0.24 }]) });
  var first = await reconcile.reconcileDate(fakeEvent({}), '2026-07-30');
  assert.equal(first.totalUsd, 0.24);

  installFetchSpy({ falBody: usageBody([{ endpoint_id: 'fal-ai/veo3.1/lite', quantity: 8, unit_price: 0.03, cost_total: 0.24 }, { endpoint_id: 'fal-ai/flux/dev', quantity: 3, unit_price: 0.1, cost_total: 0.3 }]) });
  var second = await reconcile.reconcileDate(fakeEvent({}), '2026-07-30');
  assert.equal(second.totalUsd, 0.54, 'reruns must reflect fal\'s current ledger, not accumulate on top of the prior run');

  var store = require('@netlify/blobs').getStore({ name: reconcile.STORE_NAME });
  var persisted = await store.get('reconciled:2026-07-30');
  assert.equal(persisted.totalUsd, 0.54);
});

test('utcDateString: returns yesterday (UTC) as YYYY-MM-DD for daysAgo=1', function () {
  var yesterday = reconcile.utcDateString(1);
  assert.match(yesterday, /^\d{4}-\d{2}-\d{2}$/);
  var expected = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(yesterday, expected);
});
