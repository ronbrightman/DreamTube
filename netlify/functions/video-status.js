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
// FALLBACK PATH (unused): the original Google/Veo integration is kept as
// checkVeoStatus, reached if `name` looks like a raw Google operation name
// (e.g. a Veo job started before this switch) instead of a "fal:" one. It
// still downloads the video server-side and stores it via Netlify Blobs,
// served through video-file.mjs, because Google's Files API requires
// GEM_API_KEY on every download and classic functions cap responses ~6MB.

var { connectLambda, getStore } = require('@netlify/blobs');

var FAL_API_BASE = 'https://queue.fal.run';
var VEO_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Active path. */
async function checkFalStatus(model, requestId, falKey) {
  var statusRes = await fetch(FAL_API_BASE + '/' + model + '/requests/' + requestId + '/status', {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var statusData = await statusRes.json();

  if (!statusRes.ok) {
    return { statusCode: statusRes.status, error: statusData.detail || 'status_check_failed' };
  }

  if (statusData.status === 'IN_QUEUE' || statusData.status === 'IN_PROGRESS') {
    return { statusCode: 200, done: false };
  }

  if (statusData.status !== 'COMPLETED') {
    return { statusCode: 200, done: true, error: 'generation_failed: ' + statusData.status };
  }

  var resultRes = await fetch(FAL_API_BASE + '/' + model + '/requests/' + requestId, {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var resultData = await resultRes.json();

  if (!resultRes.ok) {
    return { statusCode: 200, done: true, error: 'result_fetch_failed' };
  }

  var videoUrl = resultData.video && resultData.video.url;
  if (!videoUrl) {
    return { statusCode: 200, done: true, error: 'no_video_in_response' };
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
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var name = (event.queryStringParameters || {}).name;
  if (!name) {
    return { statusCode: 400, body: JSON.stringify({ error: 'name_required' }) };
  }

  try {
    var result;

    if (name.indexOf('fal:') === 0) {
      var falKey = process.env.FAL_KEY;
      if (!falKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
      }
      var parts = name.split(':');
      result = await checkFalStatus(parts[1], parts[2], falKey);
    } else {
      var apiKey = process.env.GEM_API_KEY;
      if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
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
    return { statusCode: 500, body: JSON.stringify({ error: 'status_check_failed: ' + (e && e.message) }) };
  }
};
