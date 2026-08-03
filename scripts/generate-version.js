#!/usr/bin/env node
// scripts/generate-version.js — writes version.json at BUILD time.
//
// Tracker item for-product-release-visibility-founder-a-8hx5cz ("Release
// visibility": founder wants revert-ability + release timestamps without
// slowing the flow down). This is the "instant answer to 'is my device on
// the latest version'" piece — see also for-product-urgent-founder-gets-
// stale-pa-6dn54z (stale-pages-after-deploy investigation) which this
// gives a concrete diagnostic for: compare what version.json says against
// what a device is actually rendering.
//
// WHY THIS NEEDS A REAL BUILD STEP AT ALL — this repo's own README/CLAUDE.md
// say "no build step" for the static site, and that's still true for the
// PAGES themselves (no bundler, no compiler, plain <script> tags). But
// "stamped at build time" for version.json specifically requires SOME
// script to run during Netlify's deploy, because there's no other moment
// where "this is the commit currently being deployed" is knowable — a
// client-side fetch at request time can't see the deploying commit's SHA.
// So this script is invoked via netlify.toml's [build] command (see that
// file) — it's the one and only build step this repo has, scoped
// narrowly to producing this JSON file. It does not bundle, transpile, or
// touch any HTML/CSS/JS page.
//
// WHERE THE DATA COMES FROM — prefer Netlify's own build-time env vars
// over shelling out to git, per this task's own guidance, since Netlify's
// build environment isn't guaranteed to have a full .git checkout
// available. Verified against Netlify's current build-environment-
// variables docs (docs.netlify.com/build/configure-builds/environment-
// variables/) before writing this:
//   - COMMIT_REF   — full SHA of the commit being built (documented, exists)
//   - BRANCH       — branch being deployed (documented, exists)
//   - CONTEXT      — 'production' / 'deploy-preview' / 'branch-deploy'
//   - DEPLOY_ID    — this deploy's unique ID
// There is NO documented COMMIT_MESSAGE (or similar) build env var —
// confirmed by reading that same docs page in full, not assumed. Netlify
// builds do clone the actual git repo to build from (that's how COMMIT_REF
// etc. get populated at all), so `git log -1 --format=%s <sha>` against
// the local checkout is the only real way to get the commit's message —
// this script shells out to git ONLY for that one field, with a graceful
// fallback (null) if git isn't available or the lookup fails, rather than
// failing the whole build over a cosmetic field.
//
// THE "version" STRING — founder-approved date-based scheme:
// v<YYYY.MM.DD>.<n> where <n> is the nth deploy that UTC calendar day.
// That requires a persistent cross-build counter ("how many times has
// this repo deployed today"), and Netlify's build environment is
// stateless/ephemeral — no filesystem or variable survives between
// builds. The only place this repo could plausibly persist a counter is
// Netlify Blobs, but this codebase has already been burned by exactly
// this shape of problem: Blobs has no compare-and-swap / read-your-own-
// write guarantee (see FOUNDER_PRINCIPLES.md's engineering-lessons
// section and tracker item history on paywall-settings.js/entitlements.js
// needing bounded retry-and-verify patches after real incidents). Two
// deploys landing in the same window would race on incrementing that
// counter with no way to detect the clash, which would produce a FAKE,
// occasionally-wrong "nth deploy" number — worse than not having one.
// Per this task's own instruction not to fake a counter that isn't real,
// this uses the documented fallback instead:
//     v<YYYY.MM.DD>-<shortsha>
// This is still unique per build, still human-sortable by date, and is
// exactly as honest as what it claims to be (it doesn't imply "3rd
// deploy today", it just says "the 2026.08.01 build with SHA a1b2c3d").
//
// ALSO STAMPS sw.js's CACHE_VERSION (added for tracker item for-product-
// urgent-founder-gets-stale-pa-6dn54z, the "stale pages after deploy"
// item this file was already a diagnostic aid for): this reuses that same
// `version` string as sw.js's own CACHE_VERSION, at the SAME build step,
// rather than inventing a second version scheme. See sw.js's own
// CACHE_VERSION comment for why this matters (changing sw.js's own bytes
// on literally every deploy is what makes the browser's SW update-check
// actually have something new to find and activate, instead of most
// routine content-only deploys leaving sw.js byte-identical and the
// update lifecycle a no-op). `stampServiceWorkerCacheVersion` below is a
// pure string-in/string-out function (no I/O) specifically so it's
// unit-testable without needing to run this whole script or touch real
// files — see test/generate-version.test.js.

