// netlify/functions/generate-image.js
//
// POST { caption, style, characters?, cameraView?, sceneryTime?, sceneryPlace?, email?, turnstileToken?, ownerBypassToken? }
// -> kicks off a cheap image generation job and returns an operationName the
// client can poll via image-status.js.
//
// ownerBypassToken (optional) — mirrors generate-video.js's own handling
// exactly, see that file's "OWNER BYPASS" doc block and
// lib/owner-bypass.js's header comment for the full mechanism. Same
// narrow scope here: only skips the E409 per-IP/per-email rate-limit
// checks and the token-init per-IP cap — never E412 (the token-balance
// gate) or E410 (spendGuard.checkAndReserve), both unconditional either
// way.
//
// Mirrors generate-video.js's structure and guardrail order (Turnstile ->
// per-IP/email rate limit -> token gate -> spend-guard circuit breaker ->
// the actual fal.ai call) almost exactly — see that file's own header
// comment for the shared reasoning behind each guardrail. Deliberately a
// SEPARATE function/model/cost, not a flag on generate-video.js, matching
// this codebase's existing "one function per distinct fal.ai call shape"
// convention (see start-pending-generation.js's own header comment making
// the same call for its pre-signup path).
//
// See docs/IMAGE_GENERATION_SPEC.md for the full design + economics this
// implements — §2a (model choice/pricing), §2b-revised (token numbers),
// §4 (exact file list), §6 (the "Turn this into a video" upsell that
// consumes this function's output via generate-video.js's sourceImageUrl).
//
// ACTIVE PATH: fal.ai's flux/dev (fal-ai/flux/dev), text-to-image. Real,
// current fal.ai pricing (fetched 2026-07-24, quoted verbatim off the model
// page): "$0.025 per megapixel, billed by rounding up to the nearest
// megapixel." At the portrait_16_9 preset used here (~1-2MP), roughly
// $0.025-$0.05/image — 30-60x cheaper than a ~$0.80-1.60 video.
//
// image_size: 'portrait_16_9' (fal's own built-in enum) matches this app's
// existing 9:16 video aspect ratio (generate-video.js always sends
// aspect_ratio: '9:16') and clears fal-ai/veo3.1/fast/image-to-video's own
// "720p or higher, 16:9 or 9:16" input requirement for the later "Turn this
// into a video" upsell — that call passes this function's own returned
// imageUrl straight through as image_url (see generate-video.js's
// callFalImageToVideo), no re-hosting/new storage needed per fal's own
// documented >=7-day file retention (see docs/IMAGE_GENERATION_SPEC.md §2a).
//
// Known limitation, not a bug: flux/dev is pure text-to-image, with no
// photo-conditioning support — an isSelf character defined only by a photo
// (no text description) can't be reflected in the generated image the way
// the video path's reference-to-video model can. buildImagePrompt below
// therefore omits the "the dreamer appears as shown in reference photo"
// pointer line entirely (a text prompt referencing a photo this model never
// sees would just confuse it) — see IMAGE_GENERATION_SPEC.md §6's own
// known-limitation writeup for the full reasoning and the flagged future
// follow-up (a photo-conditioned flux variant), explicitly out of scope here.

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
 * enrichment into the prompt actually sent to the image model — the same
 * enrichment generate-video.js's buildPrompt applies, minus the
 * reference-photo pointer line (see the header comment above for why: this
 * model has no photo-conditioning path at all, unlike the video side's
 * reference-to-video model). Deliberately duplicated rather than shared —
 * matches this codebase's existing "each Netlify function is self-
 * contained" convention (see video-status.js's own header comment making
 * the same call for its duplicated falErrorMessage/humanizeFalDetail).
 *
 * Unlike generate-video.js's buildPrompt, a character's text description is
 * included here EVEN when photoDataUrl is also set — this model never sees
 * the photo at all (no photo-conditioning path, see header comment above),
 * so a photo-having self character with no text description would
 * otherwise get zero appearance information in the prompt. Only the
 * reference-photo pointer LINE is skipped (a line pointing at an image this
 * model never receives would just confuse it) — the description itself is
 * never gated on photoDataUrl.
 */
