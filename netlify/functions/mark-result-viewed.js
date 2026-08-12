// netlify/functions/mark-result-viewed.js
//
// POST { operationName } -> records a durable, server-side "this account
// actually WATCHED its fresh video result" marker (lib/result-view-store.js).
// The suppression signal for the "unwatched dream" retention nudge
// (founder-approved retention plan, piece 1 — see
// send-unwatched-dream-nudges.js's header comment for the full feature).
//
// Called from result.html's openFullscreenVideo (via
// js/store.js's DreamStore.markResultViewed(operationName)) — fire-and-
// forget, best-effort, must never throw or block the tap that opens the
// player. Always 200s (even on a missing field or a write failure), same
// "best-effort bookkeeping, a caller has nothing useful to do with a
// non-2xx here" posture as mark-generation-completed.js (see that file's
// own header comment) and consume-generation-marker.js.
//
// WHY THE FULLSCREEN-OPEN, NOT THE PAGE RENDER, IS "VIEWED": result.html's
// ambient in-card preview autoplays muted the instant the page renders, and
// that same render is what CAPTURES the dream's thumbnail (the detached-
// <video> frame grab -> upload-dream-thumbnail.js -> dream.imageUrl). If
// "viewed" meant "result.html rendered", it would be simultaneous with (and
// inseparable from) "thumbnail became available" — so the nudge's own
// trigger condition ("ready + thumbnail available AND not viewed") could
// never be satisfied and the feature would send zero emails. The genuine
// "the user actually watched their dream" moment is opening the fullscreen
// player (a deliberate tap on the frame / the "Watch your dream" pill / the
// home Day-0 card's play deep-link) — with sound, full-viewport, distinct
// from the muted ambient loop. That is the engagement this marks, and it is
// exactly the "did X (made a dream that's ready with a thumbnail) but NOT Y
// (didn't actually watch it)" retention target. See result.html's
// openFullscreenVideo for the call site and this codebase's own thumbnail-
// capture IIFE for why the render and the capture are the same moment.
//
// AUTOMATIC "No meaning yet" ENQUEUE (founder-approved 2026-08-12: "add the
// no interpretation email to also be automatically sent like not watched
// video"): the WATCH this endpoint records IS the enqueue trigger for the
// "No meaning yet" interpretation retention email. Right after writing the
// viewed marker, this best-effort enqueues a candidate into lib/interp-none-
// queue-store.js (keyed by the SAME operationName), which send-interp-none-
// nudges.js's scheduled scan drains ~10 min later — sending the email only if
// the user has STILL read zero interpretations by then. This mirrors exactly
// how mark-generation-completed.js enqueues the "unwatched dream" nudge on a
// verified completion: its own independent try/catch, resolving WHO owns the
// operationName via lib/job-owners.js's submission-time binding (never client-
// claimed), and never affecting the 200 this endpoint always returns.
//
// SECURITY: keyed by `operationName` (the server-issued generation job id),
// never a client-invented dreamId — the exact same reasoning
// mark-generation-completed.js's own header comment lays out for why it
// only accepts operationName: dream ids are public elsewhere in this app,
// so keying a marker on one would let anyone who knows a dreamId plant a
// "viewed" marker for someone else's dream (here that would SUPPRESS a
// legitimate nudge — a griefing vector, not a data leak, but still worth
// closing). operationName is never exposed in any UI/URL, so it can't be
// targeted. This endpoint does NOT re-verify job ownership or completion
// (unlike mark-generation-completed.js): a spurious "viewed" marker for a
// random real operationName can, at worst, suppress that one dream's
// retention nudge — a strictly self-limiting, non-destructive outcome — so
// the heavier verify machinery isn't warranted. The per-IP rate limit below
// is the same cheap hygiene mark-generation-completed.js/track-conversion.js
// apply to their own public unauthenticated endpoints.
//
// Error codes (local to this small function):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_operation_name
//   E4 rate_limited

var resultViewStore = require('./lib/result-view-store');
var rateLimit = require('./lib/rate-limit');
var jobOwners = require('./lib/job-owners');
var accountStore = require('./lib/account-store');
var interpNoneQueueStore = require('./lib/interp-none-queue-store');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var operationName = (payload && payload.operationName) || '';
  if (!operationName || typeof operationName !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_operation_name' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_RESULT_VIEW_MARKS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 300;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'result-view-mark', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited' }) };
  }

  // Best-effort — a write failure is swallowed into a normal 200 (see
  // header comment), same as the marker itself being idempotent.
  try {
    await resultViewStore.markViewed(event, operationName);
  } catch (e) {
    console.error('mark-result-viewed: unexpected error', e);
  }

  // AUTOMATIC "No meaning yet" retention-email ENQUEUE — its own independent
  // try/catch, the exact "a side-write must never affect the response or the
  // primary marker" discipline mark-generation-completed.js's completion
  // side-effects use. Enqueues a pending candidate; send-interp-none-nudges.js's
  // scheduled scan decides, ~10 min later, whether the user read an
  // interpretation in the meantime (self-suppress) or not (send).
  try {
    await maybeEnqueueInterpNoneCandidate(event, operationName);
  } catch (noneErr) {
    console.error('mark-result-viewed: interp-none enqueue step failed (non-fatal)', noneErr);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

/**
 * Enqueues a pending "No meaning yet" candidate for THIS just-watched dream,
 * if it belongs to a real registered account. send-interp-none-nudges.js's
 * scheduled scan is what actually decides, ~10 min later, whether the user
 * has read any interpretation yet (read-count still 0 -> send; >=1 ->
 * self-suppress). See lib/interp-none-queue-store.js's header comment for the
 * full mechanism.
 *
 * Resolves identity via lib/job-owners.js's submission-time operationName ->
 * owner binding — never anything this request itself claims — exactly like
 * mark-generation-completed.js's maybeEnqueueUnwatchedNudge. Every branch is a
 * silent no-op (never an error, never a distinguishable HTTP response), the
 * same posture as this endpoint's viewed marker.
 *
 * Video-only scope: an unrecorded/unrecognized mediaType (a job predating that
 * field, or a write that failed) fails CLOSED here, never assumed to be
 * 'video' — same reasoning as the unwatched nudge (see lib/job-owners.js's
 * header comment on why mediaType can't be derived from operationName alone).
 * Interpretations are only ever offered on a dream VIDEO, so this scope is
 * also the natural one for the trigger.
 */
async function maybeEnqueueInterpNoneCandidate(event, operationName) {
  var ownerRecord = await jobOwners.getJobOwnerRecordWithRetry(event, operationName);
  if (!ownerRecord || !ownerRecord.email) return;
  if (ownerRecord.mediaType !== 'video') return;

  var account = await accountStore.getByEmail(event, ownerRecord.email);
  if (!account || !account.username) return;

  // Idempotent + best-effort — a duplicate call for the SAME operationName (a
  // re-watch of the same dream) is a harmless no-op against the already-ticking
  // window (onlyIfNew CAS), and a failed enqueue is a silent miss for this one
  // candidate (no failure ever surfaces to the caller).
  await interpNoneQueueStore.markPending(event, operationName, account.username, account.email);
}

// Exposed for direct unit testing of the enqueue branch in isolation
// (test/interp-none-nudge-enqueue.test.js).
exports.maybeEnqueueInterpNoneCandidate = maybeEnqueueInterpNoneCandidate;
