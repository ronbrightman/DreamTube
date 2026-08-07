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
// PostHog like_given vs. live feed-index count, three documented cases),
// CAS REWRITE (tracker item for-product-p1-urgent-fresh-signup-can-d-
// qhrrqy's follow-up: the @netlify/blobs 10.x conditional-write migration):
// this used to be a plain whole-array read -> mutate feed[idx].likes IN
// PLACE -> write-back, with no retry/verify at all. Two likes landing on
// the same dream even ~20s apart were enough: the second invocation's read
// was a stale snapshot from before the first write had propagated, so its
// write clobbered the first increment entirely. That was first fixed by
// routing through blobsRetry.retryingWrite's bounded read -> mutate ->
// write -> verify loop — a real mitigation, but review (round 1 on that
// fix) found a genuine residual gap: the loop's verify-read was itself
// only eventually consistent, so a caller whose OWN initial read was
// already stale relative to an ALREADY-fully-committed prior write (no
// temporal overlap needed — the more likely shape for the ~15-21s-apart
// incidents this item documents, given Blobs' up-to-60s propagation
// window) could still clobber it: a verify-read that reads back its own
// just-written data reports success even though that write silently
// discarded someone else's prior increment.
//
// Now goes through blobsCas.casWrite (lib/blobs-cas.js): a REAL
// compare-and-swap write (onlyIfNew/onlyIfMatch, see that file's own
// header comment) closes this gap completely rather than narrowing it —
// a write built from ANY stale read (whether from lag on our own write or
// a fully-committed prior write we simply never saw) is atomically
// REJECTED by the server the instant the record's real current state (or
// its real etag) doesn't match what our read implied, full stop. There is
// no verify-read left to fool. One adaptation specific to this file's own
// domain:
//
//   NOT FOUND -> SKIP: if the dream id isn't in the feed at all, mutate
//   returns blobsCas.SKIP (same "precondition that, once false, can never
//   become true again by retrying" case pending-dreams.js's tryTransition
//   already uses SKIP for) — the loop exits immediately with no write, and
//   the handler reports the pre-existing 404.
//
// The old per-request `opId`/`_lastLikeOp` self-dedup marker (needed under
// the old verify-loop so a false-negative verify's retry wouldn't
// double-apply the delta against its own already-landed write) is GONE:
// under real CAS, a write either fully commits (the loop returns
// immediately, no further attempts) or is atomically rejected and never
// persists anything — there is no in-between "maybe my own write already
// landed" state a later attempt could double-apply against. Every attempt
// safely recomputes "current likes + delta" from that attempt's own fresh
// read; a wrong/stale one can never commit.
//
// RESIDUAL, KNOWINGLY UNCLOSED GAP: lib/feed-comment-count.js writes to
// this EXACT same store/key (`dreamtube-feed`/`feed-index`) for the
// commentCount field, still via the OLDER blobsRetry.retryingWrite
// (unconditional overwrite, no etag) — out of this migration's scope (this
// change touches only entitlements.js's balance record and like-dream.js's
// own writes, per its own tracker item). Mixing a CAS writer with an
// unconditional one on the SAME key does not make either one's OWN race
// any worse than before (this migration still fully closes "two
// concurrent likes clobbering each other," CAS's actual job here) — but a
// blobsRetry write is, by definition, never etag-gated, so it can still
// blindly overwrite whatever this CAS write most recently landed, same
// residual cross-field-writer risk that existed before either file used
// CAS at all. Migrating feed-comment-count.js too is a natural, low-risk
// follow-up, not done here to keep this change scoped to the tracker
// item's own evidenced race family.
//
// FAIL-OPEN on retry exhaustion (mirrors tracker-store.js's
// writeItemsWithRetry — see that function's own doc comment for the same
// reasoning): a like is a low-stakes social-engagement counter, not a
// payment or entitlement marker, so an exhausted retry (every CAS write
// lost — heavy contention, or reads that kept lagging) still returns the
// last attempt's locally-computed value rather than failing the request.
// Contrast entitlements.js's creditTokenPackAmountOnce, which fails CLOSED
// on exhaustion because a payment credit silently not landing is a real
// money bug — a like silently not landing this one time (the user can
// just tap it again) is not in the same class.
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

var blobsCas = require('./lib/blobs-cas');
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
    var result = await blobsCas.casWrite(event, STORE_NAME, KEY, {
      mutate: function (current) {
        var items = current || [];
        var idx = items.findIndex(function (d) { return d.id === id; });
        if (idx === -1) return blobsCas.SKIP; // dream not found -- see this file's own header comment

        var dream = items[idx];
        var next = items.slice();
        next[idx] = Object.assign({}, dream, { likes: Math.max(0, (dream.likes || 0) + delta) });
        return next;
      }
    });

    if (result.skipped) {
      return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
    }

    // Fails open on exhaustion (see this file's own header comment for
    // why) -- but under real CAS, exhaustion means every attempt's write
    // was genuinely, atomically rejected: our own delta never landed, so
    // `result.value` (this loop's own not-actually-persisted guess) would
    // be dishonest to report. Fall back to `result.current` instead — the
    // last attempt's own fresh read, i.e. the best-known REAL persisted
    // state — rather than fabricating a number that was never written.
    var finalFeed = result.ok ? result.value : (result.current || []);
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
