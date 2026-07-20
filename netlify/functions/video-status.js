// netlify/functions/video-status.js
//
// GET ?name=<operation name> -> checks generation status; once done, returns
// { done: true, videoUrl }.
//
// ACTIVE PATH: fal.ai. generate-video.js now returns operationName values
// shaped "fal:<model>:<request_id>" (see checkFalStatus). fal hosts finished
// videos on a public CDN URL that needs no auth to fetch, so — unlike the
// Google/Veo path — there's no Blobs download/store step: we just hand back
// fal's own video URL.
//
// MOCK PATH: see generate-video.js's GENERATION_MOCK_MODE doc block and
// docs/TESTING.md. An operationName shaped "mock:<startedAtMs>:<id>" (see
// checkMockStatus) never touches fal at all — it resolves to "done" purely
// from elapsed wall-clock time against the timestamp embedded in the name
// itself, and hands back a small, stable, publicly-hosted sample video URL.
//
// FALLBACK PATH (unused): the original Google/Veo integration is kept as
// checkVeoStatus, reached if `name` looks like a raw Google operation name
// (e.g. a Veo job started before this switch) instead of a "fal:" one. It
// still downloads the video server-side and stores it via Netlify Blobs,
// served through video-file.mjs, because Google's Files API requires
// GEM_API_KEY on every download and classic functions cap responses ~6MB.

var { connectLambda, getStore } = require('@netlify/blobs');

var FAL_API_BASE = 'https://queue.fal.run';
var VEO_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Parses a fetch Response as JSON, tolerating an empty/non-JSON body so callers can report the raw text instead of throwing. */
async function parseJsonSafe(res) {
  var text = await res.text();
  try {
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, rawText: text };
  }
}

// fal's queue status/result endpoints route on just the app's "owner/alias"
// (e.g. "fal-ai/wan"), not the full model id used for submission (e.g.
// "fal-ai/wan/v2.2-5b/text-to-video") — confirmed against @fal-ai/client's
// own queue.js, which builds status/result URLs from parseEndpointId(id)
// .owner + .alias only, discarding any deeper path segments. Using the full
// model id here 405s.
function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

/**
 * fal's validation-error responses are FastAPI-style: `detail` is an array
 * of { loc, msg, type, input, ... } objects. `input` echoes the entire
 * request back — including, for a self-photo generation, the whole
 * base64-encoded reference photo — so the raw structure must never reach
 * the user. Extracts just the short msg text from each item, and for a
 * content_policy_violation specifically, replaces it with a short,
 * actionable explanation instead of fal's own (unhelpful-to-the-user) msg.
 * Duplicated from generate-video.js rather than shared — matches this
 * codebase's convention of each Netlify function being self-contained.
 */
