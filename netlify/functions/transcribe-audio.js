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
//
// PRE-SIGNUP ABUSE/COST GUARD (funnel Record-before-signup, 2026-08-08):
// this endpoint has ALWAYS been account-less — it requires only the
// server-side FAL_KEY, never a session/auth/account — so today it's already
// reachable by anyone who POSTs to it. It stayed effectively private only
// because the sole callers (create.html/result.html) sit behind the app's
// auth guard. The growth funnel's Record-it path now calls it BEFORE signup
// (so a recorded dream reaches recap+wall like Build/Write instead of
// hitting the email wall first), which turns it into a genuinely public,
// fal.ai-cost-incurring pre-signup surface reachable by cold paid traffic.
// So it gets the same shape of guard start-pending-generation.js already
// carries: a per-IP daily rate limit (its OWN 'transcribe' scope, separate
// from the generation quota — Whisper is far cheaper than a video, so it
// gets its own, more generous bucket) plus a hard base64 payload-size cap
// (a few minutes of speech is well under this; it exists to stop someone
// posting a huge blob to run up Whisper cost). Both are best-effort/fail-
// open on infra errors: they defend against casual/scripted hammering, not
// as a hard security boundary — the fal-side spend is the real backstop —
// and must never block a legitimate short recording. No new secrets, no new
// endpoint: this hardens the surface that already existed.

var rateLimit = require('./lib/rate-limit');

var FAL_API_BASE = 'https://queue.fal.run';
var FAL_MODEL = 'fal-ai/whisper';

// Max base64 length of the audio payload. base64 is ~4/3 the byte size, so
// ~7M chars ≈ ~5.2MB of encoded audio — several minutes of webm/opus speech,
// comfortably above any real dream description, and itself under Netlify's
// own ~6MB request-body ceiling (so this is the effective, explicit limit
// rather than an opaque platform 413). Env-overridable.
var MAX_AUDIO_BASE64_CHARS = parseInt(process.env.MAX_TRANSCRIBE_AUDIO_BASE64_CHARS, 10) || 7000000;

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

  if (typeof audio !== 'string' || audio.length > MAX_AUDIO_BASE64_CHARS) {
    return { statusCode: 413, body: JSON.stringify({ error: 'audio_too_large' }) };
  }

  // Per-IP daily cap, best-effort. Its own 'transcribe' scope (never the
  // generation quota) so a re-record on the funnel or the logged-in create
  // flow never eats into a user's video/image budget. Fail-open: any Blobs
  // error here must not block a real transcription — the fal-side spend cap
  // is the hard backstop.
  var maxPerDay = parseInt(process.env.MAX_TRANSCRIPTIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 60;
  try {
    var ip = rateLimit.clientIp(event);
    var ipLimit = await rateLimit.checkAndIncrement(event, 'transcribe', ip, maxPerDay);
    if (!ipLimit.allowed) {
      return { statusCode: 429, body: JSON.stringify({ error: 'rate_limited' }) };
    }
  } catch (e) {
    console.warn('transcribe-audio: rate-limit check failed, allowing (fail-open): ' + (e && e.message));
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
