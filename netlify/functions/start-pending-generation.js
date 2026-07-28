// netlify/functions/start-pending-generation.js
//
// POST { email, whatsapp?, caption, style, characters?, cameraView?,
//        sceneryTime?, sceneryPlace?, characterIdsForGeneration?,
//        turnstileToken?, mediaType? }
// -> the dream-builder wizard's "generate during signup" + abandoned-dream
// re-engagement seam (see wizard.html, dream-webhook.js,
// docs/IDENTITY_RETENTION_PROJECT_SPEC.md's email+WhatsApp pivot, and
// tracker items for-product-build-the-dream-builder-wiza-28did1 /
// for-product-generate-during-signup-aband-73jyud) — AND, as of
// docs/IMAGE_GENERATION_SPEC.md, the general-purpose "start a generation for
// a pending (not-yet-adopted) dream" entry point style.html's image-vs-video
// picker uses for ANY generation, not just first-run onboarding.
//
// Called the moment the wizard's contact-capture step collects an email
// (and optionally a WhatsApp number) — BEFORE the user has created a real
// account — so generation can run in parallel with the signup step itself
// instead of only starting after it. This is deliberately a SEPARATE
// endpoint from generate-video.js, not a flag on it, for one structural
// reason: this call has no logged-in account to attach a finished dream
// to yet, so it needs its own durable, server-side record (see
// lib/pending-dreams.js) that dream-webhook.js (fal's completion callback)
// and claim-pending-generation.js (fired the instant a real signup
// completes) both read/write — generate-video.js has no such record and
// shouldn't grow one bolted on for a caller shape it was never designed
// for. The actual prompt-assembly/fal-submission logic is NOT duplicated
// here — it's required straight from generate-video.js/generate-image.js
// (see those files' named exports, added specifically for this reuse) so
// the paths can never silently drift apart.
//
// mediaType ('image'|'video', default 'video' — fully backward compatible,
// see docs/IMAGE_GENERATION_SPEC.md §4/§6-revised): when 'image', this
// routes to genImage.buildImagePrompt/genImage.callFalImage instead of
// genVideo's equivalents, token-gates/spends against 10 instead of 100, and
// deliberately does NOT pass a webhookUrl to the fal submission — see the
// image branch below for the full reasoning (flux/dev typically finishes in
// low single-digit seconds, well inside the time a user takes to complete
// the very next signup step, so the abandoned-generation re-engagement
// machinery this file's webhookUrl exists for doesn't apply the same way).
// wizard.html itself is UNCHANGED and never sends mediaType at all — it
// still always requests a free video, per Ron's explicit correction (see
// the spec's §6-revised) — this plumbing exists for style.html's picker.
//
// Guardrails: identical set to generate-video.js's own handler (Turnstile
// if configured, per-IP/per-email rate limit, the token balance gate,
// the daily spend-cap circuit breaker) — this is a real fal.ai-cost-
// incurring endpoint reachable by anyone who hasn't signed up yet, so it
// gets the exact same protection generate-video.js already has, not a
// lighter version.
//
// Error codes — this file's own small per-file namespace (bare E1-E11, not
// a padded "E6xx" range — matching this codebase's smaller per-file
// error-code files like generate-avatar.js/request-magic-link.js, not the
// zero-padded per-hundred convention generate-video.js/interpret-dream.js
// use):
//   E1 method_not_allowed
//   E2 missing_api_key       — FAL_KEY not configured (mock mode exempt)
//   E3 invalid_json
//   E4 email_required
//   E5 caption_and_style_required
//   E6 rate_limited          — same per-IP/per-email daily cap as generate-video.js's E109
//   E7 insufficient_tokens   — same token gate as generate-video.js's E112/generate-image.js's E412
//   E8 daily_spend_cap_exceeded — same circuit breaker as generate-video.js's E110
//   E9 turnstile_verification_failed — same conditional check as generate-video.js's E113
//   E10 fal rejected the submission (bad params, content policy, rate limit, etc.)
//   E11 couldn't reach fal at all

var crypto = require('crypto');
var rateLimit = require('./lib/rate-limit');
var spendGuard = require('./lib/spend-guard');
var entitlements = require('./lib/entitlements');
var promptCondenser = require('./lib/prompt-condenser');
var turnstile = require('./lib/turnstile');
var pendingDreams = require('./lib/pending-dreams');
var jobOwners = require('./lib/job-owners');
var genVideo = require('./generate-video');
var genImage = require('./generate-image');

var TURNSTILE_SECRET_PLACEHOLDER = 'REPLACE_WITH_REAL_TURNSTILE_SECRET_KEY';

function mockOperationName() {
  return 'mock:' + Date.now() + ':' + crypto.randomUUID();
}

