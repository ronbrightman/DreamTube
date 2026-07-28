// netlify/functions/lib/blobs-retry.js
//
// Shared bounded read -> mutate -> write -> verify retry loop for any
// Netlify-Blobs-backed store that needs to defend against a check-then-act
// race. Not a Netlify Function itself — a plain module other lib/*.js
// files require(), same "self-contained function, shared bits in a plain
// require()" pattern the rest of this codebase already uses.
//
// WHY THIS EXISTS: the installed @netlify/blobs SDK has no compare-and-
// swap / conditional-write primitive (`set`/`setJSON` accept only a
// `metadata` option), and every store in this codebase reads under
// Blobs' default EVENTUAL consistency (strong consistency threw
// BlobsConsistencyError unconditionally in this deploy environment — see
// entitlements.js's own header comment for the incident). So two
// genuinely concurrent callers touching the same key — or even a single
// caller's own verify-read racing its own just-completed write — can
// each observe stale state and silently clobber or duplicate each
// other's change, with no error to either side.
//
// This exact bounded read -> mutate -> write -> verify pattern was
// independently discovered and hand-rolled FOUR separate times before
// this extraction: tracker-store.js's writeItemsWithRetry (the original,
// most mature version — full-array mutate/verify), entitlements.js's
// creditTokenPackOnce (Dodo Payments webhook double-credit prevention —
// single dedup-marker key), pending-dreams.js's tryTransition
// (webhook-vs-claim race on a single record's status field), and
// support-store.js's appendMessage (a fourth copy-pasted full-array
// version). See tracker.html's tracker items
// recurring-gap-new-blobs-backed-stores-ke-d11k47 and
// extract-shared-lib-blobs-retry-js-now-th-p1avvq for the paper trail.
//
// THE SHAPE: on each attempt (up to `maxAttempts`, default 3 — same
// bound all four original implementations independently chose, for the
// same "fail rather than hang the request indefinitely on a still-
// propagating eventually-consistent read" reasoning):
//   1. `current = await read(event)` — read the latest state. Callers
//      pass their OWN read function rather than this module reading
//      `key` directly, because "the latest state" isn't always a plain
//      `store.get(key)`: tracker-store.js's getItems() also lazily seeds
//      a fresh store and self-heals legacy item shapes, and
//      support-store.js's getMessages() defaults a never-written store
//      to `[]` rather than `null`. Any caller with nothing special to do
//      can just pass a plain raw-get function.
//   2. `mutated = mutate(current)` — synchronous, computes the FULL next
//      value to persist at `key` from the freshest read. Called fresh on
//      every attempt (never reused from a previous attempt), so it must
//      be idempotent against its own target end state — a retry can be
//      triggered by a false-negative verify (our own just-written data
//      not yet visible to an eventually consistent read), not just a
//      real clobber, so calling `mutate` again against a `current` that
//      already reflects a previous attempt's write must not double-apply
//      (e.g. double-append the same item).
//
//      `mutate` may instead return the exported `SKIP` sentinel to abort
//      the ENTIRE operation right now, without writing or retrying —
//      for a precondition that, once false, can never become true again
//      by retrying (e.g. entitlements.js: a dedup marker that already
//      exists; pending-dreams.js: a record that's already moved past the
//      status this transition expects). Returning SKIP is a normal,
//      expected outcome (e.g. "this webhook was already processed"), not
//      an error — the loop returns immediately with `skipped: true` and
//      `current` set to whatever this attempt's read showed, so the
//      caller can build its own "already handled" response from it.
//   3. Write `mutated` to `key`.
//   4. Read `key` back and call `verify(verifyRead)`. If it returns
//      true, THIS attempt won — return `{ ok: true, value: mutated,
//      current }` immediately. If false, some other writer's change is
//      the one actually visible (or this write hasn't propagated to the
//      verify-read yet) — loop back to a fresh read on the next attempt.
//
// If every attempt's verify fails, returns `{ ok: false, skipped: false,
// value: <last attempt's mutated value>, current: <last attempt's read>
// }` — this module itself does NOT decide fail-open vs fail-closed
// (tracker-store.js/support-store.js's array-mutate call sites fail OPEN,
// returning `value` as the result anyway on the theory that a retry
// exhausted by lag rather than a real clobber still produced a
// locally-correct value; entitlements.js/pending-dreams.js's marker-based
// call sites fail CLOSED, treating `ok: false` as "did not happen" and
// never touching `value`) — that decision is domain-specific and stays
// with each caller, same as every other bit of "what verify actually
// checks" logic. See each call site's own doc comments for its specific
// choice and reasoning.
//
// This narrows the race window (a clobber landing between our write and
// our own verify-read gets caught and retried against the newer state)
// but does NOT eliminate it — the verify read itself is still only
// eventually consistent, so it can lag behind the very write it's
// checking, and a clobber landing in the gap between a successful verify
// and the caller actually acting on `ok: true` remains possible in
// principle. Every real call site's own doc comment already carries this
// same honest caveat; this extraction doesn't change the underlying
// guarantee, only where the mechanism lives.

