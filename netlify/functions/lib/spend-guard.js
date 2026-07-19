// netlify/functions/lib/spend-guard.js
//
// Global daily-spend circuit breaker for generate-video.js's fal.ai
// calls — active regardless of PAYWALL_ENABLED (per the anti-abuse-
// guardrails research: this is a backstop against any failure mode in
// the per-IP/per-email rate limiter in rate-limit.js, not a substitute
// for it — "turns runaway bill into outage for a day, recoverable").
//
// Backed by a single Blobs counter (the "dreamtube-spend-guard" store,
// key "spend:<YYYY-MM-DD UTC>") tracking estimated cumulative spend for
// the day. Each reservation adds a flat per-generation cost estimate
// *before* the fal.ai call is made (a reservation, not a
// post-hoc/actual charge — fal.ai doesn't expose real-time per-call
// cost from this synchronous submission call, so this is deliberately
// an upper-bound estimate rather than exact accounting).
//
// The estimate uses the *upper* end of generate-video.js's own
// documented cost range (fal-ai/veo3.1/fast, "$0.10-0.20/sec", 8s
// duration => up to $1.60/generation) so the breaker trips earlier
// rather than later — erring toward "pause generation a bit
// conservatively" over "let the bill run past the intended cap".
//
// Same not-truly-atomic caveat as rate-limit.js applies (Blobs has no
// compare-and-swap), so under genuinely concurrent requests the actual
// spend could overshoot the cap by a small, bounded amount before the
// breaker trips — acceptable for a backstop whose job is bounding worst
// case, not billing to the cent. fal.ai's own prepaid-credit account
// lock is the final, structural backstop underneath this one.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-spend-guard';

// 8s * $0.20/s upper bound documented in generate-video.js's header comment.
var ESTIMATED_COST_PER_GENERATION_USD = 1.6;

function todayKey() {
  return 'spend:' + new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

/**
 * Checks today's running estimated spend against `capUsd`; if under it,
 * reserves this generation's estimated cost by adding it to the running
 * total. Returns { allowed, spent, cap } where `spent` is the total
 * *after* this reservation (only meaningful when allowed is true).
 */
async function checkAndReserve(event, capUsd) {
  var key = todayKey();
  connectLambda(event);
  // Eventual consistency, not strong — see entitlements.js's comment on
  // why: strong consistency threw BlobsConsistencyError unconditionally
  // in this deploy environment, taking generate-video.js down entirely.
  var store = getStore({ name: STORE_NAME });
  var spent = (await store.get(key, { type: 'json' })) || 0;

  if (spent >= capUsd) {
    return { allowed: false, spent: spent, cap: capUsd };
  }

  var next = spent + ESTIMATED_COST_PER_GENERATION_USD;
  await store.setJSON(key, next);
  return { allowed: true, spent: next, cap: capUsd };
}

module.exports = { checkAndReserve, ESTIMATED_COST_PER_GENERATION_USD };
