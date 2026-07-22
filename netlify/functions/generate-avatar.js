// netlify/functions/generate-avatar.js
//
// POST { description } -> { photoDataUrl } | { error }
//
// No email field — unlike generate-video.js, there's no per-email rate
// limit or token balance to key off here (see the "Deliberately NOT the
// same as generate-video.js" section below), so nothing on this endpoint
// ever needs to know who's signed in.
//
// Generates a real avatar image from a text description for the "Me"
// character's Describe option (profile.html's identity-edit sheet and
// create.html's self-mode "Add/Edit yourself" character sheet — both call
// this the moment the user saves while Describe mode is selected, see each
// page's identity-save-btn/char-save-btn handler). Previously "Describe"
// only ever stored the typed text as `description` and never produced an
// actual image, leaving the avatar blank — this is what makes it real.
//
// The returned photoDataUrl is stored via the exact same
// DreamStore.saveCharacter({isSelf:true, photoDataUrl, ...}) path
// "Upload photo" already uses (see js/store.js), so a generated avatar is
// indistinguishable, storage-wise, from an uploaded one — the existing
// profile.html<->create.html bidirectional sync and generate-video.js's
// reference-to-video path (see that file's callFalReferenceToVideo) both
// work unchanged, no new plumbing needed. The typed description text is
// still stored alongside it (unlike an uploaded photo, which clears
// description to '' — see each page's save handler) purely so reopening
// the sheet in Describe mode shows the user's original words if they want
// to tweak and regenerate, not because it's used in the video-generation
// prompt (buildPrompt in generate-video.js already skips text description
// for any character that has a photoDataUrl, self or not).
//
// ---- Deliberately NOT the same as generate-video.js in two ways ----
//
// 1. NO TOKEN COST. Per the founder's explicit instruction ("should be
//    very cheap so enable it without using tokens of users"), this handler
//    never imports or calls into lib/entitlements.js at all — no balance
//    check, no spendTokens, no E112-style gate. Generating one avatar image
//    costs a fraction of a cent (see the model-choice note below), nothing
//    like a $0.80-1.60 video generation, so gating it behind the same
//    100-token cost that exists specifically to ration video generation
//    would be pointless friction for something this cheap.
// 2. NO lib/spend-guard.js. That breaker's cost-per-reservation is
//    hardcoded to generate-video.js's own flat $1.60/call estimate (see
//    that file's ESTIMATED_COST_PER_GENERATION_USD) and isn't parameterized
//    for a different per-call cost — reusing it as-is here would either
//    require changing its shared estimate (wrong for video) or would
//    massively overstate this endpoint's real cost. The per-IP daily cap
//    below is this endpoint's real guardrail: at flux/schnell's ~$0.003/
//    image, even a fully-maxed-out daily cap across many IPs stays a
//    trivial dollar amount, unlike video where a single slipped-through
//    request is a real line item.
//
// Still gets its own real abuse protection though, since this is a genuine
// paid third-party API call under this app's account: MAX_AVATAR_
// GENERATIONS_PER_IP_PER_DAY via lib/rate-limit.js, same per-IP-per-day
// counter pattern as generate-video.js/track-conversion.js, just its own
// 'avatar-ip' scope so its bucket never shares (or fights over) counts with
// generate-video.js's own 'ip' scope.
//
// ---- Model choice ----
//
// fal-ai/flux/schnell, called via fal's *synchronous direct* endpoint
// (https://fal.run/<model>, NOT https://queue.fal.run/<model> —
// generate-video.js uses the queue because a video job takes minutes and
// needs polling via video-status.js; a 512x512 flux/schnell image finishes
// in well under fal.run's request/response window, so there's no queue/
// poll machinery needed here at all, same reasoning as interpret-dream.js's
// own direct fal.run text-completion call).
//
// Confirmed directly against fal's own model docs and live OpenAPI schema
// (2026-07-22, fetched https://fal.ai/models/fal-ai/flux/schnell/api and
// https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/schnell
// — not guessed):
//   - Pricing: $0.003/megapixel, billed rounding up to the nearest
//     megapixel. A 512x512 image (0.26MP, rounds up to 1MP) costs $0.003 —
//     fal's pricing page lists no image model cheaper than this (the next
//     cheapest listed, Seedream V4, is a flat $0.03/image, 10x more).
//   - image_size accepts a literal {width,height} object (default 512x512)
//     as well as named presets — sent explicitly as {512,512} below to
//     lock in the cheapest 1MP-rounded tier rather than relying on the
//     default staying what it is today.
//   - Response shape: { images: [{url, width, height, content_type}],
//     has_nsfw_concepts: [bool], seed, prompt, timings } — images are
//     returned as a fal-hosted URL, not inline base64, so this handler
//     downloads that URL server-side and re-encodes it as a data: URI
//     before ever returning it to the client (see downloadAsDataUrl) —
//     photoDataUrl is a data: URI everywhere else in this codebase (see
//     create.html/profile.html's resizeImageFile), and a fal-hosted URL
//     isn't guaranteed to stay live indefinitely, so this keeps the
//     contract identical to the upload path rather than introducing a
//     second, remote-URL flavor of photoDataUrl.
//   - Safety: enable_safety_checker (default true, sent explicitly below)
//     does NOT turn a flagged prompt into an HTTP error — it still returns
//     200 with has_nsfw_concepts[i] === true and (per fal's model card) a
//     blacked-out/blurred image in that slot. This handler treats any true
//     entry as a rejection (E6, same humanized-error spirit as
//     generate-video.js's content_policy_violation handling) rather than
//     ever handing that placeholder image back to the client as if it were
//     a real avatar.
//
// A genuine 4xx/5xx from fal (bad request shape, auth failure, etc.) still
// uses FastAPI-style `detail` (string or array-of-{msg,...}) same as
// generate-video.js's queue endpoint — same underlying framework — so
// humanizeFalDetail below mirrors that file's shape-handling, trimmed to
// what's actually reachable here (no image_urls in this request at all,
// so there's no "was it the photo or the text" branch to make).

