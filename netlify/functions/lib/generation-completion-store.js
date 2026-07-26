// netlify/functions/lib/generation-completion-store.js
//
// Durable, server-side replacement for the sessionStorage
// `dreamtube_just_generated_id` marker (tracker.html's
// result-htmls-firstvideocreated-still-dep-qfg48t item, founder-approved
// 2026-07-27) -- proves a `result.html?id=...` page load is the actual
// MOMENT a generation just finished, not a later revisit/reload of an old
// result page. See docs/EVENT_TAXONOMY.md's "FirstVideoCreated" section
// for the full two-guard picture this is one half of; js/store.js's
// `markFirstVideoCreatedIfEligible` (the OTHER, unchanged half -- the
// account-level "is this genuinely the first-ever completed dream" check)
// stays exactly as it was, since dream ownership/count data is local-only
// and has no server-side equivalent to move it to.
//
// KEYED BY operationName, NOT dreamId (review finding, fixed 2026-07-27 --
// the original version of this file was dreamId-keyed; see git history).
// Dream ids (js/store.js's `newId()`, `'d' + Math.random().toString(36)
// .slice(2,9)`) are client-invented AND already public elsewhere in this
// app -- explore.html/profile.html/watch.html all link straight to
// `result.html?id=<dreamId>`, and profile.html's own dreams grid is the
// ORDINARY way a user revisits their own past dream. Keying this marker
// on dreamId meant ANY unauthenticated caller who merely knew/guessed a
// real dreamId (trivial: browse the public feed, or a target's own public
// profile) could POST it to mark-generation-completed and plant a marker
// for it -- with no ownership check and no TTL, that marker would sit
// until the victim's own next ordinary revisit of their own old dream
// consumed it, forging a FirstVideoCreated fire (Pixel + CAPI + PostHog)
// for an account that never actually just generated anything. That's a
// forged signal injected directly into the exact ad-optimization metric
// this whole feature exists to make trustworthy -- strictly worse than
// the old sessionStorage design, which could only ever be set by the
// victim's OWN browser from a real processing.html redirect.
//
// operationName (the job id generate-video.js/generate-image.js issue at
// submission time, e.g. "fal:fal-ai/veo3.1/fast/<request_id>" or
// "mock:<startedAtMs>:<id>" -- see those files' own header comments) is
// the right key instead: it's server-issued, never client-invented, and
// never exposed in any UI/URL/share link anywhere in this app -- there is
// no public surface an outside caller can consult to learn a real
// operationName the way dreamId is trivially knowable. mark-generation-
// completed.js additionally independently RE-VERIFIES (against fal's own
// status endpoint, or the embedded-timestamp check for mock mode -- see
// that file) that the claimed operationName actually completed before
// this store's markCompleted is ever called, rather than trusting a bare
// client claim. Combined, an outside caller has no way to target a
// specific victim's account/dream at all: even a caller who successfully
// marks SOME real, genuinely-completed operationName gains nothing from
// it, because nothing will ever call consumeIfPresent with that exact
// string except the one browser that generated it (result.html reads it
// off `dream.sourceOperationName` -- see js/store.js's finalizeDream --
// which is set once, locally, only for the account that actually ran
// that generation, and is never shown or transmitted anywhere else).
//
// Backed by a single Netlify Blobs store ("dreamtube-generation-completions"),
// ONE RECORD PER operationName: { operationName, markedAt }. Plain
// existence-check-then-delete, same accepted-race shape as every other
// Blobs-backed store in this codebase (see lib/first-dream-email-store.js's
// header comment) -- two near-simultaneous consume calls for the same
// operationName (e.g. two tabs) could in principle both observe the
// marker before either delete lands, an accepted, narrow, pre-existing
// class of race this codebase already lives with elsewhere at this exact
// choke point (see docs/EVENT_TAXONOMY.md's "Known limitation" note on
// markFirstVideoCreatedIfEligible).
//
// No TTL/cleanup: a marker that's never consumed (e.g. generation
// completes but the browser never reaches result.html at all) is a single
// small, harmless record left behind forever -- same negligible-storage
// reasoning lib/rate-limit.js's header comment already accepts for its own
// uncleaned daily keys.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-generation-completions';

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Records that `operationName` just finished generating -- called
 * (best-effort, fire-and-forget) from processing.html right before it
 * redirects to result.html, replacing the old sessionStorage.setItem
 * call. Only ever called by mark-generation-completed.js AFTER it has
 * independently verified the operation actually completed (see that
 * file's `verifyOperationCompleted`) -- this function itself does no
 * verification, it just records what its caller already confirmed. A
 * fresh call for the same operationName simply overwrites whatever was
 * there before (harmless -- operationName values are unique per
 * submitted job, generate-video.js/generate-image.js never reissue one).
 */
async function markCompleted(event, operationName) {
  if (!operationName) return;
  connectLambda(event);
  await store().setJSON(operationName, { operationName: operationName, markedAt: Date.now() });
}

/**
 * Consumes (reads, then deletes) the marker for `operationName`, exactly
 * once. Returns true only the first time this is called for an
 * operationName that was actually marked complete (and independently
 * verified, see mark-generation-completed.js) -- every call after that (a
 * reload of result.html, or an operationName that was never marked/
 * verified at all) returns false. Mirrors the old sessionStorage
 * `getItem` + unconditional `removeItem` pair exactly, just durable
 * server-side instead of tied to one browser tab.
 */
async function consumeIfPresent(event, operationName) {
  if (!operationName) return false;
  connectLambda(event);
  var s = store();
  var record = await s.get(operationName, { type: 'json' });
  if (!record) return false;
  await s.delete(operationName);
  return true;
}

module.exports = { STORE_NAME, markCompleted, consumeIfPresent };
