// netlify/functions/generate-video.js
//
// POST { caption, style, characters?, cameraView?, sceneryTime?, sceneryPlace?, email? }
// -> kicks off a video generation job and returns an operationName the
// client can poll via video-status.js.
//
// characters (optional) is [{ name, description, isSelf, photoDataUrl? }] —
// the user's selected Advanced characters, resolved client-side from their
// private character list (see js/store.js's resolveCharacters).
// photoDataUrl can only be present on an isSelf entry (js/store.js strips
// it from everyone else before it ever reaches here) and is at most one
// per request, since only "Me" can have a photo.
//
// cameraView is one of 'Close-up' | 'Wide shot' | 'Aerial view' | 'POV'.
// sceneryTime is 'Day' | 'Night'; sceneryPlace is 'Urban' | 'Nature' |
// 'Inside a house'. All optional/nullable.
//
// email (optional) is the logged-in account's email, if any (see
// js/store.js's startGeneration) — sent opportunistically today. It's used
// for two things: a per-email rate-limit bucket alongside the always-on
// per-IP one (see netlify/functions/lib/rate-limit.js), and the token-
// balance check/spend (see netlify/functions/lib/entitlements.js and the
// E112 doc block below) — both always-on, not gated behind any flag.
//
// All of the above are folded into the prompt sent to the model (see
// buildPrompt) but never echoed back — the caption the UI displays is
// whatever the caller passed in and this function never alters or
// returns it. A caption long enough that it wouldn't plausibly play out
// within the model's fixed ~8s clip gets condensed to its strongest
// visual moment before being folded into the prompt (see
// lib/prompt-condenser.js's condenseIfNeeded, called just before
// buildPrompt below) — this is the *prompt-facing* text only, same "never
// echoed back" rule as everything else above. Narration/audio
// (fal's `generate_audio` param — confirmed via fal.ai's model API docs,
// not guessed) is disabled specifically when condensing actually
// happened, since narrating a condensed version would voice words the
// user never wrote; a short caption sent as-is (the common case) keeps
// audio on unchanged from before this existed.
//
// If a self photo is present, generation routes through
// fal's *reference-to-video* model (see callFalReferenceToVideo) with
// that photo as a subject-identity reference, instead of the plain
// text-to-video model — NOT image-to-video, which was the original
// (wrong) choice here: image-to-video treats the photo as the video's
// literal starting frame and just adds motion to it, so the output was
// a near-static animated photo that then cut to an unrelated generated
// scene matching the caption, instead of showing that person within the
// described dream. reference-to-video blends the reference image's
// subject into a scene described independently by the prompt, which is
// what "use my photo as this character in the dream" actually means.
//
// ACTIVE PATH: fal.ai's Veo 3.1 Fast (fal-ai/veo3.1/fast), using FAL_KEY.
// Switched from fal.ai's wan v2.2-5b because its output quality wasn't good
// enough. Veo 3.1 is the same Google model originally used via direct Google
// API calls (see callVeoDirect below) — now reached through fal.ai instead,
// which sidesteps the Google Cloud quota wall that caused the original
// switch away from it. "/fast" is the cost/quality middle tier (roughly
// $0.10-0.20/sec) — plain "veo3.1" (no /fast) costs roughly double for
// higher quality, use only if explicitly requested.
// The wan v2.2-5b path is kept below (callFalWan), unused, in case we want
// to switch back or use it as a cheaper fallback later.

var STYLE_MODIFIERS = {
  Cartoon:   'in a colorful hand-drawn cartoon animation style',
  Cinematic: 'in a moody, cinematic film style with dramatic lighting',
  Anime:     'in a vibrant Japanese anime animation style',
  Realistic: 'in a photorealistic, lifelike rendering style'
};

var CAMERA_MODIFIERS = {
  'Close-up': 'close-up shot',
  'Wide shot': 'wide shot',
  'Aerial view': 'aerial view',
  'POV': 'point-of-view (POV) shot'
};

var SCENERY_TIME_MODIFIERS = { Day: 'daytime', Night: 'nighttime' };
var SCENERY_PLACE_MODIFIERS = {
  Urban: 'an urban setting',
  Nature: 'a natural landscape',
  'Inside a house': 'inside a house'
};

