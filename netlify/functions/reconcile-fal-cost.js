// netlify/functions/reconcile-fal-cost.js
//
// Daily fal.ai cost reconciliation — tracker item for-product-real-per-job-
// fal-cost-loggin-360bxy. Ron's own ground truth ($240 actual fal spend for
// a month vs. this app's $145-230 estimate) showed a real gap driven by
// uninstrumented history and billed-but-failed jobs that no existing
// counter sees — spend-guard.js's own reservation estimate is deliberately
// just an upper-bound PRE-spend guess (see that file's header comment), not
// real accounting. This function closes that gap with fal's own usage
// ledger: every day, it pulls the PREVIOUS UTC day's real billed usage from
// fal (see lib/fal-usage-client.js), splits it into cost categories (see
// lib/fal-cost-categorize.js), and records the result somewhere durable and
// visible — both a Netlify Blobs rollup (this codebase's existing "durable
// periodic app state" home, e.g. lib/entitlements.js/push-dedup-store.js)
// and a PostHog event (this app's existing Business Overview dashboard is a
// PostHog dashboard — see docs/ANALYTICS_SETUP.md — so a PostHog event is
// what actually makes this "real cost" number show up somewhere the
// founder already looks, per this tracker item's own stated goal).
//
// PURELY ADDITIVE AND READ-ONLY:
//   - GET-only against fal.ai's usage-reporting API. This function makes NO
//     fal generation calls and spends no money itself.
//   - Does not read, write, or otherwise touch spend-guard.js's own Blobs
//     store's WRITE path or its checkAndReserve() gate — the live,
//     real-time spend circuit breaker is completely unchanged by this
//     file. The one thing this file DOES read from that store is today's
//     already-written reserved-estimate total, purely to log an
//     after-the-fact "actual vs. reserved" comparison for visibility (see
//     reconcileDate's reservedUsd below) — a read, never a write.
//   - Fails closed/no-ops harmlessly whenever FAL_ADMIN_KEY isn't set (see
//     lib/fal-usage-client.js's hasAdminKey()), and never throws out of
//     reconcileDate/the scheduled handler on any failure (a bad fal
//     response, a network error, a PostHog/Blobs hiccup) — same
//     "background job's own failure must never surface as a hard failure"
//     discipline as send-daily-claim-pushes.js's own handler.
//
// SCHEDULING: Netlify's own scheduled-function mechanism, the exact
// precedent send-daily-claim-pushes.js already set as this repo's first
// scheduled function — belt-and-suspenders between this file's own inline
// `schedule()` wrapper and netlify.toml's declared cron (see that file's
// header comment for why both). Runs once daily, well after UTC midnight,
// and reconciles the PREVIOUS UTC day (yesterday's fal usage is the
// earliest usage fal itself can have fully finalized by the time this
// runs).
//
// IDEMPOTENCY: the Blobs write for a given date is a plain overwrite
// (upsert) — safe to rerun for the same date any number of times, since
// it's always recomputed fresh from fal's own ledger, not accumulated. The
// PostHog fire is the one thing a naive rerun-in-the-same-burst could
// double-count on the dashboard, so it carries a stable
// properties.$insert_id keyed by date (PostHog's own documented
// server-side dedup mechanism — see lib/posthog-capture.js's header
// comment) rather than a separate homegrown "already reconciled" gate.

var { schedule } = require('@netlify/functions');
var { getStore, connectLambda } = require('@netlify/blobs');
var falUsageClient = require('./lib/fal-usage-client');
var falCostCategorize = require('./lib/fal-cost-categorize');
var posthogCapture = require('./lib/posthog-capture');

var STORE_NAME = 'dreamtube-fal-cost-reconciliation';

// spend-guard.js's own store name + key format ('spend:<YYYY-MM-DD UTC>',
// see that file's todayKey()) — read-only here, purely for the "actual vs.
// reserved" comparison this reconciliation adds. Duplicated rather than
// imported so this file never needs to touch spend-guard.js at all (per
// this build's own "stays reservation-based for the live gate, unchanged"
// requirement) — if that key format ever changes, spend-guard.js's own
// checkAndReserve() is unaffected either way; only this read-only
// comparison would need updating.
var SPEND_GUARD_STORE_NAME = 'dreamtube-spend-guard';

// system-level (not per-user) analytics events use this distinct_id, the
// same "unknown"-style convention posthog-capture.js's own header comment
// documents other server-only/no-real-user fires already using (e.g.
// first-dream-email-sender.js's `username || email || 'unknown'` skip
// events) — there is no real PostHog person this daily rollup belongs to.
var SYSTEM_DISTINCT_ID = 'dreamtube-system';

