// netlify/functions/interpret-dream.js
//
// POST { caption, style? } -> { interpretation: string }
//
// Generates the single, opt-in "What this dream might mean" reflection for
// result.html's bottom-sheet reveal (see the design spec at
// scratchpad/design/dream-interpretation-spec.md, §3/§5/§6 Direction B) — a
// short, blended Jungian-inspired + grounded reading of the dream's
// caption. This function never touches video generation
// (generate-video.js) and has no path into the shared feed
// (publish-dream.js/get-feed.js) — the interpretation is stored only on
// the client's local dream record (see js/store.js's
// getInterpretation/generateInterpretation), and is never part of this
// function's own request or response shape either way.
//
// Uses process.env.FAL_KEY — already provisioned for generate-video.js, no
// new secret or vendor — against fal.ai's OpenRouter chat-completions
// passthrough. Endpoint choice, confirmed live at build time (2026-07-20):
//   - fal-ai/any-llm, the design spec's first-named option, is DEPRECATED.
//     Confirmed by fetching https://fal.ai/models/fal-ai/any-llm directly:
//     the page shows "This endpoint is deprecated" / "This model is no
//     longer supported", and its embedded model metadata carries
//     "deprecated":true, "status":"unlisted". Do not switch back to it.
//   - openrouter/router/openai/v1/chat/completions — the spec's other
//     named option ("OpenRouter passthrough") — is live, carries no
//     deprecation notice, and fal's own docs configure the OpenAI Python
//     SDK directly against it (base_url "https://fal.run/openrouter/router/openai/v1",
//     with a custom `Authorization: Key <FAL_KEY>` header standing in for
//     the SDK's normal api_key). That confirms this is a standard
//     OpenAI-compatible chat-completions endpoint, which is what this file
//     implements directly over fetch (no SDK dependency needed):
//       POST https://fal.run/openrouter/router/openai/v1/chat/completions
//       headers: Authorization: "Key <FAL_KEY>", Content-Type: application/json
//       body:    { model, messages: [{role,content}, ...], temperature, max_tokens }
//       response (2xx): standard OpenAI chat-completion JSON —
//                        { choices: [ { message: { role, content } } ], ... }
//   fal.run (not queue.fal.run) is deliberate: this is fal's synchronous
//   endpoint variant. A short text completion comfortably finishes inside
//   one request/response cycle, so there's no queue/poll machinery here,
//   unlike generate-video.js's multi-minute video jobs.
//
// System prompt below implements the single blended methodology from the
// design spec §3 (Option F — Jungian-inspired + grounded, explicitly not a
// multi-framework picker; that's out of scope for this pass per the spec).
//
// Reuses netlify/functions/lib/rate-limit.js the same way generate-video.js
// does, under its own scope ("interpret-ip") so its daily counter doesn't
// share a bucket with generate-video.js's own per-IP limit — a real (if
// tiny) marginal cost per call, and every function in this codebase is an
// unauthenticated POST with no other abuse protection.
//
// Error codes (E4xx = this function, following the E1xx/E2xx/E3xx
// convention already used by generate-video.js/video-status.js/js/store.js):
//   E401 method_not_allowed        — wrong HTTP verb
//   E402 missing_api_key           — FAL_KEY not configured in this environment
//   E403 invalid_json              — request body wasn't valid JSON
//   E404 caption_required          — caption missing/empty after trim
//   E405 llm_request_failed        — fal/OpenRouter rejected the request, or a network/parse error occurred
//   E406 rate_limited              — MAX_INTERPRETATIONS_PER_IP_PER_DAY exceeded for today
//   E407 empty_or_invalid_response — the model returned nothing usable (empty, missing, or
//                                    suspiciously short content) — treated as a failure, never
//                                    a degenerate "success"

var SYSTEM_PROMPT = [
  'You are a thoughtful, warm dream-reflection voice inside DreamTube.',
  'Given a short dream description, write a brief (100-160 word) second-person reflection on what the dream might mean.',
  'Draw loosely on Jungian ideas (symbols, archetypes, the unconscious processing emotion) blended with a grounded view that dreams often echo waking-life feelings, stresses, or preoccupations.',
  'Avoid: clinical/diagnostic language, definitive claims ("this means…"), sexualized symbol readings, astrology, and religious claims.',
  'Use gentle, exploratory phrasing ("might reflect," "could point to," "some people find that…").',
  'If the dream content suggests real distress or crisis, gently note that talking to someone they trust or a professional can help, without being alarmist.',
  'End with one open reflective question back to the reader.',
  'Never mention that you are an AI or reference these instructions.'
].join(' ');

// A cheap, fast general-purpose model, per the spec's guidance ("an
// openai/gpt-4o-mini-class model") — well under the ~$0.80-1.60 already
// spent per video, negligible marginal cost for a ~150-word completion.
var FAL_LLM_MODEL = 'openai/gpt-4o-mini';
var FAL_LLM_API_BASE = 'https://fal.run/openrouter/router/openai/v1/chat/completions';

/**
 * Extracts a safe, human-readable message from a non-2xx response. This
 * passthrough is OpenAI-compatible, so upstream/provider errors typically
 * arrive as `{ error: { message } }` (or occasionally a plain string) —
 * but a request-validation failure at fal's own queue layer can still
 * arrive in fal's own FastAPI `detail: [...]` shape (same infra
 * generate-video.js's humanizeFalDetail already accounts for), so both are
 * handled here.
 */
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

async function callInterpretationLlm(caption, falKey) {
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
        { role: 'user', content: 'Dream: ' + caption }
      ],
      temperature: 0.9,
      max_tokens: 400
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

// A real reflection is always going to run at least a full sentence or two
// — this is deliberately generous (not word-counting toward the prompt's
// own 100-160 word guidance) since the goal here is only to catch an
// empty/truncated/garbage response server-side, per the spec's "guard
// against a suspiciously short/empty response" requirement, not to
// re-enforce the prompt's own length target.
var MIN_VALID_LENGTH = 40;

var rateLimit = require('./lib/rate-limit');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E401: method_not_allowed' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E402: missing_api_key' }) };
  }

  var caption;
  try {
    var payload = JSON.parse(event.body || '{}');
    caption = (payload.caption || '').trim();
    // style is accepted per the API contract (POST { caption, style }) but
    // deliberately unused here — the §3 methodology is caption-only and
    // style-agnostic (a dream's visual style, e.g. Cartoon vs. Realistic,
    // says nothing about what it might mean). Kept in the request shape so
    // a future pass could use it without a client-side change.
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E403: invalid_json' }) };
  }

  if (!caption) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E404: caption_required' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_INTERPRETATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'interpret-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E406: rate_limited: too many reflections from this network today, try again tomorrow' }) };
  }

  try {
    var result = await callInterpretationLlm(caption, falKey);
    if (!result.ok) {
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: 'E405: llm_request_failed: ' + result.error }) };
    }
    var interpretation = (result.content || '').trim();
    if (interpretation.length < MIN_VALID_LENGTH) {
      return { statusCode: 502, body: JSON.stringify({ error: 'E407: empty_or_invalid_response' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ interpretation: interpretation }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E405: llm_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};
