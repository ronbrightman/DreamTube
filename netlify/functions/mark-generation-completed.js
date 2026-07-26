// netlify/functions/mark-generation-completed.js
//
// POST { dreamId } -> durably records "this dream id just finished
// generating", replacing the old sessionStorage `dreamtube_just_generated_id`
// marker processing.html used to set right before redirecting to
// result.html (tracker.html's result-htmls-firstvideocreated-still-dep-qfg48t
// item, founder-approved 2026-07-27 -- "make the carrier durable"). See
// netlify/functions/lib/generation-completion-store.js's header comment for
// the full design (why keyed by dream id, not username/email; the accepted
// low-risk lack of auth) and docs/EVENT_TAXONOMY.md for how this fits into
// FirstVideoCreated's two-guard picture. Paired with
// consume-generation-marker.js, called from result.html at render time.
//
// Called from js/store.js's DreamStore.markDreamJustCompleted(dreamId) --
// fire-and-forget, best-effort, and must never throw or block the redirect
// it runs right before (same discipline as every other analytics-adjacent
// call in this codebase). Always 200s, even on a validation failure, since
// this is purely best-effort bookkeeping -- a caller that gets a non-2xx
// here has nothing useful to do about it anyway.
//
// Rate limiting: same reasoning as track-conversion.js -- a public,
// unauthenticated endpoint, so a per-IP daily cap guards against someone
// scripting pointless writes. Not a security boundary (see the store's own
// header comment on why an unauthenticated dreamId-keyed marker is an
// accepted, low-risk design here), just cheap hygiene consistent with this
// codebase's other public endpoints.
//
// Error codes (local to this small function):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_dream_id
//   E4 rate_limited

var generationCompletionStore = require('./lib/generation-completion-store');
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

  var dreamId = (payload && payload.dreamId) || '';
  if (!dreamId || typeof dreamId !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_dream_id' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 200;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'generation-marker-mark', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited' }) };
  }

  try {
    await generationCompletionStore.markCompleted(event, dreamId);
  } catch (e) {
    // Best-effort, same philosophy as send-first-dream-email.js -- never
    // let this surface as a failure to the caller. A failure here just
    // means this specific completion's FirstVideoCreated fire may be
    // missed, the same honest degrade the old sessionStorage marker
    // already accepted when storage was disabled.
    console.error('mark-generation-completed: unexpected error', e);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
