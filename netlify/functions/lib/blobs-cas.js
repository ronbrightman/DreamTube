// netlify/functions/lib/blobs-cas.js
//
// Shared REAL compare-and-swap read -> mutate -> write loop for any
// Netlify-Blobs-backed record that needs to defend against a "concurrent
// writes to the SAME key landing out of order" race — the counterpart to
// lib/blobs-retry.js's own bounded read -> mutate -> write -> verify loop,
// built on the genuine CAS primitive lib/blobs-retry.js's own header
// comment (section 3, "THERE IS NOW A REAL CAS PRIMITIVE") documents as
// existing only in a much newer SDK than this codebase's default
// `@netlify/blobs` 8.2.0.
//
// WHY THIS EXISTS, AND WHY IT'S A SEPARATE FILE FROM blobs-retry.js:
// blobs-retry.js's own read -> mutate -> write -> verify loop is a
// best-effort MITIGATION of Blobs' lack of compare-and-swap on the
// installed 8.2.0 SDK — it narrows the race window (a clobber landing
// between our write and our own verify-read gets caught and retried) but
// cannot eliminate it, because the verify-read itself is only eventually
// consistent and can lag behind the very write it's checking (see that
// file's own header comment, and every one of its callers' own "ambiguous
// self-clobber" handling this forced on them — entitlements.js's
// claimDailyTokens SKIP-branch attemptId check being the most elaborate
// example). Two real, evidenced incidents (tracker.html's
// for-product-p1-urgent-fresh-signup-can-d-qhrrqy "claim erasure" and
// for-product-likes-vanish-from-feed-video-fyqks0 "likes clobber") both
// trace to exactly this residual gap: a caller's own write landing, but a
// LATER, differently-shaped write from a different caller landing on top
// of it because Blobs' eventual consistency let it observe stale state
// with no atomicity to stop it.
//
// `@netlify/blobs` 10.x (installed here as the separately-aliased
// `blobs10` package — see package.json and
// lib/first-dream-email-store.js's own header comment for the full "why a
// separate alias" reasoning, which applies identically here) adds a
// GENUINE compare-and-swap write: `store.setJSON(key, value, {
// onlyIfMatch: etag })` succeeds (`{ modified: true }`) ONLY if the key's
// current server-side etag still matches what was just read, and
// atomically fails (`{ modified: false }`, never throws) otherwise — the
// server itself is the referee, not a client-side verify-read that can
// itself be stale. Paired with `store.getWithMetadata(key)` (which returns
// that etag alongside the current value), this closes the exact ambiguity
// blobs-retry.js's own callers had to work around with attemptId/claimId
// markers: a `modified: true` result IS unambiguous proof this attempt's
// write is what's now persisted — there is no "did my own write land but
// my verify-read just lag behind it" question left to ask, because there
// is no separate verify-read anymore. A CAS mismatch (`modified: false`)
// means, definitively, that SOME OTHER write is now the record's current
// state — not "maybe ours, still propagating."
//
// THE READ SIDE IS STILL ONLY EVENTUALLY CONSISTENT — CAS closes the WRITE
// race, not the READ one. `getWithMetadata`'s own read can still be stale
// (this file's own retry loop exists precisely because of that): an
// attempt built from a stale read will have its conditional write
// correctly REJECTED once it reaches the server (the etag it's holding is
// already out of date) — never silently applied against the wrong base —
// and the loop's next attempt gets a fresh(er) read to try again. This is
// what makes the CAS write itself the actual safety mechanism, not merely
// a narrower version of the same mitigation: a wrong guess computed from a
// stale read can NEVER commit, whereas under the old verify-loop pattern a
// stale-but-plausible-looking write genuinely could (that's the entire
// "claim erasure" incident).
//
// THE SHAPE: on each attempt (up to `maxAttempts`, default matches
// blobs-retry.js's own DEFAULT_MAX_ATTEMPTS for consistency, callers may
// override):
//   1. `getWithMetadata(key)` — the latest state PLUS its current etag (or
//      `null`/no etag if the key doesn't exist yet).
//   2. `mutate(current)` — synchronous, computes the FULL next value to
//      persist, from this attempt's own fresh read. Same "must be called
//      fresh on every attempt, and needs no self-idempotency trick" shape
//      as blobs-retry.js's own `mutate` — but, unlike that file, a CAS
//      retry is ALWAYS triggered by a genuine loss (someone else's write
//      is now the current state), never by a false-negative verify-read
//      lagging behind our own already-successful write — so `mutate`
//      no longer needs the attemptId/claimId self-recognition trick most
//      of blobs-retry.js's own callers had to add (see entitlements.js's
//      claimDailyTokens/creditTokenPackAmountOnce/etc. for the pre-CAS
//      version of that workaround, and their own post-migration doc
//      comments for why it's gone). `mutate` may still return the
//      exported `SKIP` sentinel to abort the whole operation right now —
//      same meaning as blobs-retry.js's own SKIP.
//   3. Write `mutated` conditionally: `{ onlyIfMatch: etag }` if this
//      attempt's read found an existing record, `{ onlyIfNew: true }` if
//      it didn't (creating a brand-new key) — NEVER an unconditional
//      write. If the write resolves `{ modified: true }`, THIS attempt's
//      write is now the record's real, current state — return
//      immediately. If `{ modified: false }`, someone else's write won
//      the race (or this read was already stale when it started) — loop
//      back to a fresh read on the next attempt.
//
// Returns the SAME result shape as blobs-retry.js's retryingWrite, so
// existing call sites' downstream handling (skipped / exhausted / ok
// branches) ports over with minimal churn:
//   { ok: true,  skipped: false, value: <mutated>, current: <last read> }
//   { ok: false, skipped: true,  value: undefined, current: <last read> }
//   { ok: false, skipped: false, value: undefined, current: <last read> }
//     (every attempt's CAS write lost — attempts exhausted)
//
// Fail-open vs fail-closed on exhaustion is, same as blobs-retry.js, left
// entirely to the caller — this module has no opinion. See each
// entitlements.js call site's own doc comment (post-migration) for its
// specific choice.

