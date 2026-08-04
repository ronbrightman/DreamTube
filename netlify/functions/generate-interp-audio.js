// netlify/functions/generate-interp-audio.js
//
// Speaking Sage — Option D (docs/SPEAKING_SAGE_SPEC.md, tracker item
// for-product-build-speaking-sage-wave-fou-8uobuh, founder GO on "Option D"
// 2026-08-02/08-03). Per-reading voice track for the Interpreter's Chamber:
//
//   POST { dreamId, personaKey, text } -> 200 { operationName }
//
// `text` is the ALREADY-GENERATED reading (interpret-dream.js's own
// mode:"reading" output, already validated/safety-checked there) — this
// function narrates it, it never generates new copy of its own (spec §9:
// "TTS narrates what was already checked; it doesn't introduce new copy").
// `dreamId` is accepted but NOT used to look anything up server-side (this
// function has no access to js/store.js's localStorage-only dream records
// — the client already resolved the persona/text before calling this); it
// is passed through purely so a future server-side persistence layer has
// it available, and so this function's request shape matches every other
// dreamId-carrying call in this codebase. See interp-audio-status.js for
// the submit-then-poll pattern this kicks off (Netlify's own function
// timeout means this must never block on the model call itself — same
// reasoning as transcribe-audio.js's own header comment).
//
// Model: fal-ai/kokoro/american-english (confirmed against fal's own model
// API docs at build time — request body is { prompt, voice, speed },
// response is { audio: { url, content_type, ... } }, same `file.url` shape
// this codebase already reads off video-status.js's `resultData.video.url`
// and transcribe-status.js's `resultData.text`). Founder-approved Option D
// casting: voice `am_onyx`, speed `0.8` (js/interpreter-personas.js's own
// `voiceId` field carries the voice id per persona; speed is fixed here,
// not yet a per-persona field — every persona reads at the same founder-
// approved pace this wave).
//
// Only the persona actually carrying a `voiceId` (currently: `talmudic`/
// The Sage — scope item 4, "sage persona first") can reach this function
// at all; every other persona is rejected with E505 (unknown_persona),
// same as if the persona didn't exist — js/interpret-experience.js never
// calls this for a persona with no voiceId, so this is defense-in-depth,
// not the only guard.
//
// Rate-limited under its OWN scope ("interp-audio-ip"), separate from
// interpret-ip (interpret-dream.js's text-generation bucket) — spec §7:
// "so a heavy day of text readings doesn't starve audio, and vice versa."
//
// Error codes (E5xx — following the E1xx/E2xx/E3xx/E4xx convention already
// used by generate-video.js/video-status.js/interpret-dream.js):
//   E501 method_not_allowed        — wrong HTTP verb
//   E502 missing_api_key           — FAL_KEY not configured (mock mode exempt, see below)
//   E503 invalid_json              — request body wasn't valid JSON
//   E504 text_required             — `text` missing/empty after trim
//   E505 unknown_persona           — personaKey missing, not a real persona key, or that
//                                     persona has no voiceId configured yet (spec: "tolerate
//                                     a missing asset, never block" — same as portraits)
//   E506 tts_request_failed        — fal rejected the submission, or a network/parse error occurred
//   E507 rate_limited              — MAX_INTERP_AUDIO_PER_IP_PER_DAY exceeded for today
//
// Mock mode (GENERATION_MOCK_MODE==="true", AGENT_POLICY.md's "keep
// generation-testing cost low" rule + docs/TESTING.md): skips the real
// fal.ai call entirely — same "true" (exact string) convention as
// generate-video.js, same reasoning (this is a dev/test-only escape
// hatch, never for production). Every guardrail above the mock branch
// (validation, rate limit) still runs unchanged. Returns a fake
// "mock:<startedAtMs>:<id>" operationName in the same shape the real path
// returns; interp-audio-status.js recognizes this prefix and resolves it
// to a real, small, stable sample audio clip after a short simulated
// delay, so the rest of the flow (polling, caption rendering, playback)
// gets exercised end-to-end at zero fal.ai cost.

var crypto = require('crypto');
var InterpreterPersonas = require('../../js/interpreter-personas');
var InterpAudioStatus = require('./interp-audio-status');
var rateLimit = require('./lib/rate-limit');

var FAL_API_BASE = 'https://queue.fal.run';
var FAL_SYNC_BASE = 'https://fal.run'; // synchronous execution — no scheduler, measured 1.3-1.4s for kokoro (probe 2026-08-04)
var FAL_MODEL = process.env.FAL_MODEL_INTERP_TTS || 'fal-ai/kokoro/american-english';
var FAL_MODEL_WHISPER = 'fal-ai/whisper'; // same model interp-audio-status.js aligns captions with
var SYNC_TTS_BUDGET_MS = 18000;    // real readings are 500-900 chars -> sync TTS can take 10-15s (founder hit the 12s abort on his first real-length reading, 08-04); 18s + capped whisper stays under Netlify's 26s ceiling
var SYNC_WHISPER_BUDGET_MS = 3500; // captions only — a blown budget degrades to sentence-level, never delays the voice (was 8000; live check 08-04 showed whisper eating the whole budget while the founder waits — the voice's own start time outranks word-level captions)
var READING_SPEED = 0.9; // founder-adjusted 08-04 ("slightly too slow" at 0.8 on his full walk); same for every persona

