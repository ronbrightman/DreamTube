// netlify/functions/lib/watermark-video.js
//
// Founder ruling (tracker item for-product-founder-ruling-08-07-every-u-
// g81h7v, 2026-08-07): "when a user downloads a video, the file must carry
// the logo watermark." Generation and in-app playback stay completely
// untouched (both keep using the clean, original video exactly as before)
// — this module only ever runs at DOWNLOAD time, lazily, the first time
// anyone requests a given dream's video for download. Once produced, the
// watermarked "twin" is cached forever in its own Blobs store and reused
// for every subsequent download of that same dream, including from the
// IG/TikTok postpack export flow (assemble-instagram-tiktok-postpack.js /
// postpack-h4mv.html) — same dreamId, same cache key, so both surfaces
// share one twin per dream rather than each maintaining its own.
//
// WHY blend-video + a static overlay asset, not ffmpeg-api/compose alone
// (the mechanism this ruling's own text originally named): investigated
// twice before this file existed (see this tracker item's own comment
// history) — fal-ai/ffmpeg-api/compose's tracks/keyframes shape is a pure
// media SEQUENCER (arranges whole clips end-to-end on a timeline; its
// Keyframe type is only {id, type, url, timestamp, duration} — no
// position/x/y/width/height/opacity/z-order fields at all), so it
// genuinely cannot place a small logo in a video's corner.
// fal-ai/workflow-utilities/blend-video CAN, but only via ffmpeg's `blend`
// filter's arithmetic blend-mode trick, not real alpha compositing (its
// schema has no alpha/position fields either — confirmed against its real
// API schema, not marketing copy: inputs are just top_video_url,
// bottom_video_url, blend_mode, opacity, shortest; output is
// `{ video: { url, content_type, file_size, file_name } }`). The trick:
// with blend_mode "screen" (result = 1-(1-top)*(1-bottom) per pixel),
// wherever the TOP layer is pure black the result is simply the bottom
// layer unchanged (screen(0, B) = B) — so a top video that's black
// EVERYWHERE except a small translucent logo badge in one corner behaves
// exactly like a real corner watermark overlay, without needing an actual
// alpha channel. assets/watermark-overlay-720x1280.mp4 (committed once,
// see that asset's own generation script referenced below) is exactly
// that: 720x1280 (this app's fixed, confirmed veo3.1 9:16/720p output
// size — see generate-video.js's aspect_ratio/resolution literals and
// image-status.js's own 720x1280 mock sample), solid black, with the
// DreamTube logo badge (assets/logo-v4-512.png) pasted bottom-right at
// ~9% of the short side / ~3.5% padding — the SAME corner geometry PR #29
// already shipped for the client-side image watermark in postpack-h4mv.html
// (WATERMARK_LOGO_SIZE_RATIO/WATERMARK_PADDING_RATIO), so a video download
// and an image download read as the same visual brand mark. Logo pixel
// brightness is pre-scaled by 0.82 (that same PR's WATERMARK_OPACITY) so
// the baked-in translucency matches too, rather than relying on
// blend-video's own runtime `opacity` param (left at 1 here — no reason to
// stack two opacity mechanisms).
//
// WHY THE OVERLAY IS ONLY 1 SECOND LONG, NOT PER-VIDEO-DURATION-MATCHED
// (the other open question this ruling flagged): fal's blend-video
// documents `shortest` (default true) as "End output when the shortest
// input ends" — ffmpeg's own `blend` filter (which this endpoint wraps)
// documents the same framesync option: shortest=false (this module's own
// explicit choice below, overriding fal's default) makes the OUTPUT run to
// the LONGEST input's length, while framesync's other default,
// repeatlast=1, holds the SHORTER input's last frame for the remainder.
// Verified directly against the real ffmpeg binary in this build's own
// sandbox (imageio-ffmpeg's bundled static build, not a guess): blending a
// 1-second single-frame overlay against a synthetic 4-second base clip
// with `blend=all_mode=screen:shortest=0` produced a full 4-second output
// with the logo still visibly present in the very last frame (t=3.5s) —
// i.e. one short, fixed-length overlay asset genuinely works for a dream
// video of ANY length, with zero per-video overlay generation needed. This
// sandbox has no FAL_KEY, so the exact fal-hosted blend-video call itself
// could not be smoke-tested for real (disclosed plainly in this feature's
// own build report) — but it's a documented, thin wrapper around the exact
// ffmpeg `blend` filter this sandbox verified directly, not a black box.
//
// STORAGE: reuses lib/media-rehost.js's existing rehostBestEffort/Blobs
// pattern rather than a new storage mechanism — see this module's own
// 'video-watermarked' mediaType addition to that file's STORE_NAMES/
// FILE_FUNCTIONS/DEFAULT_CONTENT_TYPES maps. Twins live in their own
// "dreamtube-videos-watermarked" Blobs store (never mixed into
// "dreamtube-videos", which stays exactly the clean-original store it's
// always been), keyed by the dream's own `id` (already a stable, globally
// unique identifier used elsewhere for exactly this purpose — see
// js/share-sheet.js's existing 'dreamtube-' + dream.id + '.' + ext
// filename convention) — this is what makes "retroactive for every
// existing video" and "IG/TikTok postpack reuses the same twins" both
// true for free: any caller that knows a dream's id and its current clean
// videoUrl can ask for (or trigger) that same cached twin, regardless of
// which page/flow the download request came from.
//
// ASYNC JOB SHAPE: a blend-video call is a real fal.ai queue job (not a
// guaranteed-instant response), so this follows the exact SAME
// submit-then-poll idiom this codebase already uses for real generation
// (generate-video.js submits, video-status.js polls) rather than blocking
// a single Netlify Function invocation on an unbounded wait — see
// download-video.js (submit) / download-video-status.js (poll) for the two
// user-facing endpoints built on top of this module. A small "pending job"
// marker (dreamtube-watermark-jobs store, one JSON record per dreamId)
// tracks the in-flight requestId between the submit call and however many
// status polls it takes to finish, so two overlapping download attempts
// for the same dream don't both submit their own fal job.
//
// NEVER SILENTLY FALLS BACK TO THE CLEAN VIDEO ON FAILURE — unlike
// lib/media-rehost.js's "own storage is best-effort, fall back to fal's
// url" posture (which is fine because that concerns PLAYBACK durability,
// not this ruling), a failed/errored watermark job here must surface as a
// real error to the caller, never quietly hand back the unwatermarked
// original — that would violate the ruling this whole file exists to
// satisfy. See download-video-status.js's error path.

