// netlify/functions/lib/deploy-log-store.js
//
// Backing store for "deploys today" visibility — tracker item
// for-product-surface-deploys-day-as-a-vis-xld1vk, a follow-up from
// deploy-cost round 2 (PR #10, netlify.toml's build-skip pathspec
// extended to also skip tests-only diffs). The founder's real 2026-08-04
// complaint (40 deploys in one day, ~600 Netlify credits) was only
// noticed a full billing period later — this exists so a cost regression
// like that is visible within a day instead.
//
// RACE-FREE BY DESIGN — read this before touching the write side.
// scripts/generate-version.js's own header comment already rejected a
// naive Netlify-Blobs read-increment-write counter for the adjacent
// "nth deploy today" version-string problem: the installed @netlify/blobs
// SDK has no compare-and-swap/conditional-write primitive (see
// lib/blobs-retry.js's own header comment for the full, re-checked-2026-
// 07-30 story), so two deploys landing in the same window would race on
// incrementing a shared counter with no way to detect the clash —
// producing a fake, occasionally-wrong number. Per tracker item
// decide-blobs-lazy-seed-race / tracker-store-concurrent-write-race, this
// codebase treats that as worse than not having a number at all.
//
// This sidesteps that class of race entirely by never doing a
// read-modify-write at all:
//   - WRITE: each real (non-skipped) build writes exactly ONE key, unique
//     per deploy (`deploy-log/<UTC-date>/<DEPLOY_ID>` — Netlify's own
//     DEPLOY_ID build-env var, unique per deploy attempt). This is a pure
//     CREATE, never a read-then-write — two concurrent deploys each write
//     their own distinct key, so there is nothing to clobber and nothing
//     to detect. No CAS needed, no retry loop needed.
//   - READ: "how many deploys today" is answered by LISTing the keys
//     under `deploy-log/<date>/` and counting them AT READ TIME, never by
//     trusting a stored running total. A `list({prefix})` count is exact
//     as of whenever it's read (subject only to Blobs' normal eventual-
//     consistency propagation window for the most recent write or two —
//     see lib/blobs-retry.js's header comment on that same window — never
//     a compounding/racing error like an incremented counter would be).
//
// WHY THE WRITE SIDE NEEDS A MANUALLY-CONFIGURED TOKEN (a real human
// step, not self-serve from this sandbox) — verified against Netlify's
// own Blobs docs (docs.netlify.com/build/data-and-storage/netlify-blobs/)
// before writing this: "You can perform CRUD operations for Netlify Blobs
// from... Functions, Edge Functions, Build Plugins, [and the] Netlify
// CLI" — a plain `[build] command` script (what this repo uses — see
// netlify.toml and scripts/generate-version.js's own header comment for
// why there's no Build Plugin here) is NONE of those. `siteID`/`token`
// are "set automatically when you use Blobs from Functions, Edge
// Functions or Build Plugins" — NOT from a bare build command. Every
// OTHER Blobs-backed store in this codebase (tracker-store.js,
// owner-bypass.js, etc.) reaches Blobs via `connectLambda(event)`, which
// requires a real Lambda-style invocation `event` (see that function's
// own source: it reads `event.blobs`/`event.headers['x-nf-*']`) — no such
// event exists when this file is `require()`d from a bare
// `node scripts/generate-version.js` build step, so connectLambda is not
// an option here at all, not even in principle.
//
// So the build-time write below uses `getStore`'s documented MANUAL mode
// (`{ name, siteID, token }`, talking to the real Netlify API instead of
// the edge) — `siteID` comes for free from Netlify's own `SITE_ID` build
// env var (confirmed present at build time in Netlify's build-environment-
// variables docs), but `token` needs a real Netlify Personal Access
// Token, which only the founder can create and add as a new env var
// (`NETLIFY_BLOBS_BUILD_TOKEN` — see this build's own report for the
// exact one-line step). Until that env var exists, `recordBuildTimeDeploy`
// below is a documented, logged no-op (never throws, never blocks the
// deploy — same non-fatal posture as the rest of generate-version.js) —
// this is a deliberate "ready to go the moment the token exists" design,
// not a broken half-implementation shipped to avoid saying "this needs a
// human step."
//
// ONE OPPORTUNISTIC FALLBACK before that no-op (see
// resolveBuildCredentials below): if Netlify happens to put its own
// `NETLIFY_BLOBS_CONTEXT` env var in the build environment, use it. That
// variable is @netlify/blobs' own documented "environment-based
// configuration" channel (base64-encoded JSON carrying siteID/token/
// apiURL/edgeURL — see node_modules/@netlify/blobs/README.md's section of
// that name). Netlify documents populating it automatically for
// serverless and edge FUNCTIONS; whether a plain `[build] command` also
// inherits it is NOT documented either way, and there is no way to check
// from this sandbox (no real Netlify build can be triggered here). So
// this is strictly a bonus path — it costs nothing when absent, and it is
// NOT the design's answer to the credentials problem. The explicit
// `NETLIFY_BLOBS_BUILD_TOKEN` above remains the documented, reliable
// route, and the honest expectation is that the counter reads 0 until
// that env var exists.
//
// READ side (`countDeploysForDate`) is an ordinary request-time Netlify
// Function call, so it uses this codebase's normal `connectLambda(event)`
// pattern like every other request-time Blobs read here — no special
// credentials needed.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-deploy-log';

/** `YYYY-MM-DD`, UTC — `toISOString()` is always UTC, so this never depends on the runtime's local timezone. */
function utcDateStr(date) {
  return (date || new Date()).toISOString().slice(0, 10);
}

/** The single, pure-create key a given UTC date + deploy ID always maps to. */
function keyFor(dateStr, deployId) {
  return 'deploy-log/' + dateStr + '/' + deployId;
}

