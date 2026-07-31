// netlify/functions/realign-dream-prompt.js
//
// POST { promptText, storyText, deltaText } -> { promptText, storyText }
//
// New Netlify function for tracker item
// for-product-new-edit-mechanism-founder-i-qmsdgj / docs/EDIT_MECHANISM_SPEC.md
// §3.4. Powers result.html's new default edit sheet ("What would you like to
// change?"): given a dream's CURRENT engineered prompt (promptText) and its
// CURRENT human-readable description (storyText), plus a plain-text CHANGE
// the user wants, this returns an UPDATED promptText/storyText pair that
// applies ONLY the requested change and leaves everything else (setting,
// subject, mood, camera style, time of day, etc.) exactly as it was.
//
// Built on rewrite-dream-story.js's exact existing LLM-call pattern (same
// model, same fal.ai OpenRouter passthrough, same Key-header auth, same
// error-shape extraction, same per-IP daily rate-limit convention) — no new
// vendor, no new auth scheme. Deliberately its OWN small file rather than a
// shared helper, matching this codebase's established one-file-per-function
// convention (see rewrite-dream-story.js's own header comment for why) —
// this function's system prompt, response shape (JSON with two fields
// instead of one plain sentence), and validation are all different enough
// from that file's single-string rewrite to not be worth sharing.
//
// System prompt, user-message template, and parameters (temperature 0.5,
// max_tokens 200) are specified VERBATIM in docs/EDIT_MECHANISM_SPEC.md
// §3.4 — used exactly as given there, already worked out and reviewed, not
// improvised here.
//
// MUST NEVER BLOCK THE USER: a realignment failure (LLM error, malformed/
// truncated JSON response, missing fields) is NOT fatal to the edit flow —
// result.html's own edge-case handling (docs/EDIT_MECHANISM_SPEC.md §3.3)
// falls back to a naive concatenation merge (`promptText + ". " + delta`)
// client-side when this endpoint returns a non-200, rather than blocking
// the user. No token is spent at this point either way (this call happens
// BEFORE the confirm-and-generate step — see Direction B in the spec).
//
// Error codes (this file's own small E7xx namespace — E1xx=generate-video,
// E4xx=interpret-dream, E6xx=rewrite-dream-story, all in this same "a
// short LLM text call, not a real fal.ai generation job" shape; E7xx was
// unused before this file):
//   E701 method_not_allowed
//   E702 missing_api_key           — FAL_KEY not configured in this environment
//   E703 invalid_json              — request body wasn't valid JSON
//   E704 fields_required           — promptText, storyText, or deltaText missing/empty after trim
//   E705 llm_request_failed        — fal/OpenRouter rejected the request, or a network/parse error occurred
//   E706 rate_limited              — MAX_REALIGNS_PER_IP_PER_DAY exceeded for today
//   E707 empty_or_invalid_response — the model's response wasn't valid JSON, or was missing/too-short fields

var SYSTEM_PROMPT = [
  'You edit an AI-video-generation prompt based on a user\'s requested change.',
  'You will be given the CURRENT prompt (a list of visual/technical keywords for a video model), the CURRENT story (a first-person, human-readable one-to-two sentence description of the same dream), and a CHANGE the user wants.',
  'Produce an UPDATED prompt and an UPDATED story that apply ONLY the requested change and leave every other detail — setting, subject, mood, camera style, time of day, and anything else not mentioned in the change — exactly as it was.',
  'Do not invent new details beyond what the change requires.',
  'Respond as JSON: {"promptText": "...", "storyText": "..."}.'
].join(' ');

// Same cheap, fast model class as rewrite-dream-story.js/interpret-dream.js —
// a constrained edit-merge task, if anything an even smaller completion than
// rewrite-dream-story.js's 1-2 sentence rewrite (see max_tokens below).
var FAL_LLM_MODEL = 'openai/gpt-4o-mini';
var FAL_LLM_API_BASE = 'https://fal.run/openrouter/router/openai/v1/chat/completions';

/** Same error-shape extraction as rewrite-dream-story.js/interpret-dream.js's llmErrorMessage — see either file's own doc comment for why both shapes (OpenAI-style and fal's own FastAPI detail array) are handled. */
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

async function callRealignLlm(promptText, storyText, deltaText, falKey) {
  var userMessage = 'Current prompt: ' + promptText + '\nCurrent story: ' + storyText + '\nChange: ' + deltaText;
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
        { role: 'user', content: userMessage }
      ],
      // Lower than rewrite-dream-story.js's 0.8 — this is a constrained
      // edit-merge task (apply exactly one change, hold everything else
      // stable), not a creative rewrite, so less sampling variance is
      // preferred (docs/EDIT_MECHANISM_SPEC.md §3.4, verbatim).
      temperature: 0.5,
      max_tokens: 200
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

// Deliberately short — this is a merge task, not free creative writing, so a
// degenerate/truncated response is still worth catching explicitly rather
// than passing through as a false "success".
var MIN_PROMPT_TEXT_LENGTH = 15;
var MIN_STORY_TEXT_LENGTH = 8;

/**
 * Some models wrap JSON responses in a ```json ... ``` fence despite being
 * asked for raw JSON — strip that before JSON.parse. Same defensive-parsing
 * spirit as rewrite-dream-story.js's stripWrappingQuotes, adapted for a JSON
 * payload instead of a plain quoted sentence.
 */
function stripCodeFence(text) {
  var trimmed = text.trim();
  var fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Parses the model's raw content into { promptText, storyText }, returning
 * null (never throwing) on anything that isn't a clean, sufficiently long
 * pair of strings — the caller treats null exactly like an upstream LLM
 * failure (E707), and result.html's own fallback (naive concatenation)
 * covers it either way.
 */
function parseRealignResponse(rawContent) {
  var cleaned = stripCodeFence(rawContent || '');
  if (!cleaned) return null;
  var parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  var promptText = typeof parsed.promptText === 'string' ? parsed.promptText.trim() : '';
  var storyText = typeof parsed.storyText === 'string' ? parsed.storyText.trim() : '';
  if (promptText.length < MIN_PROMPT_TEXT_LENGTH || storyText.length < MIN_STORY_TEXT_LENGTH) return null;
  return { promptText: promptText, storyText: storyText };
}

var rateLimit = require('./lib/rate-limit');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E701: method_not_allowed' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E702: missing_api_key' }) };
  }

  var promptText, storyText, deltaText;
  try {
    var payload = JSON.parse(event.body || '{}');
    promptText = (payload.promptText || '').trim();
    storyText = (payload.storyText || '').trim();
    deltaText = (payload.deltaText || '').trim();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E703: invalid_json' }) };
  }

  if (!promptText || !storyText || !deltaText) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E704: fields_required' }) };
  }

  // Fires on every edit-sheet submission (§3.2 step 6) — a more generous
  // default cap than interpret-dream.js's 40/day, matching rewrite-dream-
  // story.js's own "own scope, doesn't share generate-video.js's ip/email
  // buckets" reasoning.
  var maxPerDay = parseInt(process.env.MAX_REALIGNS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 200;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'dream-realign-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E706: rate_limited: too many edit requests from this network today, try again tomorrow' }) };
  }

  try {
    var result = await callRealignLlm(promptText, storyText, deltaText, falKey);
    if (!result.ok) {
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: 'E705: llm_request_failed: ' + result.error }) };
    }
    var parsed = parseRealignResponse(result.content);
    if (!parsed) {
      return { statusCode: 502, body: JSON.stringify({ error: 'E707: empty_or_invalid_response' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ promptText: parsed.promptText, storyText: parsed.storyText }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E705: llm_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};