function buildImagePrompt(caption, style, characters, cameraView, sceneryTime, sceneryPlace) {
  var modifier = STYLE_MODIFIERS[style] || ('in a ' + style + ' animation style');
  var parts = [caption];

  var charTextParts = (characters || [])
    .filter(function (c) { return c && typeof c.description === 'string' && c.description.trim(); })
    .map(function (c) {
      var who = c.isSelf ? 'the dreamer ("me")' : ((c.name || '').trim() || 'a character');
      return who + ': ' + c.description.trim();
    });
  if (charTextParts.length) parts.push('Characters — ' + charTextParts.join('; '));

  if (CAMERA_MODIFIERS[cameraView]) parts.push(CAMERA_MODIFIERS[cameraView]);

  var sceneryBits = [SCENERY_TIME_MODIFIERS[sceneryTime], SCENERY_PLACE_MODIFIERS[sceneryPlace]].filter(Boolean);
  if (sceneryBits.length) parts.push('Setting: ' + sceneryBits.join(', '));

  parts.push(modifier);
  return parts.join(', ') + '.';
}

/**
 * fal's validation-error responses are FastAPI-style: `detail` is an array
 * of { loc, msg, type, input, ... } objects. Duplicated from
 * generate-video.js rather than shared — see that file's own copy for the
 * full reasoning (input can echo request data back that must never reach
 * the user); the content_policy_violation "on a photo" branch is dropped
 * here since this model never receives image_urls at all.
 */
