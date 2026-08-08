// netlify/functions/start-pending-generation.js
//
// POST { email, whatsapp?, caption, storyText?, style, characters?, cameraView?,
//        sceneryTime?, sceneryPlace?, characterIdsForGeneration?,
//        turnstileToken?, mediaType? }
//
// storyText (optional, tracker item for-product-split-prompttext-
// storytext-f-yt5kc7): the human-readable dream description wizard.html's
// chip flow computes — bookkeeping only here (stored on the pending-dreams
// record for verify-pending-claim.js/claim-dream.html to read back later —
// see lib/pending-dreams.js's own doc comment). Never touches promptText/
// `caption` below or anything this file actually sends to fal — this file's
// existing prompt-assembly/submission logic is completely unchanged.
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
//   E12 content_policy_blocked — the content-tier safety gate
//                                (lib/content-classifier.js) blocked this dream:
//                                explicit content (any request), or ANY
//                                sexual/romantic content when an uploaded photo
//                                of a named other person is attached (anti-NCII).
//                                Same gate as generate-video.js's E116. Returned
//                                422 with a clear block message; NO fal call, NO
//                                pending record, NO spend, NO tokens spent.

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
var effectiveConfig = require('./lib/effective-config');
var contentClassifier = require('./lib/content-classifier');

// Logs this function's resolved rate-limit/cost-control config once per
// cold start (tracker item for-product-damage-assessment-env-var-ca-
// rmgaqh — see lib/effective-config.js's own doc block for the full
// "why"). Module-level, NOT inside exports.handler below, so this runs
// exactly once when Node first requires this file (a cold start), never
// once per request. Values/defaults mirrored from this file's own
// maxPerDay/dailyCapUsd lines further down — see that file's doc comment
// on why this is a deliberate, independent duplication rather than a
// shared resolver. (The genVideo/genImage requires just above already
// trigger those two files' own identical module-level logging too, since
// this function's cold start cold-starts them in the same process — this
// call adds this function's own distinctly-labeled line on top, not a
// duplicate of theirs.)
effectiveConfig.logEffectiveConfigOnce('start-pending-generation', [
  { envVar: 'MAX_GENERATIONS_PER_IP_PER_DAY', default: 40, type: 'int' },
  { envVar: 'DAILY_SPEND_CAP_USD', default: 50, type: 'float' }
]);

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
    // SUCCESS-PATH LOGGING (tracker.html's for-product-bug-founder-affects-
    // all-funn-0efe7t, reopened round-3 diagnostics): before this line, a
    // successful write here was completely invisible in Netlify's own
    // function logs — only the catch branch below ever logged anything, so
    // there was no way to confirm from production logs alone whether a
    // given funnel job's write actually happened, and if so under exactly
    // which operationName/pendingId. Deliberately omits the raw email —
    // operationName+pendingId is already enough to correlate this write
    // against a later mark-generation-completed.js miss (that's the actual
    // debugging need this line exists for), and this is a genuinely new
    // log line, not a pre-existing one, so it doesn't need to inherit this
    // codebase's existing (separately flagged, unrelated-scope) practice of
    // logging raw emails elsewhere just because that practice exists.
    console.log('start-pending-generation: recorded job owner — operationName=' + operationName + ' pendingId=' + pendingId + ' mediaType=' + mediaType);
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
  var storyText = typeof payload.storyText === 'string' ? payload.storyText.trim() : '';
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
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40; // default 40 (founder directive 2026-07-29); env MAX_GENERATIONS_PER_IP_PER_DAY overrides

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

  // E12 — CONTENT-TIER SAFETY GATE, the pre-signup funnel path's copy of the
  // exact same gate generate-video.js's handler runs (see
  // lib/content-classifier.js's header for the full policy, and this file's
  // own E12 doc comment above). This funnel endpoint is a real, anyone-can-
  // reach-it fal.ai-cost endpoint before signup, so it gets the SAME
  // content protection as the logged-in path, not a lighter version. Placed
  // BEFORE the spend guard's checkAndReserve, the pending-dreams record
  // creation, the mock branch, and both the image and video submission
  // branches below, so a block costs nothing (no spend reserved, no pending
  // record, no tokens spent) on any of those paths. Gates image and video
  // alike — the caption is classified regardless of mediaType. The
  // named-other-person-photo flag is structured character-payload data
  // (detectNamedOtherPersonPhoto), never LLM-inferred; character descriptions
  // are folded into the classified text so explicit text can't hide there.
  // FAIL-SAFE: normal case fails OPEN, named-other-person-photo case fails
  // CLOSED (see evaluateGenerationGate). On the funnel, a block leaves the
  // client's pendingStartFailed true (nothing surfaced here, nothing spent);
  // the message reaches the user when home.html retries the generation
  // post-signup through generate-video.js, whose identical gate blocks it
  // again and whose content-policy client branch shows the clean message.
  var hasNamedOtherPersonPhoto = contentClassifier.detectNamedOtherPersonPhoto(characters);
  var classifiableText = contentClassifier.buildClassifiableText(caption, characters);
  var gate = await contentClassifier.evaluateGenerationGate({
    text: classifiableText,
    hasNamedOtherPersonPhoto: hasNamedOtherPersonPhoto,
    falKey: falKey
  });
  if (!gate.allowed) {
    console.log('start-pending-generation: content_gate_blocked reason=' + gate.reason + (gate.error ? (' error=' + gate.error) : '') + ' named_photo=' + hasNamedOtherPersonPhoto);
    return { statusCode: 422, body: JSON.stringify({ error: 'E12: content_policy_blocked: ' + gate.message }) };
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
    email: email, whatsapp: whatsapp, caption: caption, storyText: storyText, style: style,
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
  // Generation profile classifier (tracker item for-product-cheap-
  // generation-profile-for-yz2ina) — reused from generate-video.js (see
  // genVideo.resolveGenerationProfile) purely for cost-attribution logging,
  // same as that file's own handler — no longer affects generate_audio
  // (see that function's own doc comment for the full history).
  var generationProfileResult = genVideo.resolveGenerationProfile(email, event);
  console.log('start-pending-generation: generation_profile=' + generationProfileResult.profile);
  // generateAudio is UNCONDITIONALLY false — tracker item for-product-
  // turn-off-audio-dialogue-gene-ooeyoj, founder directive 2026-08-02 (see
  // the identical override and full "why" in generate-video.js's own
  // handler, right above its own `var generateAudio = false;` line). This
  // endpoint computes generateAudio independently from generate-video.js
  // (it's a separate pre-signup submission path with no client-facing
  // audio toggle of its own — wizard.html/start.html never send one) rather
  // than importing a shared value, so it needs this override applied here
  // too rather than inheriting it for free; this used to read
  // `!condensed.wasCondensed && !generationProfileResult.forceAudioOff`
  // (audio on by default unless condensed or the now-retired owner/IL
  // force-off) — see git history on this line for that older logic.
  var generateAudio = false;

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
