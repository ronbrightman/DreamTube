// netlify/functions/lib/content-classifier.js
//
// Content-tier SAFETY GATE for the video-generation pipeline (founder-
// directed 2026-08-08). One shared classifier + decision layer sitting in
// front of the existing fal.ai/Veo pipeline — it is a GATE, never a model
// switch: it decides go/no-go and never changes which model actually runs
// (see the "why not a permissive model" note below). Used by the two
// generation chokepoints (generate-video.js — the logged-in path — and
// start-pending-generation.js — the pre-signup funnel path) and, as an
// output-side backstop, by publish-dream.js (public feed).
//
// THE POLICY — three tiers, classified from the dream text before anything
// is generated or committed:
//   - EXPLICIT  (nudity, genitals, sexual acts, explicit sexual
//               description): BLOCKED. Don't generate, don't spend tokens.
//   - ROMANTIC  (kissing, hugging, a couple in bed, non-explicit
//               intimacy): ALLOWED through unchanged. This is mainstream
//               dream content and was being over-blocked; the point of the
//               three-tier split is to STOP over-blocking it, not to route
//               it anywhere special.
//   - CLEAN     (everything else): untouched.
//
// THE STRICTER RULE (anti-NCII safeguard): when the dream carries an
// uploaded photo of a NAMED OTHER PERSON — a non-self character that has
// BOTH a name AND a photo (the "someone I know" path: a name like "Alex" +
// an uploaded face) — the block threshold DROPS to block on ANY
// sexual/romantic content, not just explicit. Generating even mild
// intimate imagery of an identifiable, non-consenting real person is the
// legal landmine (non-consensual intimate imagery / NCII laws), so a
// real, named, photographed other person gets romantic AND explicit both
// blocked. A self-photo, or an invented/unnamed character, keeps the
// normal romantic allowance. Whether such a photo is attached is STRUCTURED
// data the caller already has from the character payload (see
// detectNamedOtherPersonPhoto) — it is NOT inferred by the LLM; it only
// changes which threshold the tier is compared against.
//
// FAIL-SAFE DIRECTIONS (critical — see evaluateGenerationGate):
//   - Normal case  -> FAIL OPEN. If the classifier errors/times out, proceed
//                     to generation. The model's own guardrails still refuse
//                     hard-explicit content, so a classifier outage must not
//                     take the whole product down.
//   - Named-other-person-photo case -> FAIL CLOSED. Block on any classifier
//                     error. This is the legal landmine; it must never slip
//                     through on an error/timeout/missing-key.
//
// WHY A GATE AND NOT A "MORE PERMISSIVE MODEL": a permissive model would not
// honor the mild/explicit line — it would happily reintroduce the exact
// explicit pipeline this policy forbids, and would deepen NCII exposure for
// the named-person case. The gate blocks explicit; the current model's own
// ceiling governs how far mild content actually goes. So the classifier
// only ever decides go/no-go — it never changes which model runs.
//
// CLASSIFIER MECHANISM: reuses the same infra interpret-dream.js already
// uses — fal.ai's OpenRouter chat-completions passthrough, keyed by the
// existing FAL_KEY (no new secret, no new vendor). A cheap, fast model
// (openai/gpt-4o-mini by default, env-overridable) with temperature 0, a
// tiny max_tokens budget, a tight rubric, and a hard timeout — it's on the
// generation hot path, so it's kept cheap and low-latency.

// --- Tiers -----------------------------------------------------------------
var TIER_EXPLICIT = 'explicit';
var TIER_ROMANTIC = 'romantic';
var TIER_CLEAN = 'clean';
var VALID_TIERS = [TIER_EXPLICIT, TIER_ROMANTIC, TIER_CLEAN];

// --- User-facing block messages (exact strings, founder-specified) ---------
// Clear, specific, non-preachy. The client surfaces these directly (see the
// content-policy branches in home.html/result.html) rather than wrapping
// them in a generic "something went wrong" failure.
var EXPLICIT_BLOCK_MESSAGE =
  "We can't turn explicit sexual content into a video — try describing the scene without it.";
var NAMED_PERSON_BLOCK_MESSAGE =
  "For safety, we can't create romantic or intimate videos featuring a real person you've named and added a photo of.";

