// test/home-thumbnail-capture-behavioral.test.js
//
// Root-cause coverage for the dead "unwatched dream" retention nudge. That
// nudge's scheduled sender (send-unwatched-dream-nudges.js) will only send
// once the dream carries a real server-side `imageUrl` thumbnail, and that
// thumbnail is captured ONLY from an autoplaying <video> frame. It used to be
// captured reliably because every generation routed processing.html ->
// result.html (where result.html's own capture lives). When that flow moved
// so the completion now lands on HOME (home.html), a user who never taps into
// result.html never triggered result.html's capture, so a completed video
// dream's `imageUrl` stayed null forever and every enqueued nudge for a
// non-watcher was silently dropped at the scan's give-up step (0 sent, 0
// skipped — the observed symptom).
//
// The fix adds the SAME cross-origin frame capture to home.html's day0-card
// video (#d0-video-el). This test proves it, with a REAL cross-origin server
// and a real on-disk video (the exact harness result.html's own capture test
// uses), the three things that matter:
//   1. CORS present -> capture SUCCEEDS (upload-dream-thumbnail called with
//      real jpeg data for this dream).
//   2. dream.imageUrl already set -> capture never runs (existing guard).
//   3. In all cases no uncaught error escapes the page and the real playback
//      element (#d0-video-el) never gets a crossOrigin attribute.

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

/** Aborts requests to third-party hosts home.html loads — see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com|us\.i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/**
 * Seeds a logged-in account with ONE completed VIDEO dream created today (so
 * home's day0-card shows it ready and #d0-video-el autoplays it), no imageUrl
 * (so the capture is allowed to run), and an authToken (saveThumbnailBestEffort
 * requires one). Then navigates to home.html.
 */
async function seedHomeWithReadyVideoDream(page, username, dreamId, videoUrl, opts) {
  opts = opts || {};
  await page.goto(appBaseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {
      user: { handle: '@' + args.username, username: args.username, authToken: 'test-auth-token' },
      accounts: {},
      draft: {},
      dreams: [{
        id: args.dreamId, ownerHandle: '@' + args.username,
        promptText: 'I was flying over a quiet sea.', storyText: 'I was flying over a quiet sea.',
        caption: 'I was flying over a quiet sea.',
        style: 'Cinematic', mediaType: 'video', videoUrl: args.videoUrl, dur: '0:08',
        imageUrl: args.imageUrl || null,
        sourceOperationName: 'mock:1:' + args.dreamId,
        likes: 0, likedByMe: false, isPublished: false,
        createdAt: Date.now(), updatedAt: Date.now()
      }]
    };
    state.accounts[args.username] = { password: 'testpass1', email: args.username + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreamId: dreamId, videoUrl: videoUrl, imageUrl: opts.imageUrl || null });
  await page.goto(appBaseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

/** Intercepts the thumbnail upload + private-dream sync + token/feed endpoints and tracks page errors, BEFORE navigation. */
async function instrumentPage(page) {
  var uploadCalls = [];
  var pageErrors = [];
  await blockThirdParty(page);
  await page.route('**/.netlify/functions/upload-dream-thumbnail', function (route) {
    var req = route.request();
    var body = null;
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    uploadCalls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'https://example.invalid/fake-thumb.jpg' }) });
  });
  // saveThumbnailBestEffort syncs the private dream after a successful upload — stub it so nothing escapes.
  await page.route('**/.netlify/functions/dream-sync*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dreams: [] }) });
  });
  await page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
  });
  await page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
  });
  page.on('pageerror', function (err) { pageErrors.push(String(err)); });
  return { uploadCalls: uploadCalls, pageErrors: pageErrors };
}

test('home.html captures the video-frame thumbnail at the completion landing point (CORS present) and uploads it for this dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var videoServer = await crossOriginVideoServer.start({ cors: true });
  try {
    var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    var page = await context.newPage();
    var instrumentation = await instrumentPage(page);
    await seedHomeWithReadyVideoDream(page, 'homethumb1', 'dhomethumb1', videoServer.url);
    // Give the day0-card video time to autoplay + the detached capture to run.
    await page.waitForTimeout(4000);

    assert.equal(instrumentation.uploadCalls.length, 1, 'home.html must capture + upload exactly one thumbnail for a fresh completed video dream');
    var call = instrumentation.uploadCalls[0];
    assert.ok(call && typeof call.imageDataUrl === 'string' && call.imageDataUrl.indexOf('data:image/jpeg') === 0, 'uploaded payload should be a real jpeg data URL, got: ' + JSON.stringify(call));
    assert.equal(call.dreamId, 'dhomethumb1');
    assert.equal(instrumentation.pageErrors.length, 0, 'no uncaught error may escape the page: ' + JSON.stringify(instrumentation.pageErrors));

    // The real playback element must be untouched by the capture.
    var videoState = await page.evaluate(function () {
      var v = document.getElementById('d0-video-el');
      return { crossOrigin: v.crossOrigin, readyState: v.readyState };
    });
    assert.equal(videoState.crossOrigin, null, '#d0-video-el must never get a crossOrigin attribute');

    await context.close();
  } finally {
    await videoServer.close();
  }
});

test('home.html: a dream that already has an imageUrl is never re-captured (existing guard preserved)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var videoServer = await crossOriginVideoServer.start({ cors: true });
  try {
    var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    var page = await context.newPage();
    var instrumentation = await instrumentPage(page);
    await seedHomeWithReadyVideoDream(page, 'homethumb2', 'dhomethumb2', videoServer.url, { imageUrl: 'https://example.invalid/already-has-one.jpg' });
    await page.waitForTimeout(3000);

    assert.equal(instrumentation.uploadCalls.length, 0, 'must never re-capture once dream.imageUrl is already set');
    assert.equal(instrumentation.pageErrors.length, 0, 'no uncaught error may escape the page: ' + JSON.stringify(instrumentation.pageErrors));

    await context.close();
  } finally {
    await videoServer.close();
  }
});
