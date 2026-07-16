// netlify/functions/transcribe-audio.js
//
// POST { audio: base64, mimeType } -> { transcript }
// Sends the recorded dream audio to Gemini's generateContent endpoint as
// inline data and returns the transcribed text. Reuses GEM_API_KEY — no
// separate signup, same key already used by the unused Veo fallback path.

var MODEL = 'gemini-3.5-flash';
var API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var apiKey = process.env.GEM_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
  }

  var audio, mimeType;
  try {
    var payload = JSON.parse(event.body || '{}');
    audio = payload.audio;
    mimeType = payload.mimeType || 'audio/ogg';
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  if (!audio) {
    return { statusCode: 400, body: JSON.stringify({ error: 'audio_required' }) };
  }

  try {
    var res = await fetch(API_BASE + '/models/' + MODEL + ':generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Transcribe this audio recording verbatim. Return only the spoken words as plain text — no quotation marks, timestamps, speaker labels, or commentary. If nothing intelligible was said, return an empty string.' },
            { inlineData: { mimeType: mimeType, data: audio } }
          ]
        }]
      })
    });

    var data = await res.json();

    if (!res.ok) {
      var message = (data && data.error && data.error.message) || 'transcription_failed';
      return { statusCode: res.status, body: JSON.stringify({ error: message }) };
    }

    var candidate = data.candidates && data.candidates[0];
    var transcript = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;

    if (!transcript || !transcript.trim()) {
      return { statusCode: 200, body: JSON.stringify({ error: 'no_speech_detected' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ transcript: transcript.trim() }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'transcription_failed' }) };
  }
};