// --- Classifier call config ------------------------------------------------
// Same OpenRouter passthrough endpoint + auth shape interpret-dream.js uses.
var FAL_LLM_API_BASE = 'https://fal.run/openrouter/router/openai/v1/chat/completions';
// Env-overridable (CONTENT_CLASSIFIER_MODEL), matching this codebase's
// "a model swap is a pure env-var flip" convention (see generate-video.js's
// FAL_MODEL_* vars). Defaults to the same cheap, fast model interpret-dream.js
// already relies on.
var CLASSIFIER_MODEL = process.env.CONTENT_CLASSIFIER_MODEL || 'openai/gpt-4o-mini';
// Hard timeout so a hung classifier call can never stall the generation hot
// path indefinitely. On timeout the fail-safe directions above apply
// (open for the normal case, closed for the named-person case).
function classifierTimeoutMs() {
  var v = parseInt(process.env.CONTENT_CLASSIFIER_TIMEOUT_MS, 10);
  return (!v || v <= 0) ? 8000 : v;
}

// The rubric. Deliberately tight and deterministic. The explicit/romantic
// line is a JUDGMENT CALL — this is where the founder can tune it. As
// written: mainstream, non-explicit intimacy is 'romantic' (allowed in the
// normal case, so romantic content is NOT over-blocked), and only clearly
// explicit sexual content is 'explicit'. Ambiguous cases resolve to the
// MILDER tier on purpose — over-blocking mainstream romantic content is the
// exact failure this policy exists to stop, and the model's own guardrails
// still refuse hard-explicit output even if a borderline case is judged
// 'romantic' here.
var RUBRIC = [
  'You are a content-safety classifier for a dream-to-video app. The line you draw is essentially "Instagram-allowable": suggestive-but-clothed content passes; only actual nudity or sexual acts are blocked.',
  'Classify the dream text into exactly ONE tier and reply with STRICT JSON only, no prose before or after, in exactly this shape: {"tier":"explicit"} or {"tier":"romantic"} or {"tier":"clean"}.',
  'Tier definitions:',
  '- "explicit" (the ONLY tier that gets blocked): actual nudity (exposed genitals, or exposed/bare breasts), sexual acts (having sex, intercourse, penetration, oral sex, masturbation), or explicit/pornographic sexual description. Naming the sexual act at all is explicit — e.g. "having sex", "we had sex", "she was naked", "he was nude" are ALL explicit. Plain wording does not make an act or nudity non-explicit.',
  '- "romantic": suggestive OR romantic content that stays CLOTHED — lingerie, underwear, a bikini or swimwear, "an attractive/sexy figure", cleavage, clothed sensuality, dancing suggestively, kissing (even passionately), hugging, flirting, a couple cuddling or in bed with no explicit sexual detail. This is allowed content; do NOT mark it explicit just because it is sexy or suggestive.',
  '- "clean": everything else — no sexual or romantic content at all.',
  'Classify based only on what the text actually describes.',
  'KEY DISTINCTION: sexy-but-clothed is "romantic" (allowed); only actual nudity or an actual sexual act is "explicit" (blocked). A woman in lingerie or a bikini with an attractive figure is "romantic", NOT explicit. "Having sex" or "she was naked" is "explicit".',
  'Examples: "a woman in stylish lingerie with an attractive figure" -> romantic. "a sexy dance in a bikini" -> romantic. "kissing passionately" -> romantic. "having sex" -> explicit. "she was naked" -> explicit.',
  'Reply with only the JSON object.'
].join(' ');

