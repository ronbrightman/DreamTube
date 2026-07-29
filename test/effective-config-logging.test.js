// test/effective-config-logging.test.js
//
// Tracker item for-product-damage-assessment-env-var-ca-rmgaqh, task 3:
// MAX_GENERATIONS_PER_IP_PER_DAY silently sat at 2 in the live Netlify
// environment (a stale/typo value) while the checked-in code default said
// 40, and nothing in Netlify's function logs could reveal that — a code
// review can never see an env var override. netlify/functions/lib/
// effective-config.js's logEffectiveConfigOnce is called from each
// generation entry point's own MODULE-LEVEL code (generate-video.js,
// generate-image.js, start-pending-generation.js, and lib/entitlements.js
// for MAX_TOKEN_GRANTS_PER_IP_PER_DAY) so the RESOLVED effective value is
// directly observable in logs, not just inferable from a code review.
//
// Follows test/generate-video-model-config.test.js's established
// pattern for exercising module-load-time env var resolution: delete
// require.cache before each require so a fresh module evaluation actually
// re-reads process.env, relying on node's test runner giving each test
// *file* passed on the command line its own process (so this file's env
// var churn never leaks into another test file's module cache).

var test = require('node:test');
var assert = require('node:assert/strict');

/** Requires `modulePath` fresh (clearing its own require.cache entry first) while capturing every console.log call made during that require — this is where each of this task's module-level logEffectiveConfigOnce calls fires, since Node only ever executes a module's top-level code once, at first require ("once per cold start"). Restores the real console.log afterward no matter what. */
function requireFreshCapturingLogs(modulePath) {
  var resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  var lines = [];
  var realLog = console.log;
  console.log = function () {
    lines.push(Array.prototype.slice.call(arguments).join(' '));
  };
  try {
    require(modulePath);
  } finally {
    console.log = realLog;
  }
  return lines;
}

function cleanupEnv(names) {
  names.forEach(function (n) { delete process.env[n]; });
}

// ===== generate-video.js =====

test('generate-video.js logs effective_config for MAX_GENERATIONS_PER_IP_PER_DAY and DAILY_SPEND_CAP_USD at module load, using the code defaults when unset', function () {
  cleanupEnv(['MAX_GENERATIONS_PER_IP_PER_DAY', 'DAILY_SPEND_CAP_USD']);
  var lines = requireFreshCapturingLogs('../netlify/functions/generate-video');
  var maxLine = lines.find(function (l) { return l.indexOf('fn=generate-video MAX_GENERATIONS_PER_IP_PER_DAY=') !== -1; });
  var capLine = lines.find(function (l) { return l.indexOf('fn=generate-video DAILY_SPEND_CAP_USD=') !== -1; });
  assert.ok(maxLine, 'expected an effective_config log line for generate-video\'s MAX_GENERATIONS_PER_IP_PER_DAY');
  assert.match(maxLine, /^effective_config:/, 'log line should carry the greppable effective_config: prefix');
  assert.match(maxLine, /MAX_GENERATIONS_PER_IP_PER_DAY=40\b/, 'unset env var should resolve to the code default (40)');
  assert.match(maxLine, /raw_env=unset/, 'should report the raw env var as unset when it is not set');
  assert.ok(capLine, 'expected an effective_config log line for generate-video\'s DAILY_SPEND_CAP_USD');
  assert.match(capLine, /DAILY_SPEND_CAP_USD=50\b/, 'unset env var should resolve to the code default (50)');
});

test('generate-video.js logs the ACTUAL resolved value when MAX_GENERATIONS_PER_IP_PER_DAY is overridden -- this is the exact class of bug this task exists to make visible', function () {
  process.env.MAX_GENERATIONS_PER_IP_PER_DAY = '2';
  process.env.DAILY_SPEND_CAP_USD = '5';
  var lines = requireFreshCapturingLogs('../netlify/functions/generate-video');
  var maxLine = lines.find(function (l) { return l.indexOf('fn=generate-video MAX_GENERATIONS_PER_IP_PER_DAY=') !== -1; });
  var capLine = lines.find(function (l) { return l.indexOf('fn=generate-video DAILY_SPEND_CAP_USD=') !== -1; });
  assert.match(maxLine, /MAX_GENERATIONS_PER_IP_PER_DAY=2\b/, 'an env override to 2 (this incident\'s exact value) must show up as the resolved effective value, not the code default');
  assert.match(maxLine, /code_default=40/, 'the code default should still be reported alongside, for comparison');
  assert.match(capLine, /DAILY_SPEND_CAP_USD=5\b/);
  cleanupEnv(['MAX_GENERATIONS_PER_IP_PER_DAY', 'DAILY_SPEND_CAP_USD']);
});

