// netlify/functions/lib/media-rehost.js
//
// Best-effort re-host of a freshly-generated fal.ai media URL into Netlify
// Blobs, so playback stops depending on fal's own CDN retention at all —
// tracker item for-product-owner-media-library-page-fou-1fwxaw's corrected
// scope, closing the founder's own 2026-07-29 directive on
// for-product-bug-build-re-host-image-drea-0hpbm0 that was captured as a
// tracker comment but never actually built: "I think that in any case we
// want to store all created videos and images somewhere. do that
// regardless of these projects."
//
// This is deliberately a SEPARATE, second layer of defense — layer #1 is
// generate-video.js's/generate-image.js's FAL_NO_EXPIRY_HEADER (fal-side,
// disables expiry at the source for every generation submitted from commit
// a098b14 onward — see lib/media-status.js's own header comment for the
// exact cutoff), which is real but still a vendor-policy assumption, not
// our own storage. Own storage is the durable answer regardless of what
// fal's retention policy does or ever changes to.
//
// CALLED FROM (every completion path that hands back a real fal media URL —
// see this task's own build brief on "two completion paths that must never
// diverge"):
//   - video-status.js's checkFalStatus, the moment it resolves a real
//     videoUrl from fal's result endpoint (covers every signed-in video
//     generation: fresh, regenerate, reference-to-video, image-to-video —
//     all funnel through the same "fal:<model>:<request_id>" operationName
//     shape and the same checkFalStatus call).
//   - image-status.js's checkFalImageStatus, the same moment for images.
//   - dream-webhook.js, fal's own webhook callback for the dream-builder
//     funnel's pre-signup ABANDONED-video path — this is a genuinely
//     SEPARATE completion path (see that file's own header comment: it's
//     the only real fal webhook target this app has, wired only to the
//     funnel's abandoned-dream flow) that hands back a raw fal video URL
//     directly in the webhook payload, never touching video-status.js at
//     all. Both paths call this same function so neither can silently drift
//     out of sync with the other on what "re-hosted" means.
//
// NEVER BLOCKS THE USER-FACING FLOW: every failure mode here (fetch fails,
// non-OK response, Blobs write fails, any thrown error) resolves
// { ok: false } rather than throwing — the caller falls back to fal's own
// URL exactly as it did before this feature existed. Same "never break the
// user-facing flow for a background durability concern" posture as this
// codebase's other best-effort steps (probeVideoDuration client-side, the
// retention-email sends server-side).
//
// STORAGE SHAPE: one Blobs record per media file, keyed by the fal
// requestId (already unique per generation job, no new id-minting needed —
// see each call site for exactly what it passes as `key`) in the
// "dreamtube-videos" / "dreamtube-images" store — the SAME store/key shape
// video-file.mjs's already-shipped (if previously unused in the active fal
// path) streaming endpoint expects (store.getWithMetadata(key,
// {type:'stream'}), metadata: { contentType }) — see that file's own header
// comment. image-file.mjs (added alongside this file) mirrors it exactly
// for the image store. Durable URL shape:
// /.netlify/functions/video-file?key=<key> or .../image-file?key=<key> —
// lib/media-status.js's isDurableUrl is the single place that shape is
// interpreted back out, so the two files must be kept in sync if it ever
// changes.
//
// IDEMPOTENT: re-hosting the same key twice (a duplicate/retried
// completion, two browser tabs racing the same poll, or the backfill sweep
// re-checking a dream whose media was already re-hosted by this same code
// path) is a cheap no-op — checks store.getMetadata(key) first and skips
// the fetch+write entirely if already present, mirroring video-status.js's
// own legacy checkVeoStatus existing-key check.
//
// SIZE: no explicit cap — this only ever re-hosts OUR OWN just-generated
// fal output (a trusted source, not an arbitrary user-supplied URL), and
// fal's own media (short video clips, single images) is always well within
// any Blobs per-object size Netlify actually enforces.
//
// JPEG NORMALIZATION (image dreams, tracker item's own nice-to-have, cited
// from the original 0hpbm0 scope — Instagram publishing later needs JPEG
// <=8MB): deliberately NOT done here. Re-encoding would need a real
// image-processing dependency (sharp or equivalent — this codebase has none
// today, and adding one is a new dependency decision, not something to pull
// in silently mid-feature per this task's own "flag new dependencies
// instead of just doing it" constraint), and flux/dev's own output is
// already well under any plausible size ceiling. Images are re-hosted
// as-is, with fal's own reported content-type preserved. Left as a real,
// documented scope cut for whoever eventually wires up auto-posting.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAMES = { video: 'dreamtube-videos', image: 'dreamtube-images' };
var FILE_FUNCTIONS = { video: 'video-file', image: 'image-file' };
var DEFAULT_CONTENT_TYPES = { video: 'video/mp4', image: 'image/jpeg' };

/** The durable, Blobs-backed URL for a given mediaType+key — see lib/media-status.js's isDurableUrl, which must recognize exactly this shape. */
function durableUrl(mediaType, key) {
  return '/.netlify/functions/' + FILE_FUNCTIONS[mediaType] + '?key=' + encodeURIComponent(key);
}

/**
 * Best-effort re-host of `sourceUrl` (a fal.ai media URL) into Blobs, keyed
 * by `key`. Returns { ok: true, url } (the new durable URL) on success,
 * { ok: false } on ANY failure or invalid input — NEVER throws. See header
 * comment for the full reasoning.
 */
async function rehostBestEffort(event, mediaType, sourceUrl, key) {
  var storeName = STORE_NAMES[mediaType];
  if (!storeName || typeof sourceUrl !== 'string' || !sourceUrl || typeof key !== 'string' || !key) {
    return { ok: false };
  }

  try {
    connectLambda(event);
    var store = getStore({ name: storeName });

    // Idempotent — see header comment.
    var existing = await store.getMetadata(key);
    if (existing) return { ok: true, url: durableUrl(mediaType, key) };

    var res = await fetch(sourceUrl);
    if (!res.ok) return { ok: false };
    var arrayBuffer = await res.arrayBuffer();
    var contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || DEFAULT_CONTENT_TYPES[mediaType];

    await store.set(key, arrayBuffer, { metadata: { contentType: contentType } });
    return { ok: true, url: durableUrl(mediaType, key) };
  } catch (e) {
    console.error('media-rehost: best-effort re-host failed for ' + mediaType + ' key=' + key, e);
    return { ok: false };
  }
}

module.exports = { rehostBestEffort, durableUrl, STORE_NAMES, FILE_FUNCTIONS };
