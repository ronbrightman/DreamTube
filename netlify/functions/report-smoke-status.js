// netlify/functions/report-smoke-status.js
//
// Reliability net — write side of lib/smoke-status-store.js for a
// producer that runs OUTSIDE this Netlify site (tracker item
// for-product-reliability-net-spec-v1-smok-x1o5zc, piece 2: the nightly
// state-seeded-journeys run). both-domain-smoke.js (piece 1) is itself a
// Netlify Function, so it writes to the store directly, in-process — no
// need for this endpoint. The nightly journeys run is a real Playwright
// suite (test/prod-smoke/*.test.js) driven by this environment's own
// scheduled Routine mechanism, a plain Node process with no Netlify Lambda
// credentials of its own (see test/prod-smoke/README.md's "Nightly
// scheduling" section for the full reasoning on why it can't run INSIDE a
// Netlify Function) — this endpoint is how that external process reports
// its result back into the same shared store, the same way any other
// client of this site calls a Netlify Function: a plain HTTPS POST.
//
// POST { token, checkGroup, domain, ok, summary?, checks? } ->
//   { ok:true } on success.
//
// AUTH: a single shared-secret token (`SMOKE_STATUS_REPORT_TOKEN` env
// var), NOT the OWNER_EMAIL pattern this codebase's admin-*.js endpoints
// use — this isn't a founder-identity action (nobody types a password
// into a form here), it's one automated, non-interactive process
// authenticating itself, closer to a webhook secret (see
// lib/resend-webhook-verify.js's Svix signature, dodo-webhook.js's
// DODO_WEBHOOK_SECRET) than a login. A plain shared secret is
// proportionate to what's actually at stake: this store holds smoke-test
// pass/fail status, not money or personal data, so the worst a leaked/
// guessed token enables is a false status entry on a health dashboard, not
// an account takeover or a financial loss.
//
// SOFT-FAIL UNTIL CONFIGURED: exactly like send-whatsapp-morning-
// capture.js's own isConfigured() gate (see that file's header comment),
// this endpoint refuses every write with a clear, logged-at-console.log
// (not console.error — an expected, not-yet-configured state) "not
// configured" response until a human sets SMOKE_STATUS_REPORT_TOKEN in
// Netlify. This is a plain config step on THIS APP'S OWN already-existing
// Netlify project (generate one random string, paste it into an env var,
// same "reads from an env var, flip later with zero code/deploy" pattern
// as WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE/DODO_PRODUCT_PACK_* elsewhere
// in this codebase) — NOT signing up for a new vendor/service, so it
// doesn't need a founder go-ahead the way opening a new account would;
// see this build's own report for the exact one-line instruction to set
// it.
//
// Error codes (local to this function, small-number scheme like
// check-email.js):
//   E1 method_not_allowed  — verb other than POST
//   E2 invalid_json        — POST body wasn't valid JSON
//   E3 not_configured       — SMOKE_STATUS_REPORT_TOKEN isn't set yet
//   E4 invalid_token        — `token` didn't match the configured secret
//   E5 invalid_payload      — missing/malformed checkGroup, domain, or ok

var smokeStatusStore = require('./lib/smoke-status-store');

function looksUnset(value) {
  return typeof value !== 'string' || !value.trim();
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var configuredToken = process.env.SMOKE_STATUS_REPORT_TOKEN;
  if (looksUnset(configuredToken)) {
    console.log('report-smoke-status: SMOKE_STATUS_REPORT_TOKEN not set yet -- refusing every write until a human configures it (see this file\'s own header comment). Expected until that one-time Netlify env var is set.');
    return { statusCode: 503, body: JSON.stringify({ error: 'E3: not_configured' }) };
  }

  if (typeof payload.token !== 'string' || payload.token !== configuredToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'E4: invalid_token' }) };
  }

  var checkGroup = typeof payload.checkGroup === 'string' ? payload.checkGroup.trim() : '';
  var domain = typeof payload.domain === 'string' ? payload.domain.trim() : '';
  if (!checkGroup || !domain || typeof payload.ok !== 'boolean') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: invalid_payload' }) };
  }

  var record = await smokeStatusStore.writeResult(event, checkGroup, domain, {
    ok: payload.ok,
    summary: typeof payload.summary === 'string' ? payload.summary : undefined,
    checks: Array.isArray(payload.checks) ? payload.checks : undefined
  });

  return { statusCode: 200, body: JSON.stringify({ ok: true, record: record }) };
};
