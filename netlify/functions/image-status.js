// netlify/functions/image-status.js
//
// GET ?name=<operation name> -> checks image generation status; once done,
// returns { done: true, imageUrl }.
//
// Mirrors video-status.js's polling/status-check shape almost exactly —
// see that file's own header comment for the shared reasoning — reading
// resultData.images[0].url instead of resultData.video.url (fal-ai/flux/dev
// returns { images: [{ url, width, height, content_type }], ... }, confirmed
// against fal's schema docs, see generate-image.js's header comment and
// docs/IMAGE_GENERATION_SPEC.md §2a).
//
// ACTIVE PATH: fal.ai. generate-image.js returns operationName values shaped
// "fal:<model>:<request_id>" (see checkFalImageStatus). fal hosts finished
// images on a public CDN URL that needs no auth to fetch, same as video —
// no Blobs download/store step, this just hands back fal's own image URL.
//
// MOCK PATH: see generate-image.js's GENERATION_MOCK_MODE doc block and
// docs/TESTING.md. An operationName shaped "mock:<startedAtMs>:<id>" (see
// checkMockStatus) never touches fal at all — it resolves to "done" purely
// from elapsed wall-clock time against the timestamp embedded in the name
// itself, and hands back a small, stable, publicly-hosted sample image URL.
// The simulated delay here is deliberately much shorter than video-status.js's
// MOCK_DELAY_MS (20s): a real flux/dev completion is seconds, not minutes,
// so a mock delay proportionate to that keeps mock mode representative
// rather than making an image generation feel artificially slow.

var FAL_API_BASE = 'https://queue.fal.run';

/** Parses a fetch Response as JSON, tolerating an empty/non-JSON body so callers can report the raw text instead of throwing. Duplicated from video-status.js — see this codebase's "each function self-contained" convention. */
async function parseJsonSafe(res) {
  var text = await res.text();
  try {
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, rawText: text };
  }
}

// fal's queue status/result endpoints route on just the app's "owner/alias"
// (e.g. "fal-ai/flux"), not the full model id used for submission (e.g.
// "fal-ai/flux/dev") — same rule video-status.js's own falAppBase documents
// (confirmed against @fal-ai/client's own queue.js). Using the full model id
// here 405s.
function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

/**
 * fal's validation-error responses are FastAPI-style: `detail` is an array
 * of { loc, msg, type, input, ... } objects. Duplicated from
 * generate-image.js/video-status.js rather than shared — see either file's
 * own copy for the full reasoning.
 */
function humanizeFalDetail(detail) {
  if (!Array.isArray(detail)) return null;
  var messages = detail.map(function (item) {
    if (!item) return null;
    if (item.type === 'content_policy_violation') {
      return 'The description was flagged by the safety system. This usually happens when a description includes a minor, or another sensitive detail — try removing age or other identifying details, or switch to a non-photorealistic style.';
    }
    return typeof item.msg === 'string' ? item.msg : null;
  }).filter(Boolean);
  return messages.length ? messages.join(' ') : null;
}

/** Extracts a safe, human-readable message from a fal error response — never the raw detail/input structure. */
function falErrorMessage(data) {
  var rawDetail = data && (data.detail || data.error);
  return humanizeFalDetail(rawDetail) || (typeof rawDetail === 'string' ? rawDetail : null) || null;
}

// Error codes (E5xx = this function — the next free hundred-range after
// generate-image.js's E4xx). Same numbering pattern as video-status.js's
// E2xx range, offset:
//   E501 method_not_allowed  E502 name_required
//   E509 uncaught exception in the handler itself
//   E510 missing_api_key (FAL_KEY not configured)
//   E503 non-JSON response from fal's status endpoint (fal outage/hiccup)
//   E504 fal's status endpoint returned a non-OK HTTP response
//   E505 fal itself marked the job failed (status other than IN_QUEUE/IN_PROGRESS/COMPLETED —
//        this is the code to watch for content-moderation rejections, internal model
//        errors, etc. actually reported by fal, as opposed to a transport-level problem)
//   E506 non-JSON response from fal's result endpoint
//   E507 fal's result endpoint returned a non-OK HTTP response
//   E508 job reported COMPLETED but the result had no image URL in it (unexpected response shape)
//
// The mock path (checkMockStatus below) has no error codes of its own — a
// mock operation can't fail the way a real fal call can, by design (see
// generate-image.js's GENERATION_MOCK_MODE doc block).

