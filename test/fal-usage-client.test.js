// test/fal-usage-client.test.js
//
// Covers netlify/functions/lib/fal-usage-client.js — tracker item
// for-product-real-per-job-fal-cost-loggin-360bxy. Mocks global.fetch the
// same way test/posthog-capture.test.js does for its own outbound call
// (this codebase has no server SDK for either vendor, both are plain
// fetch() calls) -- NEVER hits the real api.fal.ai endpoint.

var test = require('node:test');
var assert = require('node:assert/strict');

var realFetch = global.fetch;
var realAdminKey = process.env.FAL_ADMIN_KEY;
// See test/helpers/fetch-double.js -- marks this file's own fetch double so
// fal-usage-client.js's own test-process guard lets these calls reach it
// instead of suppressing them (the same guard posthog-capture.js has, see
// that file's header comment -- this module duplicates it for its own real
// outbound call).
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');
var falUsageClient = require('../netlify/functions/lib/fal-usage-client');

test.beforeEach(function () {
  process.env.FAL_ADMIN_KEY = 'test-admin-key';
});

test.afterEach(function () {
  global.fetch = realFetch;
  if (realAdminKey === undefined) delete process.env.FAL_ADMIN_KEY;
  else process.env.FAL_ADMIN_KEY = realAdminKey;
});

/** Spies on global.fetch, returning `responses` in order (one per call) -- lets a test simulate multi-page pagination. */
function installFetchSpy(responses) {
  var calls = [];
  var i = 0;
  global.fetch = async function (url, opts) {
    calls.push({ url: url, opts: opts });
    var r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.throws) throw r.throws;
    return {
      ok: r.status === undefined || r.status < 300,
      status: r.status || 200,
      json: async function () { return r.body; },
      text: async function () { return r.status && r.status >= 300 ? 'fal error body' : 'ok'; }
    };
  };
  markInstalledFetchAsTestDouble();
  return calls;
}

test('fetchUsage: FAL_ADMIN_KEY missing -> { ok:false, error: missing_fal_admin_key }, never calls fetch', async function () {
  delete process.env.FAL_ADMIN_KEY;
  var calls = installFetchSpy([{ body: { time_series: [], has_more: false } }]);
  var res = await falUsageClient.fetchUsage('2026-07-30', '2026-07-30');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'missing_fal_admin_key');
  assert.equal(calls.length, 0);
});

test('fetchUsage: FAL_ADMIN_KEY blank/whitespace-only counts as missing', async function () {
  process.env.FAL_ADMIN_KEY = '   ';
  var calls = installFetchSpy([{ body: { time_series: [], has_more: false } }]);
  var res = await falUsageClient.fetchUsage('2026-07-30', '2026-07-30');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'missing_fal_admin_key');
  assert.equal(calls.length, 0);
});

test('fetchUsage: successful single-page pull with real-shaped data -- flattens buckets, sends Authorization: Key header', async function () {
  var calls = installFetchSpy([{
    body: {
      time_series: [
        {
          bucket: '2026-07-30T00:00:00-00:00',
          results: [
            { endpoint_id: 'fal-ai/veo3.1/lite', unit: 'second', quantity: 8, unit_price: 0.03, cost_total: 0.24, currency: 'USD', auth_method: 'Production Key' },
            { endpoint_id: 'fal-ai/flux/dev', unit: 'image', quantity: 3, unit_price: 0.1, cost_total: 0.3, currency: 'USD', auth_method: 'Production Key' }
          ]
        }
      ],
      next_cursor: null,
      has_more: false
    }
  }]);

  var res = await falUsageClient.fetchUsage('2026-07-30', '2026-07-30');

  assert.equal(res.ok, true);
  assert.equal(res.records.length, 2);
  assert.equal(res.records[0].endpoint_id, 'fal-ai/veo3.1/lite');
  assert.equal(res.records[0].cost, 0.24);
  assert.equal(res.records[1].endpoint_id, 'fal-ai/flux/dev');
  assert.equal(res.records[1].cost, 0.3);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.fal\.ai\/v1\/models\/usage\?limit=100&start=2026-07-30&end=2026-07-30$/);
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.headers.Authorization, 'Key test-admin-key');
});

test('fetchUsage: follows cursor pagination across multiple pages until has_more is false', async function () {
  var calls = installFetchSpy([
    { body: { time_series: [{ bucket: '2026-07-30', results: [{ endpoint_id: 'fal-ai/veo3.1/lite', quantity: 8, unit_price: 0.03, cost_total: 0.24 }] }], next_cursor: 'page-2-cursor', has_more: true } },
    { body: { time_series: [{ bucket: '2026-07-30', results: [{ endpoint_id: 'fal-ai/flux/dev', quantity: 3, unit_price: 0.1, cost_total: 0.3 }] }], next_cursor: null, has_more: false } }
  ]);

  var res = await falUsageClient.fetchUsage('2026-07-30', '2026-07-30');

  assert.equal(res.ok, true);
  assert.equal(res.records.length, 2);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0].url, /cursor=/);
  assert.match(calls[1].url, /cursor=page-2-cursor/);
});

test('fetchUsage: cost field fallback -- prefers cost_total, then cost, then derives quantity * unit_price', async function () {
  var calls = installFetchSpy([{
    body: {
      time_series: [{
        bucket: '2026-07-30',
        results: [
          { endpoint_id: 'a', quantity: 10, unit_price: 0.1, cost_total: 1.5, cost: 999 }, // cost_total wins
          { endpoint_id: 'b', quantity: 10, unit_price: 0.1, cost: 0.9 },                  // no cost_total -> cost
          { endpoint_id: 'c', quantity: 4, unit_price: 0.25 }                              // neither -> derived 4*0.25
        ]
      }],
      has_more: false
    }
  }]);

  var res = await falUsageClient.fetchUsage('2026-07-30', '2026-07-30');
  assert.equal(res.ok, true);
  assert.equal(res.records[0].cost, 1.5);
  assert.equal(res.records[1].cost, 0.9);
  assert.equal(res.records[2].cost, 1);
  assert.equal(calls.length, 1);
});

test('fetchUsage: a non-2xx response from fal -> { ok:false, error }, never throws', async function () {
  installFetchSpy([{ status: 401 }]);
  var res = await falUsageClient.fetchUsage('2026-07-30', '2026-07-30');
  assert.equal(res.ok, false);
  assert.match(res.error, /fal_usage_request_failed: 401/);
});

test('fetchUsage: fetch itself rejecting (network failure) -> { ok:false, error }, never throws', async function () {
  installFetchSpy([{ throws: new Error('ECONNRESET') }]);
  var res = await falUsageClient.fetchUsage('2026-07-30', '2026-07-30');
  assert.equal(res.ok, false);
  assert.match(res.error, /fal_usage_network_failure/);
  assert.match(res.error, /ECONNRESET/);
});

test('fetchUsage: malformed/empty response body -> ok:true with an empty records array, not a crash', async function () {
  installFetchSpy([{ body: {} }]);
  var res = await falUsageClient.fetchUsage('2026-07-30', '2026-07-30');
  assert.equal(res.ok, true);
  assert.deepEqual(res.records, []);
});

test('fetchUsage: missing start/end date -> { ok:false, error }, never calls fetch', async function () {
  var calls = installFetchSpy([{ body: { time_series: [], has_more: false } }]);
  var res = await falUsageClient.fetchUsage(null, '2026-07-30');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'start_and_end_date_required');
  assert.equal(calls.length, 0);
});
