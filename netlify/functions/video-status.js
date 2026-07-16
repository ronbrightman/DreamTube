// netlify/functions/video-status.js
//
// GET ?name=<operation name>  -> checks Veo generation status; once done,
//   returns { done: true, videoUrl } where videoUrl points back at this same
//   function in "download" mode, so the browser never sees GEM_API_KEY.
// GET ?download=<google file uri> -> fetches the finished video from Google
//   with the server-side key and streams the bytes back as video/mp4.
//
// Note: Netlify's classic (Lambda-based) functions cap response bodies around
// 6MB base64-encoded. An 8s 720p Veo clip normally fits; longer/higher-res
// clips may not — switch to a streaming/edge function if that becomes a problem.

var API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var apiKey = process.env.GEM_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
  }

  var params = event.queryStringParameters || {};

  if (params.download) {
    try {
      var fileRes = await fetch(params.download, {
        headers: { 'x-goog-api-key': apiKey }
      });
      if (!fileRes.ok) {
        return { statusCode: fileRes.status, body: JSON.stringify({ error: 'video_download_failed' }) };
      }
      var arrayBuffer = await fileRes.arrayBuffer();
      return {
        statusCode: 200,
        headers: { 'Content-Type': fileRes.headers.get('content-type') || 'video/mp4' },
        body: Buffer.from(arrayBuffer).toString('base64'),
        isBase64Encoded: true
      };
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'video_download_failed' }) };
    }
  }

  var name = params.name;
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

    var videoUrl = '/.netlify/functions/video-status?download=' + encodeURIComponent(uri);
    return { statusCode: 200, body: JSON.stringify({ done: true, videoUrl: videoUrl }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'status_check_failed' }) };
  }
};
