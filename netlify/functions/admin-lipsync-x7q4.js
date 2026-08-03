// netlify/functions/admin-lipsync-x7q4.js
//
// TEMPORARY one-shot admin helper (Manager, 2026-08-03): re-lip-sync the
// Speaking Sage intro clip to the corrected "come closer" greeting audio.
// Exists because the one-time intro asset (SPEAKING_SAGE_SPEC.md §"intro
// clip") shipped with a placeholder voice take, the corrected take must be
// generated server-side (FAL_KEY lives only in this environment), and
// sync-lipsync is not part of any product runtime path — so this is an
// admin tool, not a feature. DELETE this file once the corrected asset is
// committed to assets/interpreters/intro/ (no-dead-code rule; the
// tracker's Speaking Sage items record the follow-through).
//
// Owner-gated the same way owner-topup-tokens.js is: the request must
// carry the owner's email verbatim. Obscured -x7q4 filename like every
// other owner-only surface.
//
//   POST { email, videoUrl, audioUrl } -> 200 { operationName }
//   GET  ?name=<operationName>         -> 200 { status } | { status:'completed', videoUrl }
//
// operationName format mirrors generate-interp-audio.js: "fal:<model>:<id>".

var FAL_API_BASE = 'https://queue.fal.run';
var FAL_MODEL = 'fal-ai/sync-lipsync';
var OWNER_EMAIL = 'ronbrightman@gmail.com';

exports.handler = async function (event) {
  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
  }

  if (event.httpMethod === 'GET') {
    var name = (event.queryStringParameters || {}).name || '';
    var parts = name.split(':');
    if (parts.length < 3 || parts[0] !== 'fal') {
      return { statusCode: 400, body: JSON.stringify({ error: 'bad_operation_name' }) };
    }
    var requestId = parts[parts.length - 1];
    var statusRes = await fetch(FAL_API_BASE + '/' + FAL_MODEL + '/requests/' + requestId + '/status', {
      headers: { 'Authorization': 'Key ' + falKey }
    });
    var statusData = await statusRes.json();
    if (statusData.status !== 'COMPLETED') {
      return { statusCode: 200, body: JSON.stringify({ status: 'processing', detail: statusData.status }) };
    }
    var resultRes = await fetch(FAL_API_BASE + '/' + FAL_MODEL + '/requests/' + requestId, {
      headers: { 'Authorization': 'Key ' + falKey }
    });
    var resultData = await resultRes.json();
    var videoUrl = resultData && resultData.video && resultData.video.url;
    return { statusCode: 200, body: JSON.stringify({ status: 'completed', videoUrl: videoUrl || null, raw: videoUrl ? undefined : resultData }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
  }
  if (payload.email !== OWNER_EMAIL) {
    return { statusCode: 403, body: JSON.stringify({ error: 'forbidden' }) };
  }
  if (!payload.videoUrl || !payload.audioUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'video_and_audio_required' }) };
  }

  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Key ' + falKey },
    body: JSON.stringify({ video_url: payload.videoUrl, audio_url: payload.audioUrl, sync_mode: 'cut_off' })
  });
  var data = await res.json();
  if (!res.ok) {
    return { statusCode: res.status, body: JSON.stringify({ error: 'lipsync_request_failed', detail: data }) };
  }
  return { statusCode: 200, body: JSON.stringify({ operationName: 'fal:' + FAL_MODEL + ':' + data.request_id }) };
};