var rateLimit = require('./lib/rate-limit');

var FAL_AVATAR_MODEL = 'fal-ai/flux/schnell';
var FAL_DIRECT_API_BASE = 'https://fal.run';
var AVATAR_IMAGE_DIM = 512; // 512x512 = 0.26MP, rounds up to fal's cheapest 1MP billing tier

// Soft sanity cap only — flux/schnell is billed per output megapixel, not
// per prompt length, so this isn't a cost control. It's just a defensive
// bound against a pathologically long paste ending up as the entire
// request body; long descriptions are silently truncated, never rejected,
// so this never surfaces as a new error case a user has to react to.
var MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Wraps the user's own appearance text with enough scene-setting for a
 * clean head-and-shoulders avatar, mirroring generate-video.js's buildPrompt
 * in spirit (plain user text + fixed provider-only modifiers, never echoed
 * back to the user or altered in what's stored as `description`).
 */
function buildAvatarPrompt(description) {
  return 'A portrait avatar of a person matching this description: ' + description +
    '. Head-and-shoulders portrait, facing forward, centered, plain simple background, clean digital illustration style.';
}

/**
 * Mirrors generate-video.js's humanizeFalDetail/falErrorMessage, trimmed for
 * this endpoint's own request shape (a text prompt only — no image_urls
 * field ever sent here, so there's nothing analogous to that file's
 * "was it the photo or the text" branch). See that file's own doc comment
 * for why the raw `detail`/`input` structure must never reach the user.
 */
function humanizeFalAvatarDetail(detail) {
  if (!Array.isArray(detail)) return null;
  var messages = detail.map(function (item) {
    if (!item) return null;
    if (item.type === 'content_policy_violation') {
      return 'The description was flagged by the safety system. Try removing age or other sensitive details, or rephrase the description.';
    }
    return typeof item.msg === 'string' ? item.msg : null;
  }).filter(Boolean);
  return messages.length ? messages.join(' ') : null;
}

function falAvatarErrorMessage(data) {
  var rawDetail = data && (data.detail || data.error);
  return humanizeFalAvatarDetail(rawDetail) || (typeof rawDetail === 'string' ? rawDetail : null) || 'fal_request_failed';
}

/**
 * Downloads a fal-hosted image URL and re-encodes it as a data: URI, so
 * this handler's response always carries the same photoDataUrl shape the
 * upload path already produces (a data: URI, never a remote URL) — see the
 * doc block above. Returns null on any failure (network error, non-OK
 * response) rather than throwing, so the caller can surface one clean
 * error message instead of an unhandled rejection.
 */
async function downloadAsDataUrl(url, contentType) {
  try {
    var res = await fetch(url);
    if (!res.ok) return null;
    var buffer = await res.arrayBuffer();
    var base64 = Buffer.from(buffer).toString('base64');
    return 'data:' + (contentType || 'image/jpeg') + ';base64,' + base64;
  } catch (e) {
    return null;
  }
}

/**
 * Active path. Calls fal's synchronous direct endpoint (not the queue —
 * see the doc block above) and returns { ok:true, photoDataUrl } or
 * { ok:false, statusCode, error }. Never throws — network failures are
 * caught by the handler's own try/catch below (E7), same split as
 * generate-video.js's callFal/handler boundary.
 */
async function callFalAvatar(description, falKey) {
  var res;
  try {
    res = await fetch(FAL_DIRECT_API_BASE + '/' + FAL_AVATAR_MODEL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Key ' + falKey
      },
      body: JSON.stringify({
        prompt: buildAvatarPrompt(description),
        image_size: { width: AVATAR_IMAGE_DIM, height: AVATAR_IMAGE_DIM },
        num_images: 1,
        enable_safety_checker: true
      })
    });
  } catch (e) {
    // Network failure before any response came back — infrastructure-ish,
    // not an actionable/content problem, so this is E7 (see the doc block
    // above), same split as generate-video.js's E105/E106 (fal responded,
    // rejected) vs E107 (never reached fal at all).
    return { ok: false, statusCode: 500, code: 'E7', error: 'fal_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') };
  }

  var data = await res.json();

  if (!res.ok) {
    // fal responded but rejected the request (bad params, content policy,
    // etc.) — actionable/humanized, so E6.
    return { ok: false, statusCode: res.status, code: 'E6', error: falAvatarErrorMessage(data) };
  }

  // A flagged prompt is still a 200 here (see the doc block above) — this
  // is this endpoint's own version of generate-video.js's
  // content_policy_violation handling, just triggered by a response flag
  // instead of an error-shaped one. Still E6: fal responded, and this is
  // just as actionable/humanized as the content_policy_violation branch
  // above.
  if (Array.isArray(data.has_nsfw_concepts) && data.has_nsfw_concepts.some(Boolean)) {
    return { ok: false, statusCode: 422, code: 'E6', error: 'The description was flagged by the safety system. Try removing age or other sensitive details, or rephrase the description.' };
  }

  var image = data.images && data.images[0];
  if (!image || !image.url) {
    // fal responded 200 but the response shape wasn't what's documented —
    // an infrastructure-ish surprise, not something rephrasing the
    // description would fix, so E7.
    return { ok: false, statusCode: 502, code: 'E7', error: 'fal_returned_no_image' };
  }

  var photoDataUrl = await downloadAsDataUrl(image.url, image.content_type);
  if (!photoDataUrl) {
    return { ok: false, statusCode: 502, code: 'E7', error: 'avatar_image_download_failed' };
  }

  return { ok: true, photoDataUrl: photoDataUrl };
}