/**
 * Build-time Blobs credentials, in preference order (see this file's
 * header comment for the full story on both):
 *   1. An explicitly-configured Netlify PAT — `NETLIFY_BLOBS_BUILD_TOKEN`
 *      plus Netlify's own always-present `SITE_ID`. The documented,
 *      reliable route; needs one human step to exist at all.
 *   2. An ambient `NETLIFY_BLOBS_CONTEXT`, IF Netlify happens to expose
 *      one to a plain build command (undocumented either way — purely
 *      opportunistic, never assumed). Decoded by hand rather than left to
 *      the SDK's own implicit global lookup, so this behaves identically
 *      whether `env` is the real `process.env` or a test's plain object,
 *      and so a malformed value can be treated as simply absent instead
 *      of throwing from inside the SDK.
 *
 * Returns null when neither is available (the expected common case). Any
 * `apiURL`/`edgeURL` the ambient context carries is passed straight
 * through to `getStore`, exactly as the SDK itself would use them.
 */
function resolveBuildCredentials(env) {
  if (env.SITE_ID && env.NETLIFY_BLOBS_BUILD_TOKEN) {
    return { source: 'build_token', siteID: env.SITE_ID, token: env.NETLIFY_BLOBS_BUILD_TOKEN };
  }

  if (env.NETLIFY_BLOBS_CONTEXT) {
    try {
      var ctx = JSON.parse(Buffer.from(env.NETLIFY_BLOBS_CONTEXT, 'base64').toString('utf8'));
      if (ctx && ctx.siteID && ctx.token) {
        var creds = { source: 'ambient_context', siteID: ctx.siteID, token: ctx.token };
        if (ctx.apiURL) creds.apiURL = ctx.apiURL;
        if (ctx.edgeURL) creds.edgeURL = ctx.edgeURL;
        if (ctx.uncachedEdgeURL) creds.uncachedEdgeURL = ctx.uncachedEdgeURL;
        return creds;
      }
    } catch (err) {
      // Not valid base64 JSON — treat exactly as if it weren't set at
      // all. Never throw out of a credentials lookup on a non-fatal
      // build step.
    }
  }

  return null;
}

/**
 * BUILD-TIME write — see this file's header comment for the full "why
 * this needs a manually-configured token" story. Called from
 * scripts/generate-version.js's `main()` on every real (non-skipped)
 * Netlify build. Reads directly from `env` (defaults to `process.env`)
 * rather than any value the caller may have already computed, so it
 * still runs (or still safely no-ops) independent of whatever else that
 * build step did or didn't succeed at.
 *
 * Never throws. Returns one of:
 *   { written: false, reason: 'no_deploy_id' }             — not a real Netlify build env (e.g. local `npm run build`)
 *   { written: false, reason: 'no_blobs_credentials' }      — neither credentials route resolved (the expected, common case until NETLIFY_BLOBS_BUILD_TOKEN is added)
 *   { written: false, reason: 'write_failed', error: msg }  — a real Blobs API call was attempted and failed (network/auth/etc.)
 *   { written: true, reason: null, key: '...', credentialSource: 'build_token'|'ambient_context' } — the deploy-log entry was actually written
 */
async function recordBuildTimeDeploy(env) {
  env = env || process.env;

  var deployId = env.DEPLOY_ID;
  if (!deployId) {
    // Netlify's real build environment always sets DEPLOY_ID (see
    // scripts/generate-version.js's own header comment, which already
    // relies on this same var). Its absence means this isn't a real
    // Netlify build at all (e.g. someone running `npm run build` on a
    // laptop) — nothing meaningful to log a "deploy" for.
    return { written: false, reason: 'no_deploy_id' };
  }

  var creds = resolveBuildCredentials(env);
  if (!creds) {
    return { written: false, reason: 'no_blobs_credentials' };
  }

  var timestamp = new Date().toISOString();
  var dateStr = utcDateStr(new Date(timestamp));
  var key = keyFor(dateStr, deployId);
  var record = {
    deployId: deployId,
    commitSha: env.COMMIT_REF || null,
    branch: env.BRANCH || null,
    context: env.CONTEXT || null,
    timestamp: timestamp
  };

  var storeOpts = { name: STORE_NAME, siteID: creds.siteID, token: creds.token };
  if (creds.apiURL) storeOpts.apiURL = creds.apiURL;
  if (creds.edgeURL) storeOpts.edgeURL = creds.edgeURL;
  if (creds.uncachedEdgeURL) storeOpts.uncachedEdgeURL = creds.uncachedEdgeURL;

  try {
    var store = getStore(storeOpts);
    await store.setJSON(key, record);
    return { written: true, reason: null, key: key, credentialSource: creds.source };
  } catch (err) {
    return { written: false, reason: 'write_failed', error: err.message };
  }
}

/**
 * REQUEST-TIME read — counts how many deploy-log entries exist for
 * `dateStr` (`YYYY-MM-DD`, UTC) by LISTing keys under that date's prefix
 * and counting them, never by trusting a stored running total (see this
 * file's header comment for why). Uses this codebase's normal
 * `connectLambda(event)` pattern, same as every other request-time Blobs
 * read here.
 */
async function countDeploysForDate(event, dateStr) {
  connectLambda(event);
  var store = getStore({ name: STORE_NAME });
  var prefix = 'deploy-log/' + dateStr + '/';
  var result = await store.list({ prefix: prefix });
  return (result && result.blobs ? result.blobs.length : 0);
}

module.exports = { STORE_NAME, utcDateStr, keyFor, resolveBuildCredentials, recordBuildTimeDeploy, countDeploysForDate };
