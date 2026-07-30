// test/helpers/settle.js
//
// Condition-based waiting for things this repo's browser tests observe
// from the NODE side (a page.route() handler pushing onto an array,
// bumping a counter) rather than from the DOM.
//
// ---------------------------------------------------------------------
// Why this exists — the full-suite flakiness root cause
// ---------------------------------------------------------------------
// The recurring "a different ~2-5 unrelated tests fail on every full-suite
// run, but every one of them passes 100% in isolation" symptom (tracker
// item full-test-suite-has-broader-nondetermini-6fbmcb, and the earlier
// narrower wizard-ui-behavioral-test-js-has-a-share-h3ja1k) was NOT shared
// module-level state and NOT a shared port. `node --test test/*.test.js`
// runs every FILE in its own child process, so no module-level state can
// leak between files at all, and test/helpers/static-server.js already
// listens on port 0 (a fresh ephemeral port per file).
//
// The actual cause is an unsound ordering assumption, repeated across the
// browser suites. The shape:
//
//     await page.click('#fn-contact-continue');
//     await page.waitForSelector('#fn-username');        // DOM gate
//     assert.equal(startPendingCalls.length, 1);         // node-side count
//
// `startPendingCalls` is only ever mutated by a page.route() handler
// running in THIS process. The DOM gate it is sequenced behind is not
// causally downstream of that handler — in wizard.html's case it is
// causally UPSTREAM of it, since the page calls next() (which renders
// #fn-username) and only then calls fetch(). So the assertion races two
// completely independent notification paths back to Node:
//
//   DOM gate:    renderer (rAF poll) -> browser process -> CDP -> node
//   route event: renderer -> network service -> browser process -> CDP -> node
//
// Nothing orders those two against each other. Measured on this sandbox
// while the rest of the suite was running (4 `node --test` workers each
// driving a Chromium on a 4-CPU box), the DOM gate won 15 times out of 25
// — i.e. the counter was still 0 when the assertion would have run — and
// in all 15 the call arrived just 4-12ms later. That few-millisecond
// margin is exactly why the failures look random, land on a different
// test each run, and always disappear when the file is re-run alone on an
// otherwise idle machine.
//
// ---------------------------------------------------------------------
// What this helper does about it
// ---------------------------------------------------------------------
// It replaces the implicit "surely it has arrived by now" with an
// explicit wait on the thing actually being asserted. It is deliberately
// NOT a retry/tolerance mechanism: it never re-runs a test, never
// swallows a failure, and never changes an assertion's meaning. If the
// condition genuinely never becomes true, settle() simply returns after
// the timeout and the original assertion fails with its original message
// — a real regression still fails, it just takes up to `timeout` ms
// longer to say so.
//
// Usage (one line, immediately above the assertion it protects):
//
//     await settle(function () { return startPendingCalls.length >= 1; });
//     assert.equal(startPendingCalls.length, 1, '...');
//
// Note the `>=`: wait until AT LEAST the expected number of calls have
// been observed, then let the existing `assert.equal` decide. Waiting for
// exact equality would hang forever on an over-count, hiding a real
// double-submit bug behind a timeout instead of failing the assertion.
//
// This helper is only for node-side observations. For anything observable
// in the page, keep using Playwright's own auto-waiting APIs
// (waitForSelector/waitForFunction/waitForURL) — they already do this
// correctly, and are causally correct for DOM state.

/**
 * Resolves as soon as `predicate()` returns truthy, or after `timeout`
 * ms, whichever comes first. Returns true if the predicate became
 * truthy, false if it timed out (callers normally ignore the return
 * value and let their own assertion report the failure).
 *
 * @param {() => boolean} predicate  Checked immediately, then every `interval` ms.
 * @param {{ timeout?: number, interval?: number }} [opts]
 * @returns {Promise<boolean>}
 */
async function settle(predicate, opts) {
  var options = opts || {};
  var timeout = typeof options.timeout === 'number' ? options.timeout : 5000;
  var interval = typeof options.interval === 'number' ? options.interval : 5;
  var deadline = Date.now() + timeout;
  // Checked before the first sleep: when the observation already landed
  // (the common case) this costs nothing and adds no delay to the suite.
  if (predicate()) return true;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, interval); });
    if (predicate()) return true;
  }
  return false;
}

/**
 * A response the test releases explicitly, instead of one that releases
 * itself on a stopwatch.
 *
 * The second flake mechanism behind the same tracker item: several
 * "abandoned attempt" tests hold a mocked endpoint back with a fixed
 * `await new Promise(r => setTimeout(r, 900))` inside the route handler,
 * and then race to drive the browser into the state under test (click
 * Back, run a second attempt through to a fresh screen) before that
 * stopwatch runs out. Each of those interactions is several CDP round
 * trips; on a loaded machine — the full suite runs 4 `node --test`
 * workers, each driving its own Chromium, on a 4-CPU box — they routinely
 * take longer than the hold. When the hold loses, the held response lands
 * mid-setup instead of at the moment the test intends, and the run either
 * fails outright (the page navigates away and a later waitForSelector
 * times out) or, worse, passes without ever exercising the race it claims
 * to cover. There is no "safe" number to raise 900 to; the window is a
 * race by construction.
 *
 * A gate removes the clock entirely: the handler waits until the test
 * says so, however long the setup takes.
 *
 *     var gateA = gate();
 *     await page.route('**\/register-account', async function (route) {
 *       if (isAttemptA(route)) await gateA.wait();   // held indefinitely
 *       route.fulfill({ ... });
 *     });
 *     ...drive the browser into the exact state under test...
 *     gateA.open();                                  // now let it land
 *     await settle(function () { return gateA.released; });
 *
 * `released` flips true once a waiter has actually observed the open, so
 * a test can wait for the response to genuinely be on its way rather than
 * guessing. Opening a gate nothing is waiting on is harmless, and a gate
 * that is never opened simply keeps its endpoint pending for the life of
 * the page — which is exactly what "still in flight" is supposed to mean.
 */
function gate() {
  var open;
  var opened = new Promise(function (resolve) { open = resolve; });
  var self = {
    released: false,
    /** Awaited inside a route handler: resolves only once open() is called. */
    wait: async function () {
      await opened;
      self.released = true;
    },
    /** Called by the test to let the held response through. */
    open: function () { open(); }
  };
  return self;
}

module.exports = { settle: settle, gate: gate };