/**
 * Combines the plain caption with style + character + camera + scenery
 * enrichment into the prompt actually sent to the video model. This is
 * provider-only enrichment — the caption the UI shows the user is never
 * touched here.
 *
 * A self character with a photo is described by the reference image
 * passed alongside the prompt (see callFalReferenceToVideo), not by text,
 * so its own description is left out of the character text here — but
 * the prompt still gets a short pointer tying "the dreamer" to that image.
 */
function buildPrompt(caption, style, characters, cameraView, sceneryTime, sceneryPlace) {
  var modifier = STYLE_MODIFIERS[style] || ('in a ' + style + ' animation style');
  var parts = [caption];

  var hasPhotoSelf = (characters || []).some(function (c) { return c && c.isSelf && c.photoDataUrl; });
  var charTextParts = (characters || [])
    .filter(function (c) { return c && !c.photoDataUrl && typeof c.description === 'string' && c.description.trim(); })
    .map(function (c) {
      var who = c.isSelf ? 'the dreamer ("me")' : ((c.name || '').trim() || 'a character');
      return who + ': ' + c.description.trim();
    });
  if (hasPhotoSelf) charTextParts.unshift('the dreamer ("me") appears as shown in the reference photo');
  if (charTextParts.length) parts.push('Characters — ' + charTextParts.join('; '));

  if (CAMERA_MODIFIERS[cameraView]) parts.push(CAMERA_MODIFIERS[cameraView]);

  var sceneryBits = [SCENERY_TIME_MODIFIERS[sceneryTime], SCENERY_PLACE_MODIFIERS[sceneryPlace]].filter(Boolean);
  if (sceneryBits.length) parts.push('Setting: ' + sceneryBits.join(', '));

  parts.push(modifier);
  return parts.join(', ') + '.';
}

/**
 * fal's validation-error responses are FastAPI-style: `detail` is an array
 * of { loc, msg, type, input, ... } objects. `input` echoes the entire
 * request back — including, for a self-photo generation, the whole
 * base64-encoded reference photo — so the raw structure must never reach
 * the user (it used to: JSON.stringify(message) dumped all of it into the
 * failure screen). This extracts just the short msg text from each item,
 * and for a content_policy_violation specifically — the case that matters
 * most, since fal's own msg text doesn't explain what to change — replaces
 * it with a short, actionable explanation instead.
 */
function humanizeFalDetail(detail) {
  if (!Array.isArray(detail)) return null;
  var messages = detail.map(function (item) {
    if (!item) return null;
    if (item.type === 'content_policy_violation') {
      var onPhoto = Array.isArray(item.loc) && item.loc.indexOf('image_urls') !== -1;
      return onPhoto
        ? "The reference photo was flagged by the safety system — this usually happens when the photo appears to show a child or teen. For that character, switch to Describe (text) instead of a photo."
        : 'The description was flagged by the safety system. This usually happens when a real photo is combined with a description of a minor, or another sensitive detail — try removing age or other identifying details, or switch to a non-photorealistic style.';
    }
    return typeof item.msg === 'string' ? item.msg : null;
  }).filter(Boolean);
  return messages.length ? messages.join(' ') : null;
}

/** Extracts a safe, human-readable message from a fal error response — never the raw detail/input structure. */
function falErrorMessage(data) {
  var rawDetail = data && (data.detail || data.error);
  return humanizeFalDetail(rawDetail) || (typeof rawDetail === 'string' ? rawDetail : null) || 'fal_request_failed';
}

var FAL_MODEL = 'fal-ai/veo3.1/fast';
var FAL_API_BASE = 'https://queue.fal.run';

// GENERATION_TEST_DURATION (see the "Mock mode & test-duration override" doc
// block below and docs/TESTING.md): lets a human deliberately trade video
// length for cost on a genuinely *real* fal.ai call. fal's Veo 3.1 Fast
// (and its reference-to-video variant, same underlying model) only accept
// these three duration presets — confirmed against fal's current API docs
// (2026-07) — not arbitrary values like "1s", so an unset or invalid
// override silently falls back to the untouched default ("8s") rather than
// risk sending fal a value it would reject.
var VALID_TEST_DURATIONS = ['4s', '6s', '8s'];
var DEFAULT_DURATION = '8s';
function resolveDuration() {
  var override = (process.env.GENERATION_TEST_DURATION || '').trim();
  return VALID_TEST_DURATIONS.indexOf(override) !== -1 ? override : DEFAULT_DURATION;
}

