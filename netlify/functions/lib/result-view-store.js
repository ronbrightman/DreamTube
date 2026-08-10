// netlify/functions/lib/result-view-store.js
//
// Durable, cross-device "the account that owns this dream has actually
// WATCHED its fresh video result" marker — the server-side suppression
// signal for the "unwatched dream" retention nudge (founder-approved
// retention plan, piece 1). See send-unwatched-dream-nudges.js's header
// comment for the full feature; this store is only the "did they watch it
// yet" half.
//
// WHY THIS EXISTS AT ALL: the pre-existing "did the user see their fresh
// result" signals in this codebase are CLIENT-SIDE PostHog only —
// result.html's `first_video_result_view` track (~line 1653) and
// js/store.js's `firstVideoResultViewed` local flag. A scheduled
// server-side scan (send-unwatched-dream-nudges.js) cannot read a PostHog
// event or a browser's localStorage, so it has no way to tell a watched
// dream from an unwatched one. This adds the minimal server-side marker
// that scan needs: result.html POSTs mark-result-viewed.js the moment the
// user actually opens the fullscreen video player for their dream (see
// that endpoint's header comment and result.html's openFullscreenVideo for
// exactly why the ENGAGED watch, not the mere page render, is the signal),
// and this store persists it, keyed by the dream's server-issued
// `operationName` — the same identity everything else in this feature is
// keyed by (the pending-nudge queue, the once-per-dream guard), and the
// same unguessable, never-in-any-URL id mark-generation-completed.js's own
// header comment already established as safe to key markers on (a
// client-invented dreamId is not — anyone who knows one could plant a
// marker for someone else's dream).
//
// Backed by a single Netlify Blobs store ("dreamtube-result-views"), ONE
// RECORD PER operationName: { operationName, viewedAt }.
//
// PLAIN WRITE, NO CAS (unlike the once-per-dream send guard in
// lib/unwatched-dream-nudge-store.js): marking a result viewed is
// idempotent by construction — two taps of "watch", or the same tap racing
// itself across two tabs, only ever converge on the SAME final state
// (viewed:true), so there is nothing a losing racer could clobber. This is
// the exact tradeoff lib/email-suppression-store.js's own header comment
// documents for its own plain read/overwrite, reused here for the same
// reason, on the shared `@netlify/blobs` 8.2.0 client (not the `blobs10`
// CAS alias) every other non-idempotency-critical store in this codebase
// uses.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-result-views';

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Records that the account owning `operationName`'s dream has actually
 * watched its result. Best-effort, idempotent, never throws — a failure
 * here just means the scan can't yet see the view (it would, in the worst
 * case, send a nudge for a dream the user did in fact watch; a benign
 * over-send bounded by the once-per-dream guard and the unsubscribe link,
 * not a correctness hazard). Returns { ok:true } on a successful write,
 * { ok:false } on invalid input or a write failure.
 */
async function markViewed(event, operationName) {
  if (!operationName || typeof operationName !== 'string') return { ok: false, error: 'invalid_input' };
  try {
    connectLambda(event);
    await store().setJSON(operationName, { operationName: operationName, viewedAt: Date.now() });
    return { ok: true };
  } catch (e) {
    console.error('result-view-store: failed to record a result-viewed marker -- the scan may not see this view yet', e);
    return { ok: false, error: 'write_failed' };
  }
}

/**
 * True if a result-viewed marker exists for `operationName`. Used by
 * send-unwatched-dream-nudges.js's scan to suppress any dream the user has
 * already watched. A read failure returns FALSE (not "assume viewed"),
 * matching this codebase's other best-effort reads that degrade toward
 * "act" rather than "silently swallow" — the once-per-dream guard and the
 * unsubscribe footer bound the cost of a wrongly-sent nudge, whereas
 * wrongly SUPPRESSING would silently kill the whole feature on any read
 * blip.
 */
async function hasViewed(event, operationName) {
  if (!operationName || typeof operationName !== 'string') return false;
  try {
    connectLambda(event);
    var record = await store().get(operationName, { type: 'json' });
    return !!(record && record.viewedAt);
  } catch (e) {
    console.error('result-view-store: read failed -- treating as not-yet-viewed', e);
    return false;
  }
}

module.exports = { STORE_NAME, markViewed, hasViewed };