// Shorter than video-status.js's 20s MOCK_DELAY_MS — a real flux/dev
// completion is seconds, not minutes, so mock mode should feel
// proportionate to what it's standing in for (see header comment above).
var MOCK_DELAY_MS = 5000;

// A tiny, stable, publicly-hosted sample image — used here purely so the
// rest of the app's flow (finalizeDream, Explore/Profile rendering, the
// "Turn this into a video" upsell) has a real, working image URL to render
// against in tests — never shown to a real user. Picsum's stable seeded
// endpoint (https://picsum.photos/seed/<seed>/<w>/<h>) always resolves the
// same image for a given seed and redirects to a real, long-lived CDN URL;
// verified reachable (200, image/jpeg) as of 2026-07 — if this URL ever
// goes stale, swap it for another small, stable, publicly-hosted sample
// image, nothing else in this file depends on its specific content.
var MOCK_SAMPLE_IMAGE_URL = 'https://picsum.photos/seed/dreamtube-mock/720/1280';

/**
 * Mock path. A mock operationName is "mock:<startedAtMs>:<id>" (see
 * generate-image.js's mockOperationName) — same embedded-timestamp
 * reasoning as video-status.js's checkMockStatus (no server-side memory
 * needed, works regardless of which warm instance handles which poll).
 */
function checkMockStatus(operationName) {
  var startedAt = parseInt(operationName.split(':')[1], 10);
  var elapsedMs = Date.now() - (isFinite(startedAt) ? startedAt : 0);
  if (elapsedMs < MOCK_DELAY_MS) {
    return { statusCode: 200, done: false };
  }
  return { statusCode: 200, done: true, imageUrl: MOCK_SAMPLE_IMAGE_URL };
}

/** Active path. */
async function checkFalImageStatus(model, requestId, falKey) {
  var appBase = falAppBase(model);
  var statusRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId + '/status', {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var parsedStatus = await parseJsonSafe(statusRes);
  if (!parsedStatus.ok) {
    return { statusCode: statusRes.status, error: 'E503: status_check_failed: non-JSON response (http ' + statusRes.status + '): ' + parsedStatus.rawText.slice(0, 300) };
  }
  var statusData = parsedStatus.data;

  if (!statusRes.ok) {
    return { statusCode: statusRes.status, error: 'E504: ' + (falErrorMessage(statusData) || 'status_check_failed') };
  }

  if (statusData.status === 'IN_QUEUE' || statusData.status === 'IN_PROGRESS') {
    return { statusCode: 200, done: false };
  }

  if (statusData.status !== 'COMPLETED') {
    return { statusCode: 200, done: true, error: 'E505: generation_failed: ' + statusData.status };
  }

  var resultRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId, {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var parsedResult = await parseJsonSafe(resultRes);
  if (!parsedResult.ok) {
    return { statusCode: 200, done: true, error: 'E506: result_fetch_failed: non-JSON response (http ' + resultRes.status + '): ' + parsedResult.rawText.slice(0, 300) };
  }
  var resultData = parsedResult.data;

  if (!resultRes.ok) {
    return { statusCode: 200, done: true, error: 'E507: ' + (falErrorMessage(resultData) || 'result_fetch_failed') };
  }

  var imageUrl = resultData.images && resultData.images[0] && resultData.images[0].url;
  if (!imageUrl) {
    return { statusCode: 200, done: true, error: 'E508: no_image_in_response' };
  }

  return { statusCode: 200, done: true, imageUrl: imageUrl };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E501: method_not_allowed' }) };
  }

  var name = (event.queryStringParameters || {}).name;
  if (!name) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E502: name_required' }) };
  }

  try {
    var result;

    if (name.indexOf('mock:') === 0) {
      result = checkMockStatus(name);
    } else if (name.indexOf('fal:') === 0) {
      var falKey = process.env.FAL_KEY;
      if (!falKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'E510: missing_api_key' }) };
      }
      var parts = name.split(':');
      result = await checkFalImageStatus(parts[1], parts[2], falKey);
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'E502: name_required' }) };
    }

    if (result.error && result.done === undefined) {
      return { statusCode: result.statusCode, body: JSON.stringify({ error: result.error }) };
    }

    var body = { done: result.done };
    if (result.error) body.error = result.error;
    if (result.imageUrl) body.imageUrl = result.imageUrl;
    return { statusCode: result.statusCode, body: JSON.stringify(body) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E509: status_check_failed: ' + (e && e.message) }) };
  }
};
