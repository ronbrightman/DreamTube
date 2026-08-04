// test/generate-version.test.js
//
// Coverage for scripts/generate-version.js's sw.js CACHE_VERSION stamping —
// added for tracker item for-product-urgent-founder-gets-stale-pa-6dn54z.
// See sw.js's own CACHE_VERSION header comment and generate-version.js's
// own header comment for the full reasoning: this reuses the SAME
// build-time mechanism that already stamps version.json (tracker item
// for-product-release-visibility-founder-a-8hx5cz) to also stamp sw.js's
// CACHE_VERSION with the identical version string, on every real deploy —
// closing the gap where sw.js's own bytes previously changed only on a
// manual bump, so most routine content-only deploys left the browser's SW
// update-check with nothing new to find.
//
// Two layers of coverage:
//   1. `stampServiceWorkerCacheVersion` unit tests — pure function, no I/O,
//      exercising the substitution logic directly (including against the
//      REAL committed sw.js, so a future refactor of that file's
//      CACHE_VERSION line shape gets caught here rather than silently
//      breaking the stamp in production).
//   2. An end-to-end run of the real script (via child_process, exactly
//      how `npm run build`/Netlify's build command invokes it) against an
//      isolated temp copy of scripts/generate-version.js + sw.js — proving
//      the whole build step actually rewrites both files consistently,
//      without touching this repo's own real files.
//
// A third end-to-end test (near the bottom of this file) covers the
// deploy-log write this script's `main()` now also attempts on every real
// build (tracker item for-product-surface-deploys-day-as-a-vis-xld1vk) —
// see netlify/functions/lib/deploy-log-store.js's own tests for direct,
// non-child-process coverage of that module's write/read logic itself;
// this file's own end-to-end test only proves the two scripts are wired
// together correctly and that a real build (the common case, no
// NETLIFY_BLOBS_BUILD_TOKEN configured yet) still succeeds and still
// writes version.json/sw.js normally when that Blobs write safely no-ops.

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var os = require('node:os');
var { execFileSync } = require('node:child_process');

var genVersion = require('../scripts/generate-version.js');

test('stampServiceWorkerCacheVersion replaces the CACHE_VERSION line and leaves everything else untouched', function () {
  var source = "var x = 1;\nvar CACHE_VERSION = 'v2';\nvar CACHE_NAME = 'dreamtube-shell-' + CACHE_VERSION;\n";
  var stamped = genVersion.stampServiceWorkerCacheVersion(source, 'v2026.08.03-abc1234');
  assert.equal(stamped, "var x = 1;\nvar CACHE_VERSION = 'v2026.08.03-abc1234';\nvar CACHE_NAME = 'dreamtube-shell-' + CACHE_VERSION;\n");
});

test('stampServiceWorkerCacheVersion is idempotent -- stamping already-stamped source with the same version again is a no-op', function () {
  var source = "var CACHE_VERSION = 'v2';\n";
  var once = genVersion.stampServiceWorkerCacheVersion(source, 'v2026.08.03-abc1234');
  var twice = genVersion.stampServiceWorkerCacheVersion(once, 'v2026.08.03-abc1234');
  assert.equal(once, twice);
});

test('stampServiceWorkerCacheVersion returns null (never throws) when the CACHE_VERSION marker is not found', function () {
  var source = 'var somethingElse = 1;\n';
  assert.equal(genVersion.stampServiceWorkerCacheVersion(source, 'v2026.08.03-abc1234'), null);
});

test('stampServiceWorkerCacheVersion returns null for non-string input rather than throwing', function () {
  assert.equal(genVersion.stampServiceWorkerCacheVersion(null, 'v1'), null);
  assert.equal(genVersion.stampServiceWorkerCacheVersion(undefined, 'v1'), null);
});

test('stampServiceWorkerCacheVersion matches the REAL committed sw.js -- regression guard against the marker silently breaking', function () {
  var realSwPath = path.join(__dirname, '..', 'sw.js');
  var realSource = fs.readFileSync(realSwPath, 'utf8');
  var stamped = genVersion.stampServiceWorkerCacheVersion(realSource, 'v2026.08.03-abc1234');
  assert.notEqual(stamped, null, 'expected the CACHE_VERSION marker to be found in the real, committed sw.js');
  assert.match(stamped, /var CACHE_VERSION = 'v2026\.08\.03-abc1234';/);
});

