// test/result-thumbnail-crossorigin-capture-behavioral.test.js
//
// Root-cause fix for tracker item
// for-product-p1-regression-evidence-found-7lbwkx: the automatic "your
// dream is ready" retention email never showed a real video thumbnail —
// only the flat-color placeholder banner — because result.html's original
// thumbnail-capture IIFE drew the VISIBLE #result-video element to a
// <canvas> with no `crossOrigin` set, which taints the canvas the instant
// dream.videoUrl is cross-origin (the common case — video-file.mjs
// 302-redirects to fal's own CDN whenever media exceeds 18MB). The catch
// block silently swallowed the resulting SecurityError every time.
//
// The fix captures from a SEPARATE, detached <video> element (crossOrigin
// set BEFORE .src) instead of the real playback element — see result.html's
// own IIFE header comment for the full writeup. This test proves, with a
// REAL cross-origin server (a different port on 127.0.0.1) and a real
// on-disk video file (not a mock/stub), the two things that actually
// matter:
//
//   1. No CORS headers on the remote video -> capture fails silently
//      (upload-dream-thumbnail is never called, no error escapes the
//      page) -- proves "no worse than before this fix."
//   2. Access-Control-Allow-Origin: * on the remote video -> capture
//      SUCCEEDS (upload-dream-thumbnail IS called with real image data)
//      -- proves the fix actually works when the CDN cooperates.
//   3. In both cases, the VISIBLE/playback #result-video element itself
//      is completely unaffected: no crossOrigin attribute, playback still
//      advances -- the single most important regression to guard against
//      per this fix's own hard constraint (never touch the real playback
//      element's cross-origin loading behavior).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var crossOriginVideoServer = require('./helpers/cross-origin-video-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';

var playwright = null;
var unavailableReason = null;
try {
  playwright = require('playwright');
} catch (e1) {
  try {
    playwright = require('/opt/node22/lib/node_modules/playwright');
  } catch (e2) {
    unavailableReason = 'Playwright is not resolvable in this environment (' + e2.message + ')';
  }
}

var appServer = null;
var browser = null;
var appBaseUrl = null;
var MOBILE_VIEWPORT = { width: 390, height: 844 };

test.before(async function () {
  if (unavailableReason) return;
  appServer = await staticServer.start();
  appBaseUrl = appServer.url;
  browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
});

test.after(async function () {
  if (browser) await browser.close();
  if (appServer) await appServer.close();
});

async function seedUserWithReadyDream(page, username, dreamId, videoUrl) {
  await page.goto(appBaseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + args.username, username: args.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[args.username] = { password: 'testpass1', email: args.username + '@example.com' };
    state.dreams = [{
      id: args.dreamId, ownerHandle: '@' + args.username, title: 'Thumbnail capture test dream',
      promptText: 'I was flying over a quiet sea.', storyText: 'I was flying over a quiet sea.',
      style: 'Cinematic', videoUrl: args.videoUrl, dur: '0:08',
      likes: 0, likedByMe: false, isPublished: false,
      createdAt: Date.now(), updatedAt: Date.now()
      // no imageUrl -- capture must be allowed to run
    }];
    state.user.authToken = 'test-auth-token';
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreamId: dreamId, videoUrl: videoUrl });
}

// Wires up interception of the upload endpoint and page-level error
// tracking BEFORE navigation, so nothing fired during page load is missed.
async function instrumentPage(page) {
  var uploadCalls = [];
  var pageErrors = [];
  await page.route('**/.netlify/functions/upload-dream-thumbnail', function (route) {
    var req = route.request();
    var body = null;
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    uploadCalls.push(body);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, url: 'https://example.invalid/fake-thumb.jpg' })
    });
  });
  page.on('pageerror', function (err) { pageErrors.push(String(err)); });
  return { uploadCalls: uploadCalls, pageErrors: pageErrors };
}

