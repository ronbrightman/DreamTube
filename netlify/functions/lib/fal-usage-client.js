// netlify/functions/lib/fal-usage-client.js
//
// Thin, dependency-free client for fal.ai's real usage-reporting API —
// tracker item for-product-real-per-job-fal-cost-loggin-360bxy. Read-only
// (GET only, never spends money itself): pulls the ACTUAL billed usage fal
// recorded for a UTC date range, straight from fal's own ledger, as a
// correction against this codebase's existing spend-guard.js (which is
// deliberately just an upper-bound PRE-spend estimate/reservation, not real
// accounting — see that file's own header comment). This is what finally
// counts billed-but-failed jobs (fal bills for compute that ran even if the
// job errored out on our side) and any generation this app didn't already
// have a counter for.
//
// Endpoint shape validated by Manager against a real full-month pull that
// reconciled to $254.45, matching the founder's own fal dashboard total
// (see tracker item 360bxy's comment history):
//   GET https://api.fal.ai/v1/models/usage?limit=100&start=YYYY-MM-DD&end=YYYY-MM-DD
//   Authorization: Key <FAL_ADMIN_KEY>
// Response is cursor-paginated buckets-of-records (confirmed against fal's
// own published docs example at docs.fal.ai/platform-apis/v1/models/usage):
//   { time_series: [ { bucket: "<ISO date>", results: [
//       { endpoint_id, unit, quantity, unit_price, cost, currency, auth_method }
//     ] } ], next_cursor: <string|null>, has_more: <boolean> }
// This client is defensive about the exact per-record cost field name —
// fal's docs example uses `cost`, but the tracker item's own already-
// validated summary of the shape says `cost_total`; rather than gamble on
// which one a given API version actually sends, computeCost() below prefers
// `cost_total`, falls back to `cost`, and as a last resort derives
// quantity * unit_price (both of which the tracker item's validation DID
// confirm are always present) — so a field-name change on fal's side
// degrades to a still-correct derived number instead of silently reporting
// $0.
//
// IMPORTANT: this is a read-only reporting client. It never places a fal
// generation request and never touches the FAL_KEY the app's own
// generate-*.js functions use — a completely separate credential
// (FAL_ADMIN_KEY) and a completely separate host (api.fal.ai, not
// queue.fal.run/fal.run).

var FAL_USAGE_API_BASE = 'https://api.fal.ai/v1/models/usage';

// Matches fal's own documented per-page cap for this endpoint (the same
// limit=100 Manager's own validated pull used).
var PAGE_LIMIT = 100;

// Hard ceiling on pages followed per call, purely a defensive guard against
// an fal-side bug returning has_more:true forever — a single UTC day of
// usage for this app's current scale is nowhere near 100 * 50 = 5000
// records. Never expected to bind in practice.
var MAX_PAGES = 50;

// ── TEST-ENVIRONMENT GUARD ──
// Same house pattern as lib/posthog-capture.js's own guard (see that file's
// header comment for the full incident this defends against — a real
// npm-test run silently firing real outbound requests). This module makes
// its own separate real outbound call (to fal.ai's usage API, using
// FAL_ADMIN_KEY — a production secret, not the sandboxed analytics key
// posthog-capture.js guards), so it needs the identical protection rather
// than inheriting posthog-capture.js's: a test run must never be able to
// put a real request bearing FAL_ADMIN_KEY on the wire, whether or not a
// test remembered to mock global.fetch. Deliberately duplicated (not
// imported from posthog-capture.js) — that module documents this guard as
// scoped to itself on purpose; every module making its own real outbound
// call owns its own copy of the same signal-detection logic.
var TEST_DOUBLE_MARKER = '__dreamtubeTestDouble';

function isNonProductionRun() {
  if (process.env.DREAMTUBE_ALLOW_SERVER_ANALYTICS === '1') return false;
  if (process.env.DREAMTUBE_DISABLE_SERVER_ANALYTICS === '1') return true;
  if (process.env.NODE_TEST_CONTEXT) return true;
  var entry = process.argv && process.argv[1];
  if (typeof entry === 'string' && /\.test\.js$/.test(entry)) return true;
  return false;
}