/**
 * Active path. Submits a fal.ai queue job and returns "fal:<model>:<request_id>".
 * generateAudio maps straight to fal's own `generate_audio` boolean
 * (confirmed via fal.ai's model API docs, 2026-07-20 — not guessed; same
 * param name and default (true) on both this model and the reference-to-
 * video variant below). Defaults true (fal's own default) when the caller
 * doesn't pass one — only generate-video.js's handler ever passes false,
 * and only when the prompt caption was condensed (see
 * lib/prompt-condenser.js) — narrating a condensed version would voice
 * words the user never actually wrote.
 */
async function callFal(prompt, falKey, duration, generateAudio) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      prompt: prompt,
      aspect_ratio: '9:16',
      duration: duration || DEFAULT_DURATION,
      resolution: '720p',
      generate_audio: generateAudio !== false
    })
  });

  var data = await res.json();

  if (!res.ok) {
    return { ok: false, statusCode: res.status, error: falErrorMessage(data) };
  }

  return { ok: true, operationName: 'fal:' + FAL_MODEL + ':' + data.request_id };
}

var FAL_MODEL_REFERENCE_TO_VIDEO = 'fal-ai/veo3.1/fast/reference-to-video';

/**
 * Active path when a self character has an uploaded photo. image_urls is a
 * *list* of subject-identity references (fal blends the referenced
 * person's appearance into whatever the text prompt describes) — not a
 * single starting frame, so this is deliberately image_urls: [photo], not
 * the image_url singular that image-to-video takes. fal.ai accepts a
 * base64 data URI directly (it decodes the file for you), so the client's
 * stored photoDataUrl is passed through as-is, no separate upload step
 * needed.
 *
 * video-status.js needs no changes for this: its falAppBase() already
 * derives the polling path from just the first two model segments
 * ("fal-ai/veo3.1"), which is identical across every veo3.1 variant.
 */
async function callFalReferenceToVideo(prompt, imageDataUrl, falKey, duration, generateAudio) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL_REFERENCE_TO_VIDEO, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      prompt: prompt,
      image_urls: [imageDataUrl],
      aspect_ratio: '9:16',
      duration: duration || DEFAULT_DURATION,
      resolution: '720p',
      generate_audio: generateAudio !== false
    })
  });

  var data = await res.json();

  if (!res.ok) {
    return { ok: false, statusCode: res.status, error: falErrorMessage(data) };
  }

  return { ok: true, operationName: 'fal:' + FAL_MODEL_REFERENCE_TO_VIDEO + ':' + data.request_id };
}

// Unused fallback path — kept in case a future feature wants literal photo
// animation (e.g. "bring this exact photo to life") rather than using a
// photo's subject within an independently-described scene, which is what
// the self-photo character feature actually needs (see
// callFalReferenceToVideo above, the active path for that).
var FAL_MODEL_IMAGE_TO_VIDEO = 'fal-ai/veo3.1/fast/image-to-video';
async function callFalImageToVideo(prompt, imageDataUrl, falKey) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL_IMAGE_TO_VIDEO, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      prompt: prompt,
      image_url: imageDataUrl,
      aspect_ratio: '9:16',
      duration: '8s',
      resolution: '720p'
    })
  });

  var data = await res.json();

  if (!res.ok) {
    return { ok: false, statusCode: res.status, error: falErrorMessage(data) };
  }

  return { ok: true, operationName: 'fal:' + FAL_MODEL_IMAGE_TO_VIDEO + ':' + data.request_id };
}

