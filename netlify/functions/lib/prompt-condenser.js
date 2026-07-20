// netlify/functions/lib/prompt-condenser.js
//
// Shared helper used by generate-video.js: condenses text that's too long
// to plausibly play out within a single fal.ai Veo clip's fixed duration
// (currently always capped at 8s — see generate-video.js's
// resolveDuration/VALID_TEST_DURATIONS) down to its strongest visual
// moment, via one cheap Gemini text call. Without this, a long dream
// description just gets cut off mid-narrative — the model renders as far
// as it gets in 8 seconds and stops, rather than covering the whole
// description.
//
// Built as a small, threshold-parameterized helper — not hardcoded to
// "the whole dream description" — specifically so the future scene-by-
// scene Advanced feature (each scene independently capped at ~8s) can
// call condenseIfNeeded() once per scene instead of needing new
// condensing logic built from scratch at that point.
//
// DEFAULT_MAX_CHARS reasoning (a judgment call, not a measured constant —
// override via PROMPT_CONDENSE_THRESHOLD_CHARS if it needs tuning):
// a continuous ~8-second shot comfortably covers one clear scene/action
// plus at most a couple of short supporting beats. Empirically that's
// about 50-60 words of natural descriptive prose — roughly 300 characters
// at typical English word length (~5.5 characters/word). Longer than
// that, the source text is describing more distinct events than 8 seconds
// of continuous video can actually show, which is the root cause of the
// "runs out of time mid-narrative" bug this exists to fix — the model
// isn't malfunctioning, it's being asked to cover more ground than its
// runtime allows.
//
// Model choice: gemini-3.1-flash-lite, NOT gemini-2.5-flash-lite (the
// cheaper option) — that model is scheduled to shut down 2026-10-16
// (confirmed via ai.google.dev/gemini-api/docs/pricing, checked
// 2026-07-20), and this call is meant to be a durable part of the app,
// not a one-off test, so it targets a model that won't need a follow-up
// migration in a few months. Still extremely cheap for this use — a few
// hundred tokens per call against $0.25/$1.50 per 1M tokens (input/
// output), well under a hundredth of a cent per condense, negligible
// next to the ~$0.80-1.60 already spent per video generation.
//
// Request/response shape confirmed against ai.google.dev/api/generate-content
// (2026-07-20), not assumed from memory.

var CONDENSE_MODEL = 'gemini-3.1-flash-lite';
var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
var DEFAULT_MAX_CHARS = 300;

var CONDENSE_SYSTEM_PROMPT = [
  'You condense a dream description down to the single strongest visual moment it describes, for a video generator with a hard ~8-second clip length.',
  "Keep it as one continuous, concrete, filmable scene or action — not a summary of the whole narrative, and not a list of everything that happened.",
  "Preserve the most vivid, specific visual details (setting, key objects, what's actually happening) from the original — prefer the imagery a director would actually shoot over abstract description.",
  'Write 1-2 short sentences, plain prose, no preamble, no quotation marks, no meta-commentary about the task.',
  'Never mention that this is a condensed or shortened version.'
].join(' ');

/**
 * @param {string} text - raw text that may need condensing (a dream
 *   caption today; a single scene's text once the scene-by-scene feature
 *   exists).
 * @param {string} apiKey - GEM_API_KEY.
 * @param {number} [maxChars] - length threshold in characters; defaults
 *   to DEFAULT_MAX_CHARS (itself overridable via the
 *   PROMPT_CONDENSE_THRESHOLD_CHARS env var), or pass an explicit value
 *   (e.g. a future per-scene budget that differs from the whole-
 *   description default).
 * @returns {Promise<{text: string, wasCondensed: boolean, error: string|null}>}
 *   On any failure (missing key, network error, empty/invalid response),
 *   falls back to the ORIGINAL text with wasCondensed:false and `error`
 *   set — a failed condense call must never block generation outright,
 *   it just means the original (long) text goes through unmodified, the
 *   same as if it had been short enough already. Callers use
 *   `wasCondensed` (not `error`) to decide anything downstream — e.g.
 *   generate-video.js only disables narration when text was actually
 *   replaced, since the original text is always honest to narrate,
 *   condensed or not attempted.
 */
async function condenseIfNeeded(text, apiKey, maxChars) {
  var threshold = maxChars || parseInt(process.env.PROMPT_CONDENSE_THRESHOLD_CHARS, 10) || DEFAULT_MAX_CHARS;
  var trimmed = (text || '').trim();

  if (trimmed.length <= threshold) {
    return { text: trimmed, wasCondensed: false, error: null };
  }
  if (!apiKey) {
    return { text: trimmed, wasCondensed: false, error: 'missing_api_key' };
  }

  try {
    var res = await fetch(
      GEMINI_API_BASE + '/models/' + CONDENSE_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: { text: CONDENSE_SYSTEM_PROMPT } },
          contents: [{ role: 'user', parts: [{ text: trimmed }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 150 }
        })
      }
    );

    var data = null;
    try { data = await res.json(); } catch (e) { /* handled below via data===null */ }

    if (!res.ok) {
      var message = (data && data.error && data.error.message) || 'condense_request_failed';
      return { text: trimmed, wasCondensed: false, error: message };
    }

    var candidate = data && data.candidates && data.candidates[0];
    var parts = candidate && candidate.content && candidate.content.parts;
    var condensed = (parts && parts[0] && parts[0].text) || '';
    condensed = condensed.trim();

    if (!condensed) {
      return { text: trimmed, wasCondensed: false, error: 'empty_condense_response' };
    }
    return { text: condensed, wasCondensed: true, error: null };
  } catch (e) {
    return { text: trimmed, wasCondensed: false, error: 'condense_network_error' + (e && e.message ? ': ' + e.message : '') };
  }
}

module.exports = { condenseIfNeeded: condenseIfNeeded, DEFAULT_MAX_CHARS: DEFAULT_MAX_CHARS };
