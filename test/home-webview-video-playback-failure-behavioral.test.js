// test/home-webview-video-playback-failure-behavioral.test.js
//
// Real browser-driven coverage for home.html's FINISHED-VIDEO playback-
// FAILURE detect-and-guide (founder-directed 2026-08-14). DreamTube's biggest
// cohort arrives via FB/IG/Messenger in-app webviews (iOS especially), and on
// iOS we cannot programmatically escape to Safari. After signup a user lands
// back on home.html?generate=1 INSIDE the webview and watches their dream play
// in the #d0-video-el day0-card. Sometimes the media-constrained webview plays
// the finished video fine; sometimes it genuinely can't.
//
// Founder's decision: DON'T block entry, and DON'T nag a webview user whose
// video plays fine -- detect ACTUAL finished-video playback failure and only
// THEN guide them out (to their real browser / the recovery email). So the new
// #playfail-card is gated on BOTH (an FB/IG/Messenger webview) AND (the
// finished video really won't play -- an error, or a multi-second stall with
// zero decoded frames), and it reuses the exact intent:// / copy-link / ?bt=
// escape mechanics the #webview-card already carries. The quiet detection-only
// #webview-card is deliberately LEFT AS-IS (a separate install/data-safety
// nudge, not a video block) -- this file only covers the NEW failure surface.
//
// Follows this repo's Playwright/node:test conventions:
// test/home-thumbnail-capture-behavioral.test.js's cross-origin real-video
// server (a VP8/WebM the sandbox's headless Chromium can actually decode --
// mp4/H.264 never decodes here, see test/fixtures/generate-thumbnail-capture-
// video.md), test/home-webview-escape-behavioral.test.js's UA constants, and
// test/first-video-created-behavioral.test.js's PostHog-stub-queue reader.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var crossOriginVideoServer = require('./helpers/cross-origin-video-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };

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

var server = null;
var browser = null;
var baseUrl = null;

test.before(async function () {
  if (unavailableReason) return;
  server = await staticServer.start();
  baseUrl = server.url;
  try {
    browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
  } catch (e) {
    unavailableReason = 'Could not launch Chromium at ' + CHROMIUM_PATH + ': ' + e.message;
  }
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) await server.close();
});

var IG_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2246; google/redfin/redfin:13; en_US; 538815920)';
var FB_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0.0.0.100;FBBV/1;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.0;FBSS/3;FBID/phone;FBLC/en_US]';
var NORMAL_ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

/** Aborts requests to third-party hosts home.html loads -- see CLAUDE.md on this sandbox's outbound network. Leaves the PostHog inline stub queue intact so track() calls are still recordable. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com|us\.i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Stubs the same-origin Netlify endpoints home.html calls on load so nothing stalls/noises. */
async function stubHomeEndpoints(page) {
  await page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
  });
  await page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
  });
  await page.route('**/.netlify/functions/dream-sync*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dreams: [] }) });
  });
  await page.route('**/.netlify/functions/upload-dream-thumbnail', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'https://example.invalid/fake-thumb.jpg' }) });
  });
  // ?bt= session-transfer minting (maintainSessionTransferUrl runs in a webview) -- mint a fixed token so the escape-mechanics assertions can check it.
  await page.route('**/.netlify/functions/create-session-transfer', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, token: 'playfail-bt-token-123' }) });
  });
}

/**
 * Seeds a logged-in account with ONE completed VIDEO dream created today (so
 * home's day0-card renders it ready and #d0-video-el autoplays `videoUrl`),
 * then navigates to home.html. Mirrors test/home-thumbnail-capture-
 * behavioral.test.js's seedHomeWithReadyVideoDream shape.
 */
async function seedReadyVideoDream(page, username, videoUrl) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {
      user: { handle: '@' + args.username, username: args.username, authToken: 'test-auth-token' },
      accounts: {},
      draft: {},
      dreams: [{
        id: 'playfail-dream-1', ownerHandle: '@' + args.username,
        promptText: 'I was flying over a quiet sea.', storyText: 'I was flying over a quiet sea.',
        caption: 'I was flying over a quiet sea.',
        style: 'Cinematic', mediaType: 'video', videoUrl: args.videoUrl, dur: '0:08',
        imageUrl: null, sourceOperationName: 'mock:1:playfail-dream-1',
        likes: 0, likedByMe: false, isPublished: false,
        createdAt: Date.now(), updatedAt: Date.now()
      }]
    };
    state.accounts[args.username] = { password: 'testpass1', email: args.username + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, videoUrl: videoUrl });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