// --- Deterministic explicit-keyword pre-gate (founder repro, 2026-08-08) ---
// The founder wrote "I was having sex", it was NOT blocked, and the video
// screen vanished with no message. Root cause: the LLM rubric deliberately
// leans "romantic when ambiguous", and on the NORMAL path the gate FAILS OPEN
// on a classifier error/timeout — so an unambiguously explicit phrase could
// slip through either by a lenient judgment OR by a classifier outage, reach
// the model, get refused, and surface only as a generic failure.
//
// This layer is a CODE-SIDE, deterministic backstop that runs BEFORE the LLM
// and short-circuits to `explicit` for phrases that are unambiguously sexual
// (a named sexual act, explicit anatomy, nudity). Because it runs before the
// LLM and never depends on it, it ALSO closes the fail-open hole for these
// phrases: "having sex" is now blocked even if the classifier is down.
//
// Kept deliberately TIGHT so it never over-blocks mainstream romantic
// content — the LLM still owns every judgment-call case (kissing, "making
// love", a couple in bed). Nothing here matches "romantic", "sexy",
// "sexual tension", "kiss", "cuddle", etc. Profanity used non-sexually
// ("a fucking amazing dream") is NOT matched — the "fuck" patterns are
// object-bound to a partner so only the sexual sense is caught.
var EXPLICIT_KEYWORD_PATTERNS = [
  /\bhaving sex\b/,
  /\bhad sex\b/,
  /\bhave sex\b/,
  /\bhaving intercourse\b/,
  /\bsex with\b/,
  /\bsexual intercourse\b/,
  /\bintercourse\b/,
  /\boral sex\b/,
  /\banal sex\b/,
  /\bgiving head\b/,
  /\bblow ?job\b/,
  /\bhand ?job\b/,
  /\bmasturbat\w*/,
  /\bnaked\b/,
  /\bnude\b/,
  /\bnudity\b/,
  /\btopless\b/,
  /\bgenitals?\b/,
  /\bpenis\b/,
  /\bvagina\b/,
  /\bvulva\b/,
  /\bejaculat\w*/,
  /\borgasm\w*/,
  /\bcum(?:ming|med|s)?\b/,
  /\bporn\w*/,
  /\bfuck(?:ing|ed)?\s+(?:her|him|me|them|you|each other)\b/,
  /\bwe fucked\b/
];

/**
 * Whether `text` unambiguously describes explicit sexual content by keyword —
 * the deterministic backstop described above. Case-insensitive. Returns true
 * on the first pattern hit. This is intentionally a HIGH-PRECISION check
 * (few false positives) rather than high-recall: the LLM classifier remains
 * the primary, nuanced tier decision for everything this does not catch.
 */
function matchesExplicitKeyword(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  var lc = text.toLowerCase();
  return EXPLICIT_KEYWORD_PATTERNS.some(function (re) { return re.test(lc); });
}

/**
 * Whether the character payload includes an uploaded photo of a NAMED OTHER
 * PERSON — i.e. a character that is (a) NOT the self ("Me"), (b) has a
 * non-empty name, AND (c) has an attached photo. This is the anti-NCII
 * trigger that drops the block threshold (see evaluateGenerationGate).
 *
 * Structured, code-side detection — never inferred by the LLM. Note that in
 * the current shipped client, js/store.js's resolveCharacters strips
 * photoDataUrl off every non-self character (only "Me" can carry a photo),
 * so this returns false for every request today. It is built to fire the
 * instant a "someone I know" photo path ships, so the safeguard is in place
 * from the start rather than bolted on later. `photoDataUrl` is the field
 * the generation payload uses for an attached face (see generate-video.js's
 * character contract); `photoUrl` is accepted too as forward-compatible
 * defense in case a future field name differs.
 */
function detectNamedOtherPersonPhoto(characters) {
  if (!Array.isArray(characters)) return false;
  return characters.some(function (c) {
    if (!c || c.isSelf) return false;
    var hasName = typeof c.name === 'string' && c.name.trim().length > 0;
    var photo = c.photoDataUrl || c.photoUrl;
    var hasPhoto = typeof photo === 'string' && photo.trim().length > 0;
    return hasName && hasPhoto;
  });
}

/**
 * Assembles the text actually handed to the classifier: the dream caption
 * plus any character descriptions. Character descriptions are folded into
 * the model prompt by buildPrompt, so classifying the caption alone would
 * leave an obvious bypass (hide the explicit text in a character's
 * "description" field). Photos/names themselves are handled structurally by
 * detectNamedOtherPersonPhoto, not fed as text here.
 */
function buildClassifiableText(caption, characters) {
  var parts = [];
  if (typeof caption === 'string' && caption.trim()) parts.push(caption.trim());
  (Array.isArray(characters) ? characters : []).forEach(function (c) {
    if (c && typeof c.description === 'string' && c.description.trim()) parts.push(c.description.trim());
  });
  return parts.join('. ');
}

/** Strips a ```json ... ``` fence if the model wrapped its JSON in one — same tolerance interpret-dream.js applies. */
function stripCodeFence(raw) {
  if (typeof raw !== 'string') return '';
  var trimmed = raw.trim();
  var fence = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : trimmed;
}

