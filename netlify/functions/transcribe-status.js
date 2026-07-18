// netlify/functions/transcribe-status.js
//
// GET ?name=<operation name> -> checks transcription status; once done,
// returns { done: true, transcript }.
//
// Mirrors video-status.js's fal queue-polling pattern (see that file's
// comments for why the status/result URLs use just the app's "owner/alias"
// rather than the full model id). transcribe-audio.js now only submits the
// job and returns immediately, to avoid Netlify's function timeout — see
// its header comment for the full story.

var FAL_API_BASE = 'https://queue.fal.run';

/** Parses a fetch Response as JSON, tolerating an empty/non-JSON body so callers can report the raw text instead of throwing. */
async function parseJsonSafe(res) {
  var text = await res.text();
  try {
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, rawText: text };
  }
}

function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

async function checkTranscribeStatus(model, requestId, falKey) {
  var appBase = falAppBase(model);
  var statusRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId + '/status', {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var parsedStatus = await parseJsonSafe(statusRes);
  if (!parsedStatus.ok) {
    return { statusCode: statusRes.status, error: 'status_check_failed: non-JSON response (http ' + statusRes.status + '): ' + parsedStatus.rawText.slice(0, 300) };
  }
  var statusData = parsedStatus.data;

  if (!statusRes.ok) {
    return { statusCode: statusRes.status, error: statusData.detail || 'status_check_failed' };
  }

  if (statusData.status === 'IN_QUEUE' || statusData.status === 'IN_PROGRESS') {
    return { statusCode: 200, done: false };
  }

  if (statusData.status !== 'COMPLETED') {
    return { statusCode: 200, done: true, error: 'transcription_failed: ' + statusData.status };
  }

  var resultRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId, {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var parsedResult = await parseJsonSafe(resultRes);
  if (!parsedResult.ok) {
    return { statusCode: 200, done: true, error: 'result_fetch_failed: non-JSON response (http ' + resultRes.status + '): ' + parsedResult.rawText.slice(0, 300) };
  }
  var resultData = parsedResult.data;

  if (!resultRes.ok) {
    return { statusCode: 200, done: true, error: 'result_fetch_failed' };
  }

  var transcript = resultData.text && resultData.text.trim();
  if (!transcript) {
    return { statusCode: 200, done: true, error: 'no_speech_detected' };
  }

  return { statusCode: 200, done: true, transcript: transcript };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var name = (event.queryStringParameters || {}).name;
  if (!name || name.indexOf('fal:') !== 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'name_required' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
  }

  try {
    var parts = name.split(':');
    var result = await checkTranscribeStatus(parts[1], parts[2], falKey);

    if (result.error && result.done === undefined) {
      return { statusCode: result.statusCode, body: JSON.stringify({ error: result.error }) };
    }

    var body = { done: result.done };
    if (result.error) body.error = result.error;
    if (result.transcript) body.transcript = result.transcript;
    return { statusCode: result.statusCode, body: JSON.stringify(body) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'status_check_failed: ' + (e && e.message) }) };
  }
};
