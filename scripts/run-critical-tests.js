#!/usr/bin/env node
// scripts/run-critical-tests.js
//
// Runs the CRITICAL TIER only -- the fast subset of test/*.test.js meant
// to run on every build/PR. See test/critical-tests-exclude-list.js for
// the exclude list itself and the classification rule, and
// docs/TEST_REGISTRY.md's "Test tiering" section for the full scheme
// (tracker item for-product-test-suite-pruning-tiering-f-qminmq).
//
// EXCLUDE-LIST, NOT INCLUDE-LIST: the critical tier is every file under
// test/*.test.js EXCEPT the ones named in critical-tests-exclude-list.js
// -- see that file's own header for why (three review rounds each found
// an include-list silently missing real money/data/security-relevant
// files; an exclude-list's failure mode is a slightly slower fast tier,
// never dropped coverage). A newly added test file is critical-tier by
// default with zero action required.
//
// Invoked via `npm run test:critical`. Plain node --child_process spawn
// of the same `node --test` this repo's own `npm test` already uses --
// no new test runner/framework, just a narrower file list -- matching
// this repo's no-build-step, no-new-dependency convention.
//
// Fails loudly (before running anything) if the exclude list references
// a file that doesn't exist on disk -- a renamed/deleted test file left
// stale in the exclude list should be caught immediately, not silently
// ignored.

var path = require('node:path');
var fs = require('node:fs');
var spawnSync = require('node:child_process').spawnSync;

var TEST_DIR = path.join(__dirname, '..', 'test');
var excluded = require('../test/critical-tests-exclude-list.js');
var excludedSet = new Set(excluded);

var missing = excluded.filter(function (name) {
  return !fs.existsSync(path.join(TEST_DIR, name));
});
if (missing.length > 0) {
  console.error('run-critical-tests: the exclude list references file(s) that no longer exist under test/ -- fix or remove these entries in test/critical-tests-exclude-list.js:');
  missing.forEach(function (name) { console.error('  - ' + name); });
  process.exit(1);
}

var allTestFiles = fs.readdirSync(TEST_DIR).filter(function (n) { return n.endsWith('.test.js'); });
var criticalFiles = allTestFiles.filter(function (name) { return !excludedSet.has(name); });
var absolutePaths = criticalFiles.map(function (name) { return path.join(TEST_DIR, name); });

console.log('run-critical-tests: running ' + absolutePaths.length + ' critical-tier file(s) (of ' + allTestFiles.length + ' total under test/, ' + excluded.length + ' excluded) -- see test/critical-tests-exclude-list.js\n');

var result = spawnSync('node', ['--test'].concat(absolutePaths), { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
