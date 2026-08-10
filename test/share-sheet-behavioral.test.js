// test/share-sheet-behavioral.test.js
//
// Real browser-driven coverage for js/share-sheet.js — tracker item
// for-product-build-share-mini-sheet-share-r42tc4 (founder-reviewed
// 2026-07-28). Covers:
//   1. The mini-sheet opens on Share tap and dismisses via tap-outside +
//      drag, matching test/sheet-dismiss-behavioral.test.js's own
//      conventions (this sheet is one more entry in that file's app-wide
//      .sheet-overlay inventory, just covered here alongside its own
//      feature-specific behavior instead).
//   2. "Share link" fires the EXISTING navigator.share/clipboard-copy
//      path unchanged (regression) — only the URL changed, from a bare
//      explore.html?id=... link to the new share-dream.js endpoint.
//   3. "Save to device" fetches the dream's media as a blob and hands it
//      to navigator.share({files:[...]}) when canShare says yes, falls
//      back to a real file download when canShare declines the file, and
//      falls back to opening the raw media URL in a new tab when there's
//      no File-share support at all OR the blob fetch itself fails
//      (e.g. a CORS-blocked external image URL).
//   4. share_option_chosen fires with the right {option} the moment
//      either option is tapped.
//   5. Both real call sites (result.html's #share-btn, now a pill in the
//      hero's own tag row rather than a topbar chip -- see tracker item
//      for-product-founder-walkthrough-punch-li-t33k3y -- and explore.html's
//      feed-card Share action) open the same shared sheet.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var dragSheet = require('./helpers/touch-drag').dragSheet;

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

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

async function newMobileContext(opts) {
  return browser.newContext(Object.assign({ viewport: MOBILE_VIEWPORT, hasTouch: true, acceptDownloads: true }, opts || {}));
}

/** Stubs window.posthog (before any app script runs) so share_option_chosen can be asserted on directly — same pattern test/owner-topup-target-behavioral.test.js already uses. `__loaded:true` stops each page's own embedded PostHog snippet from clobbering this stub (see that file's identical comment). */
function installPosthogStub(page) {
  return page.addInitScript(function () {
    window.__capturedEvents = [];
    window.posthog = {
      __loaded: true,
      init: function () {},
      capture: function (name, props) { window.__capturedEvents.push({ name: name, props: props }); }
    };
  });
}

function capturedEventsNamed(page, name) {
  return page.evaluate(function (n) {
    return (window.__capturedEvents || []).filter(function (e) { return e.name === n; });
  }, name);
}

var MEDIA_URL = 'https://example.com/fake-video.mp4';
var IMAGE_URL = 'https://example.com/fake-image.png';

/**
 * Mocks netlify/functions/download-video.js's "ready immediately" response
 * — js/watermark-download.js's resolveVideoUrl() short-circuits straight
 * to the resolved url when download-video.js itself already reports
 * status:'ready' (the cached-twin path), so this reproduces every
 * pre-existing "Save to device" test's original single-fetch shape
 * unchanged downstream, while still routing through the real
 * watermark-on-download mechanism (tracker item
 * for-product-founder-ruling-08-07-every-u-g81h7v) the way production
 * does. `urlFor(id)` lets one route serve different dreams different
 * "watermarked" urls (see the stale/abandoned test below, which needs two
 * dreams answered differently from the same route).
 */
function routeDownloadVideoReady(page, urlFor) {
  return page.route('**/.netlify/functions/download-video?*', function (route) {
    var reqUrl = new URL(route.request().url());
    var id = reqUrl.searchParams.get('id');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ready', url: urlFor(id) }) });
  });
}

