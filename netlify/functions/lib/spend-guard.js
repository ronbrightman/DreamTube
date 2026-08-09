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
// checkAndReserve is called from generate-video.js's handler ONCE, before
// it branches on which of the three fal model paths a request actually
// takes (standard text-to-video, the self-photo reference-to-video path,
// or the "turn image into video" upsell — see that file's own call site
// just above the branch) — so this single flat estimate has to cover
// whichever of those three ends up being the most expensive, not just the
// default/most-common one.
//
// Recalculated 2026-07-28 (tracker item for-product-switch-default-video-
// model-t-lqxafa, the veo3.1/lite default switch) — NOT simply "Lite's
// price", because Lite is scoped to the standard text-to-video path only:
// the other two paths (reference-to-video, image-to-video) deliberately
// stay on veo3.1/fast in this same change (no Lite reference-to-video
// variant exists yet). So the real worst case across all three paths,
// at the fixed 8s duration and hardcoded 720p resolution every path here
// requests (no path in this file ever asks for 1080p), audio-on:
//   - standard text-to-video (now Lite): $0.05/s * 8s = $0.40
//   - reference-to-video (Me-photo): now defaults to Vidu Q1 ~$0.40
//       (founder 2026-08-09), but its veo FALLBACK is still $1.20, so this
//       path can STILL cost $1.20 — the reservation must assume that.
//   - image-to-video (still Fast):       $0.15/s * 8s = $1.20  <- worst
// The $1.20 worst case is therefore unchanged by the Vidu switch: it's still
// binding via image-to-video and the veo reference-to-video fallback.
// ($0.15/s is fal's founder-verified Fast audio-on rate — see style.html's
// audio-toggle comment — a firmer number than the old "$0.10-0.20/sec"
// approximate range this constant's previous $1.60 came from.) The
// binding constraint is still the two Fast-based paths, so this drops
// from $1.60 to $1.20 — a real cut, driven by the corrected/precise Fast
// rate replacing an approximate upper bound, not primarily by the Lite
// switch itself, since Lite generations aren't actually this reservation's
// worst case. This will drop further if/when reference-to-video and
// image-to-video also move to Lite (tracked as a separate follow-up).
//
// Same not-truly-atomic caveat as rate-limit.js applies (Blobs has no
// compare-and-swap), so under genuinely concurrent requests the actual
// spend could overshoot the cap by a small, bounded amount before the
// breaker trips — acceptable for a backstop whose job is bounding worst
// case, not billing to the cent. fal.ai's own prepaid-credit account
// lock is the final, structural backstop underneath this one.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-spend-guard';

// See the derivation above — $1.20 is the true worst case across all
// three generation paths this reservation covers, not just the new Lite
// default.
var ESTIMATED_COST_PER_GENERATION_USD = 1.2;

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
