// netlify/functions/like-dream.js
//
// POST { id, delta, likerHandle? } -> adjusts a dream's shared like count by
// delta (+1 or -1, from toggling like/unlike) and returns the new total.
//
// No per-user like tracking (would need real accounts, out of scope) — the
// client decides whether it's liking or unliking based on its own local
// "have I liked this" flag (js/store.js's state.likedIds), so the same
// dream liked from two different browsers/devices counts twice. Acceptable
// given this app's local-only auth model everywhere else.
//
// ---------------------------------------------------------------------
// STALE-READ CLOBBER FIX (tracker item
// for-product-likes-vanish-from-feed-video-fyqks0, founder-confirmed via
// PostHog like_given vs. live feed-index count, three documented cases):
// this used to be a plain whole-array read -> mutate feed[idx].likes IN
// PLACE -> write-back, with no retry/verify at all. Two likes landing on
// the same dream even ~20s apart were enough: the second invocation's read
// was a stale snapshot from before the first write had propagated, so its
// write clobbered the first increment entirely. Same "no compare-and-swap
// in the installed @netlify/blobs 8.2.0" root cause documented at length
// in lib/blobs-retry.js's own header comment — see that file before
// touching this one; do NOT bump the SDK version to chase the real 10.x
// CAS primitive, this codebase deliberately stays on 8.2.0 for that (see
// blobs-retry.js's own "WHAT WAS RE-CHECKED" section, point 3).
//
// Now goes through blobsRetry.retryingWrite, same bounded
// read->mutate->write->verify loop entitlements.js/pending-dreams.js/
// tracker-store.js/support-store.js already use for this exact class of
// race. Two adaptations specific to this file's own domain:
//
//   1. IDEMPOTENT MUTATE, NOT JUST A RETRY: blobs-retry.js's own header
//      comment is explicit that `mutate` runs fresh on every attempt and
//      "must be idempotent against its own target end state" — a retry
//      can be triggered by nothing more than a false-negative verify (our
//      own just-written data not yet visible to an eventually consistent
//      read), and re-deriving "current likes + delta" from a fresh read
//      on that kind of retry would DOUBLE-APPLY the delta if the fresh
//      read happens to already show our own just-landed write. A plain
//      counter increment (unlike tracker-store.js's status-field patches,
//      which are naturally idempotent — setting `done:true` twice is a
//      no-op) has no such natural idempotency, so this file adds one: a
//      fresh random `opId` generated once per HTTP request (not per
//      attempt) is stamped onto the dream as `_lastLikeOp` alongside the
//      new likes value. If a later attempt's fresh read shows THIS same
//      opId already on the dream, the delta was already applied by an
//      earlier attempt of this SAME request — mutate leaves the array
//      untouched rather than adding the delta again. This mirrors
//      entitlements.js's creditTokenPackAmountOnce, which solves the
//      identical "add an amount, but a retry must not double-add" problem
//      via its own paymentId-based appliedTokenPackPaymentIds dedup list.
//   2. NOT FOUND -> SKIP: if the dream id isn't in the feed at all, mutate
//      returns blobsRetry.SKIP (same "precondition that, once false, can
//      never become true again by retrying" case pending-dreams.js's
//      tryTransition and entitlements.js's creditTokenPackAmountOnce
//      already use SKIP for) — the loop exits immediately with no write,
//      and the handler reports the pre-existing 404.
//
// FAIL-OPEN on retry exhaustion (mirrors tracker-store.js's
// writeItemsWithRetry, the closest analog to this file's own whole-array
// mutate/verify shape — see that function's own doc comment for the same
// reasoning): a like is a low-stakes social-engagement counter, not a
// payment or entitlement marker, so an exhausted retry (every verify
// failed, most plausibly because propagation genuinely lagged the whole
// attempt budget rather than a real repeated clobber) still returns the
// last attempt's locally-computed value rather than failing the request —
// same "a retry exhausted by lag rather than a real clobber still
// produced a locally-correct value" posture blobs-retry.js's own header
// comment documents for tracker-store.js/support-store.js's array-mutate
// call sites. Contrast entitlements.js's creditTokenPackAmountOnce, which
// fails CLOSED on exhaustion because a payment credit silently not landing
// is a real money bug — a like silently not landing this one time (the
// user can just tap it again) is not in the same class.
//
// ---------------------------------------------------------------------
// 'like_given' / 'like_received' PostHog events (Phase 1 reporting
// instrumentation — tracker item for-product-phase-1-reporting-instrument-
// kjlh46, founder-greenlit 2026-07-26): this is the single choke-point that
// already knows the dream, its owner, AND the delta, so it's the natural
// place to fire both sides of one "like" action — the liker gets
// 'like_given', the dream's own owner gets 'like_received'. Only fires on
// delta === +1 (a genuine like); toggling a like back OFF (delta === -1,
// an "unlike") fires neither — these are meant to measure real like
// actions/social engagement, not net count deltas, and an unlike undoing a
// still-in-flight like (a fast double-tap) would otherwise report a
// negative-signal 'like_given' event that never really happened as its own
// action.
//
// distinct_id discipline: must match what the client's posthog.identify()
// used — the account's raw username, no leading '@' (see js/store.js's
// identifyForAnalytics / lib/posthog-capture.js's header comment). Both
// the liker (payload.likerHandle, e.g. '@alice') and the dream's owner
// (feed[idx].ownerHandle, same '@'-prefixed shape — see publish-dream.js)
// are already in that handle form, so stripHandle() below strips the
// leading '@' before using either as a distinct_id. No account-store
// lookup needed here (unlike dodo-webhook.js's Purchase fire) — a handle
// IS the username in this codebase's local-account model, nothing to
// resolve from an email.
//
// PostHog only, no Meta CAPI — a like is a product engagement signal, not
// an ad-optimization conversion event (see docs/EVENT_TAXONOMY.md).
//
// Fire-and-forget: analytics failures here must never turn a successful
// like into a failed response — same "analytics must never break the app"
// discipline as every other analytics call in this codebase.
// ---------------------------------------------------------------------

