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
// WHY KEYED BY DREAM ID, NOT USERNAME/EMAIL (a deliberate departure from
// this file's own suggested "server-side flag on the per-email
// entitlements record" framing): `netlify/functions/lib/account-store.js`
// only ever gets an account backfilled server-side if it has an email
// (see js/store.js's `backfillAccountServerSide` -- `if (!account.email)
// return`), so gating this marker on `accountStore.verifyLogin` the same
// way `send-first-dream-email.js` does would silently stop working for
// every account that never supplied an email -- a real regression, not a
// reliability improvement, for exactly the accounts this fix cannot
// afford to lose coverage for. A dream's own id is already a public,
// unauthenticated identifier elsewhere in this codebase (explore.html's
// `?id=`, watch.html's `?id=`, lib/dream-share-token.js's share links) --
// using it as this store's key needs no new identity/auth plumbing at
// all, works identically for every account regardless of whether it has
// an email on file, and is what actually needs a freshness marker in the
// first place (a specific dream's completion moment, not an account's
// generic state).
//
// SECURITY NOTE (accepted, low-risk residual): dream ids
// (js/store.js's `newId()`, `'d' + Math.random().toString(36).slice(2,9)`)
// are opaque but not cryptographically unguessable, and this endpoint pair
// has no auth. The worst a stranger who somehow knows/guesses a real,
// in-flight dream id can do is pre-write or prematurely consume its
// marker -- causing, at most, a missed FirstVideoCreated fire for that one
// completion (the exact class of gap this whole fix exists to shrink, not
// a new one), never a false fire (the account-level flag in js/store.js
// still gates that independently) and never any data exposure. Same
// "public opaque id, not a secret" trust model this codebase already
// applies to every other dream-id-keyed lookup.
//
// Backed by a single Netlify Blobs store ("dreamtube-generation-completions"),
// ONE RECORD PER DREAM ID: { dreamId, markedAt }. Plain
// existence-check-then-delete, same accepted-race shape as every other
// Blobs-backed store in this codebase (see lib/first-dream-email-store.js's
// header comment) -- two near-simultaneous consume calls for the same
// dreamId (e.g. two tabs) could in principle both observe the marker
// before either delete lands, an accepted, narrow, pre-existing class of
// race this codebase already lives with elsewhere at this exact choke
// point (see docs/EVENT_TAXONOMY.md's "Known limitation" note on
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
 * Records that `dreamId` just finished generating -- called (best-effort,
 * fire-and-forget) from processing.html right before it redirects to
 * result.html, replacing the old sessionStorage.setItem call. A fresh
 * generation for the same dreamId simply overwrites whatever was there
 * before (harmless -- there is only ever one "most recent completion" per
 * dream id in practice), matching the old marker's own "a fresh key next
 * time simply overwrites it" behavior.
 */
async function markCompleted(event, dreamId) {
  if (!dreamId) return;
  connectLambda(event);
  await store().setJSON(dreamId, { dreamId: dreamId, markedAt: Date.now() });
}

/**
 * Consumes (reads, then deletes) the marker for `dreamId`, exactly once.
 * Returns true only the first time this is called for a dreamId that was
 * actually marked complete -- every call after that (a reload of
 * result.html, or a dreamId that was never marked) returns false. Mirrors
 * the old sessionStorage `getItem` + unconditional `removeItem` pair
 * exactly, just durable server-side instead of tied to one browser tab.
 */
async function consumeIfPresent(event, dreamId) {
  if (!dreamId) return false;
  connectLambda(event);
  var s = store();
  var record = await s.get(dreamId, { type: 'json' });
  if (!record) return false;
  await s.delete(dreamId);
  return true;
}

module.exports = { STORE_NAME, markCompleted, consumeIfPresent };