/** Reads every posthog.capture(name, props) call straight out of the PostHog stub's own pending-call queue (the real array.js is blocked, so the stub stays the queue). */
function readCaptureCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return { name: entry[1], props: entry[2] }; });
  });
}

// ============================================================================
// 1. Real playback FAILURE in a webview -> the guidance UI shows, platform-
//    correct, with the email note, and the failure analytics event fires.
// ============================================================================

test('home.html: a finished video that genuinely fails to play (error) INSIDE an Android IG webview shows the failure-guidance card with the Android "Open in my browser" intent:// escape and the email note, and fires webview_video_playback_failed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA, viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stubHomeEndpoints(page);
    // The finished video's own URL always fails to load -> real playback failure.
    await page.route('**/broken-playfail-video.mp4', function (route) { route.abort(); });
    await seedReadyVideoDream(page, 'playfailandroid', baseUrl + '/broken-playfail-video.mp4');

    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    await page.waitForSelector('#playfail-card', { state: 'visible', timeout: 10000 });

    var btnLabel = await page.textContent('#playfail-btn');
    assert.match(btnLabel, /Open in my browser/, 'Android must offer the one-tap intent:// "Open in my browser" escape');
    var body = await page.textContent('#playfail-body');
    assert.match(body, /Instagram/, 'the guidance body must name the actual detected host app');
    assert.equal(await page.locator('.playfail-email').isVisible(), true, 'the email backstop line must be shown');
    assert.match(await page.locator('.playfail-email').textContent(), /check your email/i, 'the email line must point the user at the recovery email');

    // The Android intent:// escape reuses the SAME shared builder the
    // #webview-card uses, and its URL carries the live ?bt= session-transfer
    // token (minted by maintainSessionTransferUrl on a webview load).
    await page.waitForFunction(function () { return location.href.indexOf('bt=') !== -1; }, null, { timeout: 5000 });
    var intentUrl = await page.evaluate(function () { return buildAndroidChromeIntentUrl(); });
    assert.match(intentUrl, /^intent:\/\//, 'the Android escape must be a real intent:// URL');
    assert.match(intentUrl, /package=com\.android\.chrome/, 'the intent:// URL must target Chrome');
    assert.match(intentUrl, /bt=playfail-bt-token-123/, 'the intent:// URL must carry the ?bt= session-transfer token so the visitor lands signed in');

    var calls = await readCaptureCalls(page);
    var failCalls = calls.filter(function (c) { return c.name === 'webview_video_playback_failed'; });
    assert.equal(failCalls.length, 1, 'exactly one webview_video_playback_failed must fire, got: ' + JSON.stringify(calls.map(function (c) { return c.name; })));
    assert.equal(failCalls[0].props.host, 'Instagram');
    assert.equal(failCalls[0].props.platform, 'android');
    assert.ok(failCalls[0].props.reason, 'the failure event must carry a reason code (error/stall)');
  } finally {
    await context.close();
  }
});

test('home.html: on iOS FB webview, a finished video that fails to play shows the guidance card with the "Copy link for your browser" action, which actually copies the ?bt=-carrying URL and shows a persistent instruction note', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA, viewport: MOBILE_VIEWPORT, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stubHomeEndpoints(page);
    await page.route('**/broken-playfail-video.mp4', function (route) { route.abort(); });
    await seedReadyVideoDream(page, 'playfailios', baseUrl + '/broken-playfail-video.mp4');

    await page.waitForSelector('#playfail-card', { state: 'visible', timeout: 10000 });
    var btnLabel = await page.textContent('#playfail-btn');
    assert.match(btnLabel, /Copy link for your browser/, 'iOS (no programmatic escape) must get the copy-link action, not the Android intent button');

    await page.waitForFunction(function () { return location.href.indexOf('bt=') !== -1; }, null, { timeout: 5000 });
    var urlAtClick = await page.evaluate(function () { return location.href; });
    await page.click('#playfail-btn');

    await page.waitForSelector('#playfail-note', { state: 'visible', timeout: 3000 });
    var note = await page.textContent('#playfail-note');
    assert.match(note, /paste the link/i, 'the post-copy note must give the exact next step');
    var clipboard = await page.evaluate(function () { return navigator.clipboard.readText(); });
    assert.equal(clipboard, urlAtClick, 'the clipboard must hold exactly the current URL, including its ?bt= token');
    assert.match(clipboard, /bt=playfail-bt-token-123/, 'the copied link must carry the session-transfer token');

    var calls = await readCaptureCalls(page);
    var failCalls = calls.filter(function (c) { return c.name === 'webview_video_playback_failed'; });
    assert.equal(failCalls.length, 1, 'exactly one webview_video_playback_failed on iOS too');
    assert.equal(failCalls[0].props.platform, 'other');
  } finally {
    await context.close();
  }
});