// ROOT-CAUSE FIX (tracker.html's for-product-bug-founder-affects-all-funn-
// 0efe7t, founder-traced 2026-07-28): this file reuses generate-video.js's/
// generate-image.js's buildPrompt/callFal*/resolveDuration exports directly
// (see this file's own header comment on why) rather than calling either
// file's exports.handler — which means it also BYPASSED the handler-local
// recordJobOwnerBestEffort call each of those files makes right alongside
// its own spendTokens (see generate-video.js's/generate-image.js's own
// identically-named function and lib/job-owners.js's header comment for the
// full mechanism). Practical effect: NO funnel-started generation ever
// wrote a job-owners record, so mark-generation-completed.js's
// maybeSendAutomaticFirstDreamEmail (called once the SAME funnel user
// finishes signup and their generation completes — see wizard.html's/
// start.html's own handoff to processing.html) could never resolve an
// owner for the operationName and silently no-opped for every single
// funnel user, every time — this is the bug's actual root cause, not the
// email/copy/telemetry issues layered on top of it.
//
// Mirrors generate-video.js's/generate-image.js's own recordJobOwnerBestEffort
// EXACTLY (same wrap-in-try/catch, same fail-open-on-write-failure
// reasoning — see either file's own doc comment) — this is the SAME
// mechanism, not a new one, replicated here because this file's mock
// branch and both real (video/image) branches each mint their own
// operationName independently rather than going through either handler.
// `mediaType` is passed through (not hardcoded to one kind, unlike either
// of those two files' own copies) since this single file handles both.
//
// `pendingId` (review-round-1 fix, 2026-07-28): this file is the ONLY
// caller that ever has one (see lib/job-owners.js's own header comment on
// the "pendingId" arg) — passed through so mark-generation-completed.js
// can later check whether dream-webhook.js's SEPARATE abandonment-email
// path already committed to sending for this same dream before firing the
// automatic retention email too. Neither generate-video.js's nor
// generate-image.js's own copies of this function take this argument at
// all, since neither of those ever has a pending-dreams record to begin
// with.
async function recordJobOwnerBestEffort(event, operationName, email, mediaType, pendingId) {
  try {
    await jobOwners.recordJobOwner(event, operationName, email, mediaType, pendingId);
  } catch (e) {
    console.error('start-pending-generation: failed to record job owner (refund auth binding + automatic first-dream email binding) for ' + operationName + ' — a later refund attempt AND the automatic first-dream retention email for this job will both fail closed', e);
  }
}

