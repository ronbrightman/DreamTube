// netlify/functions/lib/block-store.js
//
// Durable, cross-device storage of which handles a signed-in account has
// blocked — the server-side half of tracker item
// for-product-public-feed-safety-in-app-re-ppuw77's "block user" feature.
// The LOCAL half (a PER-ACCOUNT "have I blocked this handle" flag,
// state.blockedByUser in js/store.js — keyed by the signed-in account's own
// username, same scheme as state.charactersByUser, NOT a flat device-level
// map; see that field's own doc comment for the review finding that fixed
// this) is what actually filters Explore's feed on every page load — this
// store exists purely so a SIGNED-IN account's blocks aren't lost the
// moment a different device (or a cleared browser) is used, per the
// tracker item's explicit "client-side hide ... PLUS a server-side flag so
// this is durable/synced" scope. Follows this codebase's established
// small-single-purpose-lib-file convention (lib/push-subscription-store.js,
// lib/first-dream-email-store.js) rather than folding this into a larger
// file.
//
// Backed by a single Netlify Blobs store ("dreamtube-blocks"), ONE RECORD
// PER NORMALIZED USERNAME (the BLOCKING account, not the blocked one):
//   { username, blockedHandles: [string, ...], updatedAt }
//
// Keyed by the blocking account's own USERNAME -- but UNLIKE push-
// subscription-store.js's still-bare-username trust (a defensible
// tradeoff there: a confused/duplicate push subscription is a low-stakes
// mistake), the CALLER of this module (block-user.js) does NOT resolve
// that username from a client-supplied string anymore (round-1 security
// review finding, fixed): it's derived from a VERIFIED
// lib/account-auth-token.js token instead, since this is a safety
// mechanism on PUBLIC handles, not a low-stakes convenience feature — see
// block-user.js's own header comment for the full "why" and the exact
// enumeration/unblock-defeat vulnerability that fix closes. This module
// itself is unchanged by that fix (it never saw the client-supplied
// username either way, only whatever its caller had already resolved) --
// this comment is corrected here only because an earlier version of it
// described the OLD, no-longer-accurate design.
//
// `blockedHandles` stores handles (e.g. "@alice"), not usernames — matches
// the shape js/store.js's local state.blockedByUser/dream.ownerHandle
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