/** Parses a classifier completion into one of VALID_TIERS, or null if unusable (caller treats null as a classifier error and applies the fail-safe direction). */
function parseTier(raw) {
  var text = stripCodeFence(raw);
  var tier = null;
  try {
    var data = JSON.parse(text);
    if (data && typeof data.tier === 'string') tier = data.tier;
  } catch (e) {
    // Tolerate a bare one-word answer ("romantic") if the model ignored the
    // JSON instruction — better than failing an otherwise-clear signal.
    tier = text;
  }
  if (typeof tier !== 'string') return null;
  tier = tier.toLowerCase().trim();
  return VALID_TIERS.indexOf(tier) !== -1 ? tier : null;
}

/**
 * The raw classifier call. Returns { ok:true, tier } on a clean parse, or
 * { ok:false, error } on any HTTP error, network error, timeout, or
 * unparseable response. Never throws — the fail-safe direction is decided by
 * the caller (evaluateGenerationGate / evaluateExplicitRecheck), not here.
 */
async function classifyText(text, falKey) {
  // Empty text can't be explicit/romantic — skip the call (cost + latency).
  if (typeof text !== 'string' || !text.trim()) return { ok: true, tier: TIER_CLEAN };

  // Mock / test hooks — deliberately mirror generate-video.js's own
  // GENERATION_MOCK_MODE contract (see that file's "Mock mode" doc block):
  // when the whole generation pipeline is running in mock mode (zero real
  // external calls, zero cost), the classifier — now part of that pipeline —
  // makes NO real LLM call either. It returns CONTENT_CLASSIFIER_MOCK_TIER if
  // that's set to a valid tier (so a test can deterministically exercise a
  // block path without ever making a real, paid classifier call — the
  // "never a real paid call in tests" rule), otherwise 'clean' (the
  // pipeline's existing mock-success default stays unblocked). Setting
  // CONTENT_CLASSIFIER_MOCK_TIER on its own (without GENERATION_MOCK_MODE)
  // also forces the tier — a narrower unit-test hook for the gate logic.
  // THIS MUST STAY UNSET IN PRODUCTION, exactly like GENERATION_MOCK_MODE.
  var forcedTier = (process.env.CONTENT_CLASSIFIER_MOCK_TIER || '').trim().toLowerCase();
  if (forcedTier && VALID_TIERS.indexOf(forcedTier) !== -1) {
    return { ok: true, tier: forcedTier };
  }
  if (process.env.GENERATION_MOCK_MODE === 'true') {
    return { ok: true, tier: TIER_CLEAN };
  }

  if (!falKey) return { ok: false, error: 'classifier_no_key' };

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, classifierTimeoutMs());
  try {
    var res = await fetch(FAL_LLM_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Key ' + falKey
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: RUBRIC },
          { role: 'user', content: 'Dream: ' + text }
        ],
        temperature: 0,
        max_tokens: 16
      }),
      signal: controller.signal
    });

    var data = null;
    try { data = await res.json(); } catch (e) { /* handled via data===null below */ }

    if (!res.ok) return { ok: false, error: 'classifier_http_' + res.status };

    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    var tier = parseTier(typeof content === 'string' ? content : '');
    if (!tier) return { ok: false, error: 'classifier_unparseable' };
    return { ok: true, tier: tier };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'classifier_timeout' : 'classifier_network_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GENERATION-time gate decision. This is the load-bearing chokepoint call.
 *
 * opts: { text, hasNamedOtherPersonPhoto, falKey }
 * returns:
 *   { allowed:true,  tier }                        -> proceed to generation
 *   { allowed:false, tier, message, reason }       -> block (no generation,
 *                                                     caller must NOT spend
 *                                                     tokens), show `message`
 *
 * Fail-safe: normal case FAILS OPEN on any classifier error; the
 * named-other-person-photo case FAILS CLOSED. See the file header.
 */
