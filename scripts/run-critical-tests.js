#!/usr/bin/env node
// scripts/run-critical-tests.js
//
// Runs the CRITICAL TIER only -- the fast subset of test/*.test.js meant
// to run on every build/PR. See test/critical-tests-manifest.js for the
// list itself and the classification rule, and docs/TEST_REGISTRY.md's
// "Test tiering" section for the full scheme (tracker item
// for-product-test-suite-pruning-tiering-f-qminmq).
//
// Invoked via `npm run test:critical`. Plain node --child_process spawn
// of the same `node --test` this repo's own `npm test` already uses --
// no new test runner/framework, just a narrower file list -- matching
// this repo's no-build-step, no-new-dependency convention.
//
// Fails loudly (before running anything) if the manifest references a
// file that doesn't exist on disk -- a renamed/deleted test file left
// stale in the manifest should be caught immediately, not silently
// skipped.

var path = require('node:path');
var fs = require('node:fs');
var spawnSync = require('node:child_process').spawnSync;

var TEST_DIR = path.join(__dirname, '..', 'test');
var manifest = require('../test/critical-tests-manifest.js');

var missing = manifest.filter(function (name) {
  return !fs.existsSync(path.join(TEST_DIR, name));
});
if (missing.length > 0) {
  console.error('run-critical-tests: the manifest references file(s) that no longer exist under test/ -- fix or remove these entries in test/critical-tests-manifest.js:');
  missing.forEach(function (name) { console.error('  - ' + name); });
  process.exit(1);
}

var absolutePaths = manifest.map(function (name) { return path.join(TEST_DIR, name); });

console.log('run-critical-tests: running ' + absolutePaths.length + ' critical-tier file(s) (of ' + fs.readdirSync(TEST_DIR).filter(function (n) { return n.endsWith('.test.js'); }).length + ' total under test/) -- see test/critical-tests-manifest.js\n');

var result = spawnSync('node', ['--test'].concat(absolutePaths), { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
