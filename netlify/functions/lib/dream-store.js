// netlify/functions/lib/dream-store.js
//
// Durable, cross-device storage of a signed-in account's PRIVATE (never
// published, or unpublished-again) dreams — tracker item
// for-product-build-p0-server-side-dream-p-zl3rb2. Closes the gap
// js/store.js's own header comment has documented since before this file
// existed: `state.dreams` is local-only unless a dream is published (see
// publish-dream.js/lib/... feed-index), so a private dream that only ever
// lives in one browser's localStorage is permanently lost the moment that
// storage is cleared/evicted — which, per this app's own webview-detection
// code (js/store.js), happens routinely for real users opening the app
// inside Facebook/Instagram's in-app browser, DreamTube's single biggest
// acquisition channel. This is the gating data-layer dependency for the
// homepage rebuild (journal timeline, weekly summaries, streaks — see
// tracker item for-product-build-homepage-wave-1-the-ri-xr8mir, a sibling
// item built in parallel): none of those longitudinal features mean
// anything if the dreams behind them can silently vanish.
//
// PUBLISHED dreams are explicitly OUT OF SCOPE here — their durable copy
// already exists in the shared feed-index Blob (get-feed.js/
// publish-dream.js/unpublish-dream.js), so duplicating them into this
// store would be redundant storage with its own staleness/reconciliation
// problems for zero benefit. dream-sync.js (the function this lib backs)
// is only ever called by the client for a dream that is NOT currently
// published — see that file's own header comment.
//
// Follows this codebase's established small-single-purpose-lib-file
// convention (lib/push-subscription-store.js, lib/block-store.js-shaped
// per-account stores) rather than folding this into a larger file.
//
// Backed by a single Netlify Blobs store ("dreamtube-private-dreams"),
// ONE RECORD PER NORMALIZED USERNAME:
//   { username, dreams: [ {...}, ... ], updatedAt }
//
// Keyed by USERNAME (never a bare client-supplied claim) — resolved
// server-side from a VERIFIED lib/account-auth-token.js token by
// dream-sync.js before this module is ever called (see that file's own
// header comment for the full "why a private dream store needs this, not
// a bare-username trust" reasoning — this is at least as sensitive as
// block-store.js's blocklist, arguably more so: private dream *content*,
// not just a list of handles).
//
// MANDATORY blobs-retry.js usage (tracker item's own explicit call-out):
// upsertPrivateDream/removePrivateDream both go through
// lib/blobs-retry.js's bounded read -> mutate -> write -> verify loop,
// exactly like tracker-store.js's writeItemsWithRetry (the "original, most
// mature version — full-array mutate/verify" per that file's own header
// comment) — this is the SAME read-mutate-write class that caused this
// codebase's real signup outage (see blobs-retry.js's own header comment
// for that incident), and a private-dream write racing another device's
// concurrent write/delete for the SAME account (plausible here
// specifically: a user signed in on two devices, one edits a dream while
// the other deletes it moments later) is exactly the class of bug that
// caused it. A plain, unguarded read-then-write here would silently drop
// whichever write lands second under Blobs' eventual consistency — for
// core user dream data, not a low-stakes convenience feature like push
// subscriptions (contrast lib/push-subscription-store.js's own header
// comment, which explicitly accepts a plain read-modify-write for exactly
// that "not idempotency-critical" reason — private dreams are the opposite
// case).
//
// VERIFY STRATEGY: each write stamps the target dream with a random,
// single-use `_syncMarker` (upsert) that verify checks for by id — same
// "mint a fresh marker every attempt, verify by matching it back" shape as
// lib/session-transfer-token.js's own `_consumeClaim` (see blobs-retry.js's
// own header comment on why `mutate` must be safe to call again on retry:
// a retry can be triggered by a false-negative verify, e.g. our own
// just-written data not yet visible to an eventually-consistent read, not
// just a real clobber — re-running mutate against a `current` that
// already reflects a previous attempt's write must not double-apply).
// removePrivateDream verifies by absence (same shape as tracker-store.js's
// deleteItem) — simpler, since "is this id gone" has no ambiguity the way
// "did THIS write's content land" does for an upsert.
//
// CAP: MAX_DREAMS_PER_ACCOUNT is generous headroom, not a real limit this
// is expected to hit in practice — this store only ever holds an account's
// PRIVATE dreams (published ones move OUT of this store entirely, see
// dream-sync.js), so it stays naturally bounded to whatever one account
// has generated and not yet published or deleted. Oldest-by-position
// evicted first if it's ever somehow exceeded (defense in depth against a
// runaway client, not an expected real-world path) — never silently drops
// a just-written dream (the just-upserted one is always unshifted to the
// front first, before any cap trim).

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-private-dreams';
var MAX_WRITE_ATTEMPTS = 3;
var MAX_DREAMS_PER_ACCOUNT = 2000;

function store() {
  return getStore({ name: STORE_NAME });
}

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

/** Raw record read, defaulting a never-written/malformed record to an empty one — same "never throw, degrade to empty" posture as push-subscription-store.js's getSubscriptions, and the same shape tracker-store.js's own getItems/support-store.js's getMessages use as the `read` function blobs-retry.js's retryingWrite calls on every attempt. */
async function getRecord(event, username) {
  var key = normalizeUsername(username);
  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    if (!record || !Array.isArray(record.dreams)) return { username: key, dreams: [], updatedAt: 0 };
    return record;
  } catch (e) {
    console.error('dream-store: read failed for ' + key, e);
    return { username: key, dreams: [], updatedAt: 0 };
  }
}