var { connectLambda, getStore } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./lib/blobs-retry');
var posthogCapture = require('./lib/posthog-capture');

var STORE_NAME = 'dreamtube-feed';
var KEY = 'feed-index';

/** Strips a leading '@' off a handle (e.g. '@alice' -> 'alice') so it matches the raw-username distinct_id the client's posthog.identify() call used. Returns null for anything falsy/non-string. */
function stripHandle(handle) {
  if (typeof handle !== 'string' || !handle) return null;
  return handle.charAt(0) === '@' ? handle.slice(1) : handle;
}

/** Fires like_given (to the liker) + like_received (to the dream's owner). Never throws -- every failure is swallowed, see header comment. */
async function fireLikeEvents(likerHandle, ownerHandle, dreamId) {
  try {
    var likerDistinctId = stripHandle(likerHandle);
    var ownerDistinctId = stripHandle(ownerHandle);
    var fires = [];
    if (likerDistinctId) {
      fires.push(posthogCapture.captureEvent({ event: 'like_given', distinct_id: likerDistinctId, properties: { dreamId: dreamId } }));
    }
    if (ownerDistinctId) {
      fires.push(posthogCapture.captureEvent({ event: 'like_received', distinct_id: ownerDistinctId, properties: { dreamId: dreamId } }));
    }
    await Promise.all(fires);
  } catch (e) {
    // analytics must never break the app -- the like itself has already
    // succeeded and must not be affected by this.
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  var id = payload.id;
  var delta = payload.delta === -1 ? -1 : 1;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id_required' }) };
  }

  try {
    // Fresh per REQUEST (not per retry attempt) -- see this file's own
    // STALE-READ CLOBBER FIX header comment for why this is what makes
    // `mutate` below idempotent against a false-negative-triggered retry
    // of its OWN write, without needing to fall back to any stale
    // pre-loop snapshot.
    var opId = crypto.randomBytes(8).toString('hex');
    var computedLikes; // set by mutate() on whichever attempt's write verify() confirms

    var result = await blobsRetry.retryingWrite(event, STORE_NAME, KEY, {
      read: function (evt) {
        connectLambda(evt);
        return getStore(STORE_NAME).get(KEY, { type: 'json' }).then(function (v) { return v || []; });
      },
      mutate: function (current) {
        var items = current || [];
        var idx = items.findIndex(function (d) { return d.id === id; });
        if (idx === -1) return blobsRetry.SKIP; // dream not found -- see this file's own header comment

        var dream = items[idx];
        if (dream._lastLikeOp === opId) {
          // This exact request's delta was already applied by an earlier
          // attempt (a false-negative verify, not a real clobber) -- do
          // NOT add the delta again. See header comment.
          computedLikes = dream.likes;
          return items;
        }

        computedLikes = Math.max(0, (dream.likes || 0) + delta);
        var next = items.slice();
        next[idx] = Object.assign({}, dream, { likes: computedLikes, _lastLikeOp: opId });
        return next;
      },
      verify: function (verifyItems) {
        var found = (verifyItems || []).filter(function (d) { return d.id === id; })[0];
        // Checks OWNERSHIP (this exact request's opId marker), not just
        // that the numeric likes value happens to match -- two genuinely
        // concurrent +1s starting from the same base produce the SAME
        // target number, so a losing attempt's verify-read landing on the
        // OTHER caller's write would otherwise look like a coincidental
        // match and terminate this call's retry loop before the real
        // clobber was ever detected (confirmed: this was a real bug caught
        // by test/like-dream.test.js's own CONCURRENCY coverage, not a
        // hypothetical -- an earlier version of this function checked only
        // `found.likes === computedLikes` and failed the two/three-way
        // concurrent tests). Same "verify OUR OWN marker, not just the
        // outcome" discipline pending-dreams.js's tryTransition already
        // uses via _transitionClaim.
        return !!found && found._lastLikeOp === opId;
      }
    });

    if (result.skipped) {
      return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
    }

    // Fails open on exhaustion -- see this file's own header comment for
    // why (result.value is the last attempt's locally-computed array
    // either way, same as tracker-store.js's writeItemsWithRetry).
    var finalFeed = result.value;
    var finalIdx = finalFeed.findIndex(function (d) { return d.id === id; });
    var finalLikes = finalIdx !== -1 ? finalFeed[finalIdx].likes : 0;
    var ownerHandle = finalIdx !== -1 ? finalFeed[finalIdx].ownerHandle : null;

    if (delta === 1) {
      await fireLikeEvents(payload.likerHandle, ownerHandle, id);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, likes: finalLikes }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'like_failed: ' + (e && e.message) }) };
  }
};