var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');

// Matches sw.js's exact `var CACHE_VERSION = '...';` declaration line.
var CACHE_VERSION_LINE_RE = /var CACHE_VERSION = '[^']*';/;

/**
 * Pure function: returns `swSource` with its CACHE_VERSION line's value
 * replaced by `version`, or `null` if the expected declaration line isn't
 * found at all (e.g. sw.js was refactored and this marker no longer
 * matches — caller decides how to handle that, but this never throws and
 * never guesses at a different shape to replace). Idempotent: stamping
 * already-stamped source with the same version again yields identical
 * output.
 */
function stampServiceWorkerCacheVersion(swSource, version) {
  if (typeof swSource !== 'string' || !CACHE_VERSION_LINE_RE.test(swSource)) return null;
  return swSource.replace(CACHE_VERSION_LINE_RE, "var CACHE_VERSION = '" + version + "';");
}

function safeGitCommitMessage(sha) {
  try {
    var out = execSync('git log -1 --format=%s ' + (sha ? sha : 'HEAD'), {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    var line = out.split('\n')[0].trim();
    return line || null;
  } catch (err) {
    return null;
  }
}

function safeGitSha() {
  try {
    var out = execSync('git rev-parse HEAD', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.trim() || null;
  } catch (err) {
    return null;
  }
}

// Everything below is wrapped in try/catch and never throws — this file
// runs as a real Netlify [build] command (see netlify.toml), and a
// diagnostic-only script failing must never fail the actual site deploy.
// Worst case on any error: version.json (and/or sw.js's CACHE_VERSION)
// doesn't get updated this build (a stale-but-present copy — see the
// committed placeholders — is still better than blocking a deploy over
// this). The two steps (write version.json, stamp sw.js) are each in
// their OWN try/catch so a failure in one never blocks the other.
function main() {
  var version = null;
  try {
    var commitSha = process.env.COMMIT_REF || safeGitSha() || 'unknown';
    var shortMessage = safeGitCommitMessage(commitSha !== 'unknown' ? commitSha : null);
    var timestamp = new Date().toISOString();
    var branch = process.env.BRANCH || null;
    var context = process.env.CONTEXT || null; // production / deploy-preview / branch-deploy
    var deployId = process.env.DEPLOY_ID || null;

    var shortSha = commitSha !== 'unknown' ? commitSha.slice(0, 7) : 'unknown';
    var utcDate = timestamp.slice(0, 10).replace(/-/g, '.'); // YYYY.MM.DD, UTC (toISOString is always UTC)
    version = 'v' + utcDate + '-' + shortSha;

    var payload = {
      version: version,
      commitSha: commitSha,
      shortMessage: shortMessage,
      timestamp: timestamp,
      branch: branch,
      context: context,
      deployId: deployId
    };

    var outPath = path.join(__dirname, '..', 'version.json');
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
    console.log('[generate-version] wrote ' + outPath + ':');
    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[generate-version] non-fatal: failed to write version.json — ' + err.message);
  }

  // Stamp sw.js's CACHE_VERSION with the SAME version string computed
  // above, so a device's active service worker cache name is always
  // directly comparable to version.json's own "version" field. Skipped
  // (not attempted) if the version.json step above failed entirely (no
  // `version` computed) — nothing sane to stamp with in that case.
  if (version) {
    try {
      var swPath = path.join(__dirname, '..', 'sw.js');
      var swSource = fs.readFileSync(swPath, 'utf8');
      var stamped = stampServiceWorkerCacheVersion(swSource, version);
      if (stamped === null) {
        console.error('[generate-version] non-fatal: CACHE_VERSION marker not found in sw.js -- left unchanged');
      } else if (stamped !== swSource) {
        fs.writeFileSync(swPath, stamped);
        console.log('[generate-version] stamped sw.js CACHE_VERSION -> ' + version);
      }
    } catch (err) {
      console.error('[generate-version] non-fatal: failed to stamp sw.js -- ' + err.message);
    }
  }
}

// Only auto-run as a real build step (`node scripts/generate-version.js` /
// `npm run build`) — NOT when this file is `require()`d, e.g. by
// test/generate-version.test.js, which needs `stampServiceWorkerCacheVersion`
// as a pure function without the side effect of overwriting real files on
// disk just from being imported.
if (require.main === module) {
  main();
}

module.exports = {
  stampServiceWorkerCacheVersion: stampServiceWorkerCacheVersion,
  main: main
};
