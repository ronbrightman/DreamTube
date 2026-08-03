// netlify/functions/lib/smoke-status-store.js
//
// Shared "latest health-check result" store backing the reliability-net
// buildout — tracker item for-product-reliability-net-spec-v1-smok-x1o5zc.
// ONE record per (checkGroup, domain) pair, always the MOST RECENT run's
// result (a plain overwrite/upsert, not an append-only log — see "WHY NO
// CAS / NO HISTORY" below). Two different producers write into this same
// store:
//
//   1. both-domain-smoke.js — a scheduled Netlify Function (runs INSIDE
//      this Netlify site, real @netlify/blobs credentials available via
//      connectLambda(event) same as every other scheduled function here)
//      writes DIRECTLY via writeResult() below, no HTTP hop needed — same
//      shape as send-daily-claim-pushes.js/reconcile-fal-cost.js writing
//      their own stores in-process.
//   2. The nightly state-seeded-journeys run (test/prod-smoke/*.test.js
//      against production, fired by this environment's own scheduled
//      Routine mechanism rather than a Netlify Function — see
//      test/prod-smoke/README.md's "Nightly scheduling" section for why a
//      real Playwright browser cannot run inside a Netlify Function's own
//      runtime) runs OUTSIDE this Netlify site entirely — a plain Node
//      process with no Lambda credentials — so it cannot call getStore()
//      directly. It reports its result over a real HTTPS POST to
//      report-smoke-status.js (a normal, public Netlify Function endpoint,
//      shared-secret-gated — see that file's own header comment), which
//      calls writeResult() on its behalf.
//
// get-smoke-status.js (public GET, no auth needed — same "not sensitive,
// nothing here is a secret or personal data" reasoning as
// get-tracker-items.js) reads every stored record back out via
// getAllResults(), for whatever eventually reads this at a glance (the
// Board, a morning-report channel, or just a human/Manager checking
// in) — see that file's own header comment.
//
// STORE NAME: 'dreamtube-smoke-status'.
//
// KEY SCHEME: `checkGroup + '::' + domain` — e.g.
// 'both-domain-smoke::dreamtube1.netlify.app',
// 'seeded-journeys::dreamtube.life'. `domain` is a bare host (no scheme),
// matching how both-domain-smoke.js/report-smoke-status.js already talk
// about domains elsewhere in this build. A caller that doesn't have a
// specific domain (e.g. a single routing-matrix check that's inherently
// about the relationship BETWEEN both domains, not one domain in
// isolation) may pass domain: 'both' — this store doesn't validate the
// domain string, callers own that convention (same "generic store, caller
// owns key semantics" shape as lib/rate-limit.js's
// checkAndIncrement(scope, identifier, ...) and lib/push-dedup-store.js's
// own header comment documents for itself).
//
// WHY NO CAS / NO HISTORY: unlike push-dedup-store.js (where a duplicate
// write would cause a real user-facing duplicate notification — worth a
// real compare-and-swap primitive) or tracker-store.js (a shared array
// where a lost concurrent write silently drops a real founder task), a
// stale/lost write here just means this one run's status is missing or
// gets clobbered by a near-simultaneous second run for the SAME
// checkGroup+domain — the next scheduled run (at most a few hours later
// for both-domain-smoke, or the next night for seeded-journeys) overwrites
// it again regardless. A plain last-write-wins upsert is the same
// tradeoff reconcile-fal-cost.js's own header comment already accepts for
// its own daily-rollup store ("safe to rerun ... since it's always
// recomputed fresh ... not accumulated").

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-smoke-status';

function store() {
  return getStore({ name: STORE_NAME });
}

function keyFor(checkGroup, domain) {
  return checkGroup + '::' + domain;
}

/**
 * Records the latest result for `checkGroup` + `domain`. `result` should
 * carry at least `{ ok: boolean }` — callers are free to add whatever
 * else is useful (a `checks` array of per-item pass/fail, a `summary`
 * string) since nothing here reads back into the value itself. `checkedAt`
 * (ISO timestamp) is stamped here, not left to the caller, so every record
 * in this store is directly comparable regardless of which producer wrote
 * it or what clock it ran on.
 */
async function writeResult(event, checkGroup, domain, result) {
  connectLambda(event);
  var record = Object.assign({}, result, {
    checkGroup: checkGroup,
    domain: domain,
    checkedAt: new Date().toISOString()
  });
  await store().setJSON(keyFor(checkGroup, domain), record);
  return record;
}

/** Every stored record, most-recently-known state only (no history) — the shape get-smoke-status.js hands back as-is. */
async function getAllResults(event) {
  connectLambda(event);
  var listResult = await store().list();
  var records = [];
  for (var i = 0; i < listResult.blobs.length; i++) {
    var key = listResult.blobs[i].key;
    var record = await store().get(key, { type: 'json' });
    if (record) records.push(record);
  }
  // Newest first -- a human/Board glancing at this wants the most recently
  // checked / most recently failed thing near the top, not alphabetical by
  // key.
  records.sort(function (a, b) {
    return (b.checkedAt || '').localeCompare(a.checkedAt || '');
  });
  return records;
}

module.exports = { STORE_NAME, writeResult, getAllResults, keyFor };
