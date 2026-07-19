// netlify/functions/lib/paywall-settings.js
//
// In-product override for PAYWALL_ENABLED, so the founder can flip the
// paywall on/off from inside the product (admin.html ->
// admin-paywall-toggle.js) instead of editing Netlify's dashboard env
// vars and redeploying every time.
//
// Backed by a single Netlify Blobs store ("dreamtube-settings"), one key
// ("paywall_enabled") whose value is a plain boolean, written via
// setJSON/read via get(..., {type:'json'}) — same small-record pattern as
// entitlements.js / rate-limit.js / spend-guard.js, just a single
// singleton key instead of one-per-identifier. Uses Blobs' default
// eventual consistency (edge propagation up to ~60s) — strong consistency
// was tried first (a founder flipping the toggle ideally sees it take
// effect immediately) but threw BlobsConsistencyError unconditionally in
// this deploy environment, taking generate-video.js down entirely; see
// entitlements.js's comment for the same story in more detail.
//
// Precedence (see generate-video.js's gate for where this is consumed):
//   1. If an override has been written here, it wins outright — true or
//      false, regardless of what PAYWALL_ENABLED is set to in the
//      environment.
//   2. If no override has ever been written (key doesn't exist yet), fall
//      back to the existing PAYWALL_ENABLED === "true" env-var check,
//      unchanged from before this file existed.
// This lets a fresh environment with no override behave exactly as
// documented in docs/PAYWALL_SETUP.md (default off, env-var-driven) until
// the founder actually touches the toggle for the first time.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-settings';
var KEY = 'paywall_enabled';

// Eventual consistency, not strong — see entitlements.js's comment on why:
// strong consistency threw BlobsConsistencyError unconditionally in this
// deploy environment, taking generate-video.js down entirely.
function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Raw override lookup. Returns `true`/`false` if an override has been set,
 * or `null` if none exists yet (never toggled from the product in this
 * environment). `event` is the calling function's Lambda event, passed
 * through to connectLambda so this works from any Netlify Function.
 */
async function getOverride(event) {
  connectLambda(event);
  var value = await store().get(KEY, { type: 'json' });
  return typeof value === 'boolean' ? value : null;
}

/** Writes the override. `enabled` must already be a real boolean — callers validate/coerce before calling this. */
async function setOverride(event, enabled) {
  connectLambda(event);
  await store().setJSON(KEY, enabled === true);
  return enabled === true;
}

/**
 * The single source of truth generate-video.js's gate should call: resolves
 * the *effective* paywall state by checking the Blobs override first and
 * falling back to the PAYWALL_ENABLED env var exactly as before this file
 * existed. Returns { enabled, source } where source is "override" (a human
 * has explicitly toggled it in this environment) or "env-default" (no
 * override yet — env var, or its unset default, is in effect).
 */
async function isPaywallEnabled(event) {
  var override = await getOverride(event);
  if (override !== null) return { enabled: override, source: 'override' };
  return { enabled: process.env.PAYWALL_ENABLED === 'true', source: 'env-default' };
}

module.exports = { STORE_NAME, KEY, getOverride, setOverride, isPaywallEnabled };
