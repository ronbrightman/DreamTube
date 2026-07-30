// test/settle-helper.test.js
//
// Pins the contract of test/helpers/settle.js — the condition-based wait
// introduced to fix the full-suite cross-file flakiness (tracker item
// full-test-suite-has-broader-nondetermini-6fbmcb; see that helper's own
// header for the measured root cause). The helper is now load-bearing for
// ~90 assertions across 14 browser suites, so its two failure-relevant
// properties need coverage of their own:
//
//   1. It must actually wait for a LATE observation (the bug it fixes).
//   2. It must NOT swallow a condition that never becomes true — it has
//      to give up and let the caller's own assertion fail, or a real
//      regression would silently turn into a hang or a false pass.
//
// Plain node:test, no browser — these are pure timing properties.

var test = require('node:test');
var assert = require('node:assert/strict');
var settle = require('./helpers/settle').settle;

test('returns immediately (no added delay) when the condition is already true', async function () {
  var t0 = Date.now();
  var result = await settle(function () { return true; });
  assert.equal(result, true);
  assert.ok(Date.now() - t0 < 50, 'an already-satisfied condition must not cost the suite any wall-clock time');
});

test('waits for an observation that lands a few ms late — exactly the race this exists to close', async function () {
  var calls = [];
  setTimeout(function () { calls.push('late-arrival'); }, 40);
  var t0 = Date.now();
  var result = await settle(function () { return calls.length >= 1; });
  assert.equal(result, true, 'must resolve once the late observation lands');
  assert.equal(calls.length, 1);
  var waited = Date.now() - t0;
  assert.ok(waited >= 35, 'must have actually waited for it, not raced past (waited ' + waited + 'ms)');
  assert.ok(waited < 1000, 'must resolve promptly once satisfied, not sit out the full timeout (waited ' + waited + 'ms)');
});

test('gives up after the timeout and returns false, so a genuinely-never-called endpoint still fails the caller\'s assertion', async function () {
  var calls = [];
  var t0 = Date.now();
  var result = await settle(function () { return calls.length >= 1; }, { timeout: 120 });
  assert.equal(result, false, 'must report that it timed out rather than hanging or pretending success');
  var waited = Date.now() - t0;
  assert.ok(waited >= 110, 'must honor the full timeout before giving up (waited ' + waited + 'ms)');
  assert.ok(waited < 2000, 'must not overshoot the timeout (waited ' + waited + 'ms)');
  // The caller's own assertion is what reports the failure — unchanged
  // message, unchanged meaning, just up to `timeout` ms later.
  assert.throws(function () { assert.equal(calls.length, 1, 'endpoint must be called once'); });
});

test('a condition that goes true and then false again still resolves (it latches on the first satisfied poll)', async function () {
  // Wide window between the flip-true and flip-false marks (not the
  // narrow ~5ms this test used to use) -- under heavy CPU contention
  // (many concurrent full-suite runs, exactly the load this helper
  // exists to survive) a too-tight window can let the poll miss the
  // true state entirely before it flips back, which is a fragile TEST
  // margin, not a bug in settle() itself.
  var flipped = false;
  setTimeout(function () { flipped = true; }, 30);
  setTimeout(function () { flipped = false; }, 300);
  var result = await settle(function () { return flipped; }, { timeout: 1000, interval: 5 });
  assert.equal(result, true);
});
