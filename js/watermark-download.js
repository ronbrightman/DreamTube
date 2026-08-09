// js/watermark-download.js
//
// Shared client helper for the watermark-on-download ruling (tracker item
// for-product-founder-ruling-08-07-every-u-g81h7v): "when a user downloads
// a video, the file must carry the logo watermark." Wraps
// netlify/functions/download-video.js's submit-then-poll cycle (see that
// file and lib/watermark-video.js's own header comments for the full
// server-side mechanism) behind one Promise-returning call, so every real
// "download this video" call site resolves a WATERMARKED url instead of
// fetching `dream.videoUrl` directly — currently js/share-sheet.js's "Save
// to device" video path and postpack-h4mv.html's video download button
// (the ruling's own text: "the IG/TikTok postpack exports reuse the same
// twins"). In-app PLAYBACK is untouched everywhere else — nothing here
// changes what any <video> element's `src` points at, only what a
// download/save action fetches.
//
// Plain script (no ES modules — see CLAUDE.md), attaches
// window.WatermarkDownload.

(function () {
  'use strict';

  var DOWNLOAD_ENDPOINT = '/.netlify/functions/download-video';
  var STATUS_ENDPOINT = '/.netlify/functions/download-video-status';
  var DEFAULT_TIMEOUT_MS = 60000;
  var DEFAULT_POLL_INTERVAL_MS = 2000;

  function fetchJson(url) {
    return fetch(url).then(function (res) {
      // download-video.js/download-video-status.js always resolve 200 with
      // a { status, ... } body (this codebase's "branch on the parsed
      // body, not the HTTP status" convention — see those files' own
      // header comments) except for a genuine transport-level failure
      // (network down, 404 route, etc), which res.json() itself will
      // throw on for a non-JSON body.
      return res.json();
    });
  }

  /**
   * Resolves to the watermarked download URL for `dreamId`/`srcUrl` (the
   * dream's own clean, current videoUrl), submitting + polling the
   * server-side blend job as needed. Rejects with an Error on any failure
   * or timeout — callers must show a real error, never fall back to
   * `srcUrl` directly (that would silently serve an unwatermarked file,
   * which is exactly what this ruling exists to prevent).
   *
   * opts:
   *   onStatus     — optional function(status) called with 'submitting' |
   *                  'processing' at each step, for a caller that wants to
   *                  update button copy ("Preparing…") while this runs.
   *   isCancelled  — optional function() -> boolean, checked before each
   *                  poll iteration; if it returns true, the poll loop
   *                  stops and rejects with a Error whose .cancelled is
   *                  true (callers can silently ignore this — see this
   *                  codebase's own documented recurring stale-async-
   *                  callback bug shape, tracker.html's
   *                  recurring-stale-async-callback-bug-shape-xp61pn — the
   *                  same reason js/share-sheet.js's own currentGen guard
   *                  exists).
   *   timeoutMs    — default 60000. A real blend job for this app's short
   *                  dream clips is expected to finish in well under this.
   *   pollIntervalMs — default 2000.
   */
  function resolveVideoUrl(dreamId, srcUrl, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var pollIntervalMs = opts.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () {};
    var deadline = Date.now() + timeoutMs;

    function cancelledError() {
      var err = new Error('watermark_cancelled');
      err.cancelled = true;
      return err;
    }

    function handleBody(body) {
      if (body.status === 'ready') return body.url;
      if (body.status === 'error') throw new Error(body.error || 'watermark_failed');
      // 'processing' -- keep polling.
      return poll();
    }

    function poll() {
      if (isCancelled()) throw cancelledError();
      if (Date.now() > deadline) throw new Error('watermark_timeout');
      onStatus('processing');
      return new Promise(function (resolve) { setTimeout(resolve, pollIntervalMs); }).then(function () {
        if (isCancelled()) throw cancelledError();
        return fetchJson(STATUS_ENDPOINT + '?id=' + encodeURIComponent(dreamId)).then(handleBody);
      });
    }

    onStatus('submitting');
    return fetchJson(DOWNLOAD_ENDPOINT + '?id=' + encodeURIComponent(dreamId) + '&src=' + encodeURIComponent(srcUrl)).then(handleBody);
  }

  var WatermarkDownload = { resolveVideoUrl: resolveVideoUrl };

  if (typeof window !== 'undefined') window.WatermarkDownload = WatermarkDownload;
  if (typeof module !== 'undefined' && module.exports) module.exports = WatermarkDownload;
})();
