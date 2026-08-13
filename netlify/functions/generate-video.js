// netlify/functions/generate-video.js
//
// POST { caption, style, characters?, cameraView?, sceneryTime?, sceneryPlace?, email?, turnstileToken?, ownerBypassToken?, audioOn?, musicStyle? }
// -> kicks off a video generation job and returns an operationName the
// client can poll via video-status.js.
//
// audioOn/musicStyle (both optional) are still accepted on the request body
// for backward-compatible plumbing only — see js/store.js and style.html's
// own comments — but as of tracker item for-product-turn-off-audio-
// dialogue-gene-ooeyoj (founder directive 2026-08-02) they no longer have
// any effect: generate_audio is now hardcoded false for every path below,
// unconditionally, regardless of what audioOn sends. Two reasons, both from
// the founder directly: (1) cost — audio-on bills meaningfully higher per
// second than audio-off on every veo3.1 endpoint used here; (2) correctness
// — Veo's native audio can include invented lip-synced dialogue the user
// never wrote, which is unacceptable regardless of cost. See
// generateAudio's own computation in the handler below.
//
// ownerBypassToken (optional) — see lib/owner-bypass.js and
// verify-owner-bypass.js for how the founder obtains one (a real,
// server-verified password check, never a client-claimed email) and the
// "OWNER BYPASS" doc block further down for exactly what it does and does
// NOT affect. js/store.js's startGeneration attaches this automatically
// from localStorage when present (getOwnerBypassToken) — every other
// caller simply never has one, so this is fully additive and invisible to
// every non-owner request.
//
// turnstileToken (optional) is a Cloudflare Turnstile response token,
// obtained client-side (see js/turnstile-config.js's getTurnstileToken(),
// called from processing.html's runGeneration() — the one real choke
// point every generation path funnels through). Only ever actually
// checked when TURNSTILE_SECRET_KEY is configured — see the E113 doc
// block below and docs/TURNSTILE_SETUP.md for the full story on why this
// guardrail is attached here rather than at signup.
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
// ACTIVE PATH: fal.ai's Veo 3.1, using FAL_KEY. Switched from fal.ai's wan
// v2.2-5b because its output quality wasn't good enough. Veo 3.1 is the same
// Google model originally used via direct Google API calls (see
// callVeoDirect below) — now reached through fal.ai instead, which
// sidesteps the Google Cloud quota wall that caused the original switch
// away from it.
// The wan v2.2-5b path is kept below (callFalWan), unused, in case we want
// to switch back or use it as a cheaper fallback later.
//
// Standard text-to-video model is env-configurable (FAL_MODEL_TEXT_TO_VIDEO)
// rather than hardcoded, so a revert is a pure env-var flip + redeploy —
// tracker item for-product-switch-default-video-model-t-lqxafa, founder
// decision 2026-07-28 after a real 2-round visual eval (12-clip + 8-clip,
// 6 models, 4 styles): "no big differences between the 4 finalists, go for
// the cheap one" — fal-ai/veo3.1/lite at 720p is $0.03/s audio-off /
// $0.05/s audio-on (verified against fal's own pricing, not guessed),
// roughly 80% cheaper per generation than /fast's $0.10-0.20/sec, same
// duration presets/aspect ratio/API shape.
//
// The Me-photo reference-to-video path is ALSO env-configurable now
// (FAL_MODEL_REFERENCE_TO_VIDEO) and, as of founder decision 2026-08-09,
// defaults to a DIFFERENT provider — fal.ai's Vidu Q1 reference-to-video
// (~$0.40/video vs veo /fast's ~$1.20, this path being ~80% of model spend)
// — with a transient-failure fallback to the old veo model kept in place.
// Unlike the text-to-video swap above (all veo variants, one API shape),
// Vidu and veo take different request bodies, so that path branches on the
// model id; see FAL_MODEL_REFERENCE_TO_VIDEO / referenceToVideoBody /
// callFalReferenceToVideo below for the full story. FAL_MODEL_IMAGE_TO_VIDEO
// (the "turn image into video" upsell) is untouched by all of this and stays
// on its veo /fast variant — a Lite/alternative image-to-video switch is an
// explicit separate follow-up, not folded into this.

var STYLE_MODIFIERS = {
  Cartoon:   'in a colorful hand-drawn cartoon animation style',
  Cinematic: 'in a moody, cinematic film style with dramatic lighting',
  Anime:     'in a vibrant Japanese anime animation style',
  Realistic: 'in a photorealistic, lifelike rendering style'
};