var { getStore, connectLambda } = require('blobs10');

var DEFAULT_MAX_ATTEMPTS = 3; // matches blobs-retry.js's own default, and entitlements.js's existing MAX_CREDIT_ATTEMPTS -- see this file's header comment; a CAS mismatch is a clean, unambiguous "someone else won," so this bound is if anything MORE reliably sufficient than the old verify-loop's identical bound was.

// Real elapsed delay (ms) inserted between attempts (never before the
// first, never after the last) -- mirrors blobs-retry.js's own
// DEFAULT_RETRY_DELAY_MS and identical reasoning: the READ side of Blobs
// is still only eventually consistent (see this file's header comment), so
// a fresh read immediately after a lost CAS race can plausibly still be
// looking at the SAME stale state that just lost, rather than the winner's
// now-current one. Giving real propagation a moment between attempts is
// what actually lets each retry make progress instead of spinning on the
// same stale read.
var DEFAULT_RETRY_DELAY_MS = 200;

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Sentinel `mutate(current)` can return to abort the whole operation
// immediately without writing or retrying -- same meaning and same
// "a unique Symbol so it can never collide with a real value" reasoning as
// blobs-retry.js's own SKIP. Deliberately a SEPARATE symbol, not a
// re-export of blobs-retry.js's own SKIP -- a caller migrating one call
// site to this module while leaving sibling call sites on blobs-retry.js
// (entitlements.js does exactly this, see that file) must not be able to
// mix the two up; each module's own `mutate` only ever needs to recognize
// its OWN sentinel.
var SKIP = Symbol('blobs-cas-skip');

// Shape-only per-attempt diagnostics, logged on exhaustion only -- same
// "never the key or the record's own value, only whether a read/write saw
// something vs. nothing" PII discipline as blobs-retry.js's own
// describeRead/PER-ATTEMPT DIAGNOSTICS section; see that file's header
// comment for the full reasoning (every real caller of this module keys on
// an email or a username, same as blobs-retry.js's callers).
function describeCurrent(current) {
  if (current === null || current === undefined) return 'null';
  return 'value';
}

/**
 * Runs the bounded read -> mutate -> conditional-write CAS loop described
 * in this file's header comment against `storeName`/`key`.
 *
 * `options`:
 *   mutate(current) -> next | SKIP  (required) — synchronous. `current` is
 *     this attempt's own fresh `getWithMetadata` read's `data` (or `null`
 *     if the key doesn't exist yet).
 *   maxAttempts: number (default 3)
 *   retryDelayMs: number (default 200) — see DEFAULT_RETRY_DELAY_MS above;
 *     pass 0 to disable (e.g. a test that wants the old instant behavior).
 */
async function casWrite(event, storeName, key, options) {
  var mutate = options.mutate;
  var maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  var retryDelayMs = typeof options.retryDelayMs === 'number' ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS;

  var lastCurrent = null;
  var startedAt = Date.now();
  var attempts = [];

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
    var record = { attempt: attempt + 1, startedAtMs: Date.now() - startedAt };
    attempts.push(record);

    connectLambda(event);
    var got = await getStore({ name: storeName }).getWithMetadata(key, { type: 'json' });
    var current = got ? got.data : null;
    var etag = got ? got.etag : undefined;
    lastCurrent = current;
    record.read = describeCurrent(current);
    record.readAtMs = Date.now() - startedAt;

    var mutated = mutate(current);
    if (mutated === SKIP) {
      record.outcome = 'skip';
      return { ok: false, skipped: true, value: undefined, current: current, attempts: attempts };
    }

    connectLambda(event);
    var writeOptions = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    var writeResult = await getStore({ name: storeName }).setJSON(key, mutated, writeOptions);
    record.wroteAtMs = Date.now() - startedAt;

    if (writeResult && writeResult.modified === true) {
      record.outcome = 'cas_won';
      return { ok: true, skipped: false, value: mutated, current: current, attempts: attempts };
    }
    record.outcome = 'cas_lost';
    // Someone else's write is now the record's current state (or this
    // attempt's own read was already stale when it started) -- loop back
    // to a fresh read on the next attempt.
  }

  console.error('blobs-cas: exhausted ' + maxAttempts + ' attempts on store=' + storeName
    + ' retryDelayMs=' + retryDelayMs
    + ' totalElapsedMs=' + (Date.now() - startedAt)
    + ' trace=' + JSON.stringify(attempts));

  return { ok: false, skipped: false, value: undefined, current: lastCurrent, attempts: attempts };
}

module.exports = { casWrite, SKIP, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_DELAY_MS };
