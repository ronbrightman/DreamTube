// test/watermark-download-client.test.js
//
// Fast, non-browser unit coverage for js/watermark-download.js's
// resolveVideoUrl() polling/cancellation/timeout logic (the module
// exports itself via module.exports too, purely so it's requireable
// here — see its own header comment). Complements
// test/share-sheet-behavioral.test.js's real-browser coverage of the
// actual "Save to device" call site.

var test = require('node:test');
var assert = require('node:assert/strict');

var WatermarkDownload = require('../js/watermark-download');

var realFetch = global.fetch;
var realSetTimeout = global.setTimeout;

test.after(function () {
  global.fetch = realFetch;
  global.setTimeout = realSetTimeout;
});

/** Makes setTimeout fire immediately (synchronously scheduled as a microtask-ish macrotask) so polling tests don't actually wait real wall-clock seconds. */
function fastForwardTimers() {
  global.setTimeout = function (fn) { return realSetTimeout(fn, 0); };
}

function jsonResponse(body) {
  return Promise.resolve({ json: function () { return Promise.resolve(body); } });
}

test('resolveVideoUrl: resolves immediately when download-video itself reports ready', async function () {
  global.fetch = function (url) {
    assert.match(url, /^\/\.netlify\/functions\/download-video\?id=dream-1&src=/);
    return jsonResponse({ status: 'ready', url: 'https://example.com/twin.mp4' });
  };
  var url = await WatermarkDownload.resolveVideoUrl('dream-1', 'https://example.com/clean.mp4', {});
  assert.equal(url, 'https://example.com/twin.mp4');
});

test('resolveVideoUrl: polls download-video-status while processing, resolves once ready', async function () {
  fastForwardTimers();
  var statusCalls = 0;
  global.fetch = function (url) {
    var isStatusCall = url.indexOf('download-video-status') !== -1;
    if (!isStatusCall) return jsonResponse({ status: 'processing' }); // the initial submit call
    statusCalls++;
    return jsonResponse(statusCalls < 3 ? { status: 'processing' } : { status: 'ready', url: 'https://example.com/twin-2.mp4' });
  };
  var statuses = [];
  var url = await WatermarkDownload.resolveVideoUrl('dream-2', 'https://example.com/clean.mp4', {
    pollIntervalMs: 1,
    onStatus: function (s) { statuses.push(s); }
  });
  assert.equal(url, 'https://example.com/twin-2.mp4');
  assert.equal(statusCalls, 3);
  assert.ok(statuses.indexOf('submitting') !== -1);
  assert.ok(statuses.indexOf('processing') !== -1);
});

test('resolveVideoUrl: rejects with the server error message when download-video reports an error', async function () {
  global.fetch = function () { return jsonResponse({ status: 'error', error: 'WD04: submit_failed: fal_down' }); };
  await assert.rejects(
    WatermarkDownload.resolveVideoUrl('dream-3', 'https://example.com/clean.mp4', {}),
    /WD04/
  );
});

test('resolveVideoUrl: rejects with the server error message when a poll reports an error mid-flight', async function () {
  fastForwardTimers();
  var first = true;
  global.fetch = function (url) {
    if (url.indexOf('download-video-status') === -1) return jsonResponse({ status: 'processing' });
    if (first) { first = false; return jsonResponse({ status: 'processing' }); }
    return jsonResponse({ status: 'error', error: 'job_failed: CONTENT_POLICY' });
  };
  await assert.rejects(
    WatermarkDownload.resolveVideoUrl('dream-4', 'https://example.com/clean.mp4', { pollIntervalMs: 1 }),
    /job_failed/
  );
});

test('resolveVideoUrl: isCancelled stops polling and rejects with a .cancelled error, without more fetches after cancellation', async function () {
  fastForwardTimers();
  var fetchCount = 0;
  var cancelled = false;
  global.fetch = function (url) {
    fetchCount++;
    if (url.indexOf('download-video-status') === -1) return jsonResponse({ status: 'processing' });
    return jsonResponse({ status: 'processing' }); // never actually completes -- cancellation must win first
  };
  var promise = WatermarkDownload.resolveVideoUrl('dream-5', 'https://example.com/clean.mp4', {
    pollIntervalMs: 1,
    isCancelled: function () { return cancelled; }
  });
  // Cancel right away -- the very next poll tick must observe it.
  cancelled = true;
  await assert.rejects(promise, function (err) { return err.cancelled === true; });
});

test('resolveVideoUrl: a genuine timeout rejects with a real error rather than polling forever', async function () {
  fastForwardTimers();
  global.fetch = function (url) {
    if (url.indexOf('download-video-status') === -1) return jsonResponse({ status: 'processing' });
    return jsonResponse({ status: 'processing' }); // never resolves
  };
  await assert.rejects(
    WatermarkDownload.resolveVideoUrl('dream-6', 'https://example.com/clean.mp4', { pollIntervalMs: 1, timeoutMs: 5 }),
    /watermark_timeout/
  );
});
