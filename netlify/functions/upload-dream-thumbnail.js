// netlify/functions/upload-dream-thumbnail.js
//
// POST { authToken, dreamId, imageDataUrl } -> stores a client-captured
// "frame 1" video still into the SAME "dreamtube-images" Blobs store/key
// shape lib/media-rehost.js's rehostBestEffort already establishes (see
// that file's own header comment) -- served back out through the
// EXISTING image-file.mjs endpoint completely unchanged (this file writes
// into its store under its exact metadata contract: {contentType,
// byteLength}, so no new serving code is needed or added -- per this
// task's own constraint on leaving image-file.mjs/video-file.mjs/
// lib/media-rehost.js's own size-gating logic untouched).
//
// Tracker item for-product-dream-ready-email-real-first-qr9fbj (founder
// request 2026-08-02): the "your dream is ready" retention email
// (lib/first-dream-email-sender.js) rendered a flat colored placeholder
// banner instead of a real frame from the actual video. No thumbnail/
// poster field exists anywhere in fal's veo3.1 result payload
// (video-status.js), a server-side frame extract inside a Netlify
// Function is impractical, and a second paid fal image-generation call
// per video is real ongoing spend not worth it for a cosmetic email
// detail. This is the upload half of the alternative that was chosen
// instead: result.html draws the <video> element's own already-decoded
// first real frame to a <canvas> client-side (once autoplay has actually
// advanced a moment, avoiding a black pre-decode frame — see that file's
// own capture IIFE) and POSTs the resulting JPEG data URL here. See
// js/store.js's DreamStore.saveThumbnailBestEffort for the other half of
// this feature (the fetch call here + the local dream.imageUrl write +
// the dream-sync upsert that actually attaches the returned url onto the
// dream record).
//
// IDENTITY: same authToken-verified bar as dream-sync.js (this feature's
// own existing sync mechanism for actually attaching the url this
// endpoint returns onto a dream) -- resolves the acting account from a
// VERIFIED authToken, never a bare client-supplied username, since
// dreamId is client-invented and already public elsewhere in this app
// (see dream-sync.js's own header comment for the full reasoning). The
// stored Blobs key is namespaced by the VERIFIED username (never a
// client-claimed one), so one account can never overwrite another
// account's thumbnail even if it guesses/reuses a dreamId — this endpoint
// does not need its own separate cross-account dream-ownership check on
// top of that; the actual "does this dreamId really belong to me"
// enforcement already lives where it always has, in dream-sync.js's own
// resolveOwnerHandle, the moment the client subsequently syncs the
// returned url onto dream.imageUrl.
//
// SIZE: capped well under lib/media-rehost.js's own MAX_STREAMABLE_BYTES
// streaming-response ceiling (18 MiB) — a canvas-captured JPEG still is
// always tens/low-hundreds of KB in practice, so MAX_THUMBNAIL_BYTES here
// is abuse/mistake protection, not a real operating constraint.
//
// BEST-EFFORT FROM THE CALLER'S OWN POINT OF VIEW (never this endpoint's
// own internal contract — this function itself returns real, honest
// success/failure): js/store.js's saveThumbnailBestEffort never surfaces
// a failure here to the user — a rejected/failed upload just means this
// dream keeps no imageUrl, and (per the founder's 2026-08-08 thumbnail-gate
// rule — see lib/first-dream-email-sender.js's "THUMBNAIL-GATED SEND"
// header note) the automatic first-dream retention email simply never goes
// out for that dream rather than sending a thumbnail-less one.
//
// Error codes (local to this small function, same bare-number-scheme
// convention as dream-webhook.js's/send-first-dream-email.js's own small
// namespaces):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 auth_token_required
//   E4 invalid_or_expired_token -- 200 ok:false, same "normal business
//                                    outcome, not a 4xx/5xx" shape
//                                    dream-sync.js's own GET/POST already
//                                    use for this exact case
//   E5 dream_id_required
//   E6 invalid_image            -- imageDataUrl missing, or not a real
//                                    data:image/(jpeg|png);base64,... url
//   E7 image_too_large          -- decoded bytes over MAX_THUMBNAIL_BYTES

var { getStore, connectLambda } = require('@netlify/blobs');
var accountAuthToken = require('./lib/account-auth-token');
var mediaRehost = require('./lib/media-rehost');

// Generous headroom over any real canvas-captured still (see header
// comment's "SIZE" paragraph) — this is abuse/mistake protection, not a
// real operating ceiling.
var MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

var DATA_URL_RE = /^data:(image\/jpeg|image\/png);base64,([a-zA-Z0-9+/=]+)$/;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E2: invalid_json' }) };
  }

  var authToken = (payload && payload.authToken) || '';
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: auth_token_required' }) };
  }
  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired_token' }) };
  }

  var dreamId = (payload && payload.dreamId) || '';
  if (!dreamId || typeof dreamId !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E5: dream_id_required' }) };
  }

  var imageDataUrl = (payload && payload.imageDataUrl);
  var match = typeof imageDataUrl === 'string' ? imageDataUrl.match(DATA_URL_RE) : null;
  if (!match) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E6: invalid_image' }) };
  }

  var contentType = match[1];
  var buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_THUMBNAIL_BYTES) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E7: image_too_large' }) };
  }

  try {
    connectLambda(event);
    var store = getStore({ name: mediaRehost.STORE_NAMES.image });
    // Namespaced by the VERIFIED username, not the client-claimed dreamId
    // alone — see header comment's IDENTITY paragraph. Overwriting the
    // same key twice (a duplicate capture across two tabs/reloads for the
    // same dream) is a harmless, idempotent no-op — the second write just
    // replaces the first with an equivalent frame.
    var key = 'thumb:' + auth.username + ':' + dreamId;
    await store.set(key, buffer, { metadata: { contentType: contentType, byteLength: buffer.length } });
    return { statusCode: 200, body: JSON.stringify({ ok: true, url: mediaRehost.durableUrl('image', key) }) };
  } catch (e) {
    console.error('upload-dream-thumbnail: Blobs write failed', e);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'internal_error' }) };
  }
};
