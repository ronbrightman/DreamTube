// netlify/functions/check-dream-content.js
//
// PRE-SIGNUP content gate (founder-directed 2026-08-14). A read-only,
// no-side-effect twin of the generation-time gate in generate-video.js /
// start-pending-generation.js, meant to be called BEFORE the email/signup
// step on every dream-creation surface (wizard.html, start.html,
// create.html).
//
// WHY THIS EXISTS: the explicit-content block currently fires only at
// GENERATION time — which is AFTER the user has entered their email and
// completed signup. The Meta ad campaign optimizes on the signup
// conversion (CompleteRegistration), so an explicit-content-seeker fires
// that conversion event BEFORE being blocked, and Meta actively learns to
// acquire MORE of them. Running the same classification on the dream text
// BEFORE signup lets each surface block progression to the email wall, so
// explicit users never reach signup and stop counting as conversions.
//
// CONTRACT:
//   POST { caption, characters? }
//     -> 200 { allowed: boolean, tier: "explicit"|"romantic"|"clean", reason }
//
//   NO auth, NO tokens, NO generation, NO side effects. Safe to call
//   pre-signup, repeatedly, from an anonymous visitor. `allowed:false` is
//   returned ONLY for a real block: the explicit tier, OR any
//   sexual/romantic tier when a named-other-person photo is attached
//   (the anti-NCII stricter threshold). Everything else is allowed.
//
// DECISION LOGIC IS REUSED, NOT REIMPLEMENTED: this delegates to
// content-classifier.js's evaluateGenerationGate — the exact same
// keyword fast-path + LLM tier + named-other-person-photo threshold drop
// the generation chokepoints use — so the pre-signup verdict can never
// drift from the generation-time verdict. See that file's header for the
// full policy and the fail-safe directions.
//
// FAIL-SAFE (inherited from evaluateGenerationGate):
//   - Normal case  -> FAILS OPEN (allowed:true) on any classifier
//                     error/timeout/missing-key. A classifier outage (or
//                     this sandbox having no FAL_KEY) must never block a
//                     legit user pre-signup — the generation-time gate is
//                     the full backstop.
//   - Named-other-person-photo case -> FAILS CLOSED (allowed:false). The
//                     NCII landmine must never slip through on an error.
//
// This endpoint ITSELF also fails open on its OWN failures (bad JSON, rate
// limit exceeded, unexpected throw): it returns allowed:true rather than
// blocking a real user because of our infrastructure. Blocking is reserved
// for a genuine content verdict. The only exception is a named-photo
// payload, whose fail-closed direction is owned by evaluateGenerationGate
// and honored here.
//
// Error codes (E8xx = this function, following the E1xx/E2xx/E3xx/E4xx…
// convention used across netlify/functions):
//   E801 method_not_allowed  — wrong HTTP verb
//   E802 invalid_json        — request body wasn't valid JSON (returns
//                              allowed:true — a malformed pre-check must
//                              not block a real user)
//
// Rate limiting: a cheap per-IP daily cap (lib/rate-limit.js, its own
// "content-gate-ip" scope) guards the classifier's cost against scripted
// hammering — mirroring interpret-dream.js. Exceeding it returns
// allowed:true (fail open — the generation-time gate still backstops), so
// the limiter protects LLM spend without ever hard-blocking a person.

var contentClassifier = require('./lib/content-classifier');
var rateLimit = require('./lib/rate-limit');
var moderationLogStore = require('./lib/moderation-log-store');

// MODERATION LOG bridge (added 2026-08-14, same day as this gate). Before this,
// the moderation log (lib/moderation-log-store.js) only captured blocked prompt
// text at GENERATION time (generate-video.js / generate-image.js E116). But this
// pre-signup gate now blocks explicit content BEFORE the user ever reaches
// generation — so a pre-email block would leave NO record of the text the
// founder built the moderation log to review. This best-effort append closes
// that gap: every real pre-signup block is logged with reason 'E116_preemail'.
// Best-effort — wrapped in try/catch, never alters or delays the gate response.
async function recordPreEmailBlockBestEffort(event, record) {
  try {
    await moderationLogStore.append(event, record);
  } catch (e) {
    console.error('check-dream-content: moderation-log append failed (non-fatal, gate response unaffected)', e);
  }
}

