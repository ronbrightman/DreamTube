// netlify/functions/lib/profile-store.js
//
// Durable, cross-device storage of a public-profile record — slice 1
// ("profile shell + share") of Social Layer v2 (docs/SOCIAL_LAYER_V2_DESIGN.md,
// tracker item for-product-build-social-layer-v2-direct-34047c). Not a
// Netlify Function itself — a plain module sync-profile.js/get-profile.js/
// share-profile.js all require(), matching this codebase's existing
// "self-contained function, shared bits in a plain require()" pattern (see
// lib/block-store.js, lib/moderation-store.js).
//
// Backed by a single Netlify Blobs store ("dreamtube-profiles"), ONE RECORD
// PER NORMALIZED (lowercased) USERNAME:
//   { handle, displayName, avatarDataUrl, bio, updatedAt }
//
// `handle` carries the REAL-CASED handle (e.g. "@Luna"), same as every
// dream's own `ownerHandle` field on the shared feed (netlify/functions/
// publish-dream.js) — necessary because lib/account-auth-token.js's
// verifyToken only ever hands back a NORMALIZED (lowercased) username
// (see that file's own header comment), so there is no other server-side
// source of a user's real-cased handle to fall back on. sync-profile.js
// accepts a client-supplied `handle` and validates it against the verified
// token the exact same way publish-dream.js already validates a
// client-supplied `ownerHandle` — see that file's own "DESIGN CHOICE —
// reject-on-mismatch" header comment; this module trusts its caller to
// have already done that check, same division of responsibility as
// block-store.js trusting block-user.js's own auth resolution.
//
// Full-overwrite record, not a partial patch: every upsertProfile call
// writes the complete { handle, displayName, avatarDataUrl, bio } shape
// sync-profile.js received, matching that endpoint's own "one call, one
// full save" contract (mirrors profile.html's Edit-profile sheet, which
// always submits the whole form, never a single field). There is
// deliberately no separate "patch just the bio" entry point.
//
// Goes through the shared lib/blobs-retry.js bounded retry (unlike
// lib/block-store.js's plain read-modify-write, which accepts a bigger
// residual-race risk for its own lower-stakes convenience data) per this
// slice's own build spec, which calls out blobs-retry.js explicitly as
// "matching this codebase's established pattern" for a new Blobs-backed
// store. `mutate` always produces the exact same record on every retry
// attempt (built once from the caller's own patch + a SINGLE `updatedAt`
// timestamp captured before the loop starts, not a fresh `Date.now()` per
// attempt) — required for blobs-retry's own idempotency contract (see that
// file's header comment: "mutate ... must not double-apply"), and also
// what makes `verify` below able to check a comparison stays valid across
// every attempt (a fresh timestamp on each attempt would make even a
// successful attempt's own verify-read look like a foreign clobber).
//
// FAIL-OPEN on retry exhaustion, same posture as lib/moderation-store.js's
// appendReport (see that file's own doc comment): every attempt writes
// before verifying, so even an exhausted retry loop has very likely
// actually persisted SOMETHING — just possibly not the specific attempt
// whose verify-read the loop happened to see. This is a profile edit, not
// a money/dedup path (contrast lib/entitlements.js's fail-CLOSED marker
// writes) — the caller (sync-profile.js) always returns the intended
// profile record back to the client regardless of blobs-retry's own
// ok/skipped flags, same "return the locally-correct value regardless"
// choice moderation-store.js already made.

var { getStore, connectLambda } = require('@netlify/blobs');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-profiles';
var MAX_WRITE_ATTEMPTS = 3;

function store() {
  return getStore({ name: STORE_NAME });
}

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

/** Returns the profile record for `handleOrUsername` (an "@handle", a bare username, any case), or null if none exists / on any read failure — same honest-degrade posture as block-store.js's getBlockedHandles. `event` is the calling function's Lambda event, passed through to connectLambda so this works from any Netlify Function. */
async function getProfile(event, handleOrUsername) {
  var raw = typeof handleOrUsername === 'string' ? handleOrUsername : '';
  var stripped = raw.charAt(0) === '@' ? raw.slice(1) : raw;
  var key = normalizeUsername(stripped);
  if (!key) return null;
  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    return record || null;
  } catch (e) {
    console.error('profile-store: read failed for ' + key, e);
    return null;
  }
}

/**
 * Upserts `username`'s profile record with the full { handle, displayName,
 * avatarDataUrl, bio } shape — caller (sync-profile.js) is responsible for
 * validating every field first; this module trusts its input completely,
 * same division of responsibility as lib/block-store.js. Returns the
 * stored record (always — see this file's own FAIL-OPEN header comment).
 */
async function upsertProfile(event, username, patch) {
  var key = normalizeUsername(username);
  if (!key) return null;

  var record = {
    handle: patch.handle,
    displayName: patch.displayName || '',
    avatarDataUrl: patch.avatarDataUrl || null,
    bio: patch.bio || '',
    updatedAt: Date.now()
  };

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function () { return record; },
    verify: function (verifyRead) { return !!verifyRead && verifyRead.updatedAt === record.updatedAt; }
  });

  return result.value || record;
}

module.exports = { STORE_NAME, normalizeUsername, getProfile, upsertProfile };
