// test/image-generation-style-toggle-behavioral.test.js
//
// Real browser-driven coverage for style.html's image-vs-video segmented
// toggle (docs/IMAGE_GENERATION_SPEC.md §5/§9, Direction A — confirmed by
// Ron) — the .media-type-row/.media-type-btn pill pair placed directly
// above #generate-btn. Covers:
//   1. Video is pre-selected on load (existing behavior unchanged unless a
//      user deliberately picks Image).
//   2. Tapping Image relabels the Generate button; tapping back to Video
//      reverts it. The out-of-tokens purchase sheet's own per-mediaType
//      arithmetic (10 tokens for image / 100 for video — formerly a static
//      copy on the old #modal-quota this replaced, tracker item
//      for-product-build-out-of-tokens-purchase-2y8hyw) is covered directly
//      in test/out-of-tokens-purchase-sheet-behavioral.test.js.
//   3. End to end: picking Image and generating actually produces an
//      image-type dream (mediaType:'image', imageUrl set, no videoUrl) via
//      processing.html's dispatch to DreamStore.generateImage ->
//      generate-image.js — not just a UI-only check.
//
// GENERATION_MOCK_MODE is not available to a static-file-server test (no
// real Netlify Functions runtime here — see test/helpers/static-server.js's
// own header comment), so the generate-image/image-status calls are
// intercepted via page.route(), same pattern as
// test/ui-behavioral.test.js's mockTokenStatus/mockGetFeed and
// test/first-video-created-behavioral.test.js's captureTrackConversion —
// zero real fal.ai cost either way, per AGENT_POLICY.md.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

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

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

async function seedLoggedInUserAt(page, username, path) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded' });
}

/** Drives create.html's "Write it" path to a real draft, landing on style.html exactly like a real user would. */
async function reachStyleScreen(page, caption) {
  await page.click('#choice-write');
  await page.fill('#dream-text', caption);
  await page.click('#write-continue');
  await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });
}

test('style.html: Video is pre-selected; tapping Image relabels the button, and tapping back to Video reverts it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await seedLoggedInUserAt(page, 'toggletester', '/create.html');
    await reachStyleScreen(page, 'A dream about flying over a glowing city at night');

    // ----- Default state: Video pre-selected -----
    var videoActive = await page.locator('.media-type-btn[data-media-type="video"]').evaluate(function (el) { return el.classList.contains('active'); });
    var imageActiveInitially = await page.locator('.media-type-btn[data-media-type="image"]').evaluate(function (el) { return el.classList.contains('active'); });
    assert.equal(videoActive, true, 'Video must be pre-selected on load');
    assert.equal(imageActiveInitially, false);
    assert.equal(await page.textContent('#generate-btn'), 'Generate Video');

    // ----- Tap Image -----
    await page.click('.media-type-btn[data-media-type="image"]');
    var imageActive = await page.locator('.media-type-btn[data-media-type="image"]').evaluate(function (el) { return el.classList.contains('active'); });
    var videoActiveAfter = await page.locator('.media-type-btn[data-media-type="video"]').evaluate(function (el) { return el.classList.contains('active'); });
    assert.equal(imageActive, true);
    assert.equal(videoActiveAfter, false);
    assert.equal(await page.textContent('#generate-btn'), 'Generate Image');

    // ----- Tap back to Video -----
    await page.click('.media-type-btn[data-media-type="video"]');
    assert.equal(await page.textContent('#generate-btn'), 'Generate Video');
  } finally {
    await context.close();
  }
});

test('style.html: the out-of-tokens purchase sheet reads the currently-selected media type\'s real cost (10 for image / 100 for video), not a copy fixed at page load', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Low enough to block BOTH media types, so toggling alone (no balance
    // change) is what proves the sheet's arithmetic tracks the selection.
    await mockTokenStatus(page, { balance: 5, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await seedLoggedInUserAt(page, 'toggleblocked', '/create.html');
    await reachStyleScreen(page, 'A dream about flying over a glowing city at night');
    await page.waitForTimeout(200); // let the async getTokenStatus() pre-check resolve

    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('.media-type-btn[data-media-type="image"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    assert.match(await page.textContent('#ps-title'), /this image needs 10 tokens/);

    await page.evaluate(function () { document.getElementById('purchase-sheet-overlay').classList.remove('open'); });
    await page.click('.media-type-btn[data-media-type="video"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    assert.match(await page.textContent('#ps-title'), /this video needs 100 tokens/);
  } finally {
    await context.close();
  }
});

test('style.html: picking Image and generating actually dispatches to the image path end to end, producing an image-type dream (not a video one)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });

    var generateImageCalls = [];
    await page.route('**/.netlify/functions/generate-image', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateImageCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/flux/dev:test-op-1' }) });
    });
    // generate-video.js must NEVER be called on this path -- picking Image
    // should route exclusively through generate-image.js.
    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E999: should_not_be_called' }) });
    });
    await page.route('**/.netlify/functions/image-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, imageUrl: 'https://example.com/fake-image.jpg' }) });
    });

    await seedLoggedInUserAt(page, 'imagegentester', '/create.html');
    await reachStyleScreen(page, 'A dream about a floating library');
    await page.click('.style-card[data-style="Anime"]');
    await page.click('.media-type-btn[data-media-type="image"]');
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');

    // processing.html renders the image-specific copy while the (mocked)
    // generation is in flight.
    await page.waitForURL('**/processing.html', { timeout: 8000, waitUntil: 'domcontentloaded' });
    var procTitle = await page.textContent('#proc-title');
    assert.match(procTitle, /into a picture/);

    // Completion redirects to result.html?id=... (350ms setTimeout in
    // processing.html's attachTaskHandlers, plus real navigation time).
    await page.waitForURL('**/result.html?id=*', { timeout: 8000, waitUntil: 'domcontentloaded' });

    assert.equal(generateVideoCalls.length, 0, 'generate-video.js must never be called when Image is selected');
    assert.equal(generateImageCalls.length, 1);
    assert.equal(generateImageCalls[0].caption, 'A dream about a floating library');
    assert.equal(generateImageCalls[0].style, 'Anime');

    var dreamState = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dreamState.mediaType, 'image');
    assert.equal(dreamState.imageUrl, 'https://example.com/fake-image.jpg');
    assert.equal(dreamState.videoUrl, null);
    assert.equal(dreamState.dur, undefined, 'an image-type dream must never get a duration stamped');

    // result.html should be rendering the <img>, not the <video>, and
    // showing the "Turn this into a video" upsell.
    var imageVisible = await page.locator('#result-image').isVisible();
    var videoVisible = await page.locator('#result-video').isVisible();
    var turnVideoBtnVisible = await page.locator('#turn-video-btn').isVisible();
    assert.equal(imageVisible, true);
    assert.equal(videoVisible, false);
    assert.equal(turnVideoBtnVisible, true);
  } finally {
    await context.close();
  }
});
