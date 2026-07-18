// netlify/functions/generate-video.js
//
// POST { caption, style, characters? } -> kicks off a video generation job
// and returns an operationName the client can poll via video-status.js.
//
// characters (optional) is [{ name, description, isSelf }] — the user's
// selected Advanced characters, resolved client-side from their private
// character list (see js/store.js's resolveCharacters). Their descriptions
// are folded into the prompt sent to the model (see buildPrompt) but never
// echoed back — the caption the UI displays is whatever the caller passed
// in and this function never alters or returns it.
//
// ACTIVE PATH: fal.ai's Veo 3.1 Fast (fal-ai/veo3.1/fast), using FAL_KEY.
// Switched from fal.ai's wan v2.2-5b because its output quality wasn't good
// enough. Veo 3.1 is the same Google model originally used via direct Google
// API calls (see callVeoDirect below) — now reached through fal.ai instead,
// which sidesteps the Google Cloud quota wall that caused the original
// switch away from it. "/fast" is the cost/quality middle tier (roughly
// $0.10-0.20/sec) — plain "veo3.1" (no /fast) costs roughly double for
// higher quality, use only if explicitly requested.
// The wan v2.2-5b path is kept below (callFalWan), unused, in case we want
// to switch back or use it as a cheaper fallback later.

var STYLE_MODIFIERS = {
  Cartoon:   'in a colorful hand-drawn cartoon animation style',
  Cinematic: 'in a moody, cinematic film style with dramatic lighting',
  Anime:     'in a vibrant Japanese anime animation style',
  Realistic: 'in a photorealistic, lifelike rendering style'
};

/**
 * Combines the plain caption with style + character enrichment into the
 * prompt actually sent to the video model. This is provider-only
 * enrichment — the caption the UI shows the user is never touched here.
 */
function buildPrompt(caption, style, characters) {
  var modifier = STYLE_MODIFIERS[style] || ('in a ' + style + ' animation style');
  var parts = [caption];

  var validCharacters = (characters || []).filter(function (c) {
    return c && typeof c.description === 'string' && c.description.trim();
  });
  if (validCharacters.length) {
    var charText = validCharacters.map(function (c) {
      var who = c.isSelf ? 'the dreamer ("me")' : ((c.name || '').trim() || 'a character');
      return who + ': ' + c.description.trim();
    }).join('; ');
    parts.push('Characters — ' + charText);
  }

  parts.push(modifier);
  return parts.join(', ') + '.';
}

var FAL_MODEL = 'fal-ai/veo3.1/fast';
var FAL_API_BASE = 'https://queue.fal.run';

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
      duration: '8s',
      resolution: '720p'
    })
  });

  var data = await res.json();

  if (!res.ok) {
    var message = (data && data.detail) || (data && data.error) || 'fal_request_failed';
    return { ok: false, statusCode: res.status, error: typeof message === 'string' ? message : JSON.stringify(message) };
  }

  return { ok: true, operationName: 'fal:' + FAL_MODEL + ':' + data.request_id };
}

// Unused fallback path — the previous active integration, fal.ai's wan
// v2.2-5b. num_frames maxes out at 161, so 161 frames @ 23fps gives an exact
// 7.0s video if this is ever switched back to.
var FAL_MODEL_WAN = 'fal-ai/wan/v2.2-5b/text-to-video';
async function callFalWan(prompt, falKey) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL_WAN, {
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

  return { ok: true, operationName: 'fal:' + FAL_MODEL_WAN + ':' + data.request_id };
}

/** Unused fallback path — the original direct Veo 3.1 Lite integration via the Gemini API. */
var VEO_MODEL = 'veo-3.1-lite-generate-preview';
var VEO_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function callVeoDirect(prompt, apiKey) {
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

  var caption, style, characters;
  try {
    var payload = JSON.parse(event.body || '{}');
    caption = (payload.caption || '').trim();
    style = (payload.style || '').trim();
    characters = Array.isArray(payload.characters) ? payload.characters : [];
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  if (!caption || !style) {
    return { statusCode: 400, body: JSON.stringify({ error: 'caption_and_style_required' }) };
  }

  var prompt = buildPrompt(caption, style, characters);

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