/** 'YYYY-MM-DD' for `daysAgo` days before now, UTC. */
function utcDateString(daysAgo) {
  var d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function emptyCategoryTotals() {
  var totals = {};
  var keys = Object.keys(falCostCategorize.CATEGORIES).map(function (k) { return falCostCategorize.CATEGORIES[k]; });
  for (var i = 0; i < keys.length; i++) totals[keys[i]] = 0;
  return totals;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Reconciles one UTC date ('YYYY-MM-DD') against fal's usage API and
 * persists the result. Returns:
 *   { ok: true, skipped: true, reason }              — no-op (e.g. no key)
 *   { ok: false, error }                              — fal call or storage failed
 *   { ok: true, date, totalUsd, byCategory, recordCount, reservedUsd, deltaUsd }
 * Never throws.
 */
async function reconcileDate(event, dateStr) {
  if (!falUsageClient.hasAdminKey()) {
    return { ok: true, skipped: true, reason: 'missing_fal_admin_key' };
  }

  var usage = await falUsageClient.fetchUsage(dateStr, dateStr);
  if (!usage.ok) {
    // Never write partial/corrupt state on a failed pull -- today's (or any
    // prior day's) already-persisted reconciliation record is left exactly
    // as-is; the next scheduled run tries again.
    return { ok: false, error: usage.error };
  }

  var byCategory = emptyCategoryTotals();
  var totalUsd = 0;
  for (var i = 0; i < usage.records.length; i++) {
    var record = usage.records[i];
    var category = falCostCategorize.categorizeEndpoint(record.endpoint_id);
    var cost = typeof record.cost === 'number' ? record.cost : 0;
    byCategory[category] += cost;
    totalUsd += cost;
  }
  for (var cat in byCategory) {
    if (Object.prototype.hasOwnProperty.call(byCategory, cat)) byCategory[cat] = round2(byCategory[cat]);
  }
  totalUsd = round2(totalUsd);

  var reservedUsd = null;
  try {
    connectLambda(event);
    var spendGuardStore = getStore({ name: SPEND_GUARD_STORE_NAME });
    var reserved = await spendGuardStore.get('spend:' + dateStr, { type: 'json' });
    if (typeof reserved === 'number') reservedUsd = reserved;
  } catch (e) {
    // Purely a nice-to-have comparison -- a failure to read spend-guard's
    // own store must never block recording the real reconciled total.
    reservedUsd = null;
  }
  var deltaUsd = reservedUsd === null ? null : round2(totalUsd - reservedUsd);

  var result = {
    date: dateStr,
    totalUsd: totalUsd,
    byCategory: byCategory,
    recordCount: usage.records.length,
    reservedUsd: reservedUsd,
    deltaUsd: deltaUsd,
    reconciledAt: new Date().toISOString()
  };

  try {
    connectLambda(event);
    var store = getStore({ name: STORE_NAME });
    await store.setJSON('reconciled:' + dateStr, result);
  } catch (e) {
    return { ok: false, error: 'blobs_write_failed' + (e && e.message ? ': ' + e.message : '') };
  }

  // Fire-and-forget, best-effort -- see header comment. $insert_id keyed by
  // date gives PostHog's own dedup a stable key across same-day reruns.
  posthogCapture.captureEvent({
    event: 'fal_cost_reconciled_daily',
    distinct_id: SYSTEM_DISTINCT_ID,
    properties: {
      $insert_id: 'fal_cost_reconciled_daily:' + dateStr,
      date: dateStr,
      total_usd: totalUsd,
      app_video_usd: byCategory[falCostCategorize.CATEGORIES.APP_VIDEO],
      app_image_usd: byCategory[falCostCategorize.CATEGORIES.APP_IMAGE],
      app_other_usd: byCategory[falCostCategorize.CATEGORIES.APP_OTHER],
      creative_usd: byCategory[falCostCategorize.CATEGORIES.CREATIVE],
      record_count: usage.records.length,
      reserved_usd: reservedUsd,
      delta_usd: deltaUsd
    }
  }).catch(function () { /* analytics must never break this job -- see header comment */ });

  return { ok: true, date: dateStr, totalUsd: totalUsd, byCategory: byCategory, recordCount: usage.records.length, reservedUsd: reservedUsd, deltaUsd: deltaUsd };
}

exports.handler = schedule('@daily', async function (event) {
  try {
    var yesterday = utcDateString(1);
    var result = await reconcileDate(event, yesterday);
    if (result.skipped) {
      console.log('reconcile-fal-cost: skipped (' + result.reason + ')');
    } else if (!result.ok) {
      console.error('reconcile-fal-cost: failed for ' + yesterday + ' -- ' + result.error);
    } else {
      console.log('reconcile-fal-cost: reconciled ' + result.date + ' -- $' + result.totalUsd + ' across ' + result.recordCount + ' record(s)');
    }
  } catch (e) {
    // Same "never let this surface as a hard failure" discipline as every
    // other background/analytics-adjacent job in this codebase -- a failed
    // run just means today's reconciliation doesn't happen; tomorrow's run
    // covers its own day independently (this is not a cumulative job).
    console.error('reconcile-fal-cost: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing (test/reconcile-fal-cost.test.js) and for
// a possible future manual/backfill invocation.
exports.reconcileDate = reconcileDate;
exports.utcDateString = utcDateString;
exports.STORE_NAME = STORE_NAME;