// Audio/music toggle (tracker item for-product-audio-on-off-choice-at-
// creat-dyyr98, founder-approved 2026-07-28) — style.html's audio-on
// picker (four presets only, deliberately not free text: this feeds
// Veo's own native audio generation as a prompt modifier, there is no
// separate music-generation model/API call here). Only ever appended
// when the final, server-computed generateAudio is true (see the
// handler below) — telling the model "add cinematic music" when the
// request is actually generate_audio:false would be meaningless.
// generateAudio is unconditionally false as of 2026-08-02 (tracker item
// for-product-turn-off-audio-dialogue-gene-ooeyoj — see the handler
// below), so in practice this map is currently always skipped — kept
// in place rather than deleted since it's a trivial flip back on if
// that directive is ever reversed.
var MUSIC_STYLE_MODIFIERS = {
  dreamy: 'with a soft, dreamy ambient musical score',
  cinematic: 'with a sweeping, cinematic orchestral score',
  upbeat: 'with an upbeat, energetic musical score',
  'none-ambient': 'with only subtle ambient background sound, no distinct music'
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

// Word-count threshold used by styleIntegrityClause's short-caption
// reinforcement below. STYLE_MODIFIERS' own entries run about 6-9 words
// of vivid, specific, sensory language each (e.g. "vibrant Japanese anime
// animation style" is 5 content words; "moody, cinematic film style with
// dramatic lighting" is 7). A caption at or under roughly that same
// length has too little competing descriptive content of its own to
// naturally outweigh the style modifier's vividness in the model's
// attention — that imbalance, not just the wording of the guardrail
// clause itself, is part of what let a 2-word caption ("a woman") lose
// its subject to a strongly-worded style. 10 gives a small margin above
// the longest style modifier's word count.
var SHORT_CAPTION_MAX_WORDS = 10;

/**
 * Style-integrity guardrail — a clause asserting that the chosen style is
 * an AESTHETIC choice only (rendering, palette, line work, atmosphere) and
 * must never change who/what the dream's subject IS. Placed as the second
 * clause in the prompt, immediately after the caption and before every
 * other clause (characters/camera/scenery/style itself) — deliberately
 * early and prominent rather than tacked on at the end, since these
 * models weight earlier instructions more heavily in practice, and this
 * is exactly what the style modifier further down would otherwise have
 * unchecked license to override.
 *
 * Root cause this ORIGINALLY addressed (tracker item
 * for-product-founder-ask-08-04-style-must-ezz8uf, commit 0500852): the
 * founder's caption "I am running back and forth to bring some important
 * things for my family" with style Anime produced a video where the
 * dreamer himself was rendered AS a flying dragon. Nothing in the prompt
 * previously told the model that a strongly stylized style descriptor
 * (e.g. "vibrant Japanese anime animation style") governs rendering
 * only — so the model had latitude to reinterpret the dreamer's
 * species/identity along with the art style. That first fix phrased the
 * guardrail around "the dreamer" specifically.
 *
 * GENERALIZATION (2026-08-11, tracker item
 * for-product-bug-founder-recurring-style--srehi9, SAME underlying bug,
 * BROADER trigger): founder repro — a wizard free-text caption whose
 * ONLY content was the two words "a woman" (no "I", no first-person
 * framing at all), combined with an anime/specific style, again produced
 * a flying dragon with no woman in the video. "The dreamer" reads
 * naturally as a stand-in for a first-person "I" — against a caption
 * that never says "I", there is no explicit signal that "the dreamer"
 * IS "a woman" rather than some separate, unstated narrator, so the
 * clause could be satisfied (in the model's reading) by a scene that
 * still has *a* human dreamer somewhere off-screen while the described
 * subject itself is freely reinterpreted. Fixed by widening the bound
 * referent from "the dreamer" to "the subject this dream describes",
 * with the clause spelling out explicitly that this covers first-person
 * ("I") AND third-person/generic phrasing ("a woman", "a man", "a
 * child") alike — so it resolves onto the actual described subject
 * regardless of which framing the caption happens to use.
 *
 * That rewording addresses the referent-binding half of the bug. The
 * other half is caption length: "a woman" supplies almost no competing
 * descriptive content next to a comparatively vivid, specific style
 * descriptor, so even a correctly-bound guardrail clause has less text
 * of its own to hold its ground. For captions at/under
 * SHORT_CAPTION_MAX_WORDS words (see that constant's own comment), the
 * clause below appends one further sentence that quotes the caption back
 * verbatim and states plainly that its brevity is not license to invent
 * a different subject. This is a targeted response to that specific
 * mechanism (weak vs. strong competing text), not blanket "make the
 * guardrail longer" — a caption with enough of its own descriptive
 * content (like the original 14-word founder repro) does not get it,
 * and doesn't need it.
 *
 * Deliberately still ends with "...unless the dream itself explicitly
 * describes a transformation" — this constrains the STYLE CHOICE only,
 * not genuine dream content. buildPrompt's philosophy is to narrate what
 * the dream text already says; if a dream's own caption literally
 * describes its subject turning into something else, that must still
 * come through. This clause only closes the loophole where the style
 * modifier alone was introducing a transformation the dream text never
 * asked for.
 *
 * Complements, rather than duplicates or contradicts, the existing
 * self-character text below (charTextParts/photoSelf) — that logic
 * establishes exactly who "the dreamer" is when a character/photo is
 * attached (optionally tied to a reference photo); this clause covers
 * the general case (including when there are no characters at all, as
 * with a bare "a woman" caption and no character entries) that whoever
 * or whatever the dream's subject is, they stay human and stay
 * themselves regardless of style.
 */
function styleIntegrityClause(caption, style) {
  var trimmedCaption = (caption || '').trim();
  var wordCount = trimmedCaption ? trimmedCaption.split(/\s+/).filter(Boolean).length : 0;

  var clause = 'the subject this dream describes — whether the caption phrases it in first person ("I") or as ' +
    'a third-person/generic description like "a woman", "a man", or "a child" — remains a real human being ' +
    'throughout, doing exactly what the dream describes; the ' + style + ' treatment applied below governs ' +
    'only the visual rendering, color palette, line work, and atmosphere, and must never change the subject\'s ' +
    'species, identity, or actions, unless the dream itself explicitly describes a transformation';

  if (wordCount > 0 && wordCount <= SHORT_CAPTION_MAX_WORDS) {
    clause += '; this dream\'s caption is short — "' + trimmedCaption + '" — and that brevity is not license ' +
      'to invent a different subject: it still names one real human being, whom the ' + style + ' style must ' +
      'render exactly as described, never as an animal, mythical creature, or any other non-human entity';
  }

  // Ethnicity neutrality (founder 2026-08-11; reframed 2026-08-13 per tracker
  // item for-product-investigate-no-specific-ethn-zz0fyv, founder report that
  // a real video still came out with a specific ethnicity assigned). The
  // original fix here was negative-only ("do not assign..."), and negative
  // instructions are well-documented to be followed more weakly than a
  // positive instruction stating the desired outcome directly for these
  // models — so this now LEADS with the positive framing (render the
  // subject neutrally by default) and keeps the original negative wording
  // immediately after, as reinforcement rather than the sole instruction.
  // Still one clause, and the "unless explicitly specified" carve-out is
  // preserved verbatim so a dream that DOES describe an ethnicity is never
  // suppressed — that carve-out is load-bearing and must not be weakened.
  clause += '; render the subject with a neutral, unspecified ethnicity, skin tone, and racial appearance by default — do not assign the subject any specific ethnicity, skin tone, or racial appearance — unless the dream text explicitly specifies one';

  return clause;
}

/**
 * Combines the plain caption with style + character + camera + scenery
 * enrichment into the prompt actually sent to the video model. This is
 * provider-only enrichment — the caption the UI shows the user is never
 * touched here.
 *
 * A self character with a photo is described by the reference image
 * passed alongside the prompt (see callFalReferenceToVideo) as well as by
 * text here — the photo alone can't carry corrective/clarifying details
 * (e.g. "no beard") the model's own stylization might otherwise add, so
 * when a description is also present both signals reach the model: the
 * pointer line ties "the dreamer" to the reference image, and the
 * description is appended to it rather than silently dropped. A photo-only
 * self character (no description) still gets just the plain pointer line,
 * unchanged from before.
 *
 * The second clause of the prompt is always styleIntegrityClause(caption,
 * style) — see that function's own doc comment for why it's there, why
 * it's placed this early, and why it also needs the caption itself (to
 * bind its guardrail onto the actual described subject and to detect
 * when a short-caption reinforcement sentence is warranted).
 *
 * musicStyle (optional 7th arg) — see MUSIC_STYLE_MODIFIERS above; the
 * caller (the handler below) only ever passes one when the request's
 * final, already-resolved generateAudio is true, never based on the raw
 * client request alone.
 */
function buildPrompt(caption, style, characters, cameraView, sceneryTime, sceneryPlace, musicStyle) {
  var modifier = STYLE_MODIFIERS[style] || ('in a ' + style + ' animation style');
  var parts = [caption, styleIntegrityClause(caption, style)];

  var photoSelf = (characters || []).filter(function (c) { return c && c.isSelf && c.photoDataUrl; })[0];
  var charTextParts = (characters || [])
    .filter(function (c) { return c && !c.photoDataUrl && typeof c.description === 'string' && c.description.trim(); })
    .map(function (c) {
      var who = c.isSelf ? 'the dreamer ("me")' : ((c.name || '').trim() || 'a character');
      return who + ': ' + c.description.trim();
    });
  if (photoSelf) {
    var photoSelfDescription = typeof photoSelf.description === 'string' ? photoSelf.description.trim() : '';
    charTextParts.unshift(
      photoSelfDescription
        ? 'the dreamer ("me") appears as shown in the reference photo, with these specific details: ' + photoSelfDescription
        : 'the dreamer ("me") appears as shown in the reference photo'
    );
  }
  if (charTextParts.length) parts.push('Characters — ' + charTextParts.join('; '));

  if (CAMERA_MODIFIERS[cameraView]) parts.push(CAMERA_MODIFIERS[cameraView]);

  var sceneryBits = [SCENERY_TIME_MODIFIERS[sceneryTime], SCENERY_PLACE_MODIFIERS[sceneryPlace]].filter(Boolean);
  if (sceneryBits.length) parts.push('Setting: ' + sceneryBits.join(', '));

  parts.push(modifier);
  if (MUSIC_STYLE_MODIFIERS[musicStyle]) parts.push(MUSIC_STYLE_MODIFIERS[musicStyle]);
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
      // 'image_urls' is veo's photo field; 'reference_image_urls' is Vidu's
      // (the default Me-photo model since 2026-08-09). Either being the
      // flagged location means the REFERENCE PHOTO tripped safety, so show
      // the photo-specific guidance rather than the description one.
      var onPhoto = Array.isArray(item.loc) && (item.loc.indexOf('image_urls') !== -1 || item.loc.indexOf('reference_image_urls') !== -1);
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

var FAL_MODEL = process.env.FAL_MODEL_TEXT_TO_VIDEO || 'fal-ai/veo3.1/lite';
var FAL_API_BASE = 'https://queue.fal.run';

// PixVerse V6 model-rotation routing (docs/EDIT_MECHANISM_SPEC.md §2/§3.4,
// tracker item for-product-new-edit-mechanism-founder-i-qmsdgj) — the
// founder's own words: "Model cost for edits approved," cost-approved and
// live from day one, no flag gate. Second plain text-to-video model option
// alongside FAL_MODEL above, used only when the CALLER (result.html's new
// edit sheet — see js/store.js's pickEditModel) explicitly asks for it via
// `requestedModel` on the request body. This is a rotation PARTNER, not a
// replacement — FAL_MODEL stays the default for every fresh/non-edit
// generation and for any edit whose rotation picks the other slot back.
// Env-configurable (FAL_MODEL_PIXVERSE_V6), matching this file's existing
// "a model swap is a pure env-var flip + redeploy" convention for
// FAL_MODEL/FAL_MODEL_REFERENCE_TO_VIDEO/FAL_MODEL_IMAGE_TO_VIDEO above.
//
// Deliberately scoped to the PLAIN text-to-video branch only (see
// `rotationApplies` in the handler below) — reference-to-video (self-photo)
// and image-to-video ("turn this into a video") are explicitly OUT of scope
// for rotation this wave (spec §2/§3.6): an edit on either of those simply
// reuses whichever model that path already uses, unchanged.
var FAL_MODEL_PIXVERSE_V6 = process.env.FAL_MODEL_PIXVERSE_V6 || 'fal-ai/pixverse/v6/text-to-video';

// The two rotation-eligible model keys stamped onto a dream's `modelUsed`
// field (js/store.js's finalizeDream) — fixed string literals per the spec,
// not derived from whatever FAL_MODEL/FAL_MODEL_PIXVERSE_V6 happen to
// resolve to today, so a later env-var rollback (e.g. FAL_MODEL_TEXT_TO_VIDEO
// flipped back to Fast) can never retroactively mislabel which rotation slot
// a past generation actually used.
var MODEL_KEY_VEO_LITE = 'veo3.1-lite';
var MODEL_KEY_PIXVERSE_V6 = 'pixverse-v6';

// Disables fal's default media-expiration window on this generation's
// resulting file(s) — tracker item for-product-bug-build-re-host-image-
// drea-0hpbm0: fal's own docs (docs.fal.ai/model-apis/media-expiration)
// confirm generated media (images/video/audio alike, no video exemption)
// is retained "for at least 7 days by default," so without this header
// every published dream's video eventually 404s once fal's own CDN copy
// expires — there is no re-hosting step anywhere in the active generation
// path (video-status.js just hands back fal's own URL; see that file's
// own header comment). `expiration_duration_seconds: null` disables
// expiry entirely for the media this specific submission produces.
// Applied to every ACTIVE fal submission call below (callFal,
// callFalReferenceToVideo, callFalImageToVideo) — deliberately NOT added
// to callFalWan/callVeoDirect further down, both already-dormant/unused
// paths out of scope for this fix.
var FAL_NO_EXPIRY_HEADER = { 'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: null }) };

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
 * Appends fal's documented `fal_webhook` query param to a queue submission
 * URL (see https://docs.fal.ai/model-endpoints/webhooks) — used only by
 * start-pending-generation.js's pre-signup path (see that file and
 * dream-webhook.js), so a generation started before/without a real signup
 * can still notify the user once it finishes even if nobody's browser is
 * left polling. Every other caller (generate-video.js's own handler, the
 * normal logged-in path) passes no webhookUrl and this is a no-op —
 * behavior for every existing call site is completely unchanged.
 */
function withWebhook(url, webhookUrl) {
  return webhookUrl ? (url + '?fal_webhook=' + encodeURIComponent(webhookUrl)) : url;
}

/**
 * Active path. Submits a fal.ai queue job and returns "fal:<model>:<request_id>".
 * generateAudio maps straight to fal's own `generate_audio` boolean
 * (confirmed via fal.ai's model API docs, 2026-07-20 — not guessed; same
 * param name and default (true) on both this model and the reference-to-
 * video variant below). Defaults true (fal's own default) when the caller
 * doesn't pass one, but as of 2026-08-02 both real callers (this file's own
 * handler and start-pending-generation.js) always pass false now — see the
 * `generateAudio` doc comment in the handler below (tracker item
 * for-product-turn-off-audio-dialogue-gene-ooeyoj) for why.
 *
 * webhookUrl (optional, 5th arg): see withWebhook above — unused by every
 * call site in this file itself.
 */
async function callFal(prompt, falKey, duration, generateAudio, webhookUrl) {
  var res = await fetch(withWebhook(FAL_API_BASE + '/' + FAL_MODEL, webhookUrl), {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    }, FAL_NO_EXPIRY_HEADER),
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

/**
 * The PixVerse V6 rotation partner to callFal above — same plain
 * text-to-video request shape (this codebase's established fal.ai
 * video-model call convention, reused here rather than inventing a new
 * request schema), submitted to FAL_MODEL_PIXVERSE_V6 instead. Only ever
 * called when the edit-rotation logic in the handler below picked this
 * slot (see MODEL_KEY_PIXVERSE_V6/rotationApplies) — never for a fresh,
 * non-edit generation, which always defaults to callFal/FAL_MODEL.
 *
 * NOTE for a human reviewer: this sandbox has no FAL_KEY, so the exact
 * request/response shape below could not be independently smoke-tested
 * against fal's live PixVerse V6 endpoint before this shipped — it mirrors
 * callFal's own confirmed-working shape (prompt/aspect_ratio/duration/
 * resolution/generate_audio) rather than a shape verified against
 * PixVerse's own docs param-by-param. Cheap to verify for real once
 * deployed (a single GENERATION_TEST_DURATION=4s real call, per
 * AGENT_POLICY.md's cheap-generation-testing guidance) — worth doing
 * before this rotation actually serves real edit traffic.
 */
async function callFalPixverse(prompt, falKey, duration, generateAudio, webhookUrl) {
  var res = await fetch(withWebhook(FAL_API_BASE + '/' + FAL_MODEL_PIXVERSE_V6, webhookUrl), {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    }, FAL_NO_EXPIRY_HEADER),
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

  return { ok: true, operationName: 'fal:' + FAL_MODEL_PIXVERSE_V6 + ':' + data.request_id };
}

// Primary reference-to-video model — the Me-photo path (a self character
// with an uploaded photo). Env-configurable (FAL_MODEL_REFERENCE_TO_VIDEO),
// defaulting to fal.ai's Vidu Q1 reference-to-video. Founder decision
// 2026-08-09: switch the Me-photo path off veo3.1/fast/reference-to-video
// (~$1.20/video, ~80% of model spend) to Vidu Q1 (~$0.40/video, ~67%
// cheaper, likeness verified good on the founder's own photo, 9:16
// vertical). A model swap/revert is a pure env-var flip + redeploy, same
// convention as FAL_MODEL_TEXT_TO_VIDEO above — but UNLIKE that switch (all
// veo variants, one identical API shape), Vidu and veo take DIFFERENT
// request bodies (see referenceToVideoBody), so the submit path branches on
// the model id (isViduModel) to send each its own correct shape. That keeps
// an env override back to a veo id working with no code change.
var FAL_MODEL_REFERENCE_TO_VIDEO = process.env.FAL_MODEL_REFERENCE_TO_VIDEO || 'fal-ai/vidu/q1/reference-to-video';

// The veo reference-to-video model, kept for two jobs: (1) the automatic
// FALLBACK when the primary (Vidu by default) submission fails with a
// plausibly-transient error, so a Me-photo generation never just dies
// because the cheaper model had a bad moment (same "never let a generation
// silently die" discipline this file already applies elsewhere); (2) the
// model actually submitted to whenever the resolved primary is itself a veo
// id (an env rollback of FAL_MODEL_REFERENCE_TO_VIDEO) — in that case there
// is no second, different model to fall back TO, so the fallback is skipped.
// Deliberately NOT env-configurable: it's the known-good floor the primary
// falls back to, not itself a thing to swap.
var FAL_MODEL_REFERENCE_TO_VIDEO_VEO = 'fal-ai/veo3.1/fast/reference-to-video';

// True for any fal Vidu model id (owner "fal-ai", alias "vidu"). Drives
// which request-body shape referenceToVideoBody builds — Vidu's own field
// names/params, or veo's — so FAL_MODEL_REFERENCE_TO_VIDEO can be flipped
// between a Vidu and a veo id by env alone and each still gets its correct
// body. Matches on the alias SEGMENT specifically (not a bare substring) so
// an unrelated model that merely contains the letters "vidu" can't fool it.
function isViduModel(model) {
  return String(model).split('/')[1] === 'vidu';
}

/**
 * The request body for a reference-to-video submission, shaped for whichever
 * MODEL it targets. The two supported providers take deliberately different
 * bodies (this is exactly why FAL_MODEL_REFERENCE_TO_VIDEO can't be a blind
 * string swap the way FAL_MODEL_TEXT_TO_VIDEO is):
 *
 *   Vidu Q1 (fal-ai/vidu/q1/reference-to-video) — verified against fal's
 *   Vidu API: the reference-image field is `reference_image_urls` (a LIST,
 *   name differs from veo's `image_urls`), and Vidu accepts NO
 *   duration/resolution/generate_audio params (fixed ~5s clip, and its
 *   output is SILENT). Audio for a Vidu dream comes from the client-side
 *   style/mood music bed that already plays behind EVERY (structurally
 *   silent) DreamTube video — see js/music-bed.js; no change needed there,
 *   a Vidu video is just another silent video to it. `movement_amplitude:
 *   'auto'` lets Vidu choose the motion intensity. Like veo it accepts a
 *   base64 data URI directly in the list, so the client's stored
 *   photoDataUrl passes through as-is.
 *
 *   veo3.1 (fal-ai/veo3.1/fast/reference-to-video) — the previous active
 *   path, body unchanged: `image_urls` (plural, subject-identity
 *   references) plus duration/resolution/generate_audio. duration and
 *   generateAudio are only meaningful on this shape.
 */
function referenceToVideoBody(model, prompt, imageDataUrl, duration, generateAudio) {
  if (isViduModel(model)) {
    return {
      prompt: prompt,
      reference_image_urls: [imageDataUrl],
      aspect_ratio: '9:16',
      movement_amplitude: 'auto'
    };
  }
  return {
    prompt: prompt,
    image_urls: [imageDataUrl],
    aspect_ratio: '9:16',
    duration: duration || DEFAULT_DURATION,
    resolution: '720p',
    generate_audio: generateAudio !== false
  };
}

/**
 * Submits ONE reference-to-video job to a specific `model` and returns the
 * usual { ok: true, operationName } | { ok: false, statusCode, error }.
 * fal.ai accepts a base64 data URI directly (it decodes the file for you),
 * so the client's stored photoDataUrl is passed through as-is, no separate
 * upload step needed. The operationName encodes the exact model used, so
 * video-status.js polls the right fal app base with no extra plumbing (its
 * falAppBase() derives "fal-ai/vidu" or "fal-ai/veo3.1" from the first two
 * model segments — confirmed model-agnostic, no change needed for Vidu).
 */
async function submitReferenceToVideo(model, prompt, imageDataUrl, falKey, duration, generateAudio, webhookUrl) {
  var res = await fetch(withWebhook(FAL_API_BASE + '/' + model, webhookUrl), {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    }, FAL_NO_EXPIRY_HEADER),
    body: JSON.stringify(referenceToVideoBody(model, prompt, imageDataUrl, duration, generateAudio))
  });

  var data = await res.json();

  if (!res.ok) {
    return { ok: false, statusCode: res.status, error: falErrorMessage(data) };
  }

  return { ok: true, operationName: 'fal:' + model + ':' + data.request_id };
}

/**
 * Active path when a self character has an uploaded photo. Submits to the
 * primary reference-to-video model (FAL_MODEL_REFERENCE_TO_VIDEO — Vidu by
 * default) and, on a plausibly-TRANSIENT primary failure, falls back once to
 * the veo reference-to-video path so a Me-photo generation never just dies
 * because the cheaper/newer model had a bad moment.
 *
 * "Transient" is deliberately narrow: a thrown network/transport error, an
 * HTTP 5xx (model/infra error), or a 429 (rate limit). A deterministic 4xx
 * — a bad request, or a content-policy rejection (e.g. the reference photo
 * looks like a minor) — does NOT fall back: veo would almost certainly
 * reject the same photo too, and we WANT that surfaced as E106 rather than
 * silently masked. A blanket "retry veo on any failure" would also hide a
 * Vidu MISCONFIGURATION by quietly routing 100% of Me-photo traffic back to
 * the expensive veo model — defeating the entire point of this cost switch
 * without anyone noticing. Failing loud on 4xx keeps the switch honest.
 *
 * The fallback is skipped entirely when the primary already IS the veo model
 * (an env rollback of FAL_MODEL_REFERENCE_TO_VIDEO) — there'd be no different
 * model to retry, so the single primary result/throw is returned/propagated
 * exactly as the veo-only version behaved before this change.
 *
 * Signature unchanged from the previous veo-only version (duration/
 * generateAudio/webhookUrl) so both callers — this file's handler and
 * start-pending-generation.js — need no change; duration and generateAudio
 * are simply ignored by the Vidu body (see referenceToVideoBody).
 */
async function callFalReferenceToVideo(prompt, imageDataUrl, falKey, duration, generateAudio, webhookUrl) {
  var primaryIsVeo = FAL_MODEL_REFERENCE_TO_VIDEO === FAL_MODEL_REFERENCE_TO_VIDEO_VEO;

  var primary;
  try {
    primary = await submitReferenceToVideo(FAL_MODEL_REFERENCE_TO_VIDEO, prompt, imageDataUrl, falKey, duration, generateAudio, webhookUrl);
  } catch (e) {
    // Network/transport throw talking to the primary model — the transient
    // case the fallback exists for. Nothing different to fall back to when
    // the primary already IS veo, so re-throw (handler catches it -> E107),
    // preserving the previous veo-only behavior exactly.
    if (primaryIsVeo) throw e;
    return submitReferenceToVideo(FAL_MODEL_REFERENCE_TO_VIDEO_VEO, prompt, imageDataUrl, falKey, duration, generateAudio, webhookUrl);
  }

  if (primary.ok) return primary;

  var transient = primary.statusCode >= 500 || primary.statusCode === 429;
  if (!primaryIsVeo && transient) {
    return submitReferenceToVideo(FAL_MODEL_REFERENCE_TO_VIDEO_VEO, prompt, imageDataUrl, falKey, duration, generateAudio, webhookUrl);
  }
  return primary;
}

// ACTIVE PATH when the request carries a sourceImageUrl (the "Turn this
// into a video" upsell — see js/store.js's turnImageIntoVideo and
// result.html's CTA, plus docs/IMAGE_GENERATION_SPEC.md §6). Reactivated
// 2026-07-24 — previously dormant/unused (kept only "in case a future
// feature wants literal photo animation"), which is exactly the feature
// this is now: animating the flat image generate-image.js produced (fal's
// own hosted URL, not a data URI — unlike callFalReferenceToVideo's
// selfPhoto.photoDataUrl, since there's no client-side upload step here)
// as the video's literal starting frame. This is deliberately
// image_url (singular, a starting frame) not callFalReferenceToVideo's
// image_urls (plural, subject-identity references) — see that function's
// own doc comment for why those two are semantically different fal
// concepts, not interchangeable.
//
// Signature brought in line with callFal/callFalReferenceToVideo above as
// part of this reactivation (duration/generateAudio/webhookUrl, using
// resolveDuration() and the generate_audio param instead of the previous
// hardcoded duration: '8s' and no audio param) — a consistency fix, no new
// behavior beyond what reactivating this path requires.
var FAL_MODEL_IMAGE_TO_VIDEO = 'fal-ai/veo3.1/fast/image-to-video';
async function callFalImageToVideo(prompt, imageUrl, falKey, duration, generateAudio, webhookUrl) {
  var res = await fetch(withWebhook(FAL_API_BASE + '/' + FAL_MODEL_IMAGE_TO_VIDEO, webhookUrl), {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    }, FAL_NO_EXPIRY_HEADER),
    body: JSON.stringify({
      prompt: prompt,
      image_url: imageUrl,
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
//   E114 fal rejected the image-to-video submission (the "Turn this into a video" upsell path —
//                                     see callFalImageToVideo above and js/store.js's turnImageIntoVideo.
//                                     Deliberately NOT E108 or E111 — those two are retired/renamed
//                                     from this file's old subscription-paywall gate (see the E112 doc
//                                     block below) and reusing either would confuse anyone grepping old
//                                     support tickets for what those codes used to mean.)
//   E115 fal rejected the PixVerse V6 text-to-video submission (the edit-rotation partner model —
//                                     see callFalPixverse above and docs/EDIT_MECHANISM_SPEC.md §2/§3.4).
//                                     Same causes as E105, just the other rotation slot.
//   E116 content_policy_blocked    — the content-tier safety gate (lib/content-classifier.js,
//                                     founder-directed 2026-08-08) classified the dream as explicit
//                                     (any request) or as any sexual/romantic content when an uploaded
//                                     photo of a NAMED OTHER PERSON is attached (the anti-NCII
//                                     safeguard). Returned 422 with a clear, specific block message and
//                                     — unlike E105/E106/E114/E115 — NO fal call is made, NO spend is
//                                     reserved, and NO tokens are spent. Placed before the spend guard
//                                     and mock-mode branch specifically so a block costs nothing. See
//                                     the gate's own call site below and content-classifier.js's header
//                                     for the tiered policy and the fail-open/fail-closed directions.
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
//                                     Every token anyone can spend is either free-earned (220 on
//                                     first read of a never-before-seen email, +20 every 24h — see
//                                     getTokenStatus) or purchased via shop.html's token packs (live
//                                     via Dodo Payments — see create-checkout-session-dodo.js /
//                                     dodo-webhook.js / docs/PAYWALL_SETUP.md), and this gate doesn't
//                                     distinguish between the two — a balance is a balance regardless
//                                     of how it was earned. This is a cost/usage safeguard, not a
//                                     payment gate, and nobody is ever hard-blocked forever (the daily
//                                     drip guarantees continued access even with zero purchases), just
//                                     rate-limited to a sustainable free tier. A request with no email
//                                     at all has no way to be identified for a balance, so it's
//                                     treated as balance 0 (blocked) — see the handler below.
//   E113 turnstile_verification_failed — Cloudflare Turnstile bot-abuse check (see
//                                     lib/turnstile.js) rejected the request: the client-supplied
//                                     turnstileToken was missing, or Cloudflare's siteverify call
//                                     said it was invalid/expired, or siteverify itself couldn't be
//                                     reached. UNLIKE E109/E110/E112, this one is CONDITIONAL — it
//                                     only runs at all when TURNSTILE_SECRET_KEY is configured with a
//                                     real (non-placeholder) value (see docs/TURNSTILE_SETUP.md).
//                                     Unset/placeholder = this whole check is skipped entirely, same
//                                     as today, so a fresh deploy with no Cloudflare Turnstile site
//                                     set up yet never blocks a single real generation on this. Once
//                                     configured, it's still only a cheap complement to the three
//                                     guardrails above (a bot-abuse layer, per the anti-abuse-
//                                     guardrails research this implements) — it stops naive scripted
//                                     abuse, not a determined attacker working around it, and is
//                                     deliberately NOT attached to signup (js/store.js's signup() is
//                                     100% client-side, no server round-trip to verify a token
//                                     against — see docs/TURNSTILE_SETUP.md for why this generation
//                                     call is the actual choke point instead). Returns 403 (not
//                                     429/402/503 like the other three) since this isn't "come back
//                                     later" (rate limit), "you're out of balance" (token gate), or
//                                     "paused for today" (spend cap) — it's "this specific request
//                                     failed to establish trust," the same category as the 403s
//                                     already used elsewhere in this codebase for a failed identity/
//                                     ownership check (see admin-paywall-toggle.js).
//
// OWNER BYPASS (tracker.html's for-product-founder-hit-the-per-ip-gener-
// 7mjq2l item) — see lib/owner-bypass.js's header comment for the full
// mechanism and why it requires a real server-verified password, never a
// client-claimed email. When `ownerBypassToken` is present AND verifies
// (lib/owner-bypass.js's verifyBypassToken) AND its bound email matches
// THIS request's own (normalized) email — see the "REVIEW FIX" comment at
// the actual check below for why the bound-email match is required, not
// optional — this ONLY skips the E109 per-IP/per-email rate-limit
// checkAndIncrement calls immediately below, and the token-init per-IP cap
// inside entitlements.getTokenStatus's own opts.ownerBypass (see that
// function's doc comment) — both narrow, bounded exemptions. It
// structurally CANNOT affect E112 (the unconditional token-balance gate —
// the `tokenStatus.balance < 100` comparison below never reads
// ownerBypassActive at all) or E110 (spendGuard.checkAndReserve below is
// called with no bypass signal whatsoever, by design — see
// lib/spend-guard.js, untouched by this feature). A missing/invalid/
// expired/email-mismatched token is silently treated as "no bypass" (fails
// closed) — this whole check is a no-op for every request that doesn't
// carry a live token bound to that exact request's own email, i.e. every
// request except the founder's own verified session generating under his
// own account email.
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
var turnstile = require('./lib/turnstile');
var jobOwners = require('./lib/job-owners');
var ownerBypass = require('./lib/owner-bypass');
var geo = require('./lib/geo');
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
// shared resolver.
effectiveConfig.logEffectiveConfigOnce('generate-video', [
  { envVar: 'MAX_GENERATIONS_PER_IP_PER_DAY', default: 40, type: 'int' },
  { envVar: 'DAILY_SPEND_CAP_USD', default: 50, type: 'float' }
]);

/**
 * Server-side generation-profile CLASSIFIER (tracker item for-product-
 * cheap-generation-profile-for-yz2ina, founder-approved 2026-07-28). When
 * the request's resolved email matches OWNER_EMAIL (same normalizeEmail-
 * against-OWNER_EMAIL pattern as admin-paywall-toggle.js/add-tracker-item.js
 * — reused, not reinvented) OR the request's geolocation resolves to Israel
 * (lib/geo.js), this labels the request 'cheap_owner'/'cheap_il' purely for
 * cost-attribution logging (see the call site below) — never sent to the
 * client, never changes what's actually submitted to fal.
 *
 * A malformed/unreadable geo header (lib/geo.js's own fail-open contract)
 * resolves to "not Israel" here too.
 *
 * HISTORY on the now-removed `forceAudioOff` field this function used to
 * also return, for a future reader who runs into one of the two
 * contradictory-looking founder quotes in git history and wonders which
 * one is live: (1) 2026-07-28, this function's original form force-
 * disabled audio specifically for owner/IL traffic as a silent cost
 * control, honoring everyone else's own audio toggle; (2) 2026-07-29, the
 * founder explicitly RETIRED that ("Regarding Sound for Israel don't
 * disable it just leave it the same for everyone, including myself") —
 * `forceAudioOff` was hardcoded false, so owner/IL got the same toggle-
 * honoring behavior as every other requester; (3) 2026-08-02 (tracker item
 * for-product-turn-off-audio-dialogue-gene-ooeyoj), the founder reversed
 * course again in the OPPOSITE direction from (2) — not toward re-adding an
 * owner/IL-specific force-off, but toward disabling audio unconditionally
 * for EVERY requester (cost, and to stop invented lip-synced dialogue). That
 * directive is implemented as a flat `generateAudio = false` in the handler
 * below, which makes a per-profile `forceAudioOff` field meaningless — every
 * profile forces audio off now, uniformly, so there's nothing left for this
 * function to decide on that axis. The field was removed rather than kept
 * around hardcoded to `true`/dead — this function now returns only
 * `profile`, still useful for cost-attribution logging.
 *
 * Returns { profile } — 'cheap_owner' / 'cheap_il' / 'standard'.
 */
function resolveGenerationProfile(email, event) {
  var ownerEmail = entitlements.normalizeEmail(process.env.OWNER_EMAIL);
  var isOwner = !!(ownerEmail && email && email === ownerEmail);
  var isIsrael = geo.resolveCountryCode(event) === 'IL';
  return {
    profile: isOwner ? 'cheap_owner' : (isIsrael ? 'cheap_il' : 'standard')
  };
}

/**
 * Records that `email` submitted `operationName`, best-effort — see
 * lib/job-owners.js's own header comment for the full mechanism and the
 * vulnerability this closes (auto-refund's own round-2 review finding: an
 * unauthenticated caller could otherwise redirect a stranger's refund by
 * supplying their operationName with a different email). Wrapped so a
 * transient Blobs write failure here can never turn an already-successful,
 * already-paid-for submission into a 500 — the only consequence of a
 * failed write is that a LATER refund attempt for this job fails closed
 * (see refundTokensOnce), never that this submission itself breaks.
 *
 * Also records mediaType:'video' (this file's only kind — see
 * lib/job-owners.js's header comment on why this is recorded, not
 * derived) so mark-generation-completed.js can later preserve the first-
 * dream retention email's video-only scope when it fires automatically.
 */
async function recordJobOwnerBestEffort(event, operationName, email) {
  try {
    await jobOwners.recordJobOwner(event, operationName, email, 'video');
  } catch (e) {
    console.error('generate-video: failed to record job owner (refund auth binding) for ' + operationName + ' — a later refund attempt for this job will fail closed', e);
  }
}

// Same placeholder-string convention as js/analytics-config.js's
// POSTHOG_KEY/META_PIXEL_ID and js/turnstile-config.js's TURNSTILE_SITE_KEY
// — an unset or still-placeholder secret key means the E113 guardrail
// below is skipped entirely, so this must never accidentally block
// generation before the founder has actually set up a real Cloudflare
// Turnstile site (see docs/TURNSTILE_SETUP.md). Unlike the client-side
// site key, a real deploy has no reason to ever literally contain this
// placeholder string in TURNSTILE_SECRET_KEY (it's an env var, not
// checked-in source) — this check exists purely as defense-in-depth
// against someone copy-pasting the doc's example placeholder text
// directly into the env var box.
var TURNSTILE_SECRET_PLACEHOLDER = 'REPLACE_WITH_REAL_TURNSTILE_SECRET_KEY';

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

  var caption, style, characters, cameraView, sceneryTime, sceneryPlace, email, turnstileToken, sourceImageUrl, ownerBypassToken, clientAudioOn, musicStyle, requestedModel;
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
    // Optional — the "Turn this into a video" upsell (see js/store.js's
    // turnImageIntoVideo and result.html's CTA). When present, this request
    // routes through callFalImageToVideo instead of the normal text-to-video/
    // reference-to-video paths below — see the branch right before the fal
    // call itself.
    sourceImageUrl = typeof payload.sourceImageUrl === 'string' && payload.sourceImageUrl.trim() ? payload.sourceImageUrl.trim() : null;
    // Audio/music toggle (tracker item for-product-audio-on-off-choice-at-
    // creat-dyyr98, style.html's creation-flow toggle) — still parsed for
    // backward-compatible plumbing, but as of tracker item for-product-
    // turn-off-audio-dialogue-gene-ooeyoj (2026-08-02) clientAudioOn no
    // longer has any effect on generate_audio, which is now unconditionally
    // false regardless — see the generateAudio line further down for why.
    clientAudioOn = payload.audioOn === true;
    musicStyle = typeof payload.musicStyle === 'string' ? payload.musicStyle.trim() : null;
    // Model-rotation request (docs/EDIT_MECHANISM_SPEC.md §2/§3.4) — only
    // ever sent by result.html's edit sheet (via js/store.js's
    // pickEditModel), never by a fresh/non-edit generation. Any value other
    // than the literal 'pixverse-v6' (a missing field, a stale client, a
    // typo) silently falls back to the untouched default rotation slot
    // (MODEL_KEY_VEO_LITE / FAL_MODEL) below — same permissive-fallback
    // spirit as musicStyle above — so every caller that predates this
    // feature keeps behaving exactly as it did before.
    requestedModel = typeof payload.requestedModel === 'string' ? payload.requestedModel.trim() : null;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E103: invalid_json' }) };
  }

  if (!caption || !style) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E104: caption_and_style_required' }) };
  }

  // Model-rotation resolution (docs/EDIT_MECHANISM_SPEC.md §2/§3.4) —
  // computed up front (before the mock-mode early-return below) so both the
  // mock and real paths report an identical `modelUsed` for the identical
  // request. selfPhoto is computed here (not re-derived later) so this and
  // the real fal-call branch further down can never disagree about which
  // path a given request actually takes.
  //
  // rotationApplies is false for the self-photo reference-to-video path and
  // the "turn this into a video" image-to-video path — both explicitly OUT
  // of scope for rotation this wave (spec §3.6): those two always use their
  // own existing model, `requestedModel` is silently ignored for them, and
  // the response's modelUsed is null (the dream's existing modelUsed field,
  // if any, is left untouched by js/store.js's finalizeDream in that case —
  // see that function's own doc comment).
  var selfPhoto = characters.filter(function (c) { return c && c.isSelf && c.photoDataUrl; })[0];
  var rotationApplies = !sourceImageUrl && !selfPhoto;
  var useModelKey = (rotationApplies && requestedModel === MODEL_KEY_PIXVERSE_V6) ? MODEL_KEY_PIXVERSE_V6 : MODEL_KEY_VEO_LITE;
  var modelUsedForResponse = rotationApplies ? useModelKey : null;

  // --- Guardrails below: the Turnstile bot-check (E113, conditional — see
  // its doc block above), rate limiting (E109), the token gate (E112), and
  // the spend circuit breaker (E110) — the latter three unconditional, see
  // the doc block above for each.

  var ip = rateLimit.clientIp(event);

  // E113 — only runs at all once TURNSTILE_SECRET_KEY is a real, configured
  // value (see the doc block above and docs/TURNSTILE_SETUP.md). Placed
  // first among the guardrails so an obviously-bot request never consumes
  // any of the rate-limit/token/spend-guard budget below it.
  var turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret && turnstileSecret !== TURNSTILE_SECRET_PLACEHOLDER) {
    var turnstileResult = await turnstile.verify(turnstileToken, turnstileSecret, ip);
    if (!turnstileResult.success) {
      return { statusCode: 403, body: JSON.stringify({ error: 'E113: turnstile_verification_failed' + (turnstileResult.reason ? ': ' + turnstileResult.reason : '') }) };
    }
  }

  // Owner bypass resolution — see the "OWNER BYPASS" doc block above for
  // exactly what this does and does not affect. A missing token, or one
  // that fails lib/owner-bypass.js's own verification (expired, unknown,
  // malformed), leaves ownerBypassActive false — the same as if this
  // feature didn't exist at all, for every request that isn't the
  // founder's own verified session.
  //
  // REVIEW FIX (round 1): "the token verifies" is NOT enough on its own —
  // verifyBypassToken only proves the token was genuinely issued once and
  // hasn't expired, it says nothing about whether THIS request is the
  // session it was issued to. A token is bound to a specific email at
  // issuance (see lib/owner-bypass.js's createBypassToken/verifyBypassToken
  // doc comments) precisely so it can't be replayed against an arbitrary
  // email — e.g. a token leaked from localStorage, a shared/compromised
  // device, or an XSS'd tab attaching it to a request for SOME OTHER
  // email, to skip that other email's own rate limit/anti-farming cap.
  // The bound email must match THIS request's own (normalized) email
  // before the bypass is ever treated as active.
  var ownerBypassActive = false;
  if (ownerBypassToken) {
    var bypassCheck = await ownerBypass.verifyBypassToken(event, ownerBypassToken);
    ownerBypassActive = !!(bypassCheck.ok && email && bypassCheck.email === email);
  }

  // Generation profile classifier (tracker item for-product-cheap-
  // generation-profile-for-yz2ina) — resolved once, up front, purely for
  // cost-attribution logging (see resolveGenerationProfile's own doc
  // comment; it no longer affects generate_audio — see the generateAudio
  // line further down for that). Logged here (rather than a PostHog event
  // — see that function's own doc comment on why no existing server-side
  // capture call exists in this file to attach the property to) purely for
  // operational cost-attribution visibility, same "best-effort, never
  // blocks the request" spirit as every other console.log/warn in this file.
  var generationProfileResult = resolveGenerationProfile(email, event);
  console.log('generate-video: generation_profile=' + generationProfileResult.profile);

  var maxPerDay = parseInt(process.env.MAX_GENERATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40; // default 40 (founder directive 2026-07-29); env MAX_GENERATIONS_PER_IP_PER_DAY overrides

  if (!ownerBypassActive) {
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
  }

  // E112 — unconditional token-balance gate, see the doc block above for
  // why this always runs (no flag, no owner bypass on the THRESHOLD
  // itself), unlike the E108/E111 subscription-paywall gate this replaces.
  // ownerBypassActive is forwarded here ONLY to let a brand-new email's
  // first-ever grant skip the separate token-init per-IP cap (see
  // entitlements.getTokenStatus's own doc comment) — it never changes the
  // `< 100` comparison two lines below, which runs unconditionally against
  // whatever balance comes back either way. A request with no email can't
  // be identified for a balance at all, so it reads as balance 0 (blocked)
  // via getTokenStatus's own empty-email guard rather than a special case
  // here.
  var tokenStatus = await entitlements.getTokenStatus(event, email, { ownerBypass: ownerBypassActive });
  if (tokenStatus.balance < 100) {
    return { statusCode: 402, body: JSON.stringify({ error: 'E112: insufficient_tokens: not enough tokens to generate a video' }) };
  }

  // E116 — CONTENT-TIER SAFETY GATE (founder-directed 2026-08-08, see
  // lib/content-classifier.js's full header for the policy). Classifies the
  // dream text into explicit/romantic/clean BEFORE any generation is
  // committed, and blocks per the tiered threshold:
  //   - normal request:            block EXPLICIT (romantic/clean pass).
  //   - named-other-person photo:  block ANY sexual/romantic content
  //                                (the anti-NCII safeguard — a non-self
  //                                character with both a name and a photo).
  // Deliberately placed AFTER the token-balance check but BEFORE the spend
  // guard's checkAndReserve below AND before the mock-mode early-return, so a
  // block (a) never reserves against the daily spend cap for a generation
  // that won't happen, and (b) never spends tokens — in mock mode or real.
  // The named-person flag is STRUCTURED data from the character payload
  // (contentClassifier.detectNamedOtherPersonPhoto), never inferred by the
  // LLM. Character descriptions are folded into the classified text too
  // (buildClassifiableText), so explicit text can't hide in a "description"
  // field. FAIL-SAFE: the normal case fails OPEN on a classifier error/
  // timeout (the model's own guardrails still refuse hard-explicit output, so
  // a classifier outage must not break generation for everyone); the
  // named-other-person-photo case fails CLOSED (the NCII landmine must never
  // slip through on an error). Both directions live in
  // evaluateGenerationGate. On a block, NO fal call is made and NO tokens are
  // spent — the client (home.html/result.html's content-policy branch)
  // surfaces `error` as a clean, specific message, not a generic failure.
  var hasNamedOtherPersonPhoto = contentClassifier.detectNamedOtherPersonPhoto(characters);
  var classifiableText = contentClassifier.buildClassifiableText(caption, characters);
  var gate = await contentClassifier.evaluateGenerationGate({
    text: classifiableText,
    hasNamedOtherPersonPhoto: hasNamedOtherPersonPhoto,
    falKey: falKey
  });
  if (!gate.allowed) {
    console.log('generate-video: content_gate_blocked reason=' + gate.reason + (gate.error ? (' error=' + gate.error) : '') + ' named_photo=' + hasNamedOtherPersonPhoto);
    return { statusCode: 422, body: JSON.stringify({ error: 'E116: content_policy_blocked: ' + gate.message }) };
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
    var mockOpName = mockOperationName();
    await recordJobOwnerBestEffort(event, mockOpName, email);
    return { statusCode: 200, body: JSON.stringify({ operationName: mockOpName, modelUsed: modelUsedForResponse }) };
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
  // generateAudio is UNCONDITIONALLY false — tracker item for-product-
  // turn-off-audio-dialogue-gene-ooeyoj, founder directive 2026-08-02. This
  // replaces what used to be a three-way AND of clientAudioOn (style.html's
  // toggle) && !condensed.wasCondensed && !generationProfileResult.forceAudioOff
  // (see git history on this line for that older logic). Two independent
  // reasons the founder gave, either one alone would be sufficient:
  // (1) COST — on fal's veo3.1 endpoints, audio-on bills meaningfully
  //     higher per second than audio-off (confirmed against fal's own
  //     pricing, not guessed — see the FAL_MODEL_TEXT_TO_VIDEO comment
  //     above for the exact $/s split).
  // (2) CORRECTNESS — the founder watched a real generated dream where the
  //     character lip-synced invented dialogue: words he never wrote, via
  //     Veo's own native audio generation. There is no separate "dialogue
  //     only" toggle on this model — audio and lip-synced dialogue both
  //     ride on the same `generate_audio` flag — so forcing that flag off
  //     is the only lever available and it's a hard requirement
  //     independent of cost, not just a cost optimization.
  // clientAudioOn/musicStyle are still read from the payload above and the
  // style.html toggle that sends them still exists in the client (shown
  // disabled with an explanatory note — see style.html) — left as inert,
  // trivially-reversible plumbing per this codebase's standing "no dead
  // code, but no silent throwaway either" convention, rather than ripped
  // out. This line is now the ONLY place that decides generate_audio for
  // every real call in this file (callFal/callFalReferenceToVideo/
  // callFalImageToVideo/callFalPixverse, all four below) — and the
  // identical override also lives in start-pending-generation.js, the one
  // other real caller of these same fal functions (see that file's own
  // comment on why it can't just import this variable).
  var generateAudio = false;
  // Always null now that generateAudio is always false — see
  // MUSIC_STYLE_MODIFIERS' own doc comment for why appending a music
  // instruction to a silent generation would be meaningless. Kept as a
  // ternary (rather than a flat null) so a future revert of the line above
  // doesn't also require remembering to restore this one.
  var promptMusicStyle = generateAudio ? musicStyle : null;

  var prompt = buildPrompt(condensed.text, style, characters, cameraView, sceneryTime, sceneryPlace, promptMusicStyle);
  // selfPhoto/rotationApplies/useModelKey are already resolved above (before
  // the mock-mode branch) — reused here rather than re-derived, so the two
  // can never disagree about which path this request takes.
  var duration = resolveDuration();

  try {
    // sourceImageUrl (the "Turn this into a video" upsell) takes priority
    // over the self-photo reference-to-video path — these are two
    // different fal concepts and mutually exclusive per request (see
    // callFalImageToVideo's own doc comment and
    // docs/IMAGE_GENERATION_SPEC.md §6's known-limitation writeup): a
    // "turn this into a video" call always animates the already-generated
    // image, it never also blends in a separate self-photo reference in
    // the same call. Rotation (useModelKey) only ever affects the third,
    // plain text-to-video branch — see rotationApplies above.
    var result = sourceImageUrl
      ? await callFalImageToVideo(prompt, sourceImageUrl, falKey, duration, generateAudio)
      : selfPhoto
        ? await callFalReferenceToVideo(prompt, selfPhoto.photoDataUrl, falKey, duration, generateAudio)
        : (useModelKey === MODEL_KEY_PIXVERSE_V6
            ? await callFalPixverse(prompt, falKey, duration, generateAudio)
            : await callFal(prompt, falKey, duration, generateAudio));
    if (!result.ok) {
      // No real spend happened — a rejected submission must NOT spend
      // tokens, so spendTokens is deliberately not called on this path
      // (see the E112 doc block above).
      var rejectCode = sourceImageUrl ? 'E114' : (selfPhoto ? 'E106' : (useModelKey === MODEL_KEY_PIXVERSE_V6 ? 'E115' : 'E105'));
      return { statusCode: result.statusCode || 500, body: JSON.stringify({ error: rejectCode + ': ' + result.error }) };
    }
    await entitlements.spendTokens(event, email, 100);
    await recordJobOwnerBestEffort(event, result.operationName, email);
    return { statusCode: 200, body: JSON.stringify({ operationName: result.operationName, modelUsed: modelUsedForResponse }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E107: fal_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};

// Named exports below are purely additive — exports.handler above (this
// file's only export until now) is completely unchanged, and nothing here
// alters its behavior. start-pending-generation.js (the dream-builder
// wizard's pre-signup generation path — see that file and
// dream-webhook.js) reuses these instead of re-implementing the same
// prompt-assembly/fal-call logic a second time, so the two call sites can
// never silently drift apart. Every function here is a plain, already-
// pure top-level declaration (no closures over handler-local state), so
// exporting them has no behavioral cost.
exports.buildPrompt = buildPrompt;
exports.callFal = callFal;
exports.callFalPixverse = callFalPixverse;
exports.callFalReferenceToVideo = callFalReferenceToVideo;
exports.submitReferenceToVideo = submitReferenceToVideo;
exports.referenceToVideoBody = referenceToVideoBody;
exports.isViduModel = isViduModel;
exports.callFalImageToVideo = callFalImageToVideo;
exports.resolveDuration = resolveDuration;
exports.falErrorMessage = falErrorMessage;
exports.resolveGenerationProfile = resolveGenerationProfile;
exports.MODEL_KEY_VEO_LITE = MODEL_KEY_VEO_LITE;
exports.MODEL_KEY_PIXVERSE_V6 = MODEL_KEY_PIXVERSE_V6;
exports.FAL_MODEL_PIXVERSE_V6 = FAL_MODEL_PIXVERSE_V6;
exports.FAL_MODEL = FAL_MODEL;
exports.FAL_MODEL_REFERENCE_TO_VIDEO = FAL_MODEL_REFERENCE_TO_VIDEO;
exports.FAL_MODEL_REFERENCE_TO_VIDEO_VEO = FAL_MODEL_REFERENCE_TO_VIDEO_VEO;
exports.FAL_MODEL_IMAGE_TO_VIDEO = FAL_MODEL_IMAGE_TO_VIDEO;
exports.FAL_NO_EXPIRY_HEADER = FAL_NO_EXPIRY_HEADER;