async function seedResultPageWithDream(page, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.dreams) state.dreams = [];
    state.dreams.push({
      id: o.id,
      ownerHandle: '@tester',
      caption: 'A test dream about flying over mountains',
      style: 'Cinematic',
      videoUrl: o.videoUrl || null,
      imageUrl: o.imageUrl || null,
      mediaType: o.mediaType || 'video',
      isPublished: o.isPublished !== false,
      createdAt: new Date().toISOString()
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
  await safeGoto(page, baseUrl + '/result.html?id=' + opts.id);
}

var DISMISS_WAIT_TIMEOUT_MS = 8000;
var OPEN_TRANSITION_SETTLE_MS = 350;

async function waitForSheetSettled(page) {
  await page.waitForSelector('#share-sheet-overlay.open');
  await page.waitForTimeout(OPEN_TRANSITION_SETTLE_MS);
}

async function openShareSheetFromResult(page) {
  await page.click('#share-btn');
  await waitForSheetSettled(page);
}

// ============================================================================
// 1. Open + dismiss (tap-outside, drag) — same conventions as
//    test/sheet-dismiss-behavioral.test.js.
// ============================================================================

test('share mini-sheet: tapping Share on an already-published dream opens the sheet with both options visible', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPageWithDream(page, { id: 'd-share-open-1', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);
    assert.equal(await page.locator('#share-opt-link').count(), 1);
    assert.equal(await page.locator('#share-opt-save').count(), 1);
    assert.match(await page.textContent('#share-opt-link'), /Share link/);
    assert.match(await page.textContent('#share-opt-save'), /Save to device/);
  } finally {
    await context.close();
  }
});

test('share mini-sheet: tap outside the sheet (in the tappable gap) closes it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPageWithDream(page, { id: 'd-share-dismiss-1', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);
    var box = await page.locator('#share-sheet-overlay .sheet').boundingBox();
    assert.ok(box.y > 0, 'sheet must leave a nonzero tappable gap above it');
    await page.mouse.click(box.x + box.width / 2, Math.max(1, box.y - 10));
    await page.waitForSelector('#share-sheet-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('share mini-sheet: a drag-down past ~30% of the sheet\'s height dismisses it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPageWithDream(page, { id: 'd-share-drag-1', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);
    var box = await page.locator('#share-sheet-overlay .sheet').boundingBox();
    await dragSheet(page, '#share-sheet-overlay .sheet', { startY: box.y + 20, deltaY: box.height * 0.6, steps: 20 });
    await page.waitForSelector('#share-sheet-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('share mini-sheet: a drag-down under the dismiss threshold snaps back open', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPageWithDream(page, { id: 'd-share-drag-2', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);
    var box = await page.locator('#share-sheet-overlay .sheet').boundingBox();
    await dragSheet(page, '#share-sheet-overlay .sheet', { startY: box.y + 20, deltaY: box.height * 0.1, steps: 20 });
    await page.waitForTimeout(450);
    assert.equal(await page.locator('#share-sheet-overlay.open').count(), 1, 'sheet must still be open after an under-threshold drag');
  } finally {
    await context.close();
  }
});

test('share mini-sheet: unpublished dream still routes Share through the publish-first modal before the sheet ever appears (unchanged pre-existing gate)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPageWithDream(page, { id: 'd-share-unpub-1', videoUrl: MEDIA_URL, isPublished: false });
    await page.click('#share-btn');
    await page.waitForSelector('#modal-publish.open', { timeout: 5000 });
    assert.equal(await page.locator('#share-sheet-overlay.open').count(), 0, 'the mini-sheet must not appear until publish is confirmed');

    await page.click('#publish-confirm');
    await waitForSheetSettled(page);
    assert.equal(await page.locator('#share-sheet-overlay.open').count(), 1, 'confirming publish must proceed straight into the share mini-sheet, same as the old direct doShare() call did');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. "Share link" — regression: exact pre-existing mechanism, new URL.
// ============================================================================

test('share mini-sheet: "Share link" calls navigator.share with the share-dream.js preview-card URL (not a bare explore.html link)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await installPosthogStub(page);
    await page.addInitScript(function () {
      window.__shareCalls = [];
      navigator.share = function (data) { window.__shareCalls.push(data); return Promise.resolve(); };
    });
    await seedResultPageWithDream(page, { id: 'd-share-link-1', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);

    await page.click('#share-opt-link');
    await page.waitForFunction(function () { return (window.__shareCalls || []).length > 0; }, null, { timeout: 3000 });

    var calls = await page.evaluate(function () { return window.__shareCalls; });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, 'DreamTube');
    assert.match(calls[0].text, /Check out my dream: "A test dream about flying over mountains"/);
    assert.match(calls[0].url, /\/\.netlify\/functions\/share-dream\?id=d-share-link-1$/, 'the shared URL must be the new share-dream.js endpoint, not explore.html directly');

    var sheetOpen = await page.locator('#share-sheet-overlay.open').count();
    assert.equal(sheetOpen, 0, 'the mini-sheet must close once an option is chosen');
  } finally {
    await context.close();
  }
});