/** Normalizes evaluateGenerationGate's possibly-null tier into the non-null contract value clients report in telemetry. */
function normalizeTier(gate) {
  if (gate.tier === contentClassifier.TIER_EXPLICIT ||
      gate.tier === contentClassifier.TIER_ROMANTIC ||
      gate.tier === contentClassifier.TIER_CLEAN) {
    return gate.tier;
  }
  // tier is null (fail-open / fail-closed): describe it by the verdict.
  return gate.allowed ? contentClassifier.TIER_CLEAN : contentClassifier.TIER_EXPLICIT;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E801: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    // A malformed pre-check must not hard-block a real user — fail open.
    return { statusCode: 200, body: JSON.stringify({ allowed: true, tier: 'clean', reason: 'invalid_json' }) };
  }

  var caption = typeof payload.caption === 'string' ? payload.caption : '';
  var characters = Array.isArray(payload.characters) ? payload.characters : [];
  // Optional surface tag ('wizard'|'start'|'create') the caller passes so the
  // moderation log records WHERE a pre-email block originated. Untrusted/optional.
  var source = typeof payload.source === 'string' ? payload.source : null;

  // Cheap per-IP daily cap on the classifier call. Exceeding it FAILS OPEN
  // (allowed:true) — the limiter exists to protect LLM cost from scripted
  // hammering, not to block people; the generation-time gate is the real
  // backstop. A named-photo payload is the ONE case we still evaluate even
  // when rate-limited, because its fail-closed direction is a legal
  // safeguard, not a cost concern (and detectNamedOtherPersonPhoto is a
  // free, code-side structural check with no classifier call of its own).
  var maxPerDay = parseInt(process.env.MAX_CONTENT_GATE_CHECKS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 120;
  var hasNamedOtherPersonPhoto = contentClassifier.detectNamedOtherPersonPhoto(characters);

  try {
    var ip = rateLimit.clientIp(event);
    var ipLimit = await rateLimit.checkAndIncrement(event, 'content-gate-ip', ip, maxPerDay);
    if (!ipLimit.allowed && !hasNamedOtherPersonPhoto) {
      return { statusCode: 200, body: JSON.stringify({ allowed: true, tier: 'clean', reason: 'rate_limited' }) };
    }
  } catch (e) {
    // Rate-limiter (Blobs) failure must not break the pre-check — the
    // named-photo case still runs its own fail-closed evaluation below;
    // everything else proceeds to the classifier as normal.
  }

  var classifiableText = contentClassifier.buildClassifiableText(caption, characters);

  var gate;
  try {
    gate = await contentClassifier.evaluateGenerationGate({
      text: classifiableText,
      hasNamedOtherPersonPhoto: hasNamedOtherPersonPhoto,
      falKey: process.env.FAL_KEY
    });
  } catch (e) {
    // evaluateGenerationGate is documented never to throw, but if some
    // future edit makes it, fail open for the normal case and closed for
    // the named-photo case, mirroring its own fail-safe directions.
    if (hasNamedOtherPersonPhoto) {
      return { statusCode: 200, body: JSON.stringify({ allowed: false, tier: 'explicit', reason: 'named_person_fail_closed' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ allowed: true, tier: 'clean', reason: 'gate_error_fail_open' }) };
  }

  // Capture the blocked text to the moderation log so the founder retains
  // visibility into what people try to make — the pre-email gate now intercepts
  // it before generation, where the log's only other capture point sits. Only
  // real blocks are logged; a clean/allowed pre-check writes nothing.
  if (!gate.allowed) {
    await recordPreEmailBlockBestEffort(event, {
      ts: new Date().toISOString(),
      reason: 'E116_preemail',
      promptText: caption,
      mediaType: null, // media type isn't chosen yet at pre-signup
      user: 'anonymous', // pre-signup: no account/email yet
      source: source,
      operationName: null
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      allowed: gate.allowed,
      tier: normalizeTier(gate),
      reason: gate.reason || (gate.allowed ? 'allowed' : 'blocked')
    })
  };
};
