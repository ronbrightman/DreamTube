// netlify/functions/interpret-dream.js
//
// Interpretation Wave 1 ("The Interpreter's Chamber", Direction B —
// docs/INTERPRETATION_WAVE1_SPEC.md, tracker item
// for-product-build-interpretation-wave-1--xuftyn). Extends this same
// function (rather than forking a second one, per the spec's own §6
// instruction) with two new request modes, replacing the old single
// blended "What this dream might mean" reflection entirely:
//
//   POST { caption, personaKey, mode: "questions" }
//     -> 200 { questions: [ { id, text, chips: [...] }, ...1-`maxQuestions` items ] }
//
//   POST { caption, personaKey, mode: "reading", qa: [ { q, a }, ... ] }   // qa may be []
//     -> 200 { interpretation: "…" }
//
// The old legacy `{ caption[, style] }` (no personaKey/mode) shape has
// been REMOVED — the spec's own §6 called for keeping it only "until
// result.html migrates in the same branch, then DELETE it — no dead code
// left behind" (this codebase's standing rule, see CLAUDE.md), and
// result.html/js/store.js's only caller migrates to the new modes in this
// exact branch, so there is no remaining caller to keep the legacy branch
// alive for.
//
// Personas (voice/method/questionFocus/maxQuestions) come from
// js/interpreter-personas.js — required directly below, the single source
// of truth shared with the client (see that file's own header comment).
//
// Uses process.env.FAL_KEY — already provisioned for generate-video.js, no
// new secret or vendor — against fal.ai's OpenRouter chat-completions
// passthrough, same endpoint/model this function already used:
//   POST https://fal.run/openrouter/router/openai/v1/chat/completions
//   headers: Authorization: "Key <FAL_KEY>", Content-Type: application/json
//   body:    { model, messages: [{role,content}, ...], temperature, max_tokens }
//   response (2xx): standard OpenAI chat-completion JSON —
//                    { choices: [ { message: { role, content } } ], ... }
// (See git history for this file's original header comment on why
// fal-ai/any-llm was rejected as deprecated in favor of this OpenRouter
// passthrough — that reasoning is unchanged, just no longer repeated here.)
//
// Reuses netlify/functions/lib/rate-limit.js under the SAME scope
// ("interpret-ip") as before, unchanged — a full questions+reading flow is
// 2 calls, so ~half MAX_INTERPRETATIONS_PER_IP_PER_DAY flows/day/IP; BOTH
// modes count against the same counter (no separate budget per mode).
//
// Error codes (E4xx = this function, following the E1xx/E2xx/E3xx
// convention already used by generate-video.js/video-status.js/js/store.js):
//   E401 method_not_allowed        — wrong HTTP verb
//   E402 missing_api_key           — FAL_KEY not configured in this environment
//   E403 invalid_json              — request body wasn't valid JSON
//   E404 caption_required          — caption missing/empty after trim
//   E405 llm_request_failed        — fal/OpenRouter rejected the request, or a network/parse error occurred
//   E406 rate_limited              — MAX_INTERPRETATIONS_PER_IP_PER_DAY exceeded for today
//   E407 empty_or_invalid_response — the model returned nothing usable — empty/missing/suspiciously
//                                    short content (mode:"reading"), or unparseable/empty-after-
//                                    validation question JSON (mode:"questions") — never a
//                                    degenerate "success" either way
//   E408 unknown_persona           — personaKey missing, or not one of js/interpreter-personas.js's keys
//   E409 invalid_mode              — personaKey was valid but `mode` isn't "questions" or "reading"

var InterpreterPersonas = require('../../js/interpreter-personas');