test('share mini-sheet: "Share link" falls back to clipboard-copy + toast when navigator.share is unavailable (pre-existing fallback, unchanged)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.addInitScript(function () { delete navigator.__proto__.share; Object.defineProperty(navigator, 'share', { value: undefined }); });
    await seedResultPageWithDream(page, { id: 'd-share-link-2', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);

    await page.click('#share-opt-link');
    // Waits for the SPECIFIC toast text, not the generic '.toast.show' class.
    // result.html's #toast is a single shared element reused by every toast
    // on the page, including the sound-discoverability nudge
    // (maybeShowSoundNudge, '🎵 Tap for sound') that fires automatically on
    // load for any bed-eligible video on a fresh device -- which this test's
    // seeded dream always is (js/music-bed.js's eligible() resolves a
    // default-mood bed for every real video dream). Under full-suite CPU
    // contention that nudge's own 2200ms auto-hide timer can still be
    // running (not yet removed '.show') when this test reaches its own
    // click, so a bare '.toast.show' wait was satisfied immediately by the
    // STALE nudge toast rather than the new one -- and since chooseLink()'s
    // clipboard branch only calls showToast() inside a
    // navigator.clipboard.writeText().then(...) (a genuine async hop, not
    // guaranteed complete just because page.click() resolved), the very
    // next textContent read could still race that pending promise and read
    // the stale '🎵 Tap for sound' text instead (confirmed root cause,
    // tracker item full-test-suite-has-broader-nondetermini-6fbmcb, round 2
    // pass -- see docs/flake-investigation-round2-notes.md). Waiting on the
    // real condition under test (the toast's text actually being the
    // clipboard-copy message) makes this correct regardless of the nudge's
    // timing.
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return !!t && t.classList.contains('show') && /Link copied to clipboard/.test(t.textContent || '');
    }, null, { timeout: 3000 });
    assert.match(await page.textContent('#toast'), /Link copied to clipboard/);

    var clipboardText = await page.evaluate(function () { return navigator.clipboard.readText(); });
    assert.match(clipboardText, /\/\.netlify\/functions\/share-dream\?id=d-share-link-2$/);
  } finally {
    await context.close();
  }
});

