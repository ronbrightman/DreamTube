// netlify/functions/lib/fal-cost-categorize.js
//
// Pure endpoint_id -> cost-category classifier for the fal usage
// reconciliation job (tracker item for-product-real-per-job-fal-cost-
// loggin-360bxy). Categories match what that item calls out: app-video,
// app-image, creative — plus app-other, added here for the app's real
// non-video/non-image fal calls (LLM interpret/rewrite, Whisper
// transcription) so those don't get miscounted as "creative" spend.
//
// KNOWN APP ENDPOINTS (grepped directly from this repo's own
// netlify/functions/*.js — the actual model IDs every app-side fal call
// uses today, 2026-07-31):
//   video: generate-video.js — fal-ai/veo3.1/lite (default text-to-video,
//     env-overridable via FAL_MODEL_TEXT_TO_VIDEO — still always under the
//     'fal-ai/veo3.1' family), fal-ai/veo3.1/fast/reference-to-video,
//     fal-ai/veo3.1/fast/image-to-video, fal-ai/wan/v2.2-5b/text-to-video
//   image: generate-image.js — fal-ai/flux/dev; generate-avatar.js —
//     fal-ai/flux/schnell
//   other (real app cost, but neither video nor image generation):
//     interpret-dream.js/rewrite-dream-story.js call
//     https://fal.run/openrouter/router/openai/v1/chat/completions (see
//     both files' own header comments) — that URL has NO 'fal-ai/' segment
//     at all; 'openrouter/router' is fal's own distinct provider namespace
//     for its OpenRouter passthrough, confirmed against fal's public model
//     catalog page (fal.ai/models/openrouter/router/openai/v1/chat/
//     completions/api — page title and JS-client usage both show
//     fal.subscribe("openrouter/router/openai/v1/chat/completions"), with
//     sibling models under the same namespace at openrouter/router/openai/
//     v1/responses, openrouter/router/openai/v1/embeddings, and
//     openrouter/router/vision). An earlier version of this file guessed
//     'fal-ai/openrouter/' here, which never matches the real endpoint_id
//     fal reports for these calls — silently misclassifying real
//     interpret-dream/rewrite-dream-story spend as 'creative' instead of
//     'app-other'. transcribe-audio.js — fal-ai/whisper
//
// CREATIVE (growth's ad-creative generation): everything that does NOT
// match a known app prefix above. This is an ELIMINATION-based split, not
// a clean per-key one — tracker item for-product-separate-fal-api-key-for-
// the-bevwhn (a second, app-only fal key that would let usage split
// cleanly via fal's own api_key_id filter) is still open as of this build
// (checked its live tracker status before writing this: `done: false`,
// `waitingFor: "ron"`, no second key minted yet), so today the app and
// growth's creative production still share one fal account/key with no
// per-key attribution available. Elimination by endpoint_id is this
// build's best available approximation given that — every endpoint_id this
// app's own code is confirmed to call is excluded first; anything left
// over is presumed to be creative usage. If/when bevwhn ships a second key,
// the natural upgrade is to prefer a clean api_key_id-based split (via
// auth_method — see fal-usage-client.js's per-record shape) over this
// elimination logic, not to keep both.

var APP_VIDEO_PREFIXES = ['fal-ai/veo3.1', 'fal-ai/wan/'];
var APP_IMAGE_PREFIXES = ['fal-ai/flux/'];
var APP_OTHER_PREFIXES = ['fal-ai/whisper', 'openrouter/router/'];

var CATEGORIES = {
  APP_VIDEO: 'app-video',
  APP_IMAGE: 'app-image',
  APP_OTHER: 'app-other',
  CREATIVE: 'creative'
};

function startsWithAny(value, prefixes) {
  for (var i = 0; i < prefixes.length; i++) {
    if (value.indexOf(prefixes[i]) === 0) return true;
  }
  return false;
}

/**
 * Classifies one fal usage record's endpoint_id into one of CATEGORIES.
 * Falsy/non-string input classifies as 'creative' (fails toward the
 * approximate/elimination bucket rather than silently dropping the cost —
 * this reconciliation must never lose spend, only misattribute it).
 */
function categorizeEndpoint(endpointId) {
  if (typeof endpointId !== 'string' || !endpointId) return CATEGORIES.CREATIVE;
  if (startsWithAny(endpointId, APP_VIDEO_PREFIXES)) return CATEGORIES.APP_VIDEO;
  if (startsWithAny(endpointId, APP_IMAGE_PREFIXES)) return CATEGORIES.APP_IMAGE;
  if (startsWithAny(endpointId, APP_OTHER_PREFIXES)) return CATEGORIES.APP_OTHER;
  return CATEGORIES.CREATIVE;
}

module.exports = { categorizeEndpoint: categorizeEndpoint, CATEGORIES: CATEGORIES };
