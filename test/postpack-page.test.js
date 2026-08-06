// test/postpack-page.test.js
//
// Real browser coverage for postpack-h4mv.html (tracker item
// for-product-instagram-tiktok-auto-postin-cahr76, Manager's SPEC v1) —
// the login-gate + real-password-gate flow, grid rendering, channel
// filtering, and the copy/download affordances. The owner-gate/data
// ENDPOINT itself is covered at the handler level
// (test/admin-postpack-data.test.js) — this file only proves the PAGE
// wires up to it correctly. Playwright resolution/skip convention and
// gate-flow shape both mirror test/media-library-page.test.js closely
// (same underlying gate mechanism, same page family).
//
// Also covers the watermarked-export feature (tracker item
// for-product-ig-account-live-dreamtube-ai-qij3yn) — the opt-in
// "Download (watermark)" button, image-only in this pass (see
// postpack-h4mv.html's own WATERMARK_VIDEO_NOTE comment for why video is
// scoped out), verified against a REAL same-origin image asset (not just
// mocked plumbing) so the actual canvas draw + logo overlay + toBlob path
// runs for real.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

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

/** Seeds a logged-in account with a real email on file — mirrors media-library-page.test.js's own seedUser. */
async function seedUser(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@owner', username: 'owner' };
    if (!state.accounts) state.accounts = {};
    state.accounts.owner = { password: 'ownerpass1', email: 'founder@dreamtube.example' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

var SAMPLE_ITEMS = [
  { id: 'd1:instagram', dreamId: 'd1', channel: 'instagram', ownerHandle: '@alice', style: 'Cinematic', mediaType: 'video', mediaUrl: '/.netlify/functions/video-file?key=d1', caption: 'A dream about flying.\n\nCinematic dream, made with DreamTube\n🎥 by @alice', hashtags: ['#DreamTube', '#CinematicDream'], builtAt: Date.now() },
  { id: 'd2:tiktok', dreamId: 'd2', channel: 'tiktok', ownerHandle: '@bob', style: 'Anime', mediaType: 'image', mediaUrl: 'https://fal.media/y.png', caption: 'A dream about the ocean.\n\nAnime dream, made with DreamTube\n🎥 by @bob', hashtags: ['#DreamTube', '#AnimeDream'], builtAt: Date.now() - 1000 }
];

function mockDataEndpoint(page, items) {
  return page.route('**/.netlify/functions/admin-postpack-data', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, generatedAt: Date.now(), items: items }) });
  });
}

function mockDataEndpointForbidden(page) {
  return page.route('**/.netlify/functions/admin-postpack-data', function (route) {
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) });
  });
}

test('redirects to login when no account is signed in at all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');
  await page.waitForURL(/login\.html/, { timeout: 5000 });
  await page.close();
});

test('a wrong password shows an error and keeps the grid hidden', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpointForbidden(page);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'wrongpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-gate-error:not(:empty)', { timeout: 5000 });
  var contentVisible = await page.isVisible('#pp-content');
  assert.equal(contentVisible, false);
  await page.close();
});

test('correct password unlocks the grid and renders one card per pack item with a channel badge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  var cardCount = await page.locator('#pp-grid .vcard').count();
  assert.equal(cardCount, 2);

  var totalStat = await page.locator('#pp-summary .pp-stat-num').first().textContent();
  assert.equal(totalStat.trim(), '2');

  var firstBadge = await page.locator('#pp-grid .vcard:first-child .pp-badge').textContent();
  assert.equal(firstBadge.trim(), 'Instagram'); // d1 is newest-builtAt, sorted first
  await page.close();
});

test('the channel filter narrows to just TikTok items', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  await page.selectOption('#pp-filter-channel', 'tiktok');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#pp-grid .vcard').length === 1;
  }, { timeout: 5000 });
  var ownerText = await page.locator('#pp-grid .vcard-title').first().textContent();
  assert.equal(ownerText.trim(), '@bob');
  await page.close();
});

test('an empty pack (all filtered out) shows the empty-state message, not a blank grid', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, []);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });
  await page.waitForSelector('#pp-empty', { state: 'visible', timeout: 5000 });
  var gridChildCount = await page.locator('#pp-grid .vcard').count();
  assert.equal(gridChildCount, 0);
  await page.close();
});

test('each card renders its full caption text (incl. hashtags) in a readonly textarea, exactly as built', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  var textarea = page.locator('#pp-grid .vcard:first-child .pp-caption-box');
  var value = await textarea.inputValue();
  assert.match(value, /A dream about flying\./);
  assert.match(value, /#DreamTube/);
  assert.match(value, /#CinematicDream/);
  var readonly = await textarea.getAttribute('readonly');
  assert.notEqual(readonly, null);
  await page.close();
});

test('the copy button shows a "Copied!" confirmation after clicking', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  await page.click('#pp-grid .vcard:first-child .pp-copy-btn');
  await page.waitForSelector('#pp-grid .vcard:first-child .pp-copied.show', { timeout: 5000 });
  await page.close();
});

