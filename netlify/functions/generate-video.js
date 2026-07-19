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
// for two things, both gated/no-ops until explicitly turned on: a per-email
// rate-limit bucket alongside the always-on per-IP one (see
// netlify/functions/lib/rate-limit.js), and — only when
// PAYWALL_ENABLED==="true" — the entitlement check itself (see
// netlify/functions/lib/entitlements.js and docs/PAYWALL_SETUP.md).
//
// All of the above are folded into the prompt sent to the model (see
// buildPrompt) but never echoed back — the caption the UI displays is
// whatever the caller passed in and this function never alters or
// returns it. If a self photo is present, generation routes through
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

/** Active path. Submits a fal.ai queue job and returns "fal:<model>:<request_id>". */
async function callFal(prompt, falKey) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      prompt: prompt,
      aspect_ratio: '9:16',
      duration: '8s',
      resolution: '720p'
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
async function callFalReferenceToVideo(prompt, imageDataUrl, falKey) {
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
      duration: '8s',
      resolution: '720p'
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
//   E108 payment_required          — PAYWALL_ENABLED==="true" and the request's email has no
//                                     active entitlement (or no email at all). See
//                                     docs/PAYWALL_SETUP.md — PAYWALL_ENABLED defaults to unset/
//                                     off, so this never fires until a human explicitly turns the
//                                     paywall on after standing up real Stripe checkout in front
//                                     of users. THIS MUST STAY DEFAULT-OFF: flipping it on without
//                                     a checkout funnel in place blocks every user from generating.
//   E109 rate_limited              — MAX_GENERATIONS_PER_IP_PER_DAY (or the same cap per-email)
//                                     exceeded for today. Active regardless of PAYWALL_ENABLED —
//                                     this endpoint had zero abuse protection before this existed.
//   E110 daily_spend_cap_exceeded  — DAILY_SPEND_CAP_USD circuit breaker tripped for today.
//                                     Active regardless of PAYWALL_ENABLED — a backstop against
//                                     runaway cost, not a replacement for E109's rate limiting.
var rateLimit = require('./lib/rate-limit');
var spendGuard = require('./lib/spend-guard');
var entitlements = require('./lib/entitlements');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E101: method_not_allowed' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
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

  // --- Guardrails below run regardless of PAYWALL_ENABLED (rate limiting +
  // spend circuit breaker) or are gated by it (entitlement check) — see the
  // E108/E109/E110 doc block above and docs/PAYWALL_SETUP.md.

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

  if (process.env.PAYWALL_ENABLED === 'true') {
    if (!email) {
      return { statusCode: 402, body: JSON.stringify({ error: 'E108: payment_required: sign in with the email you subscribed with' }) };
    }
    var entitled = await entitlements.isEntitled(event, email);
    if (!entitled) {
      return { statusCode: 402, body: JSON.stringify({ error: 'E108: payment_required: an active subscription is required to generate videos' }) };
    }
  }

  var dailyCapUsd = parseFloat(process.env.DAILY_SPEND_CAP_USD);
  if (!dailyCapUsd || dailyCapUsd <= 0) dailyCapUsd = 50;

  var spendCheck = await spendGuard.checkAndReserve(event, dailyCapUsd);
  if (!spendCheck.allowed) {
    return { statusCode: 503, body: JSON.stringify({ error: 'E110: daily_spend_cap_exceeded: generation is paused for today, try again tomorrow' }) };
  }

  var prompt = buildPrompt(caption, style, characters, cameraView, sceneryTime, sceneryPlace);
  var selfPhoto = characters.filter(function (c) { return c && c.isSelf && c.photoDataUrl; })[0];

  try {
    var result = selfPhoto
      ? await callFalReferenceToVideo(prompt, selfPhoto.photoDataUrl, falKey)
      : await callFal(prompt, falKey);
    if (!result.ok) {
      var rejectCode = selfPhoto ? 'E106' : 'E105';
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: rejectCode + ': ' + result.error }) };
    }
    return { statusCode: 200, body: JSON.stringify({ operationName: result.operationName }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E107: fal_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};
