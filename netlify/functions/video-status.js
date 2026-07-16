// netlify/functions/video-status.js
//
// GET ?name=<operation name> -> checks Veo generation status. Once done,
// downloads the finished video server-side (with GEM_API_KEY) and saves it
// into Netlify Blobs, then returns a small JSON payload — { done, videoUrl }
// — where videoUrl points at video-file.mjs, the streaming function that
// actually serves the blob. The video is never returned as this function's
// own HTTP response: classic Netlify functions cap synchronous response
// bodies around 6MB, which a real Veo clip can easily exceed.

var { connectLambda, getStore } = require('@netlify/blobs');

var API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

exports.handler = async function (event) {
  // Classic Lambda-compatibility functions don't get Blobs credentials
  // auto-injected the way the modern function format does — this wires
  // them up manually from the invocation event.
  connectLambda(event);

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var apiKey = process.env.GEM_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
  }

  var name = (event.queryStringParameters || {}).name;
  if (!name) {
    return { statusCode: 400, body: JSON.stringify({ error: 'name_required' }) };
  }

  try {
    var res = await fetch(API_BASE + '/' + name, {
      headers: { 'x-goog-api-key': apiKey }
    });
    var data = await res.json();

    if (!res.ok) {
      var message = (data && data.error && data.error.message) || 'status_check_failed';
      return { statusCode: res.status, body: JSON.stringify({ error: message }) };
    }

    if (!data.done) {
      return { statusCode: 200, body: JSON.stringify({ done: false }) };
    }

    if (data.error) {
      return { statusCode: 200, body: JSON.stringify({ done: true, error: data.error.message || 'generation_failed' }) };
    }

    var samples = data.response && data.response.generateVideoResponse && data.response.generateVideoResponse.generatedSamples;
    var uri = samples && samples[0] && samples[0].video && samples[0].video.uri;
    if (!uri) {
      return { statusCode: 200, body: JSON.stringify({ done: true, error: 'no_video_in_response' }) };
    }

    // Deterministic key so repeated polls after completion (retries, a
    // refreshed page before the client stops polling, etc.) reuse the same
    // blob instead of re-downloading from Google and storing a duplicate.
    var key = 'v-' + name.split('/').pop();
    var store = getStore('dreamtube-videos');
    var videoUrl = '/.netlify/functions/video-file?key=' + encodeURIComponent(key);

    var existing = await store.getMetadata(key);
    if (!existing) {
      var fileRes = await fetch(uri, { headers: { 'x-goog-api-key': apiKey } });
      if (!fileRes.ok) {
        return { statusCode: 200, body: JSON.stringify({ done: true, error: 'video_download_failed' }) };
      }
      var arrayBuffer = await fileRes.arrayBuffer();
      await store.set(key, arrayBuffer, {
        metadata: { contentType: fileRes.headers.get('content-type') || 'video/mp4' }
      });
    }

    return { statusCode: 200, body: JSON.stringify({ done: true, videoUrl: videoUrl }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'status_check_failed: ' + (e && e.message) }) };
  }
};
