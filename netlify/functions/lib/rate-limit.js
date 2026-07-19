// netlify/functions/lib/rate-limit.js
//
// Simple per-identifier (IP, and per-email once an email is on the
// request) daily generation cap for generate-video.js — active
// regardless of PAYWALL_ENABLED, per the anti-abuse-guardrails research:
// the generation endpoint currently has zero protection of any kind, and
// a cheap per-IP/per-day counter is worth having independent of the
// paywall decision (a hard paywall protects against cold-traffic cost
// risk, but not e.g. a compromised/shared paying account hammering the
// endpoint).
//
// Backed by a Blobs counter keyed "<scope>:<YYYY-MM-DD (UTC)>:<identifier>"
// in the "dreamtube-rate-limits" store. Not a true atomic increment —
// Netlify Blobs has no compare-and-swap/locking primitive (see
// infrastructure-v2.md) — so two requests from the same identifier
// landing in the same instant could both read the same pre-increment
// count and both be let through, a narrow last-write-wins race. That's
// an acceptable tradeoff here: this is a defense against casual/scripted
// hammering, not a hard security boundary, and the daily-spend circuit
// breaker (spend-guard.js) is the real backstop against runaway cost
// regardless of how many individual requests slip past this counter.
//
// No explicit cleanup/TTL for old daily keys — Blobs has no built-in TTL
// and each key's value is a single small integer, so the accumulated
// storage from this is negligible even after years of daily keys.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-rate-limits';

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Best-effort client IP from the headers Netlify's Lambda-compatible runtime provides. Falls back to 'unknown' (which still rate-limits — just as one shared bucket — rather than throwing). */
function clientIp(event) {
  var headers = (event && event.headers) || {};
  var forwardedFor = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  return (
    headers['x-nf-client-connection-ip'] ||
    headers['client-ip'] ||
    (forwardedFor ? forwardedFor.split(',')[0].trim() : '') ||
    'unknown'
  );
}

/**
 * Checks the given identifier's count for today against `limit` and, if
 * under it, increments and allows the request. Returns
 * { allowed, count, limit }. Call once per identifier you want to gate on
 * (e.g. once for IP always, once more for email if the request has one).
 */
async function checkAndIncrement(event, scope, identifier, limit) {
  var key = scope + ':' + todayUtc() + ':' + identifier;
  connectLambda(event);
  // Eventual consistency, not strong — see entitlements.js's comment on
  // why: strong consistency threw BlobsConsistencyError unconditionally
  // in this deploy environment, taking generate-video.js down entirely.
  var store = getStore({ name: STORE_NAME });
  var count = (await store.get(key, { type: 'json' })) || 0;

  if (count >= limit) {
    return { allowed: false, count: count, limit: limit };
  }

  await store.setJSON(key, count + 1);
  return { allowed: true, count: count + 1, limit: limit };
}

module.exports = { clientIp, checkAndIncrement };