test('no CORS headers on the cross-origin video: capture stays a silent no-op (no worse than before the fix)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var videoServer = await crossOriginVideoServer.start({ cors: false });
  try {
    var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    var page = await context.newPage();
    var instrumentation = await instrumentPage(page);
    await seedUserWithReadyDream(page, 'thumbnocors1', 'dthumbnocors1', videoServer.url);
    await page.goto(appBaseUrl + '/result.html?id=dthumbnocors1', { waitUntil: 'domcontentloaded' });
    // Give the real video time to start playing (gates the capture
    // attempt) and the capture element's own timeout (6s) time to expire.
    await page.waitForTimeout(7500);

    assert.equal(instrumentation.uploadCalls.length, 0, 'upload-dream-thumbnail must never be called when the CDN sends no CORS headers');
    assert.equal(instrumentation.pageErrors.length, 0, 'no uncaught error may escape the page: ' + JSON.stringify(instrumentation.pageErrors));

    // The visible playback element must be totally unaffected: no
    // crossOrigin attribute, and it must still actually be playing (this
    // same server without CORS headers is same-origin-agnostic for a
    // PLAIN <video> load -- only canvas capture cares about CORS).
    var videoState = await page.evaluate(function () {
      var v = document.getElementById('result-video');
      return { crossOrigin: v.crossOrigin, currentTime: v.currentTime, readyState: v.readyState, paused: v.paused };
    });
    assert.equal(videoState.crossOrigin, null, '#result-video must never get a crossOrigin attribute');
    assert.ok(videoState.readyState >= 2, 'playback video should have decoded a real frame, got readyState=' + videoState.readyState);

    await context.close();
  } finally {
    await videoServer.close();
  }
});

test('CORS headers present (Access-Control-Allow-Origin: *): capture succeeds and uploads a real thumbnail', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var videoServer = await crossOriginVideoServer.start({ cors: true });
  try {
    var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    var page = await context.newPage();
    var instrumentation = await instrumentPage(page);
    await seedUserWithReadyDream(page, 'thumbcors1', 'dthumbcors1', videoServer.url);
    await page.goto(appBaseUrl + '/result.html?id=dthumbcors1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    assert.equal(instrumentation.uploadCalls.length, 1, 'upload-dream-thumbnail should be called exactly once when the CDN cooperates with CORS');
    var call = instrumentation.uploadCalls[0];
    assert.ok(call && typeof call.imageDataUrl === 'string' && call.imageDataUrl.indexOf('data:image/jpeg') === 0, 'uploaded payload should be a real jpeg data URL, got: ' + JSON.stringify(call));
    assert.equal(call.dreamId, 'dthumbcors1');
    assert.equal(instrumentation.pageErrors.length, 0, 'no uncaught error may escape the page: ' + JSON.stringify(instrumentation.pageErrors));

    // Same regression guard as the no-CORS test: the real playback
    // element is unaffected even in the success path.
    var videoState = await page.evaluate(function () {
      var v = document.getElementById('result-video');
      return { crossOrigin: v.crossOrigin, currentTime: v.currentTime, readyState: v.readyState };
    });
    assert.equal(videoState.crossOrigin, null, '#result-video must never get a crossOrigin attribute, even on the success path');
    assert.ok(videoState.readyState >= 2, 'playback video should have decoded a real frame, got readyState=' + videoState.readyState);

    // The detached capture <video> must not be left lingering in the DOM
    // (cleanup discipline -- "best-effort must never leak").
    var strayVideos = await page.evaluate(function () {
      return document.querySelectorAll('video').length;
    });
    assert.equal(strayVideos, 1, 'exactly one <video> element (#result-video) should remain in the DOM after capture completes, found: ' + strayVideos);

    await context.close();
  } finally {
    await videoServer.close();
  }
});

test('dream.imageUrl already set: capture never runs (existing guard preserved)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var videoServer = await crossOriginVideoServer.start({ cors: true });
  try {
    var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    var page = await context.newPage();
    var instrumentation = await instrumentPage(page);
    await page.goto(appBaseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function (args) {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@thumbhasimg1', username: 'thumbhasimg1', authToken: 'test-auth-token' };
      if (!state.accounts) state.accounts = {};
      state.accounts.thumbhasimg1 = { password: 'testpass1', email: 'thumbhasimg1@example.com' };
      state.dreams = [{
        id: 'dthumbhasimg1', ownerHandle: '@thumbhasimg1', title: 'Already has a thumbnail',
        promptText: 'x', storyText: 'x', style: 'Cinematic', videoUrl: args.videoUrl, dur: '0:08',
        imageUrl: 'https://example.invalid/already-has-one.jpg',
        likes: 0, likedByMe: false, isPublished: false,
        createdAt: Date.now(), updatedAt: Date.now()
      }];
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    }, { videoUrl: videoServer.url });
    await page.goto(appBaseUrl + '/result.html?id=dthumbhasimg1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    assert.equal(instrumentation.uploadCalls.length, 0, 'must never re-capture once dream.imageUrl is already set');
    assert.equal(instrumentation.pageErrors.length, 0, 'no uncaught error may escape the page: ' + JSON.stringify(instrumentation.pageErrors));

    await context.close();
  } finally {
    await videoServer.close();
  }
});
