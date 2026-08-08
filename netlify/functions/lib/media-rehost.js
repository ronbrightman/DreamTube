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
// SIZE — CORRECTED 2026-08-02 (tracker item
// for-product-urgent-founder-repro-on-drea-uq3a36): this comment used to
// claim "no explicit cap ... fal's own media is always well within any
// Blobs per-object size Netlify actually enforces." That was true for
// WRITING into Blobs (no meaningful cap there) but wrong about what
// matters: video-file.mjs/image-file.mjs — the only way anything stored
// here is ever served back out — are Netlify "streaming" (V2,
// Response-based) functions, and Netlify's own docs
// (https://docs.netlify.com/build/functions/api/, "Streaming responses")
// state plainly: "Streaming functions have a 60-second execution limit and
// a 20 MB response size limit." A real fal-ai/veo3.1 8s/720p clip with
// audio routinely exceeds that. Every dream re-hosted since the own-storage
// cutover was silently switched to a URL that then 502'd for anyone trying
// to actually watch it ("error decoding lambda response: unexpected end of
// JSON input" — consistent with Netlify's own Lambda-response-streaming
// adapter breaking on an oversized body, not a bug in this codebase's own
// Blobs calls, which are correct per the installed SDK's types in both the
// 8.x and 10.x majors — checked both, no relevant behavior difference).
//
// MAX_STREAMABLE_BYTES below gates this: anything over that ceiling still
// gets WRITTEN to Blobs (durability doesn't stop mattering just because we
// can't serve it back through our own endpoint today), but rehostBestEffort
// returns { ok: false } for it so the caller keeps fal's own url — which
// actually plays, and (for anything generated since commit a098b14) is
// protected from fal's own expiry by FAL_NO_EXPIRY_HEADER (see
// generate-video.js/generate-image.js) even though it isn't "our own
// storage." video-file.mjs/image-file.mjs also carry a matching defensive
// check (see their own header comments) as a second layer, in case
// anything else ever writes into these stores without going through this
// gate.
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
//
// `options.force` (added 2026-08-02, tracker item
// for-product-urgent-reopen-video-repair-p-cyp8np): a record re-hosted
// BEFORE the SIZE fix above ever shipped only ever got `{contentType}`
// written as its metadata — no `sourceUrl`, no `byteLength` — since neither
// field existed yet at write time. The "existing record" short-circuit just
// above exists to make a normal call idempotent (see IDEMPOTENT header
// paragraph), but for exactly this legacy-broken shape it's actively
// counterproductive: it sees SOME metadata already on file and returns
// success without ever looking at whether the record is actually broken.
// admin-repair-oversized-media.js is the one caller that needs to bypass
// this — it has already independently confirmed (by measuring the real
// stored blob's byte length directly, no fal call needed for that part —
// see that file's own header comment) that this specific key is genuinely
// oversized-and-broken, and needs a real re-fetch+re-write to backfill the
// sourceUrl/byteLength this file's normal path would have written the
// first time. `{ force: true }` skips the existing-record short-circuit
// entirely and always re-fetches sourceUrl + re-writes — same "same Blobs
// key, so this legitimately overwrites the existing entry in place" shape
// as an ordinary first-time re-host, just re-run deliberately instead of
// skipped. No other caller passes this — every live completion path
// (video-status.js/image-status.js/dream-webhook.js) and the general
// backfill sweep (admin-backfill-media-rehost.js) all still want the plain
// idempotent short-circuit, unchanged.

var { getStore, connectLambda } = require('@netlify/blobs');

// 'video-watermarked' added for lib/watermark-video.js (tracker item
// for-product-founder-ruling-08-07-every-u-g81h7v — watermark-on-download)
// — a SEPARATE store/key-space from 'video' above, deliberately: these are
// server-generated watermarked TWINS, keyed by dreamId rather than by fal
// requestId, never the clean original a dream's in-app playback depends
// on. Reusing rehostBestEffort here (rather than a parallel hand-rolled
// write path) gets the same idempotency/size-gate/force-bypass behavior
// for free — see that module's own header comment for the full mechanism,
// unchanged for every existing 'video'/'image' caller.
var STORE_NAMES = { video: 'dreamtube-videos', image: 'dreamtube-images', 'video-watermarked': 'dreamtube-videos-watermarked' };
var FILE_FUNCTIONS = { video: 'video-file', image: 'image-file', 'video-watermarked': 'watermarked-video-file' };
var DEFAULT_CONTENT_TYPES = { video: 'video/mp4', image: 'image/jpeg', 'video-watermarked': 'video/mp4' };

