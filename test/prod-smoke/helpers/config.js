// test/prod-smoke/helpers/config.js
//
// Resolves the ORIGIN this run of the prod-smoke suite targets, and mints
// a single throwaway "probe" identity for the run.
//
// Origin resolution (first match wins):
//   1. a `--origin=...` CLI arg (node --test test/prod-smoke/*.test.js --origin=http://127.0.0.1:PORT)
//   2. the PROD_SMOKE_ORIGIN env var
//   3. the real, default production origin (see docs/PROD_SMOKE.md)
//
// Defaulting to PRODUCTION is deliberate — this suite's whole point is a
// daily check against the real, live site. Every other test suite in this
// repo (test/*.test.js) defaults to a local static server; this is the one
// exception, and it's exception on purpose, not an oversight.
//
// PROBE IDENTITY — see docs/PROD_SMOKE.md's "Why an @example.com probe
// account" section for the full reasoning. Short version: a literal
// `__word__`-shaped username (the historical `__probe_throwaway_user__`
// convention referenced in netlify/functions/admin-diagnose-rename-
// conflict.js's/admin-restore-founder-email.js's comments) is REJECTED at
// signup by register-account.js's own E10 suspicious_username guard (added
// after this suite's naming convention was chosen for a different purpose
// — an autofill-probing incident, not a "mark this as a test account"
// convention) — so a fresh account using that literal shape can never
// actually complete real signup. The one convention that both (a) already
// exists in this codebase and (b) a REAL signup can actually pass through
// is an `@example.com` email: js/store.js's own isTestOrInternalIdentity()
// already treats any `@example.com`-addressed account as test/internal for
// PostHog tagging purposes (see that function's own doc comment) — reused
// here rather than inventing a third convention. The username itself
// carries a human-legible "probesmoke" prefix plus a per-run timestamp/
// random suffix, so a real person skimming account records or Explore
// would immediately recognize it as this suite's own throwaway, without
// it colliding with the E10 guard.

function resolveOrigin() {
  var argOrigin = process.argv.filter(function (a) { return a.indexOf('--origin=') === 0; })[0];
  if (argOrigin) return argOrigin.slice('--origin='.length).replace(/\/$/, '');
  if (process.env.PROD_SMOKE_ORIGIN) return process.env.PROD_SMOKE_ORIGIN.replace(/\/$/, '');
  return 'https://dreamtube1.netlify.app';
}

function makeProbeIdentity() {
  var stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  return {
    username: 'probesmoke' + stamp,
    email: 'probesmoke' + stamp + '@example.com',
    password: 'ProdSmoke-' + stamp + '-1'
  };
}

module.exports = {
  origin: resolveOrigin(),
  makeProbeIdentity: makeProbeIdentity,
  // Whether this run targets something OTHER than the real production
  // origin (local verification, a branch deploy preview, etc.) — used
  // only to decide how loudly to log, never to change which endpoints get
  // mocked (see generation-mocks.js's own header comment: the generation
  // surface is ALWAYS mocked, everywhere, regardless of origin).
  isProductionOrigin: resolveOrigin() === 'https://dreamtube1.netlify.app'
};
