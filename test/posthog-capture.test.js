// test/posthog-capture.test.js
//
// Covers netlify/functions/lib/posthog-capture.js — the new server-side
// PostHog capture helper added for Phase 1 reporting instrumentation
// (tracker item for-product-phase-1-reporting-instrument-kjlh46). Mocks
// global.fetch the same way test/dream-webhook.test.js/
// test/support-feedback.test.js already do for their own outbound calls,
// since PostHog has no server SDK wired into this codebase (see that
// file's header comment) — this is a plain fetch() POST.

var test = require('node:test');
var assert = require('node:assert/strict');

var realFetch = global.fetch;
// See test/helpers/fetch-double.js -- marks this file's own fetch double so
// lib/posthog-capture.js's own test-process guard lets these fires reach it.
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');
var posthogCapture = require('../netlify/functions/lib/posthog-capture');
var analyticsConfig = require('../js/analytics-config');

test.afterEach(function () {
  global.fetch = realFetch;
});

/** Spies on global.fetch, recording every call and returning a canned response. */
function installFetchSpy(status) {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, opts: opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: (status || 200) < 300,
      status: status || 200,
      json: async function () { return {}; },
      text: async function () { return status && status >= 300 ? 'posthog error body' : 'ok'; }
    };
  };
  markInstalledFetchAsTestDouble();
  return calls;
}

test('captureEvent: posts to POSTHOG_HOST + /capture/ with api_key, event, distinct_id, properties, timestamp', async function () {
  var calls = installFetchSpy(200);
  var res = await posthogCapture.captureEvent({
    event: 'purchase_completed',
    distinct_id: 'alice',
    properties: { value: 1.99, currency: 'USD' },
    timestamp: 1700000000000
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, analyticsConfig.POSTHOG_HOST + '/capture/');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].body.api_key, analyticsConfig.POSTHOG_KEY);
  assert.equal(calls[0].body.event, 'purchase_completed');
  assert.equal(calls[0].body.distinct_id, 'alice');
  assert.deepEqual(calls[0].body.properties, { value: 1.99, currency: 'USD' });
  assert.equal(calls[0].body.timestamp, new Date(1700000000000).toISOString());
});

test('captureEvent: timestamp defaults to now when omitted', async function () {
  var calls = installFetchSpy(200);
  var before = Date.now();
  await posthogCapture.captureEvent({ event: 'signed_up', distinct_id: 'bob' });
  var after = Date.now();
  var sentMs = new Date(calls[0].body.timestamp).getTime();
  assert.ok(sentMs >= before && sentMs <= after, 'timestamp should default to roughly now');
  assert.deepEqual(calls[0].body.properties, {}, 'properties defaults to an empty object');
});

test('captureEvent: missing event or distinct_id -> { ok:false } without calling fetch', async function () {
  var calls = installFetchSpy(200);
  var res1 = await posthogCapture.captureEvent({ distinct_id: 'alice' });
  assert.equal(res1.ok, false);
  assert.match(res1.error, /event_and_distinct_id_required/);

  var res2 = await posthogCapture.captureEvent({ event: 'video_created' });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /event_and_distinct_id_required/);

  assert.equal(calls.length, 0, 'must never call fetch when required params are missing');
});

test('captureEvent: a non-2xx response from PostHog -> { ok:false, error }, never throws', async function () {
  installFetchSpy(500);
  var res = await posthogCapture.captureEvent({ event: 'video_created', distinct_id: 'alice' });
  assert.equal(res.ok, false);
  assert.match(res.error, /posthog_request_failed: 500/);
});

test('captureEvent: fetch itself rejecting (network failure) -> { ok:false, error }, never throws', async function () {
  global.fetch = async function () { throw new Error('ECONNRESET'); };
  markInstalledFetchAsTestDouble();
  var res = await posthogCapture.captureEvent({ event: 'video_created', distinct_id: 'alice' });
  assert.equal(res.ok, false);
  assert.match(res.error, /posthog_network_failure/);
  assert.match(res.error, /ECONNRESET/);
});