/** Fake but obviously-non-real operationName for GENERATION_MOCK_MODE — see doc block above and generate-video.js's own mockOperationName for the identical convention. */
function mockOperationName() {
  return 'mock:' + Date.now() + ':' + crypto.randomUUID();
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E501: method_not_allowed' }) };
  }

  var mockMode = process.env.GENERATION_MOCK_MODE === 'true';

  var falKey = process.env.FAL_KEY;
  if (!mockMode && !falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E502: missing_api_key' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E503: invalid_json' }) };
  }

  var text = (payload.text || '').trim();
  if (!text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E504: text_required' }) };
  }

  var persona = InterpreterPersonas.get(payload.personaKey);
  if (!persona || !persona.voiceId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E505: unknown_persona' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_INTERP_AUDIO_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'interp-audio-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E507: rate_limited: too many readings from this network today, try again tomorrow' }) };
  }

  if (mockMode) {
    return { statusCode: 200, body: JSON.stringify({ operationName: mockOperationName() }) };
  }

  // ── Sync-first (founder-directed, 2026-08-04, tracker cbdj3d) ──
  // The queue path measured 30s–35min of pure scheduler wait for a ~1.5s
  // TTS job (probe: sync fal.run answered in 1317/1427ms wall-clock).
  // So: call the SYNCHRONOUS endpoint and hand the client a finished
  // result in one round trip — { done:true, audioUrl, captions… } — and
  // only fall back to the legacy queue submit (the { operationName }
  // shape interp-audio-status.js polls) if sync fails or times out.
  // Whisper word-alignment runs sync too, on a tight budget: captions are
  // an enhancement, never worth delaying the voice for (spec §4's own
  // degrade-to-sentence rule) — a blown whisper budget ships the audio
  // with captionsLevel:'sentence' immediately.
  var handlerT0 = Date.now();
  var ttsBody = JSON.stringify({ prompt: text, voice: persona.voiceId, speed: READING_SPEED });
  var authHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Key ' + falKey };

  var syncAudioUrl = null;
  try {
    var ttsCtl = new AbortController();
    var ttsTimer = setTimeout(function () { ttsCtl.abort(); }, SYNC_TTS_BUDGET_MS);
    var syncRes = await fetch(FAL_SYNC_BASE + '/' + FAL_MODEL, { method: 'POST', headers: authHeaders, body: ttsBody, signal: ttsCtl.signal });
    clearTimeout(ttsTimer);
    var syncData = await syncRes.json();
    if (syncRes.ok && syncData && syncData.audio && syncData.audio.url) {
      syncAudioUrl = syncData.audio.url;
    }
  } catch (e) { /* fall through to the queue path */ }

  if (syncAudioUrl) {
    var captions = null;
    // Skip whisper entirely when a long TTS already ate most of the wall
    // clock — the 26s function ceiling outranks word-level captions.
    var whisperBudget = (Date.now() - handlerT0) > 11000 ? 0 : SYNC_WHISPER_BUDGET_MS;
    try {
      if (!whisperBudget) throw new Error('skip_whisper_budget_spent');
      var wCtl = new AbortController();
      var wTimer = setTimeout(function () { wCtl.abort(); }, whisperBudget);
      var wRes = await fetch(FAL_SYNC_BASE + '/' + FAL_MODEL_WHISPER, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ audio_url: syncAudioUrl, task: 'transcribe', chunk_level: 'word' }),
        signal: wCtl.signal
      });
      clearTimeout(wTimer);
      var wData = await wRes.json();
      if (wRes.ok) captions = InterpAudioStatus.parseWordChunks(wData);
    } catch (e) { /* sentence-level fallback below */ }

    return {
      statusCode: 200,
      body: JSON.stringify(captions ? {
        done: true,
        audioUrl: syncAudioUrl,
        audioDurationMs: captions[captions.length - 1].endMs,
        captions: captions,
        captionsLevel: 'word'
      } : {
        done: true,
        audioUrl: syncAudioUrl,
        audioDurationMs: null,
        captions: [],
        captionsLevel: 'sentence',
        degradedReason: 'E508: caption_alignment_failed'
      })
    };
  }

  // Legacy queue fallback — unchanged contract, polled by interp-audio-status.js.
  try {
    var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL, { method: 'POST', headers: authHeaders, body: ttsBody });
    var data = await res.json();

    if (!res.ok) {
      var message = (data && (data.detail || data.error)) || 'tts_request_failed';
      return { statusCode: res.status, body: JSON.stringify({ error: 'E506: tts_request_failed: ' + (typeof message === 'string' ? message : JSON.stringify(message)) }) };
    }

    return { statusCode: 200, body: JSON.stringify({ operationName: 'fal:' + FAL_MODEL + ':' + data.request_id }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E506: tts_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};

// Exported for test/generate-interp-audio.test.js's own assertions (same
// "export an internal for testability" precedent as generate-video.js's
// FAL_MODEL/buildPrompt exports).
exports.FAL_MODEL = FAL_MODEL;
exports.READING_SPEED = READING_SPEED;