test('share_option_chosen fires with {option:"link"} the moment "Share link" is tapped', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await installPosthogStub(page);
    await page.addInitScript(function () { navigator.share = function () { return Promise.resolve(); }; });
    await seedResultPageWithDream(page, { id: 'd-share-analytics-1', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);

    await page.click('#share-opt-link');
    var events = await capturedEventsNamed(page, 'share_option_chosen');
    assert.equal(events.length, 1);
    assert.equal(events[0].props.option, 'link');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3. "Save to device"
// ============================================================================

test('share mini-sheet: Save to device fetches the media as a blob and calls navigator.share({files}) when canShare supports it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await installPosthogStub(page);
    await page.addInitScript(function () {
      window.__shareCalls = [];
      navigator.share = function (data) { window.__shareCalls.push(data); return Promise.resolve(); };
      navigator.canShare = function (data) { return !!(data && data.files); };
    });
    await routeDownloadVideoReady(page, function () { return MEDIA_URL; });
    await page.route(MEDIA_URL, function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('fake-video-bytes') });
    });
    await seedResultPageWithDream(page, { id: 'd-share-save-1', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);

    await page.click('#share-opt-save');
    await page.waitForFunction(function () { return (window.__shareCalls || []).length > 0; }, null, { timeout: 5000 });

    var fileInfo = await page.evaluate(function () {
      var call = window.__shareCalls[0];
      var file = call.files && call.files[0];
      return file ? { name: file.name, type: file.type, size: file.size } : null;
    });
    assert.ok(fileInfo, 'navigator.share must have been called with a real files:[...] payload');
    assert.match(fileInfo.name, /^dreamtube-d-share-save-1\.mp4$/);
    assert.equal(fileInfo.type, 'video/mp4');
    assert.ok(fileInfo.size > 0, 'the shared file must carry the real fetched bytes, not an empty placeholder');

    var events = await capturedEventsNamed(page, 'share_option_chosen');
    assert.equal(events.length, 1);
    assert.equal(events[0].props.option, 'save');
  } finally {
    await context.close();
  }
});