// Unused fallback path — the previous active integration, fal.ai's wan
// v2.2-5b. num_frames maxes out at 161, so 161 frames @ 23fps gives an exact
// 7.0s video if this is ever switched back to.
var FAL_MODEL_WAN = 'fal-ai/wan/v2.2-5b/text-to-video';
async function callFalWan(prompt, falKey) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL_WAN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      prompt: prompt,
      aspect_ratio: '9:16',
      num_frames: 161,
      frames_per_second: 23
    })
  });

  var data = await res.json();

  if (!res.ok) {
    return { ok: false, statusCode: res.status, error: falErrorMessage(data) };
  }

  return { ok: true, operationName: 'fal:' + FAL_MODEL_WAN + ':' + data.request_id };
}

/** Unused fallback path — the original direct Veo 3.1 Lite integration via the Gemini API. */
var VEO_MODEL = 'veo-3.1-lite-generate-preview';
var VEO_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function callVeoDirect(prompt, apiKey) {
  var res = await fetch(VEO_API_BASE + '/models/' + VEO_MODEL + ':predictLongRunning', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      instances: [{ prompt: prompt }],
      parameters: {
        aspectRatio: '9:16',
        durationSeconds: 8
      }
    })
  });

  var data = await res.json();

  if (!res.ok) {
    var message = (data && data.error && data.error.message) || 'veo_request_failed';
    return { ok: false, statusCode: res.status, error: message };
  }

  return { ok: true, operationName: data.name };
}

// Error codes (E1xx = this function). Each is embedded as a "E1NN: " prefix
// on the error string returned to the client, so a user hitting a failure
// can report the number and it maps to exactly one line of code — see
// js/store.js and processing.html for how the codes flow through to the
// failure screen, and video-status.js for the E2xx range covering
// generation-time (as opposed to submission-time) failures.
//   E101 method_not_allowed        — wrong HTTP verb (shouldn't happen from the app itself)
//   E102 missing_api_key           — FAL_KEY not configured in this environment
//   E103 invalid_json              — request body wasn't valid JSON
//   E104 caption_and_style_required
//   E105 fal rejected the text-to-video submission (bad params, content policy, rate limit, etc.)
//   E106 fal rejected the reference-to-video submission (same causes, self-photo path)
//   E107 couldn't reach fal at all (network failure before any response came back)
//   E109 rate_limited              — MAX_GENERATIONS_PER_IP_PER_DAY (or the same cap per-email)
//                                     exceeded for today. Cost/abuse safety net, unrelated to E112's
//                                     token balance below — see lib/rate-limit.js.
//   E110 daily_spend_cap_exceeded  — DAILY_SPEND_CAP_USD circuit breaker tripped for today. A
//                                     backstop against runaway cost, not a replacement for E109's
//                                     rate limiting or E112's token gate — see lib/spend-guard.js.
//   E112 insufficient_tokens       — the request's email (see lib/entitlements.js's getTokenStatus)
//                                     has fewer than 100 tokens (the flat cost of one generation,
//                                     uniformly for a brand-new generation, an edit/regenerate, and a
//                                     style change — all three funnel through this same handler via
//                                     processing.html's runGeneration(), so there's exactly one
//                                     enforcement point). UNCONDITIONAL — this check always runs, for
//                                     every request with (or without) an email, with no flag to turn
//                                     it off and no owner bypass. That's a deliberate difference from
//                                     the old E108/E111 subscription-paywall gate this replaces: that
//                                     one stayed default-off until a real Stripe checkout existed,
//                                     because being entitled there required having actually paid.
//                                     Here every token anyone can spend is free-earned (200 on first
//                                     read of a never-before-seen email, +100 every 24h — see
//                                     getTokenStatus) until shop.html's token packs go live, so
//                                     there's no "before checkout exists" state to protect against —
//                                     this is a cost/usage safeguard, not a payment gate, and nobody
//                                     is ever hard-blocked forever (the daily drip guarantees
//                                     continued access), just rate-limited to a sustainable free
//                                     tier. A request with no email at all has no way to be
//                                     identified for a balance, so it's treated as balance 0 (blocked)
//                                     — see the handler below.
//
// Mock mode & test-duration override — see docs/TESTING.md for the full
// writeup and AGENT_POLICY.md's "Never spend real generation cost on
// testing" standing rule this exists to make achievable. Two independent
// dev/test-only env vars, deliberately different in both cost and how they
// behave:
//   - GENERATION_MOCK_MODE==="true": every real fal.ai call is skipped
//     entirely (no FAL_KEY read, no network call to fal at all — zero
//     cost). All the checks above this point (validation, rate limit,
//     token balance, spend guard) still run unchanged, and a mock success
//     still spends 100 tokens exactly like a real one (see spendTokens
//     below), so mock mode is only ever a stand-in for the model call
//     itself, never a way to bypass the guardrails those checks exist to
//     test. Produces a fake
//     "mock:<startedAtMs>:<id>" operationName in the same response shape
//     the real path returns, which video-status.js (see that file)
//     recognizes and resolves to a real, working sample video after a
//     short simulated delay — so the rest of the app's flow (polling UI,
//     finalizeDream, duration probing, Explore/Profile rendering) gets
//     exercised end-to-end against a real video URL, at zero fal.ai cost.
//   - GENERATION_TEST_DURATION="4s"|"6s"|"8s": makes a genuinely *real*
//     fal.ai call (still spends real money — per AGENT_POLICY.md this
//     still needs explicit human confirmation before use), just at a
//     shorter, cheaper duration than the hardcoded 8s default. fal bills
//     Veo 3.1 Fast per second, so "4s" is roughly half the cost of the
//     default. See resolveDuration() above.
// If both are somehow set at once, GENERATION_MOCK_MODE always wins —
// structurally, not by extra precedence logic: the mock branch below
// returns before GENERATION_TEST_DURATION (or falKey, or any real fal
// call) is ever read. THIS MUST STAY DEFAULT-OFF/UNSET IN PRODUCTION:
// GENERATION_MOCK_MODE=true would silently stop every real user's
// generation from producing a real video.
var crypto = require('crypto');
var rateLimit = require('./lib/rate-limit');
var spendGuard = require('./lib/spend-guard');
var entitlements = require('./lib/entitlements');
var promptCondenser = require('./lib/prompt-condenser');

