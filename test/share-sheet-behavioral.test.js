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
//   5. Both real call sites (result.html's topbar share-btn, explore.html's
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
    await page.waitForSelector('.toast.show', { timeout: 3000 });
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