/** Returns the full private-dream array for `username` (empty array if none/never synced, or on a read failure — never throws). */
async function getPrivateDreams(event, username) {
  var record = await getRecord(event, username);
  return record.dreams;
}

/**
 * Adds (or, if a dream with this id is already on file, replaces) one
 * private dream for `username`. `dream` must already carry a real `id` —
 * everything else is whatever dream-sync.js's own field whitelist already
 * validated/trusted (see that file's header comment) before calling here;
 * this module itself does no field-shape validation beyond requiring an
 * id, same division of labor push-subscription-store.js's
 * addOrUpdateSubscription already uses (shape-validate at the caller,
 * store trusts it here). Goes through lib/blobs-retry.js — see this
 * file's own header comment for the full "why". Returns { ok: true } or
 * { ok: false, error }.
 */
async function upsertPrivateDream(event, username, dream) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'invalid_username' };
  if (!dream || typeof dream.id !== 'string' || !dream.id) return { ok: false, error: 'invalid_dream' };

  // `marker`/`stamped` are re-minted fresh INSIDE mutate() on every attempt
  // (never reused across attempts, and never precomputed once outside the
  // retry loop) — mutate must be idempotent-safe to call again on a retry,
  // and a fresh marker per attempt is what lets verify tell "did THIS
  // specific attempt's write land" apart from an earlier attempt's (same
  // shape lib/session-transfer-token.js's own verifyAndConsumeToken uses
  // for its `_consumeClaim`).
  var marker;
  var stamped;

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: function (evt) { return getRecord(evt, key); },
    mutate: function (current) {
      var dreams = (current && Array.isArray(current.dreams)) ? current.dreams.slice() : [];
      marker = crypto.randomBytes(8).toString('hex');
      stamped = Object.assign({}, dream, { _syncMarker: marker });
      var idx = -1;
      for (var i = 0; i < dreams.length; i++) {
        if (dreams[i].id === stamped.id) { idx = i; break; }
      }
      if (idx === -1) {
        dreams.unshift(stamped);
      } else {
        dreams[idx] = stamped;
      }
      if (dreams.length > MAX_DREAMS_PER_ACCOUNT) dreams = dreams.slice(0, MAX_DREAMS_PER_ACCOUNT);
      return { username: key, dreams: dreams, updatedAt: Date.now() };
    },
    verify: function (verifyRead) {
      if (!verifyRead || !Array.isArray(verifyRead.dreams)) return false;
      var match = null;
      for (var i = 0; i < verifyRead.dreams.length; i++) {
        if (verifyRead.dreams[i].id === stamped.id) { match = verifyRead.dreams[i]; break; }
      }
      return !!(match && match._syncMarker === marker);
    }
  });

  return result.ok ? { ok: true } : { ok: false, error: 'write_failed' };
}

/**
 * Removes one private dream by id for `username` (e.g. the client deleted
 * it, or it just got published — see dream-sync.js). Returns
 * { ok: true, removed: true } if it was present and is now gone,
 * { ok: true, removed: false } if it was already absent (a normal,
 * idempotent no-op — matches tracker-store.js's own deleteItem "not found,
 * store left untouched" handling), or { ok: false, error } only if the
 * write itself genuinely failed (every retry attempt's verify failed) —
 * callers must treat that last case as "did NOT happen", never silently
 * assume success (same fail-closed posture blobs-retry.js's own header
 * comment documents for entitlements.js's/pending-dreams.js's marker-based
 * call sites, not tracker-store.js's fail-open array-mutate ones — an
 * un-verified delete here could otherwise silently resurrect a dream a
 * user believes is gone).
 */
async function removePrivateDream(event, username, dreamId) {
  var key = normalizeUsername(username);
  if (!key || !dreamId) return { ok: false, error: 'invalid_input' };

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: function (evt) { return getRecord(evt, key); },
    mutate: function (current) {
      var dreams = (current && Array.isArray(current.dreams)) ? current.dreams : [];
      var filtered = dreams.filter(function (d) { return d.id !== dreamId; });
      if (filtered.length === dreams.length) return blobsRetry.SKIP; // already absent -- nothing to do
      return { username: key, dreams: filtered, updatedAt: Date.now() };
    },
    verify: function (verifyRead) {
      return !!(verifyRead && Array.isArray(verifyRead.dreams) && !verifyRead.dreams.some(function (d) { return d.id === dreamId; }));
    }
  });

  if (result.skipped) return { ok: true, removed: false };
  return result.ok ? { ok: true, removed: true } : { ok: false, error: 'write_failed' };
}

/**
 * Deletes an account's ENTIRE private-dream record outright — called by
 * delete-account.js on a successful account deletion, same "clean up
 * every server-side trace this codebase actually controls" completeness
 * bar that function's own header comment already applies to the token
 * ledger/shared feed. Best-effort (never throws) — deliberately not
 * wrapped in blobs-retry.js's guarded loop, since a full-record delete has
 * no concurrent-write race to lose to the way a partial mutate does (there
 * is no "next state" to compute from a stale read here, just "this whole
 * key should no longer exist"), matching lib/entitlements.js's own
 * deleteEntitlement's equivalent plain-delete shape for the same reason.
 */
async function deleteAllPrivateDreams(event, username) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false };
  try {
    connectLambda(event);
    await store().delete(key);
    return { ok: true };
  } catch (e) {
    console.error('dream-store: deleteAllPrivateDreams failed for ' + key, e);
    return { ok: false };
  }
}

module.exports = {
  STORE_NAME,
  MAX_DREAMS_PER_ACCOUNT,
  normalizeUsername,
  getPrivateDreams,
  upsertPrivateDream,
  removePrivateDream,
  deleteAllPrivateDreams
};
