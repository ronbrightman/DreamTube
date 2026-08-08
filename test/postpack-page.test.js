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

test('an image card has a plain download link pointing at the item\'s real media url (this ruling only concerns video)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  // SAMPLE_ITEMS[1] (d2, image) sorts second (older builtAt) -- its card is
  // the second .vcard in the newest-first grid.
  var href = await page.locator('#pp-grid .vcard:nth-child(2) .pp-download-btn').getAttribute('href');
  assert.equal(href, 'https://fal.media/y.png');
  var downloadAttr = await page.locator('#pp-grid .vcard:nth-child(2) .pp-download-btn').getAttribute('download');
  assert.notEqual(downloadAttr, null);
  await page.close();
});

// Video download -- founder ruling, tracker item
// for-product-founder-ruling-08-07-every-u-g81h7v: "when a user downloads
// a video, the file must carry the logo watermark." A video card's
// Download is a BUTTON (not a plain <a href download>), since the
// watermarked url isn't known until js/watermark-download.js's async job
// resolves — see postpack-h4mv.html's own cardHTML/handleVideoDownload
// comments.

test('a video card renders Download as a BUTTON, not a plain anchor (the watermarked url isn\'t known synchronously)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/postpack-h4mv.html');

  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  // SAMPLE_ITEMS[0] (d1, video) sorts first (newest builtAt).
  var tagName = await page.locator('#pp-grid .vcard:first-child .pp-download-btn').evaluate(function (el) { return el.tagName; });
  assert.equal(tagName, 'BUTTON');
});

test('a video card\'s Download button resolves the WATERMARKED twin (via download-video.js/download-video-status.js, dreamId d1) and downloads it, never the raw clean media url', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT, acceptDownloads: true });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);

  // SAME-ORIGIN, matching production (a real twin is served from our own
  // watermarked-video-file.mjs, same domain as the page) — a genuinely
  // cross-origin fixture here would make the anchor's `download` attribute
  // get silently ignored by the browser (a real, well-known cross-origin
  // limitation on <a download>, same one this page's PRE-EXISTING plain
  // image download link already accepts — see cardHTML's own `target=
  // "_blank"` comment history), turning this into a popup-tab open instead
  // of a 'download' event, which isn't what this test means to exercise.
  var WATERMARKED_URL = baseUrl + '/.netlify/functions/watermarked-video-file?key=d1';
  var downloadVideoCalls = [];
  await page.route('**/.netlify/functions/download-video?*', function (route) {
    downloadVideoCalls.push(new URL(route.request().url()).searchParams);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ready', url: WATERMARKED_URL }) });
  });
  await page.route(WATERMARKED_URL, function (route) {
    route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('watermarked-postpack-bytes') });
  });
  // The grid's own lazy-loading <video preload="none" data-src> thumbnail
  // (unrelated to Download, and exactly what should stay untouched/clean
  // per this ruling) legitimately fetches the raw clean video-file url for
  // its IN-GRID PREVIEW once it's visible/observed — mocked here (real
  // network can't be reached in this sandbox) but deliberately NOT tracked
  // as a pass/fail signal, same reasoning as
  // test/share-sheet-behavioral.test.js's equivalent video watermark
  // tests (see that file's own comment on this exact class of false
  // positive).
  await page.route('**/.netlify/functions/video-file*', function (route) {
    route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('clean-bytes') });
  });

  await safeGoto(page, baseUrl + '/postpack-h4mv.html');
  await page.fill('#pp-gate-password', 'realownerpassword');
  await page.click('#pp-gate-submit');
  await page.waitForSelector('#pp-content', { state: 'visible', timeout: 5000 });

  // NOTE: this deliberately does not try to prove which URL's BYTES ended
  // up in the saved file via Playwright's own download-tracing (found to
  // be unreliable/racy against a same-origin `<a download>` anchor in this
  // sandbox — the 'download' event can resolve before this test's own
  // route handler is provably the one that served it). The real,
  // deterministic proof that the WATERMARKED twin (not the raw clean
  // video) is what gets downloaded lives one layer up, already asserted
  // below: download-video.js is called with this exact dream's id/src,
  // and js/watermark-download.js's own unit coverage
  // (test/watermark-download-client.test.js) proves resolveVideoUrl()
  // hands back exactly the url that call reports -- the url this button's
  // own `a.href` is then set to (see handleVideoDownload).
  var downloadPromise = page.waitForEvent('download', { timeout: 5000 });
  await page.click('#pp-grid .vcard:first-child .pp-download-btn');
  var download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^dreamtube-d1\.mp4$/);

  assert.equal(downloadVideoCalls.length, 1);
  assert.equal(downloadVideoCalls[0].get('id'), 'd1', 'must key the watermark twin by dreamId, the SAME id result.html/explore.html\'s Save to device uses for this dream -- so both surfaces share one cached twin');
  assert.equal(downloadVideoCalls[0].get('src'), '/.netlify/functions/video-file?key=d1');
  await page.close();
});