/** Fake but obviously-non-real operationName for GENERATION_MOCK_MODE — see doc block above. The embedded timestamp lets video-status.js resolve "done" purely from elapsed wall-clock time, with no server-side memory needed (see that file's checkMockStatus). */
function mockOperationName() {
  return 'mock:' + Date.now() + ':' + crypto.randomUUID();
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E101: method_not_allowed' }) };
  }

  // GENERATION_MOCK_MODE (see the doc block above and docs/TESTING.md) skips
  // every real fal.ai call, so FAL_KEY isn't required at all in that mode —
  // deliberately checked with the exact string "true" (never a truthy-ish
  // value) to match this codebase's other boolean-flag env vars
  // (PAYWALL_ENABLED, etc.), so nothing flips this on by accident.
  var mockMode = process.env.GENERATION_MOCK_MODE === 'true';

  var falKey = process.env.FAL_KEY;
  if (!mockMode && !falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E102: missing_api_key' }) };
  }

  var caption, style, characters, cameraView, sceneryTime, sceneryPlace, email;
  try {
    var payload = JSON.parse(event.body || '{}');
    caption = (payload.caption || '').trim();
    style = (payload.style || '').trim();
    characters = Array.isArray(payload.characters) ? payload.characters : [];
    cameraView = payload.cameraView || null;
    sceneryTime = payload.sceneryTime || null;
    sceneryPlace = payload.sceneryPlace || null;
    email = entitlements.normalizeEmail(payload.email);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E103: invalid_json' }) };
  }

  if (!caption || !style) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E104: caption_and_style_required' }) };
  }

  // --- Guardrails below: rate limiting (E109), the token gate (E112), and
  // the spend circuit breaker (E110) — all unconditional, see the doc block
  // above for each.

  var maxPerDay = parseInt(process.env.MAX_GENERATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 20;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E109: rate_limited: too many generations from this network today, try again tomorrow' }) };
  }
  if (email) {
    var emailLimit = await rateLimit.checkAndIncrement(event, 'email', email, maxPerDay);
    if (!emailLimit.allowed) {
      return { statusCode: 429, body: JSON.stringify({ error: 'E109: rate_limited: too many generations from this account today, try again tomorrow' }) };
    }
  }

  // E112 — unconditional token-balance gate, see the doc block above for
  // why this always runs (no flag, no owner bypass), unlike the E108/E111
  // subscription-paywall gate this replaces. A request with no email can't
  // be identified for a balance at all, so it reads as balance 0 (blocked)
  // via getTokenStatus's own empty-email guard rather than a special case
  // here.
  var tokenStatus = await entitlements.getTokenStatus(event, email);
  if (tokenStatus.balance < 100) {
    return { statusCode: 402, body: JSON.stringify({ error: 'E112: insufficient_tokens: not enough tokens to generate a video' }) };
  }

  var dailyCapUsd = parseFloat(process.env.DAILY_SPEND_CAP_USD);
  if (!dailyCapUsd || dailyCapUsd <= 0) dailyCapUsd = 50;

  var spendCheck = await spendGuard.checkAndReserve(event, dailyCapUsd);
  if (!spendCheck.allowed) {
    return { statusCode: 503, body: JSON.stringify({ error: 'E110: daily_spend_cap_exceeded: generation is paused for today, try again tomorrow' }) };
  }

  // Mock mode returns here, after every guardrail above has already run
  // exactly as it does on the real path — see the doc block above. Nothing
  // below this point (buildPrompt, the self-photo check, FAL_MODEL,
  // GENERATION_TEST_DURATION, the actual fal.ai call) is ever reached.
  if (mockMode) {
    // Spends tokens exactly like a real submission — see spendTokens' own
    // doc comment for why a rejection (E105-E107) never reaches this point
    // but every 200 does, mock or real.
    await entitlements.spendTokens(event, email, 100);
    return { statusCode: 200, body: JSON.stringify({ operationName: mockOperationName() }) };
  }

  // Long captions get cut off mid-narrative otherwise: the model only has
  // a fixed ~8s clip to work with (see resolveDuration above) and just
  // renders as far as it gets before running out of time, rather than
  // covering the whole description. condenseIfNeeded (see
  // lib/prompt-condenser.js) leaves short captions untouched — this is a
  // no-op, no extra cost, for the common case — and only replaces long
  // ones with a condensed version *for the fal.ai prompt specifically*.
  // The `caption` variable itself (and everything derived from it that
  // isn't `prompt`) is never touched, so what the UI displays back to the
  // user (result.html, Explore, everywhere) always stays exactly what
  // they typed — same rule this app already applies to the Advanced/
  // character fields never leaking into the visible caption.
  var condensed = await promptCondenser.condenseIfNeeded(caption, process.env.GEM_API_KEY);
  if (condensed.error) {
    // Never fatal — falls back to the original (long) caption, same as if
    // it had been short enough already. Logged only for operational
    // visibility into how often this path is failing.
    console.warn('prompt-condenser: ' + condensed.error);
  }
  // Narration would voice whatever the video's audio track says, and for
  // a condensed prompt that's no longer the user's own words verbatim —
  // there is no honest way to narrate a version of the text they didn't
  // actually write. Only disabled when text was actually replaced
  // (condensed.wasCondensed) — a short caption sent as-is, or a long one
  // that failed to condense and fell back to the untouched original, both
  // narrate the user's real words, so audio stays on for those exactly
  // like before this change.
  var generateAudio = !condensed.wasCondensed;

  var prompt = buildPrompt(condensed.text, style, characters, cameraView, sceneryTime, sceneryPlace);
  var selfPhoto = characters.filter(function (c) { return c && c.isSelf && c.photoDataUrl; })[0];
  var duration = resolveDuration();

  try {
    var result = selfPhoto
      ? await callFalReferenceToVideo(prompt, selfPhoto.photoDataUrl, falKey, duration, generateAudio)
      : await callFal(prompt, falKey, duration, generateAudio);
    if (!result.ok) {
      // No real spend happened — a rejected submission must NOT spend
      // tokens, so spendTokens is deliberately not called on this path
      // (see the E112 doc block above).
      var rejectCode = selfPhoto ? 'E106' : 'E105';
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: rejectCode + ': ' + result.error }) };
    }
    await entitlements.spendTokens(event, email, 100);
    return { statusCode: 200, body: JSON.stringify({ operationName: result.operationName }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E107: fal_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};
