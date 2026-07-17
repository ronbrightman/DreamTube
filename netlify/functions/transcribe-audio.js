// netlify/functions/transcribe-audio.js
//
// POST { audio: base64, mimeType } -> { transcript }
// Sends the recorded dream audio to fal.ai's Whisper model and returns the
// transcribed text. Reuses FAL_KEY — same key already used for video
// generation, no separate signup.
//
// Previously used Gemini (gemini-3.5-flash), but that model was consistently
// returning 503 "high demand" errors (confirmed by direct testing, including
// on plain text-only calls with no audio involved) — an upstream Google
// availability issue, not something fixable in this function. Switched to
// fal.ai's Whisper, which is already proven reliable via the video pipeline.
//
// fal's audio_url data-URL parser validates the declared mime type against
// an internal whitelist that (confirmed by direct testing against this
// endpoint) rejects literal "audio/webm" and "audio/wav" labels with a 422
// "Unsupported data URL", while accepting "audio/mpeg" — but the actual
// decoding is content-sniffed from the real bytes regardless of the label
// (verified with both real WAV/PCM audio and a real webm/opus MediaRecorder
// blob, both transcribed correctly under the "audio/mpeg" label). So every
// recording is labeled "audio/mpeg" here regardless of what the browser
// actually recorded.

var FAL_API_BASE = 'https://fal.run';
var FAL_MODEL = 'fal-ai/whisper';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
  }

  var audio;
  try {
    var payload = JSON.parse(event.body || '{}');
    audio = payload.audio;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  if (!audio) {
    return { statusCode: 400, body: JSON.stringify({ error: 'audio_required' }) };
  }

  try {
    var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Key ' + falKey
      },
      body: JSON.stringify({
        audio_url: 'data:audio/mpeg;base64,' + audio,
        task: 'transcribe',
        chunk_level: 'none'
      })
    });

    var data = await res.json();

    if (!res.ok) {
      var message = (data && data.detail) || 'transcription_failed';
      return { statusCode: res.status, body: JSON.stringify({ error: typeof message === 'string' ? message : JSON.stringify(message) }) };
    }

    var transcript = data && data.text && data.text.trim();
    if (!transcript) {
      return { statusCode: 200, body: JSON.stringify({ error: 'no_speech_detected' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ transcript: transcript }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'transcription_failed' }) };
  }
};