var { getStore, connectLambda } = require('@netlify/blobs');

var DEFAULT_MAX_ATTEMPTS = 3;

// Delay (ms) inserted between attempts (never before the FIRST one, and
// never after the last — a doomed final attempt gains nothing from a
// trailing pause). Root cause of tracker item
// for-product-daily-claim-bugs-founder-rea-kei2ub's BUG 2 ("Couldn't
// claim right now" for a genuinely eligible real user): every attempt in
// this loop used to fire back-to-back with ZERO elapsed time between
// them, against a store this file's own header comment already
// documents as only eventually consistent (entitlements.js's own header
// comment cites propagation lag up to ~60s in the worst case). Three
// rapid-fire attempts within the same handful of milliseconds gives that
// propagation no real time to catch up, so a verify-read can plausibly
// fail to see its own just-completed write on EVERY attempt, exhausting
// the loop and surfacing a genuine (if rare) failure to a genuinely
// eligible user — exactly the class of bug a synchronous in-memory mock
// store can never reproduce, since it has no propagation lag to model in
// the first place.
//
// This does not change the retry COUNT or the read/mutate/verify
// contract — purely additive real-world reliability, benefiting all four
// call sites documented at the top of this file, not just the daily
// claim (tracker-store.js/pending-dreams.js/support-store.js all share
// the exact same underlying hazard). 200ms is a judgment call, not a
// founder-approved figure: large enough to matter against real
// propagation lag, trivial against any Netlify Function's execution
// budget (worst case here is maxAttempts-1 delays — 2 x 200ms = 400ms —
// against a multi-second function timeout), and overridable per call via
// `options.retryDelayMs` (test/blobs-retry.test.js passes 0 on the
// exhaustion-focused tests that don't need it, to keep this file's own
// test run fast).
var DEFAULT_RETRY_DELAY_MS = 200;

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Sentinel `mutate(current)` can return to abort the whole operation
// immediately without writing or retrying — see the doc block above.
// A unique Symbol so it can never collide with a real value a caller
// might legitimately want to persist.
var SKIP = Symbol('blobs-retry-skip');

/**
 * Runs the bounded read -> mutate -> write -> verify retry loop described
 * in this file's header comment against `storeName`/`key`.
 *
 * `options`:
 *   read(event) -> Promise<current>  (required) — reads the latest state.
 *   mutate(current) -> next | SKIP    (required) — synchronous.
 *   verify(verifyReadValue) -> boolean (required) — synchronous.
 *   maxAttempts: number (default 3)
 *   retryDelayMs: number (default 200) — real elapsed delay inserted
 *     between attempts (never before the first), to give Blobs' eventual
 *     consistency a genuine window to propagate before the next
 *     verify-read — see this constant's own doc comment above. Pass 0 to
 *     disable entirely (e.g. a test that wants the old instant behavior).
 *
 * Returns one of:
 *   { ok: true,  skipped: false, value: <mutated>, current: <last read> }
 *   { ok: false, skipped: true,  value: undefined, current: <last read> }
 *   { ok: false, skipped: false, value: <last attempt's mutated value>, current: <last read> }
 *     (every attempt's verify failed — attempts exhausted)
 */
async function retryingWrite(event, storeName, key, options) {
  var read = options.read;
  var mutate = options.mutate;
  var verify = options.verify;
  var maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  var retryDelayMs = typeof options.retryDelayMs === 'number' ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS;

  var lastMutated;
  var lastCurrent;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
    var current = await read(event);
    lastCurrent = current;

    var mutated = mutate(current);
    if (mutated === SKIP) {
      return { ok: false, skipped: true, value: undefined, current: current };
    }
    lastMutated = mutated;

    connectLambda(event);
    await getStore({ name: storeName }).setJSON(key, mutated);

    connectLambda(event);
    var verifyRead = await getStore({ name: storeName }).get(key, { type: 'json' });
    if (verify(verifyRead)) {
      return { ok: true, skipped: false, value: mutated, current: current };
    }
    // Someone else's write is the one actually visible (or ours hasn't
    // propagated to this read yet) — loop back to a fresh read.
  }

  return { ok: false, skipped: false, value: lastMutated, current: lastCurrent };
}

module.exports = { retryingWrite, SKIP, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_DELAY_MS };