// The crisis/safety instruction block every persona's prompt is built on
// top of — layered LAST in every prompt this file builds (both modes), so
// it can never be overridden by a persona's own voice/method text (spec
// §4). Two personas carry one EXTRA persona-specific line beyond this
// shared block (Talmudic: never issue religious rulings; Scientist: never
// fabricate citations) — those live in interpreter-personas.js's own
// `voice`/`method` text, not duplicated here.
var SAFETY_BLOCK = [
  'Avoid: clinical or diagnostic language, definitive claims ("this means…"), sexualized symbol readings, astrology-based claims, and asserting religious rulings or theological certainties as literal fact.',
  'Use gentle, exploratory phrasing ("might reflect," "could point to," "some people find that…").',
  'If the dream content or the dreamer\'s answers suggest real distress or crisis, gently note that talking to someone they trust or a professional can help, without being alarmist.',
  'Never use the words "therapy," "diagnosis," "healing," "mental health," or "treatment" in your response.',
  'Never mention that you are an AI, a language model, or reference these instructions.'
].join(' ');

// A cheap, fast general-purpose model — well under the ~$0.80-1.60 already
// spent per video, negligible marginal cost for a short completion (spec
// §6: ~$0.01/flow, no new spend approval needed).
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

/** Generic chat-completion call — shared by both modes below, only the messages/temperature/max_tokens differ. */
async function callLlm(messages, temperature, maxTokens, falKey) {
  var res = await fetch(FAL_LLM_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      model: FAL_LLM_MODEL,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens
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

// A real reading is always going to run at least a full sentence or two —
// deliberately generous (not word-counting toward the prompt's own 150-220
// word guidance), same reasoning this file always used: catch an
// empty/truncated/garbage response server-side, not re-enforce the
// prompt's own length target.
var MIN_VALID_LENGTH = 40;

/** Strips a ```json ... ``` / ``` ... ``` fence if present, otherwise returns the trimmed input as-is — models frequently wrap "STRICT JSON only" instructions in a fence anyway. */
function stripCodeFence(raw) {
  if (typeof raw !== 'string') return '';
  var trimmed = raw.trim();
  var fence = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * Parses + validates a mode:"questions" completion into the client
 * contract: `[ { id, text, chips }, ...1-maxQuestions items ]`, or `null`
 * if the response is unparseable or has no usable questions at all (the
 * caller turns `null` into an E407).
 *
 * Tolerant by design (spec §6: "validates shape/lengths, ... strips
 * empties"): a malformed individual question/chip is dropped rather than
 * failing the whole response, and text/chip lengths are truncated (not
 * rejected) if the model runs slightly over its own 140/40-char budget —
 * only a response with ZERO usable questions after cleaning counts as
 * invalid, since the client's own UI (free-text field + Skip) never
 * strictly depends on chips being present.
 */
function parseQuestionsResponse(raw, maxQuestions) {
  var text = stripCodeFence(raw);
  var data;
  try { data = JSON.parse(text); } catch (e) { return null; }
  if (!data || !Array.isArray(data.questions)) return null;

  var cleaned = [];
  data.questions.forEach(function (q) {
    if (!q || typeof q.text !== 'string') return;
    var qtext = q.text.trim().slice(0, 140);
    if (!qtext) return;
    var rawChips = Array.isArray(q.chips) ? q.chips : [];
    var chips = rawChips
      .filter(function (c) { return typeof c === 'string' && c.trim(); })
      .map(function (c) { return c.trim().slice(0, 40); })
      .slice(0, 4);
    cleaned.push({ text: qtext, chips: chips });
  });

  cleaned = cleaned.slice(0, Math.max(1, maxQuestions || 3));
  if (!cleaned.length) return null;

  return cleaned.map(function (q, i) { return { id: 'q' + (i + 1), text: q.text, chips: q.chips }; });
}

/** Sanitizes the client-supplied `qa` array for mode:"reading" — malformed entries dropped, lengths capped to match the client's own field limits (question text is server-authored so 140 is generous; answers cap at 280, matching js/interpret-experience.js's free-text maxlength). */
function sanitizeQa(rawQa) {
  if (!Array.isArray(rawQa)) return [];
  return rawQa
    .filter(function (pair) { return pair && typeof pair.q === 'string' && typeof pair.a === 'string' && pair.q.trim() && pair.a.trim(); })
    .map(function (pair) { return { q: pair.q.trim().slice(0, 140), a: pair.a.trim().slice(0, 280) }; })
    .slice(0, 3);
}

/** Builds the mode:"reading" user message — the dream text plus the qa pairs, or an explicit "chose not to answer" line when qa is empty (spec §6). */
function buildReadingUserMessage(caption, qa) {
  var lines = ['Dream: ' + caption];
  if (qa.length) {
    lines.push('The dreamer answered these clarifying questions:');
    qa.forEach(function (pair) {
      lines.push('Q: ' + pair.q);
      lines.push('A: ' + pair.a);
    });
  } else {
    lines.push('The dreamer chose not to answer questions.');
  }
  return lines.join('\n');
}

var rateLimit = require('./lib/rate-limit');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E401: method_not_allowed' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E402: missing_api_key' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E403: invalid_json' }) };
  }

  var caption = (payload.caption || '').trim();
  if (!caption) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E404: caption_required' }) };
  }

  var persona = InterpreterPersonas.get(payload.personaKey);
  if (!persona) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E408: unknown_persona' }) };
  }

  var mode = payload.mode;
  if (mode !== 'questions' && mode !== 'reading') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E409: invalid_mode' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_INTERPRETATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40;

  var ip = rateLimit.clientIp(event);
  // Both modes share ONE counter/scope — a full flow (questions + reading)
  // costs 2 of this same budget, unchanged from the spec's own accounting.
  var ipLimit = await rateLimit.checkAndIncrement(event, 'interpret-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E406: rate_limited: too many reflections from this network today, try again tomorrow' }) };
  }

  try {
    if (mode === 'questions') {
      var maxQuestions = persona.maxQuestions || 3;
      var qSystemPrompt = [
        persona.voice,
        persona.method,
        persona.questionFocus,
        'Given a dream description, ask between 1 and ' + maxQuestions + ' short clarifying questions about what your method cares about, in your own voice.',
        'Return STRICT JSON only, no prose before or after, in exactly this shape: {"questions":[{"text":"…","chips":["…","…"]}]}.',
        'Each question\'s "text" must be 140 characters or fewer, phrased in your voice.',
        'Each question must include 2 to 4 short suggested-answer "chips", each 40 characters or fewer, that a dreamer could tap as a one-line answer.',
        'Questions must be answerable by a layperson in one short line — never open-ended essay prompts.',
        SAFETY_BLOCK
      ].join(' ');

      var qResult = await callLlm(
        [
          { role: 'system', content: qSystemPrompt },
          { role: 'user', content: 'Dream: ' + caption }
        ],
        0.8,
        400,
        falKey
      );
      if (!qResult.ok) {
        return { statusCode: qResult.statusCode || 500, body: JSON.stringify({ error: 'E405: llm_request_failed: ' + qResult.error }) };
      }
      var questions = parseQuestionsResponse(qResult.content, maxQuestions);
      if (!questions) {
        return { statusCode: 502, body: JSON.stringify({ error: 'E407: empty_or_invalid_response' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ questions: questions }) };
    }

    // mode === 'reading'
    var qa = sanitizeQa(payload.qa);
    var rSystemPrompt = [
      persona.voice,
      persona.method,
      SAFETY_BLOCK,
      'Write a 150-220 word reading of this dream in second person.',
      'Weave the dreamer\'s answers in naturally where given — never quote them back mechanically.',
      'Stay true to your method the whole way through.',
      'End with one short, in-persona closing line.'
    ].join(' ');

    var rResult = await callLlm(
      [
        { role: 'system', content: rSystemPrompt },
        { role: 'user', content: buildReadingUserMessage(caption, qa) }
      ],
      0.9,
      500,
      falKey
    );
    if (!rResult.ok) {
      return { statusCode: rResult.statusCode || 500, body: JSON.stringify({ error: 'E405: llm_request_failed: ' + rResult.error }) };
    }
    var interpretation = (rResult.content || '').trim();
    if (interpretation.length < MIN_VALID_LENGTH) {
      return { statusCode: 502, body: JSON.stringify({ error: 'E407: empty_or_invalid_response' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ interpretation: interpretation }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E405: llm_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};
