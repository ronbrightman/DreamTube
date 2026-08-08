// netlify/functions/download-video-status.js
//
// GET ?id=<dreamId> -> polls the in-flight watermark blend job for
// `dreamId` (submitted by download-video.js) once, and finalizes it into
// the durable twin cache the moment fal reports it COMPLETED. See
// netlify/functions/lib/watermark-video.js for the full mechanism.
//
// Response shapes (always 200; see download-video.js's own header comment
// for why this codebase's convention is branching on the parsed body, not
// the HTTP status):
//   { status: 'ready', url }    -- job just completed (or another poll
//                                   already finalized it) and the twin is
//                                   cached; client fetches `url` now.
//   { status: 'processing' }    -- still running; poll again shortly.
//   { status: 'error', error }  -- job failed, or there's no pending job
//                                   for this dreamId at all (e.g. the
//                                   marker expired/was never created —
//                                   see PENDING_JOB_STALE_MS). Caller
//                                   should call download-video.js again to
//                                   restart from scratch, or give up and
//                                   show a real error — never fall back to
//                                   the clean video (this ruling's whole
//                                   point).
//
// Error codes (this file's own range):
//   WS01 method_not_allowed
//   WS02 missing_params (id)
//   WS03 missing_api_key
//   WS09 uncaught exception in the handler itself

var watermarkVideo = require('./lib/watermark-video');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ status: 'error', error: 'WS01: method_not_allowed' }) };
  }

  var dreamId = (event.queryStringParameters || {}).id;
  if (!dreamId) {
    return { statusCode: 400, body: JSON.stringify({ status: 'error', error: 'WS02: missing_params' }) };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 200, body: JSON.stringify({ status: 'error', error: 'WS03: missing_api_key' }) };
  }

  try {
    var result = await watermarkVideo.pollAndFinalize(event, dreamId, falKey);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('download-video-status: uncaught exception', e);
    return { statusCode: 200, body: JSON.stringify({ status: 'error', error: 'WS09: ' + (e && e.message) }) };
  }
};