test('end-to-end: running the real script (as Netlify\'s build command does) stamps version.json and sw.js with the SAME version string', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamtube-genversion-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'scripts'));
    fs.copyFileSync(
      path.join(__dirname, '..', 'scripts', 'generate-version.js'),
      path.join(tmpDir, 'scripts', 'generate-version.js')
    );
    // A minimal stand-in sw.js -- only the CACHE_VERSION line matters for
    // this script; using the real committed sw.js here too would work but
    // this keeps the fixture self-contained and independent of that file's
    // other content.
    fs.writeFileSync(
      path.join(tmpDir, 'sw.js'),
      "var CACHE_VERSION = 'v0-unbuilt-dev';\nvar CACHE_NAME = 'dreamtube-shell-' + CACHE_VERSION;\n"
    );

    execFileSync(process.execPath, [path.join(tmpDir, 'scripts', 'generate-version.js')], {
      cwd: tmpDir,
      env: Object.assign({}, process.env, {
        COMMIT_REF: 'deadbeef1234567890abcdef1234567890abcdef',
        BRANCH: 'test-branch',
        CONTEXT: 'production',
        DEPLOY_ID: 'dep-test-123'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    var versionJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'version.json'), 'utf8'));
    var swSource = fs.readFileSync(path.join(tmpDir, 'sw.js'), 'utf8');

    // Date portion is whatever UTC day the test actually ran on -- don't
    // hardcode it, just check the shape and that the short SHA is right.
    var expectedUtcDate = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    assert.equal(versionJson.version, 'v' + expectedUtcDate + '-deadbee');
    assert.equal(versionJson.commitSha, 'deadbeef1234567890abcdef1234567890abcdef');
    assert.match(swSource, new RegExp("var CACHE_VERSION = 'v" + expectedUtcDate.replace(/\./g, '\\.') + "-deadbee';"));
    // The two files must always agree -- that's the entire point (a
    // human/founder can directly compare version.json's "version" against
    // what a device's active SW cache name shows).
    assert.match(swSource, new RegExp("var CACHE_VERSION = '" + versionJson.version + "';"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('end-to-end: running the script twice (two simulated deploys) produces two DIFFERENT CACHE_VERSION values -- the actual mechanism that makes sw.js\'s bytes change every deploy', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamtube-genversion-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'scripts'));
    fs.copyFileSync(
      path.join(__dirname, '..', 'scripts', 'generate-version.js'),
      path.join(tmpDir, 'scripts', 'generate-version.js')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'sw.js'),
      "var CACHE_VERSION = 'v0-unbuilt-dev';\n"
    );

    function runBuild(commitRef) {
      execFileSync(process.execPath, [path.join(tmpDir, 'scripts', 'generate-version.js')], {
        cwd: tmpDir,
        env: Object.assign({}, process.env, { COMMIT_REF: commitRef }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return fs.readFileSync(path.join(tmpDir, 'sw.js'), 'utf8');
    }

    var deploy1 = runBuild('1111111111111111111111111111111111111111');
    var deploy2 = runBuild('2222222222222222222222222222222222222222');

    assert.notEqual(deploy1, deploy2, 'a different commit each deploy must produce different sw.js bytes -- the whole point of auto-stamping instead of a manual bump');
    assert.match(deploy1, /1111111/);
    assert.match(deploy2, /2222222/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('end-to-end: a real build with DEPLOY_ID but no NETLIFY_BLOBS_BUILD_TOKEN configured (today\'s real, common case) still writes version.json/sw.js normally, and logs the deploy-log write as a safe no-op rather than failing the build', function () {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamtube-genversion-deploylog-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'scripts'));
    fs.mkdirSync(path.join(tmpDir, 'netlify', 'functions', 'lib'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'scripts', 'generate-version.js'),
      path.join(tmpDir, 'scripts', 'generate-version.js')
    );
    // The real lib file, at the SAME relative path generate-version.js's
    // own require('../netlify/functions/lib/deploy-log-store') expects --
    // proves the two are actually wired together, not just that each
    // passes its own isolated unit tests.
    fs.copyFileSync(
      path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'deploy-log-store.js'),
      path.join(tmpDir, 'netlify', 'functions', 'lib', 'deploy-log-store.js')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'sw.js'),
      "var CACHE_VERSION = 'v0-unbuilt-dev';\n"
    );

    // NODE_PATH lets the copied deploy-log-store.js's own
    // require('@netlify/blobs') resolve against this repo's REAL
    // node_modules despite tmpDir living outside the repo tree (Node
    // reads NODE_PATH at process startup, which execFileSync's `env`
    // controls here).
    var output = execFileSync(process.execPath, [path.join(tmpDir, 'scripts', 'generate-version.js')], {
      cwd: tmpDir,
      env: Object.assign({}, process.env, {
        COMMIT_REF: 'cafebabe1234567890abcdef1234567890abcdef',
        DEPLOY_ID: 'dep-test-noblobs',
        CONTEXT: 'production',
        NODE_PATH: path.join(__dirname, '..', 'node_modules')
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString();

    assert.match(output, /deploy-log entry not written \(no_blobs_credentials\)/, 'must log the specific no-op reason, not silently swallow it');
    assert.doesNotMatch(output, /non-fatal: (failed to write version\.json|failed to stamp sw\.js|deploy-log write failed|unexpected top-level error)/, 'the deploy-log no-op must never be confused with, or cause, a real failure of either of the other two steps');

    var versionJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'version.json'), 'utf8'));
    assert.equal(versionJson.commitSha, 'cafebabe1234567890abcdef1234567890abcdef');
    var swSource = fs.readFileSync(path.join(tmpDir, 'sw.js'), 'utf8');
    assert.match(swSource, /cafebab/); // sw.js's CACHE_VERSION carries the 7-char SHORT sha, not the full COMMIT_REF
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
