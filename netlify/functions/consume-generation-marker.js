// netlify/functions/consume-generation-marker.js
//
// POST { operationName } -> { matched: boolean }. Reads + deletes
// (consumes, exactly once) the durable "this operation just finished
// generating" marker mark-generation-completed.js wrote, the server-side
// replacement for the old sessionStorage `dreamtube_just_generated_id`
// read+remove pair (tracker.html's
// result-htmls-firstvideocreated-still-dep-qfg48t item, founder-approved
// 2026-07-27). See netlify/functions/lib/generation-completion-store.js's
// header comment for the full design (why keyed by operationName, not
// dreamId -- a review finding, fixed 2026-07-27) and
// docs/EVENT_TAXONOMY.md for how this fits into FirstVideoCreated's
// two-guard picture -- `matched: true` here is the durable equivalent of
// the old code's `justGeneratedId === dream.id`, still only HALF the
// eligibility check: callers must still gate the actual conversion fire
// on DreamStore.markFirstVideoCreatedIfEligible(dreamId) (the unchanged,
// account-level "is this genuinely the first-ever completed dream" guard)
// on top of this.
//
// Called from js/store.js's DreamStore.wasOperationJustCompleted(operationName)
// -> Promise<boolean>, from result.html's render path, using the
// completed dream's own `sourceOperationName` field (see js/store.js's
// finalizeDream). A network failure (or this returning matched:false) is
// treated the exact same honest way the old sessionStorage-missing case
// already was: no fire this time, nothing thrown, nothing surfaced to the
// user.
//
// Rate limiting: same reasoning as mark-generation-completed.js's own
// comment -- public, unauthenticated, per-IP daily cap as cheap hygiene.
//
// Error codes (local to this small function):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_operation_name
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

  var operationName = (payload && payload.operationName) || '';
  if (!operationName || typeof operationName !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_operation_name' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 200;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'generation-marker-consume', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited' }) };
  }

  try {
    var matched = await generationCompletionStore.consumeIfPresent(event, operationName);
    return { statusCode: 200, body: JSON.stringify({ matched: matched }) };
  } catch (e) {
    // Best-effort -- see header comment. A read/delete failure here should
    // degrade to "not fresh, don't fire" rather than surface as an error,
    // same honest posture as every other analytics-adjacent call in this
    // codebase.
    console.error('consume-generation-marker: unexpected error', e);
    return { statusCode: 200, body: JSON.stringify({ matched: false }) };
  }
};
