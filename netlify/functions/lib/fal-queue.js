// netlify/functions/lib/fal-queue.js
//
// Small shared helper for fal.ai's queue-based submit -> poll -> result
// cycle, factored out for watermark-video.js's two new call sites
// (download-video.js submits a job, download-video-status.js polls it) so
// that cycle isn't hand-rolled a THIRD time in this codebase — it's already
// implemented twice, deliberately duplicated per-file, in generate-video.js
// (callFal) and video-status.js (checkFalStatus). Those two stay exactly as
// they are (each is tightly coupled to its own file's own token/refund/
// error-code concerns, and this codebase's own convention — see
// video-file.mjs's header comment — is that a NETLIFY FUNCTION is
// self-contained; a shared `lib/` helper used by more than one function is
// the normal, existing pattern for logic that has nothing function-specific
// in it, same as lib/media-rehost.js, lib/entitlements.js, etc). This one
// module is genuinely generic fal-queue plumbing with zero DreamTube-
// specific business logic (no tokens, no refunds, no dream records) — a
// clean case for sharing rather than a third copy-paste.
//
// Only implements the ACTIVE fal.ai queue path — no mock mode of its own
// (see netlify/functions/lib/watermark-video.js for how the watermark
// feature's own mock/no-FAL_KEY story is handled at the call-site level).

var FAL_API_BASE = 'https://queue.fal.run';

/**
 * fal's queue status/result endpoints route on just the app's
 * "owner/alias" (e.g. "fal-ai/workflow-utilities"), not the full model id
 * used for submission (e.g. "fal-ai/workflow-utilities/blend-video") —
 * same fact video-status.js's own falAppBase documents (confirmed against
 * @fal-ai/client's queue.js, which builds status/result URLs from
 * parseEndpointId(id).owner + .alias only). Duplicated here rather than
 * required from video-status.js, matching this codebase's "duplicate
 * small pure helpers across files, share only real logic" convention.
 */
function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

/** Parses a fetch Response as JSON, tolerating an empty/non-JSON body. */
async function parseJsonSafe(res) {
  var text = await res.text();
  try {
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, rawText: text };
  }
}

/**
 * Submits `body` to fal's queue for `model`, with `falKey` auth and any
 * `extraHeaders` (e.g. generate-video.js's own FAL_NO_EXPIRY_HEADER —
 * callers pass it explicitly rather than this module hardcoding it, since
 * it's a generic fal request-lifecycle header, not specific to this
 * module). Returns `{ ok: true, requestId }` or `{ ok: false, error }` —
 * never throws.
 */
async function submitJob(model, falKey, body, extraHeaders) {
  try {
    var res = await fetch(FAL_API_BASE + '/' + model, {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Authorization': 'Key ' + falKey
      }, extraHeaders || {}),
      body: JSON.stringify(body)
    });
    var parsed = await parseJsonSafe(res);
    if (!parsed.ok) {
      return { ok: false, error: 'non_json_response (http ' + res.status + '): ' + parsed.rawText.slice(0, 300) };
    }
    if (!res.ok) {
      return { ok: false, error: (parsed.data && (parsed.data.detail || parsed.data.error)) || 'submit_failed (http ' + res.status + ')' };
    }
    if (!parsed.data.request_id) {
      return { ok: false, error: 'no_request_id_in_response' };
    }
    return { ok: true, requestId: parsed.data.request_id };
  } catch (e) {
    return { ok: false, error: 'submit_exception: ' + (e && e.message) };
  }
}

/**
 * Polls `model`/`requestId`'s status once, and if COMPLETED, fetches and
 * returns the full result payload too — same two-step status-then-result
 * shape as video-status.js's checkFalStatus, generalized (this module has
 * no opinion on what the result payload's own shape is — callers pull
 * whatever field their specific fal endpoint returns, e.g. `.video.url` for
 * blend-video). Returns:
 *   { ok: true, done: false }                    -- still IN_QUEUE/IN_PROGRESS
 *   { ok: true, done: true, result: <resultData> } -- COMPLETED, result fetched
 *   { ok: false, error }                          -- fal-side failure or transport hiccup
 * Never throws.
 */
async function pollJob(model, requestId, falKey) {
  var appBase = falAppBase(model);
  try {
    var statusRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId + '/status', {
      headers: { 'Authorization': 'Key ' + falKey }
    });
    var parsedStatus = await parseJsonSafe(statusRes);
    if (!parsedStatus.ok) {
      return { ok: false, error: 'status_non_json (http ' + statusRes.status + '): ' + parsedStatus.rawText.slice(0, 300) };
    }
    if (!statusRes.ok) {
      return { ok: false, error: 'status_check_failed (http ' + statusRes.status + ')' };
    }

    var status = parsedStatus.data.status;
    if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
      return { ok: true, done: false };
    }
    if (status !== 'COMPLETED') {
      return { ok: false, error: 'job_failed: ' + status };
    }

    var resultRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId, {
      headers: { 'Authorization': 'Key ' + falKey }
    });
    var parsedResult = await parseJsonSafe(resultRes);
    if (!parsedResult.ok) {
      return { ok: false, error: 'result_non_json (http ' + resultRes.status + '): ' + parsedResult.rawText.slice(0, 300) };
    }
    if (!resultRes.ok) {
      return { ok: false, error: (parsedResult.data && (parsedResult.data.detail || parsedResult.data.error)) || 'result_fetch_failed (http ' + resultRes.status + ')' };
    }

    return { ok: true, done: true, result: parsedResult.data };
  } catch (e) {
    return { ok: false, error: 'poll_exception: ' + (e && e.message) };
  }
}

module.exports = { submitJob: submitJob, pollJob: pollJob, falAppBase: falAppBase };
