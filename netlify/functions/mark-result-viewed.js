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

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
