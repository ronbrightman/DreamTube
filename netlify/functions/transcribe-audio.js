// netlify/functions/transcribe-audio.js
//
// POST { audio: base64, mimeType } -> { operationName } the client polls via
// transcribe-status.js.
//
// Previously called fal.ai's synchronous Whisper endpoint (fal.run) directly
// and blocked until it returned. That worked for short test clips, but real
// recordings hit real 504 "Inactivity Timeout" errors from Netlify's own
// gateway — confirmed by testing: fal's queue metrics showed the actual
// transcription (inference_time) completing in well under a second, but the
// job sat IN_QUEUE for 60+ seconds first waiting for a worker. A synchronous
// call has no way to survive that queue wait once it exceeds Netlify's
// function timeout (10s on this plan). Switched to the same submit-then-poll
// pattern already used for video generation (generate-video.js/
// video-status.js) — each individual call here is fast (just a queue
// submission), so no single request can ever trip the gateway timeout, no
// matter how long fal's queue takes to actually start the job.
//
// fal's audio_url data-URL parser validates the declared mime type against
// an internal whitelist that (confirmed by direct testing against this
// endpoint) rejects literal "audio/webm" and "audio/wav" labels with a 422
// "Unsupported data URL", while accepting "audio/mpeg" — but the actual
// decoding is content-sniffed from the real bytes regardless of the label
// (verified with real WAV/PCM audio, a real webm/opus MediaRecorder blob,
// and real recorded speech, all transcribed correctly under the "audio/mpeg"
// label). So every recording is labeled "audio/mpeg" here regardless of
// what the browser actually recorded.

var FAL_API_BASE = 'https://queue.fal.run';
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

    return { statusCode: 200, body: JSON.stringify({ operationName: 'fal:' + FAL_MODEL + ':' + data.request_id }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'transcription_failed' }) };
  }
};