function webhookUrlFor(event, pendingId) {
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  return 'https://' + host + '/.netlify/functions/dream-webhook?pendingId=' + encodeURIComponent(pendingId);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var mockMode = process.env.GENERATION_MOCK_MODE === 'true';
  var falKey = process.env.FAL_KEY;
  if (!mockMode && !falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_api_key' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  var email = entitlements.normalizeEmail(payload.email);
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: email_required' }) };
  }
  var whatsapp = typeof payload.whatsapp === 'string' && payload.whatsapp.trim() ? payload.whatsapp.trim() : null;
  var caption = (payload.caption || '').trim();
  var style = (payload.style || '').trim();
  if (!caption || !style) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: caption_and_style_required' }) };
  }
  var characters = Array.isArray(payload.characters) ? payload.characters : [];
  var characterIdsForGeneration = Array.isArray(payload.characterIdsForGeneration) ? payload.characterIdsForGeneration : [];
  var cameraView = payload.cameraView || null;
  var sceneryTime = payload.sceneryTime || null;
  var sceneryPlace = payload.sceneryPlace || null;
  var turnstileToken = typeof payload.turnstileToken === 'string' ? payload.turnstileToken : null;
  // Default 'video' — fully backward compatible with every existing caller
  // (wizard.html never sends this at all). See this file's own header
  // comment for the full mediaType story.
  var mediaType = payload.mediaType === 'image' ? 'image' : 'video';
  var tokenCost = mediaType === 'image' ? genImage.IMAGE_TOKEN_COST : 100;

  var ip = rateLimit.clientIp(event);

  var turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret && turnstileSecret !== TURNSTILE_SECRET_PLACEHOLDER) {
    var turnstileResult = await turnstile.verify(turnstileToken, turnstileSecret, ip);
    if (!turnstileResult.success) {
      return { statusCode: 403, body: JSON.stringify({ error: 'E9: turnstile_verification_failed' + (turnstileResult.reason ? ': ' + turnstileResult.reason : '') }) };
    }
  }

  var maxPerDay = parseInt(process.env.MAX_GENERATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 20;

  var ipLimit = await rateLimit.checkAndIncrement(event, 'ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E6: rate_limited: too many generations from this network today, try again tomorrow' }) };
  }
  var emailLimit = await rateLimit.checkAndIncrement(event, 'email', email, maxPerDay);
  if (!emailLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E6: rate_limited: too many generations from this account today, try again tomorrow' }) };
  }

  var tokenStatus = await entitlements.getTokenStatus(event, email);
  if (tokenStatus.balance < tokenCost) {
    var insufficientMsg = mediaType === 'image' ? 'not enough tokens to generate an image' : 'not enough tokens to generate a video';
    return { statusCode: 402, body: JSON.stringify({ error: 'E7: insufficient_tokens: ' + insufficientMsg }) };
  }

  var dailyCapUsd = parseFloat(process.env.DAILY_SPEND_CAP_USD);
  if (!dailyCapUsd || dailyCapUsd <= 0) dailyCapUsd = 50;

  var spendCheck = await spendGuard.checkAndReserve(event, dailyCapUsd);
  if (!spendCheck.allowed) {
    return { statusCode: 503, body: JSON.stringify({ error: 'E8: daily_spend_cap_exceeded: generation is paused for today, try again tomorrow' }) };
  }

  // Create the pending-dream record now, before submitting to fal, so its
  // id exists to embed in the fal_webhook URL (dream-webhook.js correlates
  // the eventual callback back to this record purely via that query param
  // — see that file's header comment). mediaType is stamped onto the
  // record itself (see lib/pending-dreams.js) purely for bookkeeping —
  // nothing downstream of this file currently reads it back off a pending
  // record (see the image branch's own webhookUrl comment below for why).
  var pending = await pendingDreams.create(event, {
    email: email, whatsapp: whatsapp, caption: caption, style: style,
    characterIdsForGeneration: characterIdsForGeneration,
    cameraView: cameraView, sceneryTime: sceneryTime, sceneryPlace: sceneryPlace,
    mediaType: mediaType
  });
  // Only the video path ever gets a webhookUrl — see the image branch
  // below (docs/IMAGE_GENERATION_SPEC.md §7's explicit scope cut) for why
  // an image submission deliberately never receives one.
  var webhookUrl = mediaType === 'video' ? webhookUrlFor(event, pending.id) : null;

  if (mockMode) {
    await entitlements.spendTokens(event, email, tokenCost);
    var mockOp = mockOperationName();
    await recordJobOwnerBestEffort(event, mockOp, email, mediaType, pending.id);
    await pendingDreams.update(event, pending.id, { operationName: mockOp });
    return { statusCode: 200, body: JSON.stringify({ pendingId: pending.id, operationName: mockOp }) };
  }

  if (mediaType === 'image') {
    // No prompt condensing here — unlike video's fixed ~8s clip, a still
    // image has no duration constraint to condense a long caption against
    // (see generate-image.js's own header comment, which makes the same
    // call). No fal_webhook either (webhookUrl is null above): flux/dev
    // typically completes in low single-digit seconds, well inside the
    // time a user takes to complete the very next signup step, so the
    // abandoned-generation re-engagement machinery dream-webhook.js exists
    // for doesn't meaningfully apply here — this pending-dreams record is
    // still created (for durability/bookkeeping) but deliberately never
    // transitions past 'pending' for an image-mode record, a documented,
    // intentional dead end (see docs/IMAGE_GENERATION_SPEC.md §7).
    var imagePrompt = genImage.buildImagePrompt(caption, style, characters, cameraView, sceneryTime, sceneryPlace);
    try {
      var imageResult = await genImage.callFalImage(imagePrompt, falKey);
      if (!imageResult.ok) {
        await pendingDreams.markFailed(event, pending.id, imageResult.error);
        return { statusCode: imageResult.statusCode || 500, body: JSON.stringify({ error: 'E10: ' + imageResult.error }) };
      }
      await entitlements.spendTokens(event, email, tokenCost);
      await recordJobOwnerBestEffort(event, imageResult.operationName, email, 'image', pending.id);
      await pendingDreams.update(event, pending.id, { operationName: imageResult.operationName });
      return { statusCode: 200, body: JSON.stringify({ pendingId: pending.id, operationName: imageResult.operationName }) };
    } catch (e) {
      await pendingDreams.markFailed(event, pending.id, 'fal_request_failed');
      return { statusCode: 500, body: JSON.stringify({ error: 'E11: fal_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
    }
  }

  var condensed = await promptCondenser.condenseIfNeeded(caption, process.env.GEM_API_KEY);
  if (condensed.error) console.warn('start-pending-generation: prompt-condenser: ' + condensed.error);
  var generateAudio = !condensed.wasCondensed;

  var prompt = genVideo.buildPrompt(condensed.text, style, characters, cameraView, sceneryTime, sceneryPlace);
  var selfPhoto = characters.filter(function (c) { return c && c.isSelf && c.photoDataUrl; })[0];
  var duration = genVideo.resolveDuration();

  try {
    var result = selfPhoto
      ? await genVideo.callFalReferenceToVideo(prompt, selfPhoto.photoDataUrl, falKey, duration, generateAudio, webhookUrl)
      : await genVideo.callFal(prompt, falKey, duration, generateAudio, webhookUrl);
    if (!result.ok) {
      await pendingDreams.markFailed(event, pending.id, result.error);
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: 'E10: ' + result.error }) };
    }
    await entitlements.spendTokens(event, email, tokenCost);
    await recordJobOwnerBestEffort(event, result.operationName, email, 'video', pending.id);
    await pendingDreams.update(event, pending.id, { operationName: result.operationName });
    return { statusCode: 200, body: JSON.stringify({ pendingId: pending.id, operationName: result.operationName }) };
  } catch (e) {
    await pendingDreams.markFailed(event, pending.id, 'fal_request_failed');
    return { statusCode: 500, body: JSON.stringify({ error: 'E11: fal_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};