async function evaluateGenerationGate(opts) {
  opts = opts || {};
  var named = !!opts.hasNamedOtherPersonPhoto;

  // Deterministic explicit-keyword backstop (founder repro 2026-08-08 —
  // "I was having sex" slipped through). Runs BEFORE the LLM and independent
  // of it, so an unambiguously explicit phrase is blocked even if the
  // classifier is lenient OR down (this is the fix for the normal-path
  // fail-open hole for clearly-explicit text). The named-person message is
  // used when a named+photographed real person is attached, otherwise the
  // plain explicit message. See matchesExplicitKeyword's own doc comment.
  if (matchesExplicitKeyword(opts.text)) {
    return {
      allowed: false,
      tier: TIER_EXPLICIT,
      message: named ? NAMED_PERSON_BLOCK_MESSAGE : EXPLICIT_BLOCK_MESSAGE,
      reason: named ? 'named_person_explicit_keyword' : 'explicit_keyword'
    };
  }

  var result = await classifyText(opts.text, opts.falKey);

  if (!result.ok) {
    // Classifier error/timeout/missing-key.
    if (named) {
      // FAIL CLOSED — the NCII landmine must never slip through on an error.
      return { allowed: false, tier: null, message: NAMED_PERSON_BLOCK_MESSAGE, reason: 'named_person_fail_closed', error: result.error, failClosed: true };
    }
    // FAIL OPEN — a classifier outage must not break generation for everyone;
    // the model's own guardrails still refuse hard-explicit output.
    return { allowed: true, tier: null, reason: 'fail_open', error: result.error };
  }

  var tier = result.tier;

  if (named) {
    // Stricter threshold: block ANY sexual/romantic content for a named,
    // photographed real other person — only fully clean content is allowed.
    if (tier === TIER_EXPLICIT || tier === TIER_ROMANTIC) {
      return { allowed: false, tier: tier, message: NAMED_PERSON_BLOCK_MESSAGE, reason: 'named_person_' + tier };
    }
    return { allowed: true, tier: tier };
  }

  // Normal threshold: block only explicit; romantic and clean pass through.
  if (tier === TIER_EXPLICIT) {
    return { allowed: false, tier: tier, message: EXPLICIT_BLOCK_MESSAGE, reason: 'explicit' };
  }
  return { allowed: true, tier: tier };
}

/**
 * OUTPUT-side re-check for the public feed / any outward-facing share
 * (publish-dream.js). Explicit-only, defense-in-depth: it re-runs the
 * explicit check on the caption so nothing borderline the model DID manage
 * to produce can leak outward to other users. It never applies the
 * named-person threshold (there's no character/photo payload at publish, and
 * this is a public-leak backstop, not the NCII generation gate).
 *
 * Fail-safe: FAILS OPEN on any classifier error. The generation-time gate is
 * the primary defense; a classifier outage must not block every publish. A
 * private dream the user keeps to themselves is never touched by this — only
 * the outward-facing path calls it.
 *
 * opts: { text, falKey }
 * returns { allowed:true, tier } or { allowed:false, tier, message, reason }.
 */
async function evaluateExplicitRecheck(opts) {
  opts = opts || {};
  // Same deterministic explicit-keyword backstop as evaluateGenerationGate —
  // on the output/publish side it means an unambiguously explicit caption is
  // kept off the public feed even if the classifier fails open here too.
  if (matchesExplicitKeyword(opts.text)) {
    return { allowed: false, tier: TIER_EXPLICIT, message: EXPLICIT_BLOCK_MESSAGE, reason: 'explicit_keyword' };
  }
  var result = await classifyText(opts.text, opts.falKey);
  if (!result.ok) {
    return { allowed: true, tier: null, reason: 'fail_open', error: result.error };
  }
  if (result.tier === TIER_EXPLICIT) {
    return { allowed: false, tier: result.tier, message: EXPLICIT_BLOCK_MESSAGE, reason: 'explicit' };
  }
  return { allowed: true, tier: result.tier };
}

module.exports = {
  TIER_EXPLICIT: TIER_EXPLICIT,
  TIER_ROMANTIC: TIER_ROMANTIC,
  TIER_CLEAN: TIER_CLEAN,
  EXPLICIT_BLOCK_MESSAGE: EXPLICIT_BLOCK_MESSAGE,
  NAMED_PERSON_BLOCK_MESSAGE: NAMED_PERSON_BLOCK_MESSAGE,
  RUBRIC: RUBRIC,
  matchesExplicitKeyword: matchesExplicitKeyword,
  detectNamedOtherPersonPhoto: detectNamedOtherPersonPhoto,
  buildClassifiableText: buildClassifiableText,
  classifyText: classifyText,
  evaluateGenerationGate: evaluateGenerationGate,
  evaluateExplicitRecheck: evaluateExplicitRecheck
};