var { connectLambda, getStore } = require('@netlify/blobs');
var falQueue = require('./fal-queue');
var mediaRehost = require('./media-rehost');

var BLEND_MODEL = 'fal-ai/workflow-utilities/blend-video';
var JOBS_STORE = 'dreamtube-watermark-jobs';
var TWIN_MEDIA_TYPE = 'video-watermarked';
var OVERLAY_ASSET_PATH = '/assets/watermark-overlay-720x1280.mp4';

// Same generic fal request-lifecycle header generate-video.js defines as
// FAL_NO_EXPIRY_HEADER (duplicated here rather than required from that
// file, per this codebase's "self-contained function/lib module"
// convention) — disables fal's default media-expiration window on the
// blend-video call's own output, so the twin's fal-hosted url stays valid
// indefinitely even in the rare case rehostBestEffort itself can't cache
// it into our own Blobs (see that function's own "NEVER THROWS" doc
// block).
var FAL_NO_EXPIRY_HEADER = { 'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: null }) };

// A pending job marker older than this is treated as abandoned/stuck
// (e.g. a Netlify function that crashed mid-poll, or a fal job that never
// reports back) rather than blocking new attempts forever — the next
// download-video.js call for that dream is free to submit a fresh job
// instead of returning "processing" indefinitely. Generous on purpose: a
// real blend job is expected to take low tens of seconds at most for this
// app's short dream clips, not minutes.
var PENDING_JOB_STALE_MS = 5 * 60 * 1000;

/**
 * The absolute, publicly-fetchable URL of the committed overlay asset —
 * fal's own servers need to fetch this over the open internet, so it can
 * never be a relative path. Same FALLBACK_HOST derivation share-dream.js/
 * share-profile.js already use (process.env.URL, Netlify's own built-in
 * "this site's primary URL" env var, falling back to the known production
 * host only if that's ever unset, e.g. local dev/tests).
 */
function siteOrigin() {
  var siteUrl = process.env.URL;
  if (siteUrl) {
    try { return new URL(siteUrl).origin; } catch (e) { /* fall through */ }
  }
  return 'https://dreamtube1.netlify.app';
}

function overlayAssetUrl() {
  return siteOrigin() + OVERLAY_ASSET_PATH;
}

/** { found: false } | { found: true, url, tooLargeToServe } — never throws. */
async function getCachedTwin(event, dreamId) {
  try {
    connectLambda(event);
    var store = getStore({ name: mediaRehost.STORE_NAMES[TWIN_MEDIA_TYPE] });
    var existing = await store.getMetadata(dreamId);
    if (!existing) return { found: false };
    var meta = existing.metadata || {};
    var oversized = typeof meta.byteLength === 'number' && meta.byteLength > mediaRehost.MAX_STREAMABLE_BYTES;
    return oversized
      ? { found: true, url: meta.sourceUrl || null, tooLargeToServe: true }
      : { found: true, url: mediaRehost.durableUrl(TWIN_MEDIA_TYPE, dreamId) };
  } catch (e) {
    console.error('watermark-video: getCachedTwin failed', e && e.message);
    return { found: false };
  }
}

/** Reads the pending-job marker for `dreamId`, or null if there isn't one (or it's stale — see PENDING_JOB_STALE_MS). */
async function getPendingJob(event, dreamId) {
  try {
    connectLambda(event);
    var store = getStore({ name: JOBS_STORE });
    var job = await store.get(dreamId, { type: 'json' });
    if (!job) return null;
    if (Date.now() - (job.createdAt || 0) > PENDING_JOB_STALE_MS) return null;
    return job;
  } catch (e) {
    console.error('watermark-video: getPendingJob failed', e && e.message);
    return null;
  }
}

async function setPendingJob(event, dreamId, job) {
  connectLambda(event);
  var store = getStore({ name: JOBS_STORE });
  await store.setJSON(dreamId, job);
}

async function clearPendingJob(event, dreamId) {
  try {
    connectLambda(event);
    var store = getStore({ name: JOBS_STORE });
    await store.delete(dreamId);
  } catch (e) {
    console.error('watermark-video: clearPendingJob failed', e && e.message);
  }
}

/**
 * Submits the blend-video job for `dreamId`/`srcVideoUrl` and records a
 * pending-job marker. Returns { ok: true, requestId } or
 * { ok: false, error }. Does NOT check for an existing cached twin or
 * pending job first — that's the caller's job (download-video.js), so this
 * stays a single, testable "just submit" operation.
 */
async function submitBlendJob(event, dreamId, srcVideoUrl, falKey) {
  var submitResult = await falQueue.submitJob(BLEND_MODEL, falKey, {
    top_video_url: overlayAssetUrl(),
    bottom_video_url: srcVideoUrl,
    blend_mode: 'screen',
    opacity: 1,
    shortest: false
  }, FAL_NO_EXPIRY_HEADER);

  if (!submitResult.ok) return submitResult;

  await setPendingJob(event, dreamId, {
    requestId: submitResult.requestId,
    model: BLEND_MODEL,
    createdAt: Date.now()
  });

  return submitResult;
}

/**
 * Polls the pending job for `dreamId` once and, if it just completed,
 * caches the result as the durable twin. Returns:
 *   { status: 'processing' }
 *   { status: 'ready', url }
 *   { status: 'error', error }
 * Never throws.
 */
async function pollAndFinalize(event, dreamId, falKey) {
  var job = await getPendingJob(event, dreamId);
  if (!job) return { status: 'error', error: 'no_pending_job' };

  var pollResult = await falQueue.pollJob(job.model, job.requestId, falKey);

  if (!pollResult.ok) {
    await clearPendingJob(event, dreamId);
    return { status: 'error', error: pollResult.error };
  }
  if (!pollResult.done) {
    return { status: 'processing' };
  }

  var videoUrl = pollResult.result && pollResult.result.video && pollResult.result.video.url;
  if (!videoUrl) {
    await clearPendingJob(event, dreamId);
    return { status: 'error', error: 'no_video_in_response' };
  }

  var rehost = await mediaRehost.rehostBestEffort(event, TWIN_MEDIA_TYPE, videoUrl, dreamId);
  await clearPendingJob(event, dreamId);
  return { status: 'ready', url: rehost.ok ? rehost.url : videoUrl };
}

module.exports = {
  BLEND_MODEL: BLEND_MODEL,
  TWIN_MEDIA_TYPE: TWIN_MEDIA_TYPE,
  overlayAssetUrl: overlayAssetUrl,
  getCachedTwin: getCachedTwin,
  getPendingJob: getPendingJob,
  submitBlendJob: submitBlendJob,
  pollAndFinalize: pollAndFinalize,
  clearPendingJob: clearPendingJob
};