/** True when firing right now would put a real request on the wire from a non-production process. */
function wouldEscapeToRealNetwork() {
  if (!isNonProductionRun()) return false;
  var f = typeof globalThis !== 'undefined' ? globalThis.fetch : undefined;
  return !(f && f[TEST_DOUBLE_MARKER] === true);
}

/** True when `key` looks like a real credential rather than unset/blank. */
function hasAdminKey() {
  var key = process.env.FAL_ADMIN_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

/** Prefers cost_total, then cost, then derives quantity * unit_price — see header comment. */
function computeCost(record) {
  if (typeof record.cost_total === 'number') return record.cost_total;
  if (typeof record.cost === 'number') return record.cost;
  var quantity = typeof record.quantity === 'number' ? record.quantity : 0;
  var unitPrice = typeof record.unit_price === 'number' ? record.unit_price : 0;
  return quantity * unitPrice;
}

/**
 * Fetches every usage record fal reports for the UTC date range
 * [startDate, endDate] (both 'YYYY-MM-DD', inclusive per fal's own
 * start/end query params), following cursor pagination to completion.
 * Flattens fal's bucket/results nesting into one flat array of
 * { endpoint_id, unit, quantity, unit_price, cost, currency, auth_method, bucket }.
 *
 * Returns { ok: true, records } on success, or { ok: false, error } on any
 * failure (missing key, non-2xx response, network failure, malformed body)
 * — NEVER throws, matching this codebase's fire-and-forget-safe discipline
 * for background/analytics-adjacent calls (see posthog-capture.js). Callers
 * must check `ok` rather than relying on a try/catch.
 */
async function fetchUsage(startDate, endDate) {
  if (!hasAdminKey()) {
    return { ok: false, error: 'missing_fal_admin_key' };
  }
  if (!startDate || !endDate) {
    return { ok: false, error: 'start_and_end_date_required' };
  }
  // See "TEST-ENVIRONMENT GUARD" above — never let a test process put a
  // real request bearing FAL_ADMIN_KEY on the wire.
  if (wouldEscapeToRealNetwork()) {
    return { ok: false, error: 'suppressed_non_production_run' };
  }

  var records = [];
  var cursor = null;
  var page = 0;

  try {
    do {
      var url = FAL_USAGE_API_BASE + '?limit=' + PAGE_LIMIT +
        '&start=' + encodeURIComponent(startDate) +
        '&end=' + encodeURIComponent(endDate) +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');

      var res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Key ' + process.env.FAL_ADMIN_KEY }
      });

      if (!res.ok) {
        var text = '';
        try { text = await res.text(); } catch (e2) { /* best-effort detail only */ }
        return { ok: false, error: 'fal_usage_request_failed: ' + res.status + (text ? ' ' + text : '') };
      }

      var data = await res.json();
      var timeSeries = Array.isArray(data.time_series) ? data.time_series : [];
      for (var i = 0; i < timeSeries.length; i++) {
        var bucket = timeSeries[i];
        var results = Array.isArray(bucket.results) ? bucket.results : [];
        for (var j = 0; j < results.length; j++) {
          var r = results[j];
          records.push({
            endpoint_id: r.endpoint_id,
            unit: r.unit,
            quantity: r.quantity,
            unit_price: r.unit_price,
            cost: computeCost(r),
            currency: r.currency,
            auth_method: r.auth_method,
            bucket: bucket.bucket
          });
        }
      }

      cursor = data.has_more ? data.next_cursor : null;
      page++;
    } while (cursor && page < MAX_PAGES);

    return { ok: true, records: records };
  } catch (e) {
    return { ok: false, error: 'fal_usage_network_failure' + (e && e.message ? ': ' + e.message : '') };
  }
}

module.exports = {
  fetchUsage: fetchUsage,
  hasAdminKey: hasAdminKey,
  computeCost: computeCost,
  isNonProductionRun: isNonProductionRun,
  wouldEscapeToRealNetwork: wouldEscapeToRealNetwork
};
