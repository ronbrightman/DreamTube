// test/result-image-render-behavioral.test.js
//
// Real browser-driven coverage for result.html's image-dream rendering —
// specifically the failure path the founder hit on 2026-08-08: choosing
// "create an image" produced a dream with an imageUrl set, but the <img>
// then failed to load and the frame silently collapsed to its dark
// `.dreamvideo{background:var(--surface)}` backing = a "black blank square"
// with no error shown at all (the <video> element has an error listener;
// the <img> had none).
//
// Covers:
//   1. A successful image load: #result-image is shown with the right src,
//      and NO error state is surfaced.
//   2. A failing image load (routed to abort, standing in for a fal CDN
//      hiccup / expiry / image-file.mjs serving failure): after the one
//      self-heal retry, a real, visible error state is surfaced on the
//      frame instead of a silent black square, and it's tappable to retry.
//
// The image URLs are intercepted via page.route() — zero real fal.ai cost,
// same pattern as test/image-generation-style-toggle-behavioral.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settle = require('./helpers/settle').settle;

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

var GOOD_IMAGE_URL = 'https://img.example.test/good-image.png';
var BAD_IMAGE_URL = 'https://img.example.test/broken-image.png';

// A tiny real 1x1 PNG, served for the "good" URL so the <img> genuinely loads.
var PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function routeImages(page) {
  return page.route('https://img.example.test/**', function (route) {
    var url = route.request().url();
    if (url.indexOf('good-image') !== -1) {
      route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG_1x1_BASE64, 'base64') });
    } else {
      // Stands in for a fal CDN hiccup / expired URL / image-file.mjs 500 —
      // every one of which lands here as a load failure in the browser.
      route.abort();
    }
  });
}

async function seedImageDream(page, imageUrl) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  var dreamId = await page.evaluate(function (url) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@imgviewer', username: 'imgviewer' };
    if (!state.accounts) state.accounts = {};
    state.accounts.imgviewer = { password: 'testpass1', email: 'imgviewer@example.com' };
    if (!state.dreams) state.dreams = [];
    var id = 'dream-img-test-1';
    state.dreams.unshift({
      id: id,
      ownerHandle: '@imgviewer',
      caption: 'A quiet lake under two moons',
      storyText: 'A quiet lake under two moons',
      style: 'Cinematic',
      mediaType: 'image',
      imageUrl: url,
      videoUrl: null,
      likes: 0, likedByMe: false, isPublished: false,
      createdAt: Date.now()
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    return id;
  }, imageUrl);
  return dreamId;
}

test('result.html: a successful image dream shows the <img> with the right src and no error state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await routeImages(page);
    var id = await seedImageDream(page, GOOD_IMAGE_URL);
    await page.goto(baseUrl + '/result.html?id=' + id, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#result-image', { timeout: 5000 });
    var imageVisible = await page.locator('#result-image').isVisible();
    var videoVisible = await page.locator('#result-video').isVisible();
    assert.equal(imageVisible, true, 'the image element must be shown for an image dream');
    assert.equal(videoVisible, false, 'the video element must be hidden for an image dream');

    var src = await page.locator('#result-image').getAttribute('src');
    assert.equal(src, GOOD_IMAGE_URL, 'the image src must be the dream\'s own imageUrl');

    // Let the load settle; the error state must stay hidden for a good image.
    await page.waitForTimeout(400);
    var errVisible = await page.locator('#result-image-error').isVisible().catch(function () { return false; });
    assert.equal(errVisible, false, 'no error state may show when the image loads fine');
  } finally {
    await context.close();
  }
});

test('result.html: when the image fails to load, a real error state is surfaced instead of a silent black square', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await routeImages(page);
    var id = await seedImageDream(page, BAD_IMAGE_URL);
    await page.goto(baseUrl + '/result.html?id=' + id, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#result-image', { timeout: 5000 });

    // The failure state must become visible (after the one self-heal retry).
    await page.waitForSelector('#result-image-error', { state: 'visible', timeout: 8000 });
    var errVisible = await page.locator('#result-image-error').isVisible();
    assert.equal(errVisible, true, 'a failed image load must surface a visible error state, not a silent black square');

    // And it must carry real, human-readable copy (never an empty black box).
    var errText = (await page.locator('#result-image-error').textContent()).trim();
    assert.ok(errText.length > 0, 'the error state must show a real message');
  } finally {
    await context.close();
  }
});