// ===== generate-image.js =====

test('generate-image.js logs effective_config for MAX_GENERATIONS_PER_IP_PER_DAY and DAILY_SPEND_CAP_USD at module load', function () {
  cleanupEnv(['MAX_GENERATIONS_PER_IP_PER_DAY', 'DAILY_SPEND_CAP_USD']);
  var lines = requireFreshCapturingLogs('../netlify/functions/generate-image');
  var maxLine = lines.find(function (l) { return l.indexOf('fn=generate-image MAX_GENERATIONS_PER_IP_PER_DAY=') !== -1; });
  assert.ok(maxLine, 'expected an effective_config log line for generate-image\'s MAX_GENERATIONS_PER_IP_PER_DAY');
  assert.match(maxLine, /MAX_GENERATIONS_PER_IP_PER_DAY=40\b/);
});

// ===== start-pending-generation.js =====

test('start-pending-generation.js logs its own effective_config line (distinct from the generate-video.js/generate-image.js lines its own requires also trigger)', function () {
  cleanupEnv(['MAX_GENERATIONS_PER_IP_PER_DAY', 'DAILY_SPEND_CAP_USD']);
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  delete require.cache[require.resolve('../netlify/functions/generate-image')];
  var lines = requireFreshCapturingLogs('../netlify/functions/start-pending-generation');
  var ownLine = lines.find(function (l) { return l.indexOf('fn=start-pending-generation MAX_GENERATIONS_PER_IP_PER_DAY=') !== -1; });
  assert.ok(ownLine, 'expected start-pending-generation\'s own labeled effective_config line');
  assert.match(ownLine, /MAX_GENERATIONS_PER_IP_PER_DAY=40\b/);
});

// ===== lib/entitlements.js =====

test('lib/entitlements.js logs effective_config for MAX_TOKEN_GRANTS_PER_IP_PER_DAY at module load, defaulting to 5 when unset', function () {
  cleanupEnv(['MAX_TOKEN_GRANTS_PER_IP_PER_DAY']);
  var lines = requireFreshCapturingLogs('../netlify/functions/lib/entitlements');
  var line = lines.find(function (l) { return l.indexOf('fn=entitlements MAX_TOKEN_GRANTS_PER_IP_PER_DAY=') !== -1; });
  assert.ok(line, 'expected an effective_config log line for entitlements\' MAX_TOKEN_GRANTS_PER_IP_PER_DAY');
  assert.match(line, /MAX_TOKEN_GRANTS_PER_IP_PER_DAY=5\b/);
});

test('lib/entitlements.js reflects an override', function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '3';
  var lines = requireFreshCapturingLogs('../netlify/functions/lib/entitlements');
  var line = lines.find(function (l) { return l.indexOf('fn=entitlements MAX_TOKEN_GRANTS_PER_IP_PER_DAY=') !== -1; });
  assert.match(line, /MAX_TOKEN_GRANTS_PER_IP_PER_DAY=3\b/);
  cleanupEnv(['MAX_TOKEN_GRANTS_PER_IP_PER_DAY']);
});

// ===== Does NOT log per request (the whole point of module-level placement) =====

test('logEffectiveConfigOnce is not re-invoked on a second require of an already-cached module -- confirms this is a module-load-time (cold start), not per-call, log', function () {
  cleanupEnv(['MAX_GENERATIONS_PER_IP_PER_DAY']);
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  var realLog = console.log;
  var lines = [];
  console.log = function () { lines.push(Array.prototype.slice.call(arguments).join(' ')); };
  try {
    require('../netlify/functions/generate-video'); // first require: module top-level code runs, logs once
    require('../netlify/functions/generate-video'); // second require: served from require.cache, no re-execution
  } finally {
    console.log = realLog;
  }
  var matches = lines.filter(function (l) { return l.indexOf('fn=generate-video MAX_GENERATIONS_PER_IP_PER_DAY=') !== -1; });
  assert.equal(matches.length, 1, 'requiring an already-cached module a second time must not re-log the effective config -- module top-level code, and this log call within it, only ever runs once per process (cold start)');
});
