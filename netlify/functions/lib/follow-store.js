// netlify/functions/lib/follow-store.js
//
// Durable, cross-device storage of who follows whom — Social Layer v2
// slice 3 ("follow" — docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Not a Netlify Function
// itself — a plain module follow-user.js/get-following.js require(), same
// "self-contained function, shared bits in a plain require()" pattern the
// rest of this codebase already uses (lib/block-store.js, lib/profile-
// store.js).
//
// Backed by a single Netlify Blobs store ("dreamtube-follows"), TWO KEY
// NAMESPACES per the design doc's own Data/API section:
//   following:<normalized username> -> { handles: [string, ...], updatedAt }
//     — the handles THIS account follows. PRIVATE — only ever read for the
//     authenticated caller's OWN account (see get-following.js's own
//     header comment for why there is no way to ask for anyone else's).
//   counts:<normalized username>    -> { followers: number }
//     — how many accounts follow THIS username. LOCKED CONSTRAINT (design
//     doc, repeated because it's the constraint most likely to be casually
//     violated): OWNER-ONLY read, NEVER public — u.html (the public profile
//     view) never calls anything that surfaces another account's follower
//     count. Only profile.html's own private view, for the signed-in
//     account's OWN count, via get-following.js.
//
// Goes through the shared lib/blobs-retry.js bounded retry, per the design
// doc's own explicit call-out ("all writes go through lib/blobs-retry.js's
// bounded retry, matching every other store in this codebase") — same
// choice lib/profile-store.js and lib/feed-comment-count.js already made
// for their own Blobs-backed writes, over lib/block-store.js's plain
// read-modify-write (that file's own header comment explains why a lower-
// stakes, self-correcting write can skip the guarded retry; a follow
// toggle's SIDE EFFECT — the target's own follower count — is exactly the
// kind of denormalized counter blobs-retry.js exists to defend, so this
// follows profile-store.js/feed-comment-count.js's stricter precedent
// instead).
//
// TWO SEPARATE WRITES, NOT ONE ATOMIC TRANSACTION: setFollowing below
// writes the follower's own `following:` record, then — only if that write
// actually changed membership — separately adjusts the target's `counts:`
// record. This store (like every other one in this codebase) has no
// cross-key transaction primitive, so the two writes can, under heavy
// concurrent contention, land out of step with each other (e.g. the
// follower-list write lands but a crash/timeout occurs before the counts
// adjustment fires). Same accepted-RMW-race posture lib/feed-comment-
// count.js's own header comment documents for its denormalized
// commentCount — a follow and its own counter drifting apart under rare
// concurrent contention is the same class of narrow, low-stakes, largely
// self-correcting gap as everywhere else in this codebase that denormalizes
// a count next to the record that drives it, not a new problem introduced
// here.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-follows';
var FOLLOWING_KEY_PREFIX = 'following:';
var COUNTS_KEY_PREFIX = 'counts:';

function store() {
  return getStore({ name: STORE_NAME });
}

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

function followingKey(username) {
  return FOLLOWING_KEY_PREFIX + normalizeUsername(username);
}

function countsKey(username) {
  return COUNTS_KEY_PREFIX + normalizeUsername(username);
}

/** Returns the array of handles `username` follows (empty array if none/never followed anyone, or on any read failure — same honest-degrade posture as lib/block-store.js's getBlockedHandles). */
async function getFollowing(event, username) {
  var key = followingKey(username);
  if (!normalizeUsername(username)) return [];
  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    return (record && Array.isArray(record.handles)) ? record.handles : [];
  } catch (e) {
    console.error('follow-store: getFollowing read failed for ' + key, e);
    return [];
  }
}

/** Returns `username`'s own follower count (0 if never followed by anyone, or on any read failure). OWNER-ONLY by construction at the caller layer — see this file's own header comment. */
async function getFollowerCount(event, username) {
  var key = countsKey(username);
  if (!normalizeUsername(username)) return 0;
  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    return (record && typeof record.followers === 'number') ? record.followers : 0;
  } catch (e) {
    console.error('follow-store: getFollowerCount read failed for ' + key, e);
    return 0;
  }
}

/** True if `followerUsername` already follows `targetHandle` (any casing/'@' form). */
async function isFollowing(event, followerUsername, targetHandle) {
  var handles = await getFollowing(event, followerUsername);
  var targetNorm = normalizeUsername(stripAt(targetHandle));
  if (!targetNorm) return false;
  return handles.some(function (h) { return normalizeUsername(stripAt(h)) === targetNorm; });
}

/**
 * Adjusts `username`'s counts:<username> follower total by delta (+1/-1,
 * floored at 0) — mirrors lib/feed-comment-count.js's own opId-marker
 * idempotent-delta shape almost verbatim (see that file's own header
 * comment for the full "why" this specific shape, not a plain blind
 * +delta write, is needed against a false-negative-triggered retry of the
 * SAME request re-deriving "current + delta" from a fresh read that
 * already shows its own just-landed write). `_lastFollowerCountOp` was
 * never at risk of leaking publicly the way like-dream.js's `_lastLikeOp`/
 * feed-comment-count.js's `_lastCommentCountOp` used to (tracker item
 * minor-like-dream-js-internal-dedup-marke-8qztvq, fixed via
 * lib/public-feed-record.js) — counts:<username> is never returned
 * wholesale to any caller (see get-following.js, which only ever projects
 * out the bare `followers` number), so this marker has no public response
 * to leak into in the first place.
 *
 * FAIL-OPEN on retry exhaustion, same posture as feed-comment-count.js: a
 * follower count is a low-stakes social counter, not a payment/entitlement
 * marker.
 */