function humanizeFalDetail(detail) {
  if (!Array.isArray(detail)) return null;
  var messages = detail.map(function (item) {
    if (!item) return null;
    if (item.type === 'content_policy_violation') {
      return 'The description was flagged by the safety system. This usually happens when a description includes a minor, or another sensitive detail — try removing age or other identifying details, or switch to a non-photorealistic style.';
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

var FAL_MODEL_IMAGE_GEN = 'fal-ai/flux/dev';
var FAL_API_BASE = 'https://queue.fal.run';
var IMAGE_SIZE = 'portrait_16_9';

// Disables fal's default media-expiration window on this generation's
// resulting image — tracker item for-product-bug-build-re-host-image-
// drea-0hpbm0: fal's own docs (docs.fal.ai/model-apis/media-expiration)
// confirm generated media is retained "for at least 7 days by default,"
// so without this header every published image dream 404s once fal's own
// CDN copy expires (this handler hands back fal's own image URL directly,
// no re-host step). `expiration_duration_seconds: null` disables expiry
// entirely for the media this specific submission produces. Duplicated
// from generate-video.js's own identical constant rather than shared —
// matches this codebase's existing "each Netlify function is self-
// contained" convention (see this file's own header comment on
// buildImagePrompt/humanizeFalDetail being duplicated for the same
// reason).
var FAL_NO_EXPIRY_HEADER = { 'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: null }) };

/**
 * Active path. Submits a fal.ai queue job and returns "fal:<model>:<request_id>",
 * the exact same operationName shape generate-video.js's callFal uses (just
 * a different model id) — image-status.js parses it identically.
 */
async function callFalImage(prompt, falKey) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL_IMAGE_GEN, {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    }, FAL_NO_EXPIRY_HEADER),
    body: JSON.stringify({
      prompt: prompt,
      image_size: IMAGE_SIZE
    })
  });

  var data = await res.json();

  if (!res.ok) {
    return { ok: false, statusCode: res.status, error: falErrorMessage(data) };
  }

  return { ok: true, operationName: 'fal:' + FAL_MODEL_IMAGE_GEN + ':' + data.request_id };
}

// Error codes (E4xx = this function — the next free hundred-range after
// generate-video.js's E1xx). Deliberately not every number in the range is
// used — this function has no self-photo/reference-to-video-style second
// submission path the way generate-video.js does, so there's no E406
// equivalent, and no separate "empty/malformed fal response shape" split
// the way video-status.js's E2xx range has (E408/E411 likewise unused) —
// see docs/IMAGE_GENERATION_SPEC.md §4 for the exact list this mirrors:
//   E401 method_not_allowed        — wrong HTTP verb
//   E402 missing_api_key           — FAL_KEY not configured (mock mode exempt)
//   E403 invalid_json              — request body wasn't valid JSON
//   E404 caption_and_style_required
//   E405 fal rejected the submission (bad params, content policy, rate limit, etc.)
//   E407 couldn't reach fal at all (network failure before any response came back)
//   E409 rate_limited              — same per-IP/per-email daily cap as generate-video.js's E109
//   E410 daily_spend_cap_exceeded  — same circuit breaker as generate-video.js's E110
//   E412 insufficient_tokens       — balance < 10 (the flat cost of one image) — see
//                                     lib/entitlements.js. Unconditional, same as generate-video.js's
//                                     E112 — no flag, no owner bypass.
//   E413 turnstile_verification_failed — same conditional check as generate-video.js's E113
//
// Mock mode: see generate-video.js's own "Mock mode & test-duration
// override" doc block and docs/TESTING.md — identical discipline here.
// GENERATION_MOCK_MODE==="true" skips every real fal.ai call entirely (no
// FAL_KEY read, no network call), every guardrail above that point still
// runs unchanged, and a mock success still spends 10 tokens exactly like a
// real one.
var crypto = require('crypto');
var rateLimit = require('./lib/rate-limit');
var spendGuard = require('./lib/spend-guard');
var entitlements = require('./lib/entitlements');
var turnstile = require('./lib/turnstile');
var jobOwners = require('./lib/job-owners');
var ownerBypass = require('./lib/owner-bypass');
var effectiveConfig = require('./lib/effective-config');

// Logs this function's resolved rate-limit/cost-control config once per
// cold start (tracker item for-product-damage-assessment-env-var-ca-
// rmgaqh — see lib/effective-config.js's own doc block for the full
// "why"). Module-level, NOT inside exports.handler below, so this runs
// exactly once when Node first requires this file (a cold start), never
// once per request. Values/defaults mirrored from this file's own
// maxPerDay/dailyCapUsd lines further down — see that file's doc comment
// on why this is a deliberate, independent duplication rather than a
// shared resolver.
effectiveConfig.logEffectiveConfigOnce('generate-image', [
  { envVar: 'MAX_GENERATIONS_PER_IP_PER_DAY', default: 40, type: 'int' },
  { envVar: 'DAILY_SPEND_CAP_USD', default: 50, type: 'float' }
]);

/** Mirrors generate-video.js's own recordJobOwnerBestEffort exactly — see that function's doc comment and lib/job-owners.js's header comment for the full mechanism. Records mediaType:'image' (this file's only kind) so mark-generation-completed.js can keep the first-dream retention email video-only when it fires automatically. */
async function recordJobOwnerBestEffort(event, operationName, email) {
  try {
    await jobOwners.recordJobOwner(event, operationName, email, 'image');
  } catch (e) {
    console.error('generate-image: failed to record job owner (refund auth binding) for ' + operationName + ' — a later refund attempt for this job will fail closed', e);
  }
}

var IMAGE_TOKEN_COST = 10;

var TURNSTILE_SECRET_PLACEHOLDER = 'REPLACE_WITH_REAL_TURNSTILE_SECRET_KEY';

/** Fake but obviously-non-real operationName for GENERATION_MOCK_MODE — same shape/reasoning as generate-video.js's mockOperationName. */
function mockOperationName() {
  return 'mock:' + Date.now() + ':' + crypto.randomUUID();
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E401: method_not_allowed' }) };
  }

  var mockMode = process.env.GENERATION_MOCK_MODE === 'true';

  var falKey = process.env.FAL_KEY;
  if (!mockMode && !falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E402: missing_api_key' }) };
  }

  var caption, style, characters, cameraView, sceneryTime, sceneryPlace, email, turnstileToken, ownerBypassToken;
  try {
    var payload = JSON.parse(event.body || '{}');
    caption = (payload.caption || '').trim();
    style = (payload.style || '').trim();
    characters = Array.isArray(payload.characters) ? payload.characters : [];
    cameraView = payload.cameraView || null;
    sceneryTime = payload.sceneryTime || null;
    sceneryPlace = payload.sceneryPlace || null;
    email = entitlements.normalizeEmail(payload.email);
    turnstileToken = typeof payload.turnstileToken === 'string' ? payload.turnstileToken : null;
    ownerBypassToken = typeof payload.ownerBypassToken === 'string' ? payload.ownerBypassToken : null;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E403: invalid_json' }) };
  }

  if (!caption || !style) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E404: caption_and_style_required' }) };
  }

  var ip = rateLimit.clientIp(event);

  var turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret && turnstileSecret !== TURNSTILE_SECRET_PLACEHOLDER) {
    var turnstileResult = await turnstile.verify(turnstileToken, turnstileSecret, ip);
    if (!turnstileResult.success) {
      return { statusCode: 403, body: JSON.stringify({ error: 'E413: turnstile_verification_failed' + (turnstileResult.reason ? ': ' + turnstileResult.reason : '') }) };
    }
  }

  // Owner bypass resolution — mirrors generate-video.js's own handling
  // exactly, see that file's "OWNER BYPASS" doc block. A missing/invalid/
  // expired token leaves ownerBypassActive false, same as if this feature
  // didn't exist for every request that isn't the founder's own verified
  // session.
  //
  // REVIEW FIX (round 1): the token is bound to a specific email at
  // issuance (lib/owner-bypass.js's createBypassToken) — a live token
  // alone is not enough, THIS request's own (normalized) email must match
  // the token's bound email, or the bypass never activates. See
  // generate-video.js's own identical comment for the full reasoning (a
  // leaked/replayed token must not be usable against an arbitrary email).
  var ownerBypassActive = false;
  if (ownerBypassToken) {
    var bypassCheck = await ownerBypass.verifyBypassToken(event, ownerBypassToken);
    ownerBypassActive = !!(bypassCheck.ok && email && bypassCheck.email === email);
  }

  var maxPerDay = parseInt(process.env.MAX_GENERATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40; // default 40 (founder directive 2026-07-29); env MAX_GENERATIONS_PER_IP_PER_DAY overrides

  if (!ownerBypassActive) {
    var ipLimit = await rateLimit.checkAndIncrement(event, 'ip', ip, maxPerDay);
    if (!ipLimit.allowed) {
      return { statusCode: 429, body: JSON.stringify({ error: 'E409: rate_limited: too many generations from this network today, try again tomorrow' }) };
    }
    if (email) {
      var emailLimit = await rateLimit.checkAndIncrement(event, 'email', email, maxPerDay);
      if (!emailLimit.allowed) {
        return { statusCode: 429, body: JSON.stringify({ error: 'E409: rate_limited: too many generations from this account today, try again tomorrow' }) };
      }
    }
  }

  // E412 — unconditional token-balance gate, same shape/reasoning as
  // generate-video.js's E112 (see that file's doc block) — just a 10-token
  // threshold instead of 100. ownerBypassActive is forwarded ONLY to let a
  // brand-new email's first-ever grant skip the token-init per-IP cap (see
  // entitlements.getTokenStatus's own doc comment) — it never changes the
  // `< IMAGE_TOKEN_COST` comparison below. A request with no email can't
  // be identified for a balance at all, so it reads as balance 0 (blocked).
  var tokenStatus = await entitlements.getTokenStatus(event, email, { ownerBypass: ownerBypassActive });
  if (tokenStatus.balance < IMAGE_TOKEN_COST) {
    return { statusCode: 402, body: JSON.stringify({ error: 'E412: insufficient_tokens: not enough tokens to generate an image' }) };
  }

  var dailyCapUsd = parseFloat(process.env.DAILY_SPEND_CAP_USD);
  if (!dailyCapUsd || dailyCapUsd <= 0) dailyCapUsd = 50;

  var spendCheck = await spendGuard.checkAndReserve(event, dailyCapUsd);
  if (!spendCheck.allowed) {
    return { statusCode: 503, body: JSON.stringify({ error: 'E410: daily_spend_cap_exceeded: generation is paused for today, try again tomorrow' }) };
  }

  // Mock mode returns here, after every guardrail above has already run
  // exactly as it does on the real path — see generate-video.js's own doc
  // block for the full reasoning. Nothing below this point (buildImagePrompt,
  // FAL_MODEL_IMAGE_GEN, the actual fal.ai call) is ever reached.
  if (mockMode) {
    await entitlements.spendTokens(event, email, IMAGE_TOKEN_COST);
    var mockOpName = mockOperationName();
    await recordJobOwnerBestEffort(event, mockOpName, email);
    return { statusCode: 200, body: JSON.stringify({ operationName: mockOpName }) };
  }

  var prompt = buildImagePrompt(caption, style, characters, cameraView, sceneryTime, sceneryPlace);

  try {
    var result = await callFalImage(prompt, falKey);
    if (!result.ok) {
      // No real spend happened — a rejected submission must NOT spend
      // tokens, matching generate-video.js's own E105/E106 discipline.
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: 'E405: ' + result.error }) };
    }
    await entitlements.spendTokens(event, email, IMAGE_TOKEN_COST);
    await recordJobOwnerBestEffort(event, result.operationName, email);
    return { statusCode: 200, body: JSON.stringify({ operationName: result.operationName }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E407: fal_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};

// Named exports below are purely additive, mirroring generate-video.js's
// own named-export convention (see that file's tail comment) — every
// function here is a plain, already-pure top-level declaration.
exports.buildImagePrompt = buildImagePrompt;
exports.callFalImage = callFalImage;
exports.falErrorMessage = falErrorMessage;
exports.FAL_MODEL_IMAGE_GEN = FAL_MODEL_IMAGE_GEN;
exports.IMAGE_TOKEN_COST = IMAGE_TOKEN_COST;
exports.FAL_NO_EXPIRY_HEADER = FAL_NO_EXPIRY_HEADER;