// Netlify's documented hard ceiling for a streaming function's response —
// see this file's header comment ("SIZE") for the full reasoning and the
// exact doc quote. 18 MiB, not the full 20 MB: headroom for HTTP header
// framing and for the "20 MB" figure's own decimal-vs-binary ambiguity —
// this codebase would rather fall back to fal's own url a little early than
// risk actually tripping the real ceiling. video-file.mjs/image-file.mjs
// duplicate this same value (self-contained-file convention, see e.g.
// image-file.mjs's own header comment) — if this ever changes, update both.
var MAX_STREAMABLE_BYTES = 18 * 1024 * 1024;

/** The durable, Blobs-backed URL for a given mediaType+key — see lib/media-status.js's isDurableUrl, which must recognize exactly this shape. */
function durableUrl(mediaType, key) {
  return '/.netlify/functions/' + FILE_FUNCTIONS[mediaType] + '?key=' + encodeURIComponent(key);
}

/**
 * Best-effort re-host of `sourceUrl` (a fal.ai media URL) into Blobs, keyed
 * by `key`. Returns { ok: true, url } (the new durable URL) on success,
 * { ok: false } on ANY failure or invalid input — NEVER throws. See header
 * comment for the full reasoning. `options.force` (default false) bypasses
 * the existing-record idempotency short-circuit below — see this file's
 * own "`options.force`" header comment for why/who uses it.
 */
async function rehostBestEffort(event, mediaType, sourceUrl, key, options) {
  var storeName = STORE_NAMES[mediaType];
  if (!storeName || typeof sourceUrl !== 'string' || !sourceUrl || typeof key !== 'string' || !key) {
    return { ok: false };
  }
  var force = !!(options && options.force);

  try {
    connectLambda(event);
    var store = getStore({ name: storeName });

    // Idempotent — see header comment. A record written BEFORE the size
    // gate below existed has no metadata.byteLength at all; treated as
    // "unknown, assumed safe" rather than "definitely oversized" so an
    // already-working small durable url never regresses. A record written
    // AFTER the gate always carries byteLength, so a second call for the
    // same key (a duplicate/retried completion) makes exactly the same
    // servable/not-servable call the first one did. Skipped entirely when
    // `force` is set — see this file's own "`options.force`" header
    // comment.
    var existing = force ? null : await store.getMetadata(key);
    if (existing) {
      var existingMeta = existing.metadata || {};
      var existingOversized = typeof existingMeta.byteLength === 'number' && existingMeta.byteLength > MAX_STREAMABLE_BYTES;
      return existingOversized ? { ok: false, tooLargeToServe: true } : { ok: true, url: durableUrl(mediaType, key) };
    }

    var res = await fetch(sourceUrl);
    if (!res.ok) return { ok: false };
    var arrayBuffer = await res.arrayBuffer();
    var contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || DEFAULT_CONTENT_TYPES[mediaType];
    var byteLength = arrayBuffer.byteLength;

    // Stored regardless of size — durability (never depend solely on fal's
    // own retention) still matters even for media too big to ever stream
    // back through video-file.mjs/image-file.mjs on this platform.
    // sourceUrl+byteLength are recorded so a SERVING function can fall back
    // defensively too (see video-file.mjs/image-file.mjs's own comments).
    await store.set(key, arrayBuffer, { metadata: { contentType: contentType, sourceUrl: sourceUrl, byteLength: byteLength } });

    if (byteLength > MAX_STREAMABLE_BYTES) {
      console.warn('media-rehost: ' + mediaType + ' key=' + key + ' is ' + byteLength + ' bytes, over the ' + MAX_STREAMABLE_BYTES + '-byte streaming-function ceiling — stored for durability, but NOT switching the served url (would 502 per this file\'s "SIZE" header comment). Caller keeps fal\'s own url.');
      return { ok: false, tooLargeToServe: true };
    }

    return { ok: true, url: durableUrl(mediaType, key) };
  } catch (e) {
    console.error('media-rehost: best-effort re-host failed for ' + mediaType + ' key=' + key, e);
    return { ok: false };
  }
}

module.exports = { rehostBestEffort, durableUrl, STORE_NAMES, FILE_FUNCTIONS, MAX_STREAMABLE_BYTES };
