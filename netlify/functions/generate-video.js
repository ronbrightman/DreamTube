// netlify/functions/generate-video.js
//
// POST { caption, style } -> kicks off a Veo 3.1 Lite generation job and
// returns the operation name so the client can poll video-status.js.
// GEM_API_KEY is read from the Netlify environment; it never reaches the client.

var MODEL = 'veo-3.1-lite-generate-preview';
var API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

var STYLE_MODIFIERS = {
  Cartoon:   'in a colorful hand-drawn cartoon animation style',
  Cinematic: 'in a moody, cinematic film style with dramatic lighting',
  Anime:     'in a vibrant Japanese anime animation style',
  Realistic: 'in a photorealistic, lifelike rendering style'
};

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var apiKey = process.env.GEM_API_KEY;
  if (!apiKey) {
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
    var res = await fetch(API_BASE + '/models/' + MODEL + ':predictLongRunning', {
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
      return { statusCode: res.status, body: JSON.stringify({ error: message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ operationName: data.name }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'veo_request_failed' }) };
  }
};
