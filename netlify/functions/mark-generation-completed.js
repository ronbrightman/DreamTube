// netlify/functions/mark-generation-completed.js
//
// POST { operationName } -> independently RE-VERIFIES that this
// server-issued job actually completed, and only then durably records
// "this operation just finished generating" -- replacing the old
// sessionStorage `dreamtube_just_generated_id` marker processing.html
// used to set right before redirecting to result.html (tracker.html's
// result-htmls-firstvideocreated-still-dep-qfg48t item, founder-approved
// 2026-07-27 -- "make the carrier durable"). See
// netlify/functions/lib/generation-completion-store.js's header comment
// for the full design (why keyed by operationName, not dreamId) and
// docs/EVENT_TAXONOMY.md for how this fits into FirstVideoCreated's
// two-guard picture. Paired with consume-generation-marker.js, called
// from result.html at render time.
//
// SECURITY (review finding, fixed 2026-07-27): the original version of
// this endpoint accepted a bare client-supplied `dreamId` with NO
// verification at all that a real generation had actually just
// completed. Since dream ids are client-invented and already public
// elsewhere in this app (explore.html/profile.html/watch.html links --
// profile.html's own dreams grid is the ORDINARY way a user revisits
// their own past dream), that meant any unauthenticated caller who
// merely knew/guessed a real dreamId could plant a marker for it, and the
// victim's own next ordinary revisit of their own old dream would
// silently consume it -- forging a FirstVideoCreated fire (Meta Pixel +
// CAPI + PostHog) for an account that never actually just generated
// anything. This is now closed two ways at once: (1) the accepted
// identifier is `operationName`, the server-issued job id from
// generate-video.js/generate-image.js, never client-invented and never
// exposed in any UI/URL anywhere in this app (see
// generation-completion-store.js's header comment for why that alone
// already prevents targeting a specific victim); and (2)
// `verifyOperationCompleted` below independently re-confirms, against
// fal's own status endpoint (or the mock path's embedded-timestamp
// check), that the claimed operationName genuinely reached a completed
// state -- a bare, unverified claim writes NOTHING.
//
// Called from js/store.js's DreamStore.markGenerationJustCompleted(operationName)
// -- fire-and-forget, best-effort, and must never throw or block the
// redirect it runs right before (same discipline as every other
// analytics-adjacent call in this codebase). Always 200s, even when
// verification fails or a field is missing, since this is purely
// best-effort bookkeeping -- a caller that gets a non-2xx here has
// nothing useful to do about it anyway, and a distinguishable response
// for "unverified" vs "verified" would just hand a prober a free oracle.
//
// Rate limiting: same reasoning as track-conversion.js -- a public,
// unauthenticated endpoint, so a per-IP daily cap guards against someone
// scripting pointless requests. Not the actual security boundary (that's
// verifyOperationCompleted below) -- just cheap hygiene consistent with
// this codebase's other public endpoints.
//
// Error codes (local to this small function):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_operation_name
//   E4 rate_limited

var generationCompletionStore = require('./lib/generation-completion-store');
var rateLimit = require('./lib/rate-limit');

var FAL_API_BASE = 'https://queue.fal.run';

// A genuine mock-mode completion is only ever observed as "done" by
// video-status.js/image-status.js once at least their own MOCK_DELAY_MS
// has elapsed since the operationName's embedded start timestamp (20s for
// video, 5s for image -- see either file's own MOCK_DELAY_MS). This
// function doesn't know which mediaType a given operationName was for, so
// it uses the SHORTER (image's) threshold as a conservative floor: any
// genuine completion will have already cleared it by the time the client
// gets here (finalizeDream only runs after the client's own poll already
// saw done:true), while a freshly-fabricated "mock:<Date.now()>:..." string
// (an attacker's forged operationName, minted the instant before calling
// this endpoint) will not.
var MOCK_MIN_ELAPSED_MS = 5000;

/** Same "owner/alias, not the full model id" extraction as video-status.js's/image-status.js's own falAppBase -- fal's status endpoint 405s on the full model id. Duplicated rather than shared, matching this codebase's "each function self-contained" convention (see image-status.js's own header comment on duplicating from video-status.js for the same reason). */
function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

/**
 * Independently re-verifies (never trusts the client's bare claim) that
 * `operationName` genuinely reached a completed state, consulting the
 * exact same status source video-status.js/image-status.js already
 * check: fal's own queue status endpoint for a real "fal:" job, or the
 * embedded-timestamp elapsed check for a "mock:" one (see those files'
 * own header comments and generate-video.js's/generate-image.js's
 * GENERATION_MOCK_MODE doc blocks). Deliberately a LIGHTER check than
 * either status function's own full logic -- this only needs "did fal
 * actually mark this COMPLETED", never the actual video/image URL, so it
 * skips the result-fetch/error-humanization machinery those files need
 * for their own different job (telling the user what went wrong).
 *
 * Fails CLOSED: an unrecognized operationName shape, a missing FAL_KEY, a
 * non-OK/non-JSON response, or fal reporting anything other than
 * COMPLETED (IN_QUEUE/IN_PROGRESS/an error status) all resolve false. A
 * false negative here just means a legitimate completion's marker doesn't
 * get written this time (an honest degrade, same class as every other
 * best-effort gap in this feature) -- never a false positive, which is
 * the property this function exists to guarantee.
 */
async function verifyOperationCompleted(operationName) {
  if (typeof operationName !== 'string' || !operationName) return false;

  if (operationName.indexOf('mock:') === 0) {
    var startedAt = parseInt(operationName.split(':')[1], 10);
    if (!isFinite(startedAt)) return false;
    return (Date.now() - startedAt) >= MOCK_MIN_ELAPSED_MS;
  }

  if (operationName.indexOf('fal:') === 0) {
    var falKey = process.env.FAL_KEY;
    if (!falKey) return false;
    var parts = operationName.split(':');
    var model = parts[1];
    var requestId = parts[2];
    if (!model || !requestId) return false;
    try {
      var res = await fetch(FAL_API_BASE + '/' + falAppBase(model) + '/requests/' + requestId + '/status', {
        headers: { 'Authorization': 'Key ' + falKey }
      });
      if (!res.ok) return false;
      var data = await res.json();
      return !!(data && data.status === 'COMPLETED');
    } catch (e) {
      return false;
    }
  }

  // Neither a recognized "fal:" nor "mock:" shape (e.g. the unused Veo
  // fallback path's raw operation names, or a fabricated value) -- fail
  // closed rather than guessing.
  return false;
}

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
  var ipLimit = await rateLimit.checkAndIncrement(event, 'generation-marker-mark', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited' }) };
  }

  try {
    var verified = await verifyOperationCompleted(operationName);
    if (verified) {
      await generationCompletionStore.markCompleted(event, operationName);
    }
    // An operationName that doesn't verify is a silent no-op -- see header
    // comment on why this never surfaces as a distinguishable response.
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

// Exposed for direct unit testing of the verification logic in isolation
// (test/generation-completion-marker.test.js) -- not used by any other
// production caller.
exports.verifyOperationCompleted = verifyOperationCompleted;
