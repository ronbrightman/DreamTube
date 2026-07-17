// netlify/functions/generate-video.js
//
// POST { caption, style } -> kicks off a video generation job and returns an
// operationName the client can poll via video-status.js.
//
// ACTIVE PATH: fal.ai (fal-ai/wan/v2.2-5b/text-to-video), using FAL_KEY.
// Switched from calling Google's Veo API directly because the Google Cloud
// project hit a 2 RPM quota that wouldn't meaningfully increase for 30 days.
// The original Veo/Gemini path is kept below (callVeo), unused, in case we
// want to switch back or use it as a fallback later — see callVeo/GEM_API_KEY.

var STYLE_MODIFIERS = {
  Cartoon:   'in a colorful hand-drawn cartoon animation style',
  Cinematic: 'in a moody, cinematic film style with dramatic lighting',
  Anime:     'in a vibrant Japanese anime animation style',
  Realistic: 'in a photorealistic, lifelike rendering style'
};

var FAL_MODEL = 'fal-ai/wan/v2.2-5b/text-to-video';
var FAL_API_BASE = 'https://queue.fal.run';

// wan v2.2-5b's defaults (81 frames @ 24fps = ~3.4s) were producing clips far
// shorter than intended. num_frames maxes out at 161, so 161 frames @ 23fps
// gives an exact 7.0s video — comfortably inside the target 6-8s range.
/** Active path. Submits a fal.ai queue job and returns "fal:<model>:<request_id>". */
async function callFal(prompt, falKey) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      prompt: prompt,
      aspect_ratio: '9:16',
      num_frames: 161,
      frames_per_second: 23
    })
  });

  var data = await res.json();

  if (!res.ok) {
    var message = (data && data.detail) || (data && data.error) || 'fal_request_failed';
    return { ok: false, statusCode: res.status, error: typeof message === 'string' ? message : JSON.stringify(message) };
  }

  return { ok: true, operationName: 'fal:' + FAL_MODEL + ':' + data.request_id };
}

/** Unused fallback path — the original direct Veo 3.1 Lite integration via the Gemini API. */
var VEO_MODEL = 'veo-3.1-lite-generate-preview';
var VEO_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function callVeo(prompt, apiKey) {
  var res = await fetch(VEO_API_BASE + '/models/' + VEO_MODEL + ':predictLongRunning', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      instances: [{ prompt: prompt }],
      parameters: {
        aspectRatio: '9:16',
        durationSeconds: 8
      }
    })
  });

  var data = await res.json();

  if (!res.ok) {
    var message = (data && data.error && data.error.message) || 'veo_request_failed';
    return { ok: false, statusCode: res.status, error: message };
  }

  return { ok: true, operationName: data.name };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
  }

  var caption, style;
  try {
    var payload = JSON.parse(event.body || '{}');
    caption = (payload.caption || '').trim();
    style = (payload.style || '').trim();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  if (!caption || !style) {
    return { statusCode: 400, body: JSON.stringify({ error: 'caption_and_style_required' }) };
  }

  var modifier = STYLE_MODIFIERS[style] || ('in a ' + style + ' animation style');
  var prompt = caption + ', ' + modifier + '.';

  try {
    var result = await callFal(prompt, falKey);
    if (!result.ok) {
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: result.error }) };
    }
    return { statusCode: 200, body: JSON.stringify({ operationName: result.operationName }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'fal_request_failed' }) };
  }
};
