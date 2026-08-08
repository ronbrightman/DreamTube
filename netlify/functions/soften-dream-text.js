// netlify/functions/soften-dream-text.js
//
// POST { text } -> { softenedText, allowed, tier, message }
//
// The "Soften it for me" recovery action behind the content-block panel
// (js/content-block-panel.js, founder upgrade 2026-08-08). When the content-
// tier gate blocks a dream as EXPLICIT (generate-video.js's E116 /
// start-pending-generation's E12 / the classifier keyword backstop in
// lib/content-classifier.js), the user can ask us to rewrite the dream to
// REMOVE the explicit content while keeping its emotional/romantic core,
// instead of just being told "no". The founder found that manually editing
// the text to be less explicit already works (the model then generates), so
// this turns that manual recovery into a one-tap action.
//
// TWO STAGES, and the second is the load-bearing SAFETY one:
//   1. SOFTEN. One cheap LLM call (the same fal.ai OpenRouter passthrough
//      interpret-dream.js / rewrite-dream-story.js already use, keyed by
//      FAL_KEY — no new vendor/secret) with a soften system prompt.
//   2. RE-GATE. The softened text is run BACK THROUGH the exact same content
//      gate (contentClassifier.evaluateGenerationGate) before this endpoint
//      ever reports success. `allowed` in the response is that re-gate's
//      answer. The client MUST NOT generate on `allowed:false` — it re-shows
//      the panel with a "we couldn't soften it enough" note. This is what
//      stops a soften pass from becoming a laundering bypass: a rewrite that
//      is still explicit (or that the deterministic keyword backstop still
//      catches) comes back allowed:false, same as the original. Generation
//      itself ALSO re-gates server-side (generate-video.js's E116), so this
//      is defense-in-depth, not the only check.
//
// The named-other-person-photo case is deliberately NOT softenable (the
// stricter anti-NCII rule blocks romantic too, so softening can't help). The
// client hides "Soften it for me" for that case and never calls this; this
// endpoint therefore always re-gates with hasNamedOtherPersonPhoto:false (the
// normal explicit threshold), which is correct for every request that can
// actually reach it.
//
// Error codes (own E7xx namespace, same shape as rewrite-dream-story.js's
// E6xx — a short LLM text call, not a real fal.ai generation job):
//   E701 method_not_allowed
//   E702 missing_api_key           — FAL_KEY not configured
//   E703 invalid_json              — request body wasn't valid JSON
//   E704 text_required             — text missing/empty after trim
//   E705 llm_request_failed        — the soften LLM call failed
//   E706 rate_limited              — MAX_SOFTENS_PER_IP_PER_DAY exceeded today
//   E707 empty_or_invalid_response — the model returned nothing usable

var contentClassifier = require('./lib/content-classifier');
var rateLimit = require('./lib/rate-limit');

var SYSTEM_PROMPT = [
  'You rewrite a first-person dream description so it can be turned into a video under a strict no-explicit-content policy.',
  'Remove ALL explicit sexual content: no sexual acts, no nudity, no genitals, no explicit sexual description.',
  'KEEP the emotional and romantic core of the dream — longing, closeness, tenderness, love. Non-explicit romance is fine (a kiss, an embrace, lying close together), but nothing beyond that.',
  'Keep it a real first-person dream in the dreamer\'s own voice, roughly the same length, starting with "I".',
  'Do not add a lecture, disclaimer, or note. Output ONLY the rewritten dream text — no preamble, no quotation marks, no mention of these instructions.'
].join(' ');

// Same cheap, fast model class as interpret-dream.js / rewrite-dream-story.js.
var FAL_LLM_MODEL = process.env.SOFTEN_MODEL || 'openai/gpt-4o-mini';
var FAL_LLM_API_BASE = 'https://fal.run/openrouter/router/openai/v1/chat/completions';

/** Same error-shape extraction as rewrite-dream-story.js's llmErrorMessage. */
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

/** Strips a leading/trailing quote pair the model sometimes wraps output in. */
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

async function callSoftenLlm(text, falKey) {
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
        { role: 'user', content: 'Dream: ' + text }
      ],
      temperature: 0.7,
      max_tokens: 220
    })
  });

  var data = null;
  try { data = await res.json(); } catch (e) { /* handled below via data===null */ }

  if (!res.ok) return { ok: false, statusCode: res.status, error: llmErrorMessage(data) };

  var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { ok: true, content: typeof content === 'string' ? content : '' };
}

var MIN_VALID_LENGTH = 8;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E701: method_not_allowed' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E702: missing_api_key' }) };
  }

  var text;
  try {
    var payload = JSON.parse(event.body || '{}');
    text = (payload.text || '').trim();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E703: invalid_json' }) };
  }

  if (!text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E704: text_required' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_SOFTENS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 100;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'soften-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E706: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  // Test/mock hook — mirrors GENERATION_MOCK_MODE / CONTENT_CLASSIFIER_MOCK_TIER:
  // when set, the softened text is taken from this env var instead of a real,
  // paid LLM call, so a test can exercise the soften -> re-gate branch
  // deterministically ("never a real paid call in tests"). MUST STAY UNSET IN
  // PRODUCTION.
  var mockText = process.env.SOFTEN_MOCK_TEXT;

  var softenedText;
  if (typeof mockText === 'string' && mockText.length) {
    softenedText = stripWrappingQuotes(mockText.trim());
  } else {
    var result;
    try {
      result = await callSoftenLlm(text, falKey);
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: 'E705: llm_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
    }
    if (!result.ok) {
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: 'E705: llm_request_failed: ' + result.error }) };
    }
    softenedText = stripWrappingQuotes((result.content || '').trim());
  }

  if (softenedText.length < MIN_VALID_LENGTH) {
    return { statusCode: 502, body: JSON.stringify({ error: 'E707: empty_or_invalid_response' }) };
  }

  // STAGE 2 — RE-GATE the softened text through the exact same content gate.
  // Normal explicit threshold (the named-person case is never softenable and
  // never reaches here — see this file's header). A classifier outage here
  // fails OPEN exactly like the generation gate does (allowed:true), but the
  // deterministic explicit-keyword backstop in evaluateGenerationGate still
  // catches a softened rewrite that plainly still names a sexual act, and
  // generation itself re-gates a third time server-side.
  var gate = await contentClassifier.evaluateGenerationGate({
    text: softenedText,
    hasNamedOtherPersonPhoto: false,
    falKey: falKey
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      softenedText: softenedText,
      allowed: gate.allowed,
      tier: gate.tier || null,
      message: gate.allowed ? null : (gate.message || contentClassifier.EXPLICIT_BLOCK_MESSAGE)
    })
  };
};