test('home.html: a finished video that never starts (a STALL -- no error, no decoded frame) inside a webview is treated as a real failure after the stall window and shows the guidance card', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA, viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stubHomeEndpoints(page);
    // Never fulfilled and never aborted -> the video request hangs: no error,
    // no `playing`, no decoded frame -> the stall heuristic must catch it.
    await page.route('**/hanging-playfail-video.mp4', function () { /* deliberately never responds */ });
    await seedReadyVideoDream(page, 'playfailstall', baseUrl + '/hanging-playfail-video.mp4');

    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    // Stall window is ~7s; allow generous headroom.
    await page.waitForSelector('#playfail-card', { state: 'visible', timeout: 15000 });
    var calls = await readCaptureCalls(page);
    var failCalls = calls.filter(function (c) { return c.name === 'webview_video_playback_failed'; });
    assert.equal(failCalls.length, 1, 'a genuine stall must fire exactly one failure event');
    assert.equal(failCalls[0].props.reason, 'stall', 'the reason code must distinguish a stall from an error');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. The SMOOTH path -- a webview that plays the video FINE shows nothing.
// ============================================================================

test('home.html: a finished video that plays FINE inside a webview shows NO guidance card and fires NO failure event (the smooth path is untouched)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var videoServer = await crossOriginVideoServer.start({ cors: true });
  try {
    var context = await browser.newContext({ userAgent: FB_IOS_UA, viewport: MOBILE_VIEWPORT });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await stubHomeEndpoints(page);
      // A real, decodable VP8/WebM served with CORS -> the day0 video actually plays.
      await seedReadyVideoDream(page, 'playfailsmooth', videoServer.url);

      await page.waitForSelector('#d0-video.ready', { timeout: 5000 });

      // Sanity FIRST: the video genuinely plays (advancing, decoded frame) --
      // otherwise this test proves nothing. Poll (the fixture is a 3s loop, so
      // an instant snapshot can land at a loop boundary) rather than sample once.
      await page.waitForFunction(function () {
        var v = document.getElementById('d0-video-el');
        return v && v.currentTime > 0.15 && v.readyState >= 2;
      }, null, { timeout: 9000 });

      // Now sit past the ~7s stall window to prove nothing fires late either.
      await page.waitForTimeout(8000);

      assert.equal(await page.locator('#playfail-card').isVisible(), false, 'a webview whose video plays fine must never see the failure-guidance card');
      var calls = await readCaptureCalls(page);
      var failCalls = calls.filter(function (c) { return c.name === 'webview_video_playback_failed'; });
      assert.equal(failCalls.length, 0, 'no failure event may fire when the video plays fine, got: ' + JSON.stringify(failCalls));
    } finally {
      await context.close();
    }
  } finally {
    await videoServer.close();
  }
});

// ============================================================================
// 3. NOT a webview -> the guidance never shows, regardless of playback.
// ============================================================================

test('home.html: in a NORMAL browser (not an FB/IG/Messenger webview), a finished video that fails to play NEVER shows the guidance card and fires NO failure event -- the detect-and-guide is webview-gated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_ANDROID_CHROME_UA, viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stubHomeEndpoints(page);
    await page.route('**/broken-playfail-video.mp4', function (route) { route.abort(); });
    await seedReadyVideoDream(page, 'playfailnormal', baseUrl + '/broken-playfail-video.mp4');

    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    // Wait past both the retry+error path and the stall window -- neither may surface anything in a normal browser.
    await page.waitForTimeout(9000);

    assert.equal(await page.locator('#playfail-card').isVisible(), false, 'a normal (non-webview) browser must never show the failure-guidance card, even when the video is broken -- they already have their own real browser');
    var calls = await readCaptureCalls(page);
    var failCalls = calls.filter(function (c) { return c.name === 'webview_video_playback_failed'; });
    assert.equal(failCalls.length, 0, 'no failure event may fire outside a webview');
  } finally {
    await context.close();
  }
});
