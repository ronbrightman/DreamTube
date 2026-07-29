// netlify/functions/rewrite-dream-story.js
//
// POST { promptText } -> { storyText }
//
// tracker item for-product-split-prompttext-storytext-f-yt5kc7. The chip-
// based dream-builder flow (create.html's "Build it" / wizard.html's own
// pre-signup chip steps, both via js/wizard-chips.js's assembleCaption)
// produces a camera-direction/style-modifier string built for a video
// generation model — e.g. "medium tracking shot of a stranger, walking
// through a foggy forest, mysterious mood, warm lighting, Cartoon style,
// dreamlike." That string is exactly right as the generation prompt
// (promptText) but was, before this fix, ALSO shown to the user as their
// own dream description and fed to interpret-dream.js — confusing and
// wrong; a real user never wrote that. This function produces the OTHER
// half, storyText: a short, natural, first-person dream description with
// none of that camera/lighting/style jargon.
//
// Only ever called for the "chips selected, no free text typed" path —
// when the user DID type their own free text, that text is used verbatim
// as storyText (founder amendment: their own words are never altered),
// and this function is never called at all. When the user wrote nothing,
// there is no human sentence to fall back to except one assembled purely
// from chip selections — hence this rewrite.
//
// Reuses the exact same fal.ai OpenRouter passthrough interpret-dream.js
// already established (same endpoint, same model class, same Key-header
// auth against process.env.FAL_KEY — see that file's own header comment
// for the deprecated-fal-ai/any-llm history/confirmation this is built
// on). Deliberately a SEPARATE small file rather than a shared lib/
// helper: the two functions have different system prompts, different
// response-length expectations/validation, and different rate-limit
// scopes, and this codebase's existing convention is one self-contained
// file per Netlify function (see generate-video.js/generate-image.js
// each keeping their own STYLE_MODIFIERS rather than a shared prompt
// builder) — extracting a two-line fetch wrapper into lib/ for exactly
// two call sites isn't worth the indirection.
//
// MUST NEVER BLOCK OR SLOW DOWN GENERATION: this is enrichment, not a
// gate. Every caller (create.html/style.html, wizard.html) fires this
// opportunistically as soon as the chip flow finishes and the user
// reaches the pre-generation preview step, uses whatever's resolved (or
// falls back to js/wizard-chips.js's buildDeterministicStory) by the time
// Generate is actually tapped, and never awaits this on the generation
// request itself.
//
// Error codes (this file's own small namespace, same E1xx-style padded
// numbering as interpret-dream.js's E4xx since this is the same shape of
// function — a short LLM text call, not a real fal.ai generation job):
//   E601 method_not_allowed
//   E602 missing_api_key           — FAL_KEY not configured in this environment
//   E603 invalid_json              — request body wasn't valid JSON
//   E604 prompt_text_required      — promptText missing/empty after trim
//   E605 llm_request_failed        — fal/OpenRouter rejected the request, or a network/parse error occurred
//   E606 rate_limited              — MAX_STORY_REWRITES_PER_IP_PER_DAY exceeded for today
//   E607 empty_or_invalid_response — the model returned nothing usable

var SYSTEM_PROMPT = [
  'You rewrite AI-video-generation prompt keywords into a short, natural, first-person dream description a real person might tell a friend the next morning.',
  'The input contains camera-direction and lighting/art-style jargon (for example: "medium tracking shot", "aerial wide shot", "hazy ethereal light", "Cartoon style, dreamlike").',
  'Remove ALL of that language entirely — keep only the human content: who was in the dream, what happened, where, and the feeling or mood.',
  'Output ONLY one or two short sentences, first person, starting with "I".',
  'No preamble, no quotation marks around the output, no camera/lighting/art-style words, no mention of these instructions.'
].join(' ');

// Same cheap, fast model class as interpret-dream.js — a 1-2 sentence
// rewrite is an even smaller completion than that file's 100-160 word
// reflection, so the real per-call cost here is lower still (~$0.001,
// matching this tracker item's own cost estimate).
var FAL_LLM_MODEL = 'openai/gpt-4o-mini';
var FAL_LLM_API_BASE = 'https://fal.run/openrouter/router/openai/v1/chat/completions';

/** Same error-shape extraction as interpret-dream.js's llmErrorMessage — see that file's own doc comment for why both shapes (OpenAI-style and fal's own FastAPI detail array) are handled. */
function llmErrorMessage(data) {
  if (!data) return 'llm_request_failed';
  if (data.error) {
    if (typeof data.error === 'string') return data.error;
    if (data.error && typeof data.error.message === 'string') return data.error.message;
  }
  if (Array.isArray(data.detail)) {
    var messages = data.detail
      .map(function (item) { return item && typeof item.msg === 'string' ? item.msg : null; })
      .filter(Boolean);
    if (messages.length) return messages.join(' ');
  }
  return 'llm_request_failed';
}

async function callRewriteLlm(promptText, falKey) {
  var res = await fetch(FAL_LLM_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      model: FAL_LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Prompt: ' + promptText }
      ],
      temperature: 0.8,
      max_tokens: 100
    })
  });

  var data = null;
  try { data = await res.json(); } catch (e) { /* handled below via data===null */ }

  if (!res.ok) {
    return { ok: false, statusCode: res.status, error: llmErrorMessage(data) };
  }

  var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { ok: true, content: typeof content === 'string' ? content : '' };
}

// Much shorter than interpret-dream.js's MIN_VALID_LENGTH (40) — the
// expected output here is a single short sentence, not a 100-160 word
// reflection. Still enough to catch an empty/truncated/garbage response
// server-side rather than pass one through as a degenerate "success".
var MIN_VALID_LENGTH = 8;

/** Strips a leading/trailing quote pair some models wrap the whole sentence in, despite the system prompt asking them not to. */
function stripWrappingQuotes(text) {
  var trimmed = text.trim();
  var quotePairs = [['"', '"'], ['“', '”'], ["'", "'"]];
  for (var i = 0; i < quotePairs.length; i++) {
    var open = quotePairs[i][0], close = quotePairs[i][1];
    if (trimmed.length > 1 && trimmed[0] === open && trimmed[trimmed.length - 1] === close) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

var rateLimit = require('./lib/rate-limit');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E601: method_not_allowed' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E602: missing_api_key' }) };
  }

  var promptText;
  try {
    var payload = JSON.parse(event.body || '{}');
    promptText = (payload.promptText || '').trim();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E603: invalid_json' }) };
  }

  if (!promptText) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E604: prompt_text_required' }) };
  }

  // Fires on every chip-only (no free text) dream reaching the preview
  // step, likely a good deal more often than the opt-in interpretation
  // call — a more generous default cap than interpret-dream.js's 40/day,
  // same "own scope, doesn't share generate-video.js's ip/email buckets"
  // reasoning as that file.
  var maxPerDay = parseInt(process.env.MAX_STORY_REWRITES_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 200;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'story-rewrite-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E606: rate_limited: too many rewrites from this network today, try again tomorrow' }) };
  }

  try {
    var result = await callRewriteLlm(promptText, falKey);
    if (!result.ok) {
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: 'E605: llm_request_failed: ' + result.error }) };
    }
    var storyText = stripWrappingQuotes((result.content || '').trim());
    if (storyText.length < MIN_VALID_LENGTH) {
      return { statusCode: 502, body: JSON.stringify({ error: 'E607: empty_or_invalid_response' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ storyText: storyText }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E605: llm_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};