test('share mini-sheet: Save to device falls back to a real file download when canShare declines the fetched file', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.addInitScript(function () {
      navigator.share = function () { return Promise.resolve(); };
      navigator.canShare = function () { return false; }; // browser has navigator.share, but declines this file
    });
    await routeDownloadVideoReady(page, function () { return MEDIA_URL; });
    await page.route(MEDIA_URL, function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('fake-video-bytes') });
    });
    await seedResultPageWithDream(page, { id: 'd-share-save-2', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);

    var downloadPromise = page.waitForEvent('download', { timeout: 5000 });
    await page.click('#share-opt-save');
    var download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^dreamtube-d-share-save-2\.mp4$/);

    await page.waitForSelector('#share-sheet-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('share mini-sheet: Save to device opens the raw media URL in a new tab when there is no File-share support at all (most desktop browsers)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.addInitScript(function () {
      // No navigator.share/canShare at all -- headless Chromium's own
      // default (desktop Chromium implements neither), made explicit here
      // so this test doesn't depend on that default silently changing.
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
    });
    // No fetch is ever made on this path (the whole point of this
    // branch is skipping straight to window.open) -- but the POPUP tab
    // window.open() creates still has to actually navigate somewhere for
    // its .url() to be checkable, and this sandbox's real network can't
    // reach an arbitrary external host (see CLAUDE.md) -- registered at
    // the CONTEXT level (not page-level) so it also covers the new
    // popup page's own navigation request, not just the original page's.
    await routeDownloadVideoReady(page, function () { return MEDIA_URL; });
    await context.route(MEDIA_URL, function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('fake-video-bytes') });
    });
    await seedResultPageWithDream(page, { id: 'd-share-save-3', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);

    var popupPromise = context.waitForEvent('page', { timeout: 5000 });
    await page.click('#share-opt-save');
    var popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded').catch(function () {});
    assert.equal(popup.url(), MEDIA_URL);

    await page.waitForSelector('#share-sheet-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('share mini-sheet: Save to device falls back to opening the raw media URL when fetching it as a blob fails (e.g. a CORS-blocked external image URL)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.addInitScript(function () {
      navigator.share = function () { return Promise.resolve(); };
      navigator.canShare = function () { return true; };
    });
    // Context-level fulfill first (so the FALLBACK popup tab's own
    // navigation to this same URL can actually succeed -- this sandbox's
    // real network can't reach an arbitrary external host, see
    // CLAUDE.md), then a PAGE-level abort on top (page-level routes take
    // precedence over context-level ones for that specific page's own
    // requests) so the original page's fetch() genuinely fails, forcing
    // chooseSave()'s .catch() branch this test exists to cover.
    await context.route(IMAGE_URL, function (route) {
      route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('fake-image-bytes') });
    });
    await page.route(IMAGE_URL, function (route) { route.abort('failed'); });
    await seedResultPageWithDream(page, { id: 'd-share-save-4', imageUrl: IMAGE_URL, mediaType: 'image' });
    await openShareSheetFromResult(page);

    var popupPromise = context.waitForEvent('page', { timeout: 5000 });
    await page.click('#share-opt-save');
    var popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded').catch(function () {});
    assert.equal(popup.url(), IMAGE_URL, 'Save must never do nothing on a blob-fetch failure -- it must still hand the user the raw media URL');

    await page.waitForSelector('#share-sheet-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('share mini-sheet: Save to device dismissed before its fetch resolves, then reopened for a DIFFERENT dream, does not let the stale resolution fire navigator.share for the abandoned dream or clobber the reopened sheet\'s button/label state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // Sibling regression test to js/purchase-sheet.js's own currentGen-guard
  // coverage (test/out-of-tokens-purchase-sheet-behavioral.test.js
  // ~L181-242 and ~L830-891). js/share-sheet.js's header comment claims
  // the exact same currentGen pattern (myGen captured before fetchAsBlob,
  // checked in both .then() and .catch() before any DOM mutation), and it
  // IS implemented correctly on manual trace, but nothing here actually
  // exercised it: start "Save to device" for dream A, dismiss before its
  // fetch resolves, reopen the sheet for dream B, then let A's fetch
  // resolve while B's sheet is on screen and confirm it's a genuine no-op.
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await installPosthogStub(page);
    await page.addInitScript(function () {
      window.__shareCalls = [];
      navigator.share = function (data) { window.__shareCalls.push(data); return Promise.resolve(); };
      navigator.canShare = function (data) { return !!(data && data.files); };
    });

    var STALE_MEDIA_URL = 'https://example.com/fake-video-stale.mp4';
    var OTHER_MEDIA_URL = 'https://example.com/fake-video-other.mp4';

    await routeDownloadVideoReady(page, function (id) {
      return id === 'd-share-stale-A' ? STALE_MEDIA_URL : OTHER_MEDIA_URL;
    });

    var resolveStaleFetch;
    var staleFetchGate = new Promise(function (resolve) { resolveStaleFetch = resolve; });
    await page.route(STALE_MEDIA_URL, function (route) {
      staleFetchGate.then(function () {
        route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('stale-dream-bytes') });
      });
    });
    await page.route(OTHER_MEDIA_URL, function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('other-dream-bytes') });
    });
    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          feed: [
            { id: 'd-share-stale-A', ownerHandle: '@other', caption: 'The abandoned dream', style: 'Cinematic', videoUrl: STALE_MEDIA_URL, imageUrl: null, mediaType: 'video', likes: 1 },
            { id: 'd-share-stale-B', ownerHandle: '@other', caption: 'The reopened dream', style: 'Cinematic', videoUrl: OTHER_MEDIA_URL, imageUrl: null, mediaType: 'video', likes: 2 }
          ],
          dreamOfDayId: null
        })
      });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-share="d-share-stale-A"]', { timeout: 5000 });

    // Open the sheet for dream A, tap Save (kicks off the fetch this test
    // holds open via staleFetchGate), then dismiss before it can resolve.
    await page.click('[data-share="d-share-stale-A"]');
    await waitForSheetSettled(page);
    await page.click('#share-opt-save');
    await page.waitForSelector('#share-opt-save-label:has-text("Preparing")', { timeout: 3000 });
    await page.click('#share-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#share-sheet-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });

    // Reopen the sheet for a DIFFERENT dream (B) while A's fetch is still
    // gated open -- this bumps currentGen past the abandoned attempt's
    // own captured myGen.
    await page.click('[data-share="d-share-stale-B"]');
    await waitForSheetSettled(page);
    var labelOnReopen = await page.textContent('#share-opt-save-label');
    assert.match(labelOnReopen, /Save to device/, 'reopened sheet must start fresh with its normal idle label, not carry over dream A\'s "Preparing…" state');
    var disabledOnReopen = await page.evaluate(function () { return document.getElementById('share-opt-save').disabled; });
    assert.equal(disabledOnReopen, false, 'reopened sheet\'s Save button must not be stuck disabled from dream A\'s abandoned in-flight attempt');

    // Now let dream A's stale fetch resolve while dream B's sheet is what
    // is actually on screen.
    resolveStaleFetch();
    await page.waitForTimeout(600);

    var shareCallsAfter = await page.evaluate(function () { return window.__shareCalls; });
    assert.equal(shareCallsAfter.length, 0, 'the abandoned dream A attempt must never fire navigator.share once its fetch resolves after being superseded');

    var labelAfter = await page.textContent('#share-opt-save-label');
    assert.match(labelAfter, /Save to device/, 'dream B\'s sheet must still show its own normal idle label -- dream A\'s stale resolution must not touch it');
    var sheetStillOpen = await page.evaluate(function () { return document.getElementById('share-sheet-overlay').classList.contains('open'); });
    assert.ok(sheetStillOpen, 'dream B\'s sheet must still be open -- the stale resolution must not have called hide() on it');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3b. Watermark-on-download (founder ruling, tracker item
//     for-product-founder-ruling-08-07-every-u-g81h7v): video Save to
//     device must resolve a WATERMARKED url via download-video.js/
//     download-video-status.js (js/watermark-download.js), never fetch
//     dream.videoUrl directly, and must never fall back to the raw video
//     on a watermark failure.
// ============================================================================

test('share mini-sheet: Save to device on a video polls download-video-status while "processing" and shares the WATERMARKED url, not the raw dream.videoUrl', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await installPosthogStub(page);
    await page.addInitScript(function () {
      window.__shareCalls = [];
      navigator.share = function (data) { window.__shareCalls.push(data); return Promise.resolve(); };
      navigator.canShare = function (data) { return !!(data && data.files); };
    });

    var WATERMARKED_URL = 'https://example.com/fake-video-watermarked.mp4';
    var downloadVideoCalls = [];
    var statusPollCount = 0;

    await page.route('**/.netlify/functions/download-video?*', function (route) {
      downloadVideoCalls.push(new URL(route.request().url()).searchParams);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'processing' }) });
    });
    await page.route('**/.netlify/functions/download-video-status?*', function (route) {
      statusPollCount++;
      // First poll: still running. Second poll: done -- resolves to a URL
      // that is DELIBERATELY different from dream.videoUrl (MEDIA_URL), so
      // this test can prove the app fetched the watermarked twin, not the
      // clean original.
      var body = statusPollCount < 2 ? { status: 'processing' } : { status: 'ready', url: WATERMARKED_URL };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    // MEDIA_URL is still mocked here (so result.html's own <video> player,
    // which legitimately sets video.src = dream.videoUrl for ordinary
    // IN-APP PLAYBACK the instant the page loads — unrelated to Save, and
    // exactly what this ruling requires stay untouched/clean — doesn't hit
    // the real network), but this test deliberately does NOT assert it's
    // "never fetched" page-wide, since that legitimate playback request
    // would make such an assertion flaky/wrong. The real, ruling-relevant
    // proof is the SHARED FILE's own bytes below: its size exactly matches
    // the watermarked fixture, not the differently-sized clean one, so it
    // can only have come from WATERMARKED_URL.
    await page.route(MEDIA_URL, function (route) { route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('clean-bytes') }); });
    await page.route(WATERMARKED_URL, function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('watermarked-bytes') });
    });

    await seedResultPageWithDream(page, { id: 'd-share-wm-1', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);

    await page.click('#share-opt-save');
    await page.waitForSelector('#share-opt-save-label:has-text("Watermarking")', { timeout: 5000 });
    await page.waitForFunction(function () { return (window.__shareCalls || []).length > 0; }, null, { timeout: 5000 });

    assert.equal(downloadVideoCalls.length, 1, 'download-video.js must be called exactly once to submit/check the job');
    assert.equal(downloadVideoCalls[0].get('id'), 'd-share-wm-1');
    assert.equal(downloadVideoCalls[0].get('src'), MEDIA_URL, 'the clean original url must be passed through as the src to watermark');
    assert.ok(statusPollCount >= 2, 'must have polled download-video-status at least until it reported ready');

    var fileInfo = await page.evaluate(function () {
      var call = window.__shareCalls[0];
      var file = call.files && call.files[0];
      return file ? { size: file.size, name: file.name } : null;
    });
    assert.ok(fileInfo, 'navigator.share must have been called with a real files:[...] payload');
    assert.equal(fileInfo.size, Buffer.from('watermarked-bytes').length, 'the shared file\'s bytes must be the WATERMARKED fixture specifically, not the (differently-sized) clean one -- proves Save fetched WATERMARKED_URL, not the raw dream.videoUrl');
  } finally {
    await context.close();
  }
});

