// netlify/functions/lib/block-store.js
//
// Durable, cross-device storage of which handles a signed-in account has
// blocked — the server-side half of tracker item
// for-product-public-feed-safety-in-app-re-ppuw77's "block user" feature.
// The LOCAL half (a device-level "have I blocked this handle" flag,
// state.blockedHandles in js/store.js) is what actually filters Explore's
// feed on every page load, mirroring state.likedIds' own "purely local,
// not deduped per-account" precedent exactly (see that field's own doc
// comment in js/store.js) — this store exists purely so a SIGNED-IN
// account's blocks aren't lost the moment a different device (or a
// cleared browser) is used, per the tracker item's explicit "client-side
// hide ... PLUS a server-side flag so this is durable/synced" scope.
// Follows this codebase's established small-single-purpose-lib-file
// convention (lib/push-subscription-store.js, lib/first-dream-email-store.js)
// rather than folding this into a larger file.
//
// Backed by a single Netlify Blobs store ("dreamtube-blocks"), ONE RECORD
// PER NORMALIZED USERNAME (the BLOCKING account, not the blocked one):
//   { username, blockedHandles: [string, ...], updatedAt }
//
// Keyed by the blocking account's own USERNAME, same identity model as
// push-subscription-store.js: the client already knows its own signed-in
// username (DreamStore.getCurrentUser().username) by the time it calls
// block-user.js, and this codebase has no server-side session/auth token
// at all (see push-subscription-store.js's own header comment for the
// fuller "no session, client states its own already-signed-in identity"
// precedent this follows, not a stricter one). A confused/duplicate block
// entry is a low-stakes mistake, same reasoning as push subscriptions —
// not the money/account-takeover concern that made session-transfer's
// endpoint require a real password check.
//
// `blockedHandles` stores handles (e.g. "@alice"), not usernames — matches
// the shape js/store.js's local state.blockedHandles/dream.ownerHandle
// already use everywhere else in the feed, so no normalization/lookup is
// needed to cross-reference the two.
//
// NOT idempotency-critical the same way lib/entitlements.js's token ledger
// is (see lib/job-owners.js's own header comment on this same distinction)
// — a plain read-modify-write is used, not lib/blobs-retry.js's guarded
// retry loop. The worst case of a lost concurrent write here is a block/
// unblock not durably recording on its very first attempt (the LOCAL flag
// in js/store.js already applied regardless, so the feature still works
// on this device even if this sync silently no-ops) — a narrow, low-stakes,
// mostly-self-correcting gap (the next block/unblock action, or the next
// explicit re-sync, simply overwrites with the latest full list again),
// not the kind of double-spend/double-send hazard blobs-retry.js exists to
// prevent.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-blocks';

function store() {
  return getStore({ name: STORE_NAME });
}

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

/** Returns the blocked-handles array for `username` (empty array if none/never blocked anyone, or on any read failure — same honest-degrade posture as push-subscription-store.js's getSubscriptions). */
async function getBlockedHandles(event, username) {
  var key = normalizeUsername(username);
  if (!key) return [];
  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    return (record && Array.isArray(record.blockedHandles)) ? record.blockedHandles : [];
  } catch (e) {
    console.error('block-store: read failed for ' + key, e);
    return [];
  }
}

/**
 * Adds `handle` to `username`'s blocked list (no-op, not an error, if
 * already present). Returns { ok: true, blockedHandles } / { ok: false,
 * error }.
 */
async function addBlockedHandle(event, username, handle) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'invalid_username' };
  if (typeof handle !== 'string' || !handle.trim()) return { ok: false, error: 'invalid_handle' };

  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    var handles = (record && Array.isArray(record.blockedHandles)) ? record.blockedHandles.slice() : [];
    if (handles.indexOf(handle) === -1) handles.push(handle);

    connectLambda(event);
    await store().setJSON(key, { username: key, blockedHandles: handles, updatedAt: Date.now() });
    return { ok: true, blockedHandles: handles };
  } catch (e) {
    console.error('block-store: addBlockedHandle failed for ' + key, e);
    return { ok: false, error: 'write_failed' };
  }
}

/**
 * Removes `handle` from `username`'s blocked list (no-op, not an error, if
 * not present). Returns { ok: true, blockedHandles } / { ok: false, error }.
 */
async function removeBlockedHandle(event, username, handle) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'invalid_username' };
  if (typeof handle !== 'string' || !handle.trim()) return { ok: false, error: 'invalid_handle' };

  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    var handles = (record && Array.isArray(record.blockedHandles)) ? record.blockedHandles.filter(function (h) { return h !== handle; }) : [];

    connectLambda(event);
    await store().setJSON(key, { username: key, blockedHandles: handles, updatedAt: Date.now() });
    return { ok: true, blockedHandles: handles };
  } catch (e) {
    console.error('block-store: removeBlockedHandle failed for ' + key, e);
    return { ok: false, error: 'write_failed' };
  }
}

module.exports = {
  STORE_NAME,
  normalizeUsername,
  getBlockedHandles,
  addBlockedHandle,
  removeBlockedHandle
};