async function adjustFollowerCount(event, username, delta) {
  var key = countsKey(username);
  var opId = crypto.randomBytes(8).toString('hex');
  var computedCount;

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    read: function (evt) { connectLambda(evt); return store().get(key, { type: 'json' }); },
    mutate: function (current) {
      var record = current || { followers: 0 };
      if (record._lastFollowerCountOp === opId) {
        // This exact request's delta was already applied by an earlier
        // attempt (a false-negative verify, not a real clobber) — do NOT
        // add the delta again. Same reasoning as like-dream.js/feed-
        // comment-count.js's identical opId check.
        computedCount = record.followers || 0;
        return record;
      }
      computedCount = Math.max(0, (record.followers || 0) + delta);
      return { followers: computedCount, _lastFollowerCountOp: opId };
    },
    verify: function (verifyRead) {
      return !!verifyRead && verifyRead._lastFollowerCountOp === opId;
    }
  });

  return result.value ? result.value.followers : computedCount;
}

/**
 * Toggles follow state: adds/removes `targetHandle` from `followerUsername`'s
 * own `following:` list (full-overwrite retryingWrite, mirroring lib/
 * profile-store.js's own single-captured-timestamp discipline — `mutate`
 * must be able to produce a value `verify` can unambiguously attribute to
 * THIS call across retries), then — only if this call's own write genuinely
 * changed membership — adjusts `targetHandle`'s own follower count via
 * adjustFollowerCount above. See this file's own header comment for the
 * two-separate-writes-not-one-transaction shape.
 *
 * IDEMPOTENT: following an already-followed handle, or unfollowing a
 * not-followed one, is a no-op on BOTH keys (returns immediately via the
 * blobs-retry SKIP sentinel, no write attempted at all, no counter drift
 * from a duplicate/retried client request).
 *
 * Returns { ok: boolean, following: boolean } — `following` is
 * `followerUsername`'s OWN resulting state for `targetHandle`. NEVER
 * returns the target's follower count — see this file's own header comment
 * for why that stays owner-only, read through a completely separate call
 * (getFollowerCount, only ever invoked by get-following.js for the
 * AUTHENTICATED caller's own username).
 */
async function setFollowing(event, followerUsername, targetHandle, follow) {
  var targetNorm = normalizeUsername(stripAt(targetHandle));
  var fKey = followingKey(followerUsername);
  // Captured once, not per attempt — mirrors lib/profile-store.js's own
  // identical discipline (see that file's header comment): this is what
  // lets `verify` unambiguously recognize THIS call's own write across
  // retries, rather than a coincidentally-similar concurrent one.
  var writeTimestamp = Date.now();
  var appliedChange = false;

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, fKey, {
    read: function (evt) { connectLambda(evt); return store().get(fKey, { type: 'json' }); },
    mutate: function (current) {
      var handles = (current && Array.isArray(current.handles)) ? current.handles : [];
      var idx = handles.findIndex(function (h) { return normalizeUsername(stripAt(h)) === targetNorm; });
      var isCurrentlyFollowing = idx !== -1;
      if (follow === isCurrentlyFollowing) return blobsRetry.SKIP; // already in the desired state -- see this function's own IDEMPOTENT header note
      var next = handles.slice();
      if (follow) next.push(targetHandle); else next.splice(idx, 1);
      appliedChange = true;
      return { handles: next, updatedAt: writeTimestamp };
    },
    verify: function (verifyRead) {
      return !!verifyRead && verifyRead.updatedAt === writeTimestamp;
    }
  });

  var finalHandles = (result.value && result.value.handles) ? result.value.handles
    : (result.current && Array.isArray(result.current.handles) ? result.current.handles : []);
  var nowFollowing = finalHandles.some(function (h) { return normalizeUsername(stripAt(h)) === targetNorm; });

  if (appliedChange) {
    // adjustFollowerCount's `username` param is a normalized USERNAME (it
    // shares the same counts:<username> key space getFollowerCount reads
    // from) -- targetHandle here is still the raw, "@"-prefixed HANDLE
    // (e.g. "@luna") received from the caller, so it must be stripped
    // first. Root-caused via systematic-debugging (a failing test):
    // passing the raw handle through unstripped silently wrote to a
    // DIFFERENT key ("counts:@luna") than every read ever looks up
    // ("counts:luna"), so a follower count never actually incremented
    // even though setFollowing itself reported ok:true.
    await adjustFollowerCount(event, stripAt(targetHandle), follow ? 1 : -1);
  }

  return { ok: result.ok || result.skipped, following: nowFollowing };
}

module.exports = {
  STORE_NAME,
  normalizeUsername,
  getFollowing,
  getFollowerCount,
  isFollowing,
  setFollowing
};