test('share mini-sheet: Save to device on a video shows a real error and NEVER falls back to the raw dream.videoUrl when the watermark job fails', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // window.open is this app's OWN fallback-download mechanism (see
    // chooseSave's "no File-share support"/blob-fetch-failure branches) --
    // stubbing and asserting it's never called is a direct, precise proof
    // that a watermark failure triggers no fallback download of the raw
    // url, unlike page-wide network tracking on MEDIA_URL itself (which
    // would also fire from result.html's own <video> player loading it for
    // ordinary, unrelated, correctly-unchanged in-app playback).
    await page.addInitScript(function () {
      window.__openCalls = [];
      window.open = function (url) { window.__openCalls.push(url); return null; };
    });
    await page.route('**/.netlify/functions/download-video?*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'error', error: 'WD04: submit_failed: fal_down' }) });
    });
    await page.route(MEDIA_URL, function (route) { route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('clean-bytes') }); });

    await seedResultPageWithDream(page, { id: 'd-share-wm-err-1', videoUrl: MEDIA_URL });
    await openShareSheetFromResult(page);

    await page.click('#share-opt-save');
    await page.waitForSelector('#share-sheet-error:not([style*="display: none"])', { timeout: 5000 });
    assert.match(await page.textContent('#share-sheet-error'), /watermarked copy/i);

    await page.waitForTimeout(300);
    var openCalls = await page.evaluate(function () { return window.__openCalls; });
    assert.deepEqual(openCalls, [], 'a watermark failure must never silently fall back to opening/serving the unwatermarked original');

    var labelAfter = await page.textContent('#share-opt-save-label');
    assert.match(labelAfter, /Save to device/, 'the Save button must reset to its normal idle label so the user can retry');
    var disabledAfter = await page.evaluate(function () { return document.getElementById('share-opt-save').disabled; });
    assert.equal(disabledAfter, false);
  } finally {
    await context.close();
  }
});

// ============================================================================
// 4. Both real call sites open the same shared sheet.
// ============================================================================

test('explore.html feed-card Share action opens the same share mini-sheet as result.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          feed: [{
            id: 'd-explore-share-1', ownerHandle: '@other', caption: 'Someone else\'s dream',
            style: 'Cinematic', videoUrl: MEDIA_URL, imageUrl: null, mediaType: 'video', likes: 3
          }],
          dreamOfDayId: null
        })
      });
    });
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-share="d-explore-share-1"]', { timeout: 5000 });
    await page.click('[data-share="d-explore-share-1"]');
    await waitForSheetSettled(page);
    assert.equal(await page.locator('#share-opt-link').count(), 1);
    assert.equal(await page.locator('#share-opt-save').count(), 1);
  } finally {
    await context.close();
  }
});
