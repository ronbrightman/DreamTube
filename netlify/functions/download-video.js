// netlify/functions/download-video.js
//
// GET ?id=<dreamId>&src=<clean video url> -> the watermark-on-download
// entry point (tracker item for-product-founder-ruling-08-07-every-u-
// g81h7v). Called by js/watermark-download.js (js/share-sheet.js's "Save
// to device" video path, and postpack-h4mv.html's video download button —
// see that shared client module's own header comment) instead of fetching
// `dream.videoUrl` directly, so every real video DOWNLOAD carries the logo
// watermark while in-app playback (still fed `dream.videoUrl` unchanged
// everywhere else) stays completely clean.
//
// See netlify/functions/lib/watermark-video.js for the full mechanism
// (why blend-video + a static overlay asset, the async submit/poll shape,
// the storage pattern) — this file and download-video-status.js are just
// the thin HTTP surface over that module's submit/poll operations:
//   - THIS file: is there already a cached twin? -> ready. Already a job
//     in flight for this dream? -> processing (client should start/keep
//     polling download-video-status). Otherwise submit a fresh blend job.
//   - download-video-status.js: polls whatever job is in flight and
//     finalizes it into the cache once fal completes it.
//
// Response shapes (always 200; distinguished by `status`, matching this
// codebase's existing "client branches on the parsed body, not the HTTP
// status" convention — see video-status.js's own E203/E204 comment for
// why):
//   { status: 'ready', url }        -- watermarked twin ready to fetch/download
//   { status: 'processing' }        -- job submitted or already in flight; poll download-video-status
//   { status: 'error', error }      -- see error codes below; caller must
//                                       show a real error, NEVER silently
//                                       fall back to the clean `src` url
//                                       (that would violate this ruling).
//
// Error codes (this file's own range, distinct from generate-video.js's
// E1xx/video-status.js's E2xx per this codebase's per-file convention):
//   WD01 method_not_allowed
//   WD02 missing_params (id and/or src)
//   WD03 missing_api_key (no FAL_KEY configured in this environment)
//   WD04 submit_failed (fal rejected the blend-video submission)
//   WD09 uncaught exception in the handler itself

var watermarkVideo = require('./lib/watermark-video');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ status: 'error', error: 'WD01: method_not_allowed' }) };
  }

  var query = event.queryStringParameters || {};
  var dreamId = query.id;
  var srcUrl = query.src;
  if (!dreamId || !srcUrl) {
    return { statusCode: 400, body: JSON.stringify({ status: 'error', error: 'WD02: missing_params' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 200, body: JSON.stringify({ status: 'error', error: 'WD03: missing_api_key' }) };
  }

  try {
    var cached = await watermarkVideo.getCachedTwin(event, dreamId);
    if (cached.found && cached.url) {
      return { statusCode: 200, body: JSON.stringify({ status: 'ready', url: cached.url }) };
    }

    var pending = await watermarkVideo.getPendingJob(event, dreamId);
    if (pending) {
      return { statusCode: 200, body: JSON.stringify({ status: 'processing' }) };
    }

    var submitResult = await watermarkVideo.submitBlendJob(event, dreamId, srcUrl, falKey);
    if (!submitResult.ok) {
      return { statusCode: 200, body: JSON.stringify({ status: 'error', error: 'WD04: submit_failed: ' + submitResult.error }) };
    }

    return { statusCode: 200, body: JSON.stringify({ status: 'processing' }) };
  } catch (e) {
    console.error('download-video: uncaught exception', e);
    return { statusCode: 200, body: JSON.stringify({ status: 'error', error: 'WD09: ' + (e && e.message) }) };
  }
};