function humanizeFalDetail(detail) {
  if (!Array.isArray(detail)) return null;
  var messages = detail.map(function (item) {
    if (!item) return null;
    if (item.type === 'content_policy_violation') {
      var onPhoto = Array.isArray(item.loc) && item.loc.indexOf('image_urls') !== -1;
      return onPhoto
        ? "The reference photo was flagged by the safety system — this usually happens when the photo appears to show a child or teen. For that character, switch to Describe (text) instead of a photo."
        : 'The description was flagged by the safety system. This usually happens when a real photo is combined with a description of a minor, or another sensitive detail — try removing age or other identifying details, or switch to a non-photorealistic style.';
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

// Error codes (E2xx = this function). See generate-video.js for the E1xx
// (submission-time) range this continues from.
//   E201 method_not_allowed  E202 name_required
//   E209 uncaught exception in the handler itself
//   E210/E211 missing_api_key (fal / legacy Veo path respectively)
//   E203 non-JSON response from fal's status endpoint (fal outage/hiccup)
//   E204 fal's status endpoint returned a non-OK HTTP response
//   E205 fal itself marked the job failed (status other than IN_QUEUE/IN_PROGRESS/COMPLETED —
//        this is the code to watch for content-moderation rejections, internal model
//        errors, etc. actually reported by fal, as opposed to a transport-level problem)
//   E206 non-JSON response from fal's result endpoint
//   E207 fal's result endpoint returned a non-OK HTTP response
//   E208 job reported COMPLETED but the result had no video URL in it (unexpected response shape)
//
// The mock path (checkMockStatus below) has no error codes of its own — a
// mock operation can't fail the way a real fal call can, by design (see
// generate-video.js's GENERATION_MOCK_MODE doc block).

// MOCK_DELAY_MS is deliberately a couple of the client's own poll cycles
// (js/store.js's POLL_INTERVAL_MS is 10000ms) rather than instant — part of
// the value of mock mode is still exercising the real "Generating..."
// polling/loading UI states, not skipping straight to done.
var MOCK_DELAY_MS = 20000;

// A tiny (~770KB), stable, publicly-hosted sample MP4 — W3Schools' standard
// HTML5-video-tutorial sample clip (itself an excerpt of Blender
// Foundation's Big Buck Bunny, CC-BY 3.0), used here purely so the rest of
// the app's flow (finalizeDream, duration probing, Explore/Profile
// rendering) has a real, working video to render against in tests — never
// shown to a real user. Verified reachable (200, video/mp4,
// long-lived cache-control) as of 2026-07; if this URL ever goes stale,
// swap it for another small, stable, publicly-hosted sample clip — nothing
// else in this file depends on its specific content.
var MOCK_SAMPLE_VIDEO_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';

/**
 * Mock path. A mock operationName is "mock:<startedAtMs>:<id>" (see
 * generate-video.js's mockOperationName) — the start timestamp is embedded
 * in the name itself, rather than kept in any server-side memory or Blobs
 * store, because Netlify Functions give no guarantee that repeated polls
 * for the same job land on the same warm instance. Comparing "now" against
 * that embedded timestamp keeps "is it done yet" correct regardless of
 * which instance handles which poll.
 */
function checkMockStatus(operationName) {
  var startedAt = parseInt(operationName.split(':')[1], 10);
  var elapsedMs = Date.now() - (isFinite(startedAt) ? startedAt : 0);
  if (elapsedMs < MOCK_DELAY_MS) {
    return { statusCode: 200, done: false };
  }
  return { statusCode: 200, done: true, videoUrl: MOCK_SAMPLE_VIDEO_URL };
}

/** Active path. */
async function checkFalStatus(model, requestId, falKey) {
  var appBase = falAppBase(model);
  var statusRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId + '/status', {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var parsedStatus = await parseJsonSafe(statusRes);
  if (!parsedStatus.ok) {
    return { statusCode: statusRes.status, error: 'E203: status_check_failed: non-JSON response (http ' + statusRes.status + '): ' + parsedStatus.rawText.slice(0, 300) };
  }
  var statusData = parsedStatus.data;

  if (!statusRes.ok) {
    return { statusCode: statusRes.status, error: 'E204: ' + (falErrorMessage(statusData) || 'status_check_failed') };
  }

  if (statusData.status === 'IN_QUEUE' || statusData.status === 'IN_PROGRESS') {
    return { statusCode: 200, done: false };
  }

  if (statusData.status !== 'COMPLETED') {
    return { statusCode: 200, done: true, error: 'E205: generation_failed: ' + statusData.status };
  }

  var resultRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId, {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var parsedResult = await parseJsonSafe(resultRes);
  if (!parsedResult.ok) {
    return { statusCode: 200, done: true, error: 'E206: result_fetch_failed: non-JSON response (http ' + resultRes.status + '): ' + parsedResult.rawText.slice(0, 300) };
  }
  var resultData = parsedResult.data;

  if (!resultRes.ok) {
    // resultData parsed as valid JSON (parsedResult.ok above), so fal sent
    // a structured reason along with the non-OK status — surface it
    // instead of a bare "result_fetch_failed" with nothing to go on. This
    // is the path a content-safety rejection comes through: fal can mark a
    // job COMPLETED (processing finished) while the actual result fetch
    // 4xxs with the real reason in the body — falErrorMessage turns that
    // into a short, human explanation (never the raw detail/input, which
    // would otherwise leak the full base64 reference photo into this text).
    return { statusCode: 200, done: true, error: 'E207: ' + (falErrorMessage(resultData) || 'result_fetch_failed') };
  }

  var videoUrl = resultData.video && resultData.video.url;
  if (!videoUrl) {
    return { statusCode: 200, done: true, error: 'E208: no_video_in_response' };
  }

  return { statusCode: 200, done: true, videoUrl: videoUrl };
}

/** Unused fallback path — the original Veo integration, storing the result via Netlify Blobs. */
async function checkVeoStatus(name, apiKey, event) {
  connectLambda(event);

  var res = await fetch(VEO_API_BASE + '/' + name, {
    headers: { 'x-goog-api-key': apiKey }
  });
  var data = await res.json();

  if (!res.ok) {
    var message = (data && data.error && data.error.message) || 'status_check_failed';
    return { statusCode: res.status, error: message };
  }

  if (!data.done) {
    return { statusCode: 200, done: false };
  }

  if (data.error) {
    return { statusCode: 200, done: true, error: data.error.message || 'generation_failed' };
  }

  var samples = data.response && data.response.generateVideoResponse && data.response.generateVideoResponse.generatedSamples;
  var uri = samples && samples[0] && samples[0].video && samples[0].video.uri;
  if (!uri) {
    return { statusCode: 200, done: true, error: 'no_video_in_response' };
  }

  var key = 'v-' + name.split('/').pop();
  var store = getStore('dreamtube-videos');
  var videoUrl = '/.netlify/functions/video-file?key=' + encodeURIComponent(key);

  var existing = await store.getMetadata(key);
  if (!existing) {
    var fileRes = await fetch(uri, { headers: { 'x-goog-api-key': apiKey } });
    if (!fileRes.ok) {
      return { statusCode: 200, done: true, error: 'video_download_failed' };
    }
    var arrayBuffer = await fileRes.arrayBuffer();
    await store.set(key, arrayBuffer, {
      metadata: { contentType: fileRes.headers.get('content-type') || 'video/mp4' }
    });
  }

  return { statusCode: 200, done: true, videoUrl: videoUrl };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E201: method_not_allowed' }) };
  }

  var name = (event.queryStringParameters || {}).name;
  if (!name) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E202: name_required' }) };
  }

  try {
    var result;

    if (name.indexOf('mock:') === 0) {
      result = checkMockStatus(name);
    } else if (name.indexOf('fal:') === 0) {
      var falKey = process.env.FAL_KEY;
      if (!falKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'E210: missing_api_key' }) };
      }
      var parts = name.split(':');
      result = await checkFalStatus(parts[1], parts[2], falKey);
    } else {
      var apiKey = process.env.GEM_API_KEY;
      if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'E211: missing_api_key' }) };
      }
      result = await checkVeoStatus(name, apiKey, event);
    }

    if (result.error && result.done === undefined) {
      return { statusCode: result.statusCode, body: JSON.stringify({ error: result.error }) };
    }

    var body = { done: result.done };
    if (result.error) body.error = result.error;
    if (result.videoUrl) body.videoUrl = result.videoUrl;
    return { statusCode: result.statusCode, body: JSON.stringify(body) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E209: status_check_failed: ' + (e && e.message) }) };
  }
};