// Error codes (E-series, this function's own — not part of generate-
// video.js's E1xx/video-status.js's E2xx/interpret-dream.js's E4xx numbering,
// since this isn't part of that video-generation pipeline; same simple
// per-function scheme as track-conversion.js/update-tracker-item.js).
//   E1 method_not_allowed        — wrong HTTP verb
//   E2 missing_api_key           — FAL_KEY not configured in this environment (mock mode exempt, see below)
//   E3 invalid_json              — request body wasn't valid JSON
//   E4 description_required      — `description` missing/empty after trim
//   E5 rate_limited              — MAX_AVATAR_GENERATIONS_PER_IP_PER_DAY exceeded for today (per-IP only,
//                                   own 'avatar-ip' rate-limit.js scope — see the doc block above for why
//                                   this is the real guardrail here, not a token/spend gate)
//   E6 fal rejected the prompt, or flagged it as unsafe (content policy, validation, or has_nsfw_concepts)
//   E7 couldn't reach fal at all, or the response couldn't be turned into a photoDataUrl
//      (network failure, no image in the response, or the image download itself failed)
//
// GENERATION_MOCK_MODE (same flag generate-video.js/video-status.js use —
// see docs/TESTING.md — deliberately shared rather than a second avatar-
// specific flag, since it's already this codebase's one standing "don't
// spend real generation cost" switch for the whole app, and a test run
// mocking video but not avatar, or vice versa, isn't a real scenario worth
// a second env var for). "true" (exact string) skips the real fal.ai call
// entirely — no FAL_KEY read, no network call — and returns a small,
// obviously-fake placeholder image in the exact same { photoDataUrl } shape
// the real path returns. Every guardrail above this point (validation, rate
// limit) still runs unchanged.
var MOCK_PHOTO_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var mockMode = process.env.GENERATION_MOCK_MODE === 'true';

  var falKey = process.env.FAL_KEY;
  if (!mockMode && !falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_api_key' }) };
  }

  var description;
  try {
    var payload = JSON.parse(event.body || '{}');
    description = (payload.description || '').trim();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  if (!description) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: description_required' }) };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH);
  }

  var ip = rateLimit.clientIp(event);
  var maxPerDay = parseInt(process.env.MAX_AVATAR_GENERATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40;

  // Own 'avatar-ip' scope — deliberately never shares a bucket with
  // generate-video.js's 'ip' scope (see the doc block above).
  var ipLimit = await rateLimit.checkAndIncrement(event, 'avatar-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E5: rate_limited: too many avatar generations from this network today, try again tomorrow' }) };
  }

  if (mockMode) {
    return { statusCode: 200, body: JSON.stringify({ photoDataUrl: MOCK_PHOTO_DATA_URL }) };
  }

  // callFalAvatar never throws — every failure (network, fal rejection,
  // unexpected response shape, image download) is caught inside it and
  // returned as { ok:false, statusCode, code, error }, so there's no
  // separate try/catch needed here (unlike generate-video.js, which does
  // its own request try/catch at this call site).
  var result = await callFalAvatar(description, falKey);
  if (!result.ok) {
    return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: result.code + ': ' + result.error }) };
  }
  return { statusCode: 200, body: JSON.stringify({ photoDataUrl: result.photoDataUrl }) };
};