test('each card has a download link pointing at the item\'s real media url', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  var href = await page.locator('#pp-grid .vcard:first-child .pp-download-btn').getAttribute('href');
  assert.equal(href, '/.netlify/functions/video-file?key=d1');
  var downloadAttr = await page.locator('#pp-grid .vcard:first-child .pp-download-btn').getAttribute('download');
  assert.notEqual(downloadAttr, null);
  await page.close();
});

// --- Watermarked export (tracker item for-product-ig-account-live-dreamtube-ai-qij3yn) ---
//
// The plain .pp-download-btn covered above stays completely unchanged —
// these tests only cover the NEW, opt-in .pp-watermark-btn sitting
// alongside it. Video is deliberately out of scope for this pass (see
// postpack-h4mv.html's own WATERMARK_VIDEO_NOTE comment) so d1 (video) in
// SAMPLE_ITEMS above must NOT get the button; only d2 (image) should.

test('only image items get a "Download (watermark)" button; the video item does not', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  var wmBtnCount = await page.locator('#pp-grid .pp-watermark-btn').count();
  assert.equal(wmBtnCount, 1); // only d2 (image) — d1 is a video

  var videoCardHasWmBtn = await page.locator('.vcard[data-item-id="d1\\:instagram"] .pp-watermark-btn').count();
  assert.equal(videoCardHasWmBtn, 0);
  var imageCardHasWmBtn = await page.locator('.vcard[data-item-id="d2\\:tiktok"] .pp-watermark-btn').count();
  assert.equal(imageCardHasWmBtn, 1);

  // The plain download button is untouched on both — this is a purely
  // additive, opt-in feature, never a replacement.
  var plainDownloadCount = await page.locator('#pp-grid .pp-download-btn').count();
  assert.equal(plainDownloadCount, 2);
  await page.close();
});

test('clicking "Download (watermark)" on a real image produces a real watermarked file download, plain download untouched', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  // Same-origin real asset (mirrors a re-hosted postpack image in
  // production, which is always served same-origin — see
  // assemble-instagram-tiktok-postpack.js's own header comment) so the
  // watermark fetch()/canvas pipeline runs for real, no mocking of the
  // actual image bytes or the canvas/toBlob step.
  var realImageItems = [
    { id: 'r1:instagram', dreamId: 'r1', channel: 'instagram', ownerHandle: '@dana', style: 'Cinematic', mediaType: 'image', mediaUrl: baseUrl + '/assets/style-previews/cinematic.jpg', caption: 'A real dream image.', hashtags: ['#DreamTube'], builtAt: Date.now() }
  ];
  await mockDataEndpoint(page, realImageItems);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });
  await page.waitForSelector('.pp-watermark-btn', { timeout: 5000 });

  var downloadPromise = page.waitForEvent('download', { timeout: 10000 });
  await page.click('.pp-watermark-btn');
  var download = await downloadPromise;

  assert.match(download.suggestedFilename(), /^r1-watermarked\.jpg$/);

  var savedPath = await download.path();
  var fs = require('node:fs');
  var stat = fs.statSync(savedPath);
  assert.ok(stat.size > 0, 'watermarked file should be a real, non-empty image');

  // No error surfaced, button re-enabled with its original label, and the
  // plain download link is exactly as it always was.
  var errorText = await page.locator('#pp-wm-error-r1\\:instagram').textContent();
  assert.equal(errorText.trim(), '');
  var wmBtnEnabled = await page.locator('.pp-watermark-btn').isEnabled();
  assert.equal(wmBtnEnabled, true);
  var wmBtnLabel = await page.locator('.pp-watermark-btn').textContent();
  assert.match(wmBtnLabel, /Download \(watermark\)/);
  var plainHref = await page.locator('.pp-download-btn').getAttribute('href');
  assert.equal(plainHref, baseUrl + '/assets/style-previews/cinematic.jpg');
  await page.close();
});

test('a watermark fetch failure (e.g. cross-origin media with no CORS) shows a graceful error and leaves plain download usable', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  var crossOriginUrl = 'https://example.com/no-cors-headers-dream-image.jpg';
  var items = [
    { id: 'r2:tiktok', dreamId: 'r2', channel: 'tiktok', ownerHandle: '@eli', style: 'Realistic', mediaType: 'image', mediaUrl: crossOriginUrl, caption: 'A dream that cannot be fetched cross-origin.', hashtags: ['#DreamTube'], builtAt: Date.now() }
  ];
  await mockDataEndpoint(page, items);
  await page.route(crossOriginUrl, function (route) { route.abort('failed'); });
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });
  await page.waitForSelector('.pp-watermark-btn', { timeout: 5000 });

  await page.click('.pp-watermark-btn');
  await page.waitForSelector('#pp-wm-error-r2\\:tiktok:not(:empty)', { timeout: 5000 });
  var errorText = await page.locator('#pp-wm-error-r2\\:tiktok').textContent();
  assert.match(errorText, /watermark|download instead/i);

  // The button recovers (not stuck disabled/"Working…") and the plain
  // download link is completely unaffected by the watermark attempt failing.
  var wmBtnEnabled = await page.locator('.pp-watermark-btn').isEnabled();
  assert.equal(wmBtnEnabled, true);
  var plainHref = await page.locator('.pp-download-btn').getAttribute('href');
  assert.equal(plainHref, crossOriginUrl);
  await page.close();
});
