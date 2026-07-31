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
//
// ── WHAT WAS RE-CHECKED 2026-07-30, AND WHAT IT RULED IN/OUT ──
// (tracker.html's for-product-bug-founder-affects-all-funn-0efe7t item,
// round 4, investigating whether this loop is structurally the wrong tool)
//
// 1. STRONG CONSISTENCY IS STILL GENUINELY UNAVAILABLE on this deploy path,
//    confirming entitlements.js's older incident note rather than
//    superseding it — and, importantly, upgrading the SDK would NOT change
//    that. Read directly out of the SDK source, in BOTH the installed
//    @netlify/blobs 8.2.0 and the current 10.7.11: `connectLambda(event)`
//    builds its environment context from exactly four fields (deployID,
//    edgeURL, siteID, token) and NEVER populates `uncachedEdgeURL`; and
//    `Client.getFinalRequest` throws `BlobsConsistencyError` whenever
//    `consistency: 'strong'` is requested while `edgeURL` is set and
//    `uncachedEdgeURL` isn't. Every store in this codebase reaches Blobs
//    through connectLambda, so `consistency: 'strong'` throws for all of
//    them, on both versions. Not a lever available here.
//
// 2. RETRY-WIDENING CANNOT FIX THIS CLASS on its own, and the ceiling is
//    arithmetic, not judgment. Netlify documents Blobs propagation as
//    guaranteed to all edge locations only "within 60 seconds". A Netlify
//    synchronous function's default execution limit is 10 seconds total —
//    and mark-generation-completed.js, the busiest caller of this path,
//    already spends part of that on a fal status round trip plus half a
//    dozen other Blobs round trips before it ever reaches the marker claim.
//    So the entire attainable retry budget is a small fraction of the
//    documented worst case; buying a few hundred more milliseconds trades a
//    real timeout risk for no guarantee. The defaults are deliberately left
//    alone, and callers that need to distinguish "our write landed but the
//    read hasn't caught up" from "our write never landed" should do what
//    entitlements.js's claimDailyTokens and first-dream-email-store.js's
//    markSentOnce now both do: one final confirming read that checks for
//    their OWN attempt/claim id.
//
// 3. THERE IS NOW A REAL CAS PRIMITIVE, but only in a much newer SDK.
//    @netlify/blobs 10.x adds genuine conditional writes —
//    `set(key, value, { onlyIfNew: true })` and `{ onlyIfMatch: etag }`,
//    returning `{ modified: boolean }` and implemented server-side via
//    if-none-match/if-match — which is exactly the compare-and-swap
//    primitive this file's header says doesn't exist, and would let every
//    single-key dedup-marker call site (first-dream-email-store.js,
//    push-dedup-store.js, entitlements.js's payment/refund markers) drop
//    the read/verify race entirely. The installed 8.2.0 has none of it.
//    Deliberately NOT taken here: that is a two-major-version dependency
//    bump touching every Blobs-backed store including the money paths, its
//    behavior against this specific deploy environment cannot be verified
//    from a sandbox, and it needs its own reviewed change — see this
//    tracker item's round-4 write-up.

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

// ── PER-ATTEMPT DIAGNOSTICS (tracker.html's
//    for-product-bug-founder-affects-all-funn-0efe7t item, round 4) ──
//
// Until this, an exhausted loop was a total black box: the only thing any
// caller could say afterwards was "ok:false, not skipped", with no way to
// tell apart the three genuinely different failure shapes that all land
// there — (a) our own write landing but every verify-read lagging behind it
// (Blobs' documented eventual consistency: Netlify guarantees propagation to
// all edge locations only "within 60 seconds", against this loop's total
// wall-clock budget of maxAttempts-1 delays ≈ 400ms by default), (b) a real,
// repeated clobber by a genuinely concurrent writer, or (c) a write that
// isn't landing at all. Those need completely different fixes, and there was
// no evidence in production logs to choose between them — which is exactly
// how this tracker item burned three rounds. This turns the NEXT occurrence,
// for ANY of the four call sites documented at the top of this file, into
// something readable straight out of Netlify's function logs.
//
// Shape-only, deliberately: `describeRead` records whether a read produced
// null / undefined / an actual value, and NEVER the value itself or the key.
// Every current caller's records carry real PII (first-dream-email-store.js
// keys on a username; entitlements.js keys on an email and stores balances) —
// a raw-email log line written during round 3 of this same item had to be
// pulled back out before merge, and this shared lib must not reintroduce
// that surface for all four callers at once. Callers that want a domain
// identifier in the log already log their own (see first-dream-email-store.js's
// markSentOnce), where the PII decision is theirs to make.
function describeRead(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return 'value';
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

  // See "PER-ATTEMPT DIAGNOSTICS" above. Returned on every exit path (as
  // `attempts`) so a caller can fold it into its own domain-specific log or
  // assert on it in a test, and logged here in one structured line on the
  // exhaustion path — the one outcome that is genuinely unexplained without
  // it. Never logged on ok/skip: both are ordinary, high-frequency outcomes
  // (claimDailyTokens runs this on every daily claim), and a line per call
  // would bury the signal this exists to surface.
  var startedAt = Date.now();
  var attempts = [];

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
    var record = { attempt: attempt + 1, startedAtMs: Date.now() - startedAt };
    attempts.push(record);

    var current = await read(event);
    lastCurrent = current;
    record.read = describeRead(current);
    record.readAtMs = Date.now() - startedAt;

    var mutated = mutate(current);
    if (mutated === SKIP) {
      record.outcome = 'skip';
      return { ok: false, skipped: true, value: undefined, current: current, attempts: attempts };
    }
    lastMutated = mutated;

    connectLambda(event);
    await getStore({ name: storeName }).setJSON(key, mutated);
    record.wroteAtMs = Date.now() - startedAt;

    connectLambda(event);
    var verifyRead = await getStore({ name: storeName }).get(key, { type: 'json' });
    record.verifyRead = describeRead(verifyRead);
    record.verifyReadAtMs = Date.now() - startedAt;

    if (verify(verifyRead)) {
      record.outcome = 'verified';
      return { ok: true, skipped: false, value: mutated, current: current, attempts: attempts };
    }
    record.outcome = 'verify_failed';
    // Someone else's write is the one actually visible (or ours hasn't
    // propagated to this read yet) — loop back to a fresh read.
  }

  // Store name (not the key — see describeRead's own comment on why) plus
  // the full per-attempt trace: attempt number, ms elapsed since the loop
  // started at each step, what each read and verify-read actually saw
  // (null/undefined/value), and which step each attempt died at.
  console.error('blobs-retry: exhausted ' + maxAttempts + ' attempts on store=' + storeName
    + ' retryDelayMs=' + retryDelayMs
    + ' totalElapsedMs=' + (Date.now() - startedAt)
    + ' trace=' + JSON.stringify(attempts));

  return { ok: false, skipped: false, value: lastMutated, current: lastCurrent, attempts: attempts };
}

module.exports = { retryingWrite, SKIP, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_DELAY_MS };
