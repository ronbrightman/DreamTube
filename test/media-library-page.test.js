// test/media-library-page.test.js
//
// Real browser coverage for media-library-x7q4.html (tracker item
// for-product-owner-media-library-page-fou-1fwxaw, Part 3) — the
// login-gate + real-password-gate flow, grid rendering, and status
// filtering. The owner-gate/backfill/data ENDPOINTS themselves are covered
// at the handler level (test/admin-media-library-data.test.js,
// test/admin-backfill-media-rehost.test.js) — this file only proves the
// PAGE wires up to them correctly. Playwright resolution/skip convention
// matches every other browser test in this repo (see
// test/barA-nav-rollout-behavioral.test.js's own header comment).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };
var DESKTOP_VIEWPORT = { width: 1280, height: 800 };

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

/** Seeds a logged-in account with a real email on file — enough for the client-side gate to show the password box (mirrors barA-nav-rollout-behavioral.test.js's own seedUser). */
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
  { id: 'd1:video', dreamId: 'd1', ownerHandle: '@alice', mediaType: 'video', url: '/.netlify/functions/video-file?key=d1', createdAt: Date.now(), isPublished: false, status: 're-hosted-durable', protectedByNoExpiryHeader: false, daysUntilExpiry: null },
  { id: 'd2:video', dreamId: 'd2', ownerHandle: '@bob', mediaType: 'video', url: 'https://fal.media/x.mp4', createdAt: Date.now(), isPublished: true, status: 'still-on-fal', protectedByNoExpiryHeader: true, daysUntilExpiry: null },
  { id: 'd3:image', dreamId: 'd3', ownerHandle: '@alice', mediaType: 'image', url: 'https://fal.media/y.png', createdAt: Date.now() - 20 * 24 * 60 * 60 * 1000, isPublished: false, status: 'lost-expired', protectedByNoExpiryHeader: false, daysUntilExpiry: 0 }
];

function mockDataEndpoint(page, items) {
  return page.route('**/.netlify/functions/admin-media-library-data', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, generatedAt: Date.now(), scannedAccounts: 2, items: items }) });
  });
}

function mockDataEndpointForbidden(page) {
  return page.route('**/.netlify/functions/admin-media-library-data', function (route) {
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) });
  });
}

/** Enough fake items to force the grid taller than one desktop screen — see the desktop-scroll test below, which needs real overflow to actually observe scroll behavior rather than assert on it in the abstract. */
function buildManyItems(count) {
  var items = [];
  for (var i = 0; i < count; i++) {
    items.push({
      id: 'd' + i + ':image', dreamId: 'd' + i, ownerHandle: '@user' + (i % 5), mediaType: 'image',
      url: 'https://fal.media/y' + i + '.png', createdAt: Date.now() - i * 1000,
      isPublished: i % 2 === 0, status: 're-hosted-durable', protectedByNoExpiryHeader: false, daysUntilExpiry: null
    });
  }
  return items;
}

test('redirects to login when no account is signed in at all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');
  await page.waitForURL(/login\.html/, { timeout: 5000 });
  await page.close();
});

test('a wrong password shows an error and keeps the grid hidden', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpointForbidden(page);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');

  await page.fill('#ml-gate-password', 'wrongpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-gate-error:not(:empty)', { timeout: 5000 });
  var contentVisible = await page.isVisible('#ml-content');
  assert.equal(contentVisible, false);
  await page.close();
});

test('correct password unlocks the grid, renders items with status badges, and the status filter narrows them', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');

  await page.fill('#ml-gate-password', 'realownerpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-content', { state: 'visible', timeout: 5000 });

  var cardCount = await page.locator('#ml-grid .vcard').count();
  assert.equal(cardCount, 3, 'all three sample items render');

  var totalStat = await page.locator('#ml-summary .ml-stat-num').first().textContent();
  assert.equal(totalStat.trim(), '3');

  // Filter to just still-on-fal.
  await page.selectOption('#ml-filter-status', 'still-on-fal');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#ml-grid .vcard').length === 1;
  }, { timeout: 5000 });
  var filteredOwner = await page.locator('#ml-grid .vcard-title').first().textContent();
  assert.equal(filteredOwner.trim(), '@bob');

  await page.close();
});

test('the account filter narrows to one owner\'s media across mixed media types', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');

  await page.fill('#ml-gate-password', 'realownerpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-content', { state: 'visible', timeout: 5000 });

  await page.selectOption('#ml-filter-account', '@alice');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#ml-grid .vcard').length === 2;
  }, { timeout: 5000 });

  await page.close();
});

test('an empty result set (all filtered out) shows the empty-state message, not a blank grid', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');

  await page.fill('#ml-gate-password', 'realownerpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-content', { state: 'visible', timeout: 5000 });

  await page.selectOption('#ml-filter-status', 'still-on-fal');
  await page.selectOption('#ml-filter-account', '@alice'); // no still-on-fal item belongs to @alice
  await page.waitForSelector('#ml-empty', { state: 'visible', timeout: 5000 });
  var gridChildCount = await page.locator('#ml-grid .vcard').count();
  assert.equal(gridChildCount, 0);

  await page.close();
});

// ===== Published/Private filter (tracker item
// for-product-media-library-founder-feedba-wnr3iw) — the backend/front-end
// already carried private items and an isPublished badge per card before
// this change (verified by reading admin-media-library-data.js/
// dream-store.js/media-library-x7q4.html's own cardHTML); the real gap was
// only a dedicated filter control, added as #ml-filter-published. =====

test('the published/private filter narrows to just published items', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS); // d1/d3 private, d2 published
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');

  await page.fill('#ml-gate-password', 'realownerpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-content', { state: 'visible', timeout: 5000 });

  await page.selectOption('#ml-filter-published', 'published');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#ml-grid .vcard').length === 1;
  }, { timeout: 5000 });
  var publishedOwner = await page.locator('#ml-grid .vcard-title').first().textContent();
  assert.equal(publishedOwner.trim(), '@bob');
  var badgeText = await page.locator('#ml-grid .priv').first().textContent();
  assert.equal(badgeText.trim(), 'Published');

  await page.close();
});

test('the published/private filter narrows to just private items', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS); // d1/d3 private, d2 published
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');

  await page.fill('#ml-gate-password', 'realownerpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-content', { state: 'visible', timeout: 5000 });

  await page.selectOption('#ml-filter-published', 'private');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#ml-grid .vcard').length === 2;
  }, { timeout: 5000 });
  var badges = await page.locator('#ml-grid .priv').allTextContents();
  badges.forEach(function (b) { assert.equal(b.trim(), 'Private'); });

  await page.close();
});

test('the published/private filter combines with the existing status/account filters', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, SAMPLE_ITEMS);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');

  await page.fill('#ml-gate-password', 'realownerpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-content', { state: 'visible', timeout: 5000 });

  // @alice's private items only (d1 re-hosted-durable, d3 lost-expired) —
  // narrowing to "private" + "@alice" should leave both; adding a status
  // filter for lost-expired should leave just d3.
  await page.selectOption('#ml-filter-published', 'private');
  await page.selectOption('#ml-filter-account', '@alice');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#ml-grid .vcard').length === 2;
  }, { timeout: 5000 });

  await page.selectOption('#ml-filter-status', 'lost-expired');
  await page.waitForFunction(function () {
    return document.querySelectorAll('#ml-grid .vcard').length === 1;
  }, { timeout: 5000 });

  await page.close();
});

// ===== Desktop scroll fix — founder reported getting stuck at the fold on
// a desktop viewport. Root cause (verified via css/styles.css): #app gets a
// fixed/definite height + overflow:hidden once the desktop phone-frame
// breakpoint (@media min-width:560px) kicks in, and body becomes a flex
// container that stretches #app to that same height — with no internal
// scroll region, any content past that height was simply clipped, with no
// scrollbar anywhere to reach it. Fixed by adopting the same
// scroll-shell + .scroll-area pattern tracker.html (another long-content
// owner-only page) already uses. Needs enough items to actually force
// overflow past one 800px-tall desktop viewport to observe real scroll
// behavior, not just assert on markup. =====

test('desktop viewport: page content past the fold is reachable by scrolling (not clipped)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await blockThirdParty(page);
  await mockDataEndpoint(page, buildManyItems(60)); // plenty to overflow one 800px-tall screen
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');

  await page.fill('#ml-gate-password', 'realownerpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-content', { state: 'visible', timeout: 5000 });

  var cardCount = await page.locator('#ml-grid .vcard').count();
  assert.equal(cardCount, 60, 'all 60 sample items render into the DOM');

  // The internal scroll region must actually have overflow to scroll — if
  // this is 0, the bug is back (content is clipped, nothing to scroll).
  var scrollArea = page.locator('.scroll-area');
  var overflowAmount = await scrollArea.evaluate(function (el) { return el.scrollHeight - el.clientHeight; });
  assert.ok(overflowAmount > 100, 'the scroll area has real overflow to scroll through (got ' + overflowAmount + 'px)');

  // The last card must be unreachable before scrolling...
  var lastCard = page.locator('#ml-grid .vcard').last();
  var visibleBefore = await lastCard.isVisible();
  var inViewportBefore = await lastCard.evaluate(function (el) {
    var r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  assert.ok(visibleBefore && !inViewportBefore, 'last card exists but starts below the fold, off-screen');

  // ...and reachable by scrolling the internal scroll area (not the
  // document, which the scroll-shell pattern deliberately does not use).
  await scrollArea.evaluate(function (el) { el.scrollTop = el.scrollHeight; });
  // page.waitForFunction's real signature is (pageFunction, arg, options) --
  // this predicate takes no arguments, so `null` fills that slot and the
  // timeout must go in the third position. A previous version of this test
  // passed { timeout: 5000 } as the second positional argument, which
  // Playwright silently accepted as `arg` (unused, since the predicate
  // takes no parameters) rather than as options, so the intended 5000ms
  // never actually applied and this always ran with Playwright's default
  // 30000ms instead. Fixed to actually pass an explicit timeout in the
  // right place.
  //
  // KNOWN CONTENTION-SENSITIVE TEST, not a product bug: this assertion is
  // already condition-based (waitForFunction, no fixed sleep) and passes
  // reliably every time run alone or alongside a handful of other files
  // (8/8 isolated re-runs across two separate investigations). It has twice
  // been the sole failure in a full `node --test test/*.test.js` run on
  // this sandbox (a 4-CPU box where ~85 of ~187 test files each launch a
  // real headless Chromium instance and node:test schedules files with
  // concurrency by default) -- once exceeding a 30000ms default, then once
  // exceeding an already-bumped 45000ms explicit budget. Both failures were
  // a genuine timeout on real layout/scroll settling, not a race in this
  // test's own waiting logic, and this test's own DOM work (rendering +
  // measuring 60 grid cards) is heavier than most of this file's other
  // assertions, making it more exposed than most when dozens of concurrent
  // Chromium processes are starving each other for CPU. Chasing an
  // ever-larger timeout doesn't fix this (it already failed against a
  // budget 9x the originally-intended one) and an unbounded timeout would
  // just make a real future hang here fail slowly instead of fast -- so
  // this is left as a known, occasional full-suite flake with this comment
  // as the explanation, per this session's own established pattern of
  // contention-only failures that don't reproduce in isolation. If this
  // starts failing in isolation too, that's a real regression -- treat it
  // as one.
  await page.waitForFunction(function () {
    var el = document.querySelector('#ml-grid .vcard:last-child');
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  }, null, { timeout: 45000 });

  await page.close();
});

// ===== Lightbox (tracker for-product-media-library-clicking-a-vid-bnlcus,
// founder repro 08-02): the grid rendered muted/preload=none video cards
// with a lazy-load observer, but NO click handler existed at all — tapping
// a card was a no-op by omission. Fixed with a shared #ml-lightbox-overlay
// opened via event delegation on #ml-grid; see media-library-x7q4.html's
// own inline comments for the close-handling design (esc via a direct
// listener, tap-outside reused from js/sheet-dismiss.js's SheetDismiss.wire
// for its same-spot re-tap guard). =====

async function unlockGrid(page, items) {
  await mockDataEndpoint(page, items);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/media-library-x7q4.html');
  await page.fill('#ml-gate-password', 'realownerpassword');
  await page.click('#ml-gate-submit');
  await page.waitForSelector('#ml-content', { state: 'visible', timeout: 5000 });
}

test('tapping a video card opens a lightbox with a real, unmuted, controls-enabled <video> using the item\'s real url', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await unlockGrid(page, SAMPLE_ITEMS); // d1 (@alice) is the first-rendered video, sorted newest-first

  await page.click('#ml-grid .vcard:first-child');
  await page.waitForSelector('#ml-lightbox-overlay.open', { timeout: 5000 });

  var video = page.locator('#ml-lightbox-content video');
  await assert.doesNotReject(video.waitFor({ state: 'attached', timeout: 5000 }));
  var props = await video.evaluate(function (el) {
    return { muted: el.muted, hasControls: el.controls, src: el.getAttribute('src') };
  });
  assert.equal(props.muted, false, 'lightbox video is unmuted, unlike the in-grid muted thumbnail');
  assert.equal(props.hasControls, true, 'lightbox video has native controls');
  assert.equal(props.src, '/.netlify/functions/video-file?key=d1', 'uses the real item url, not whatever the (possibly not-yet-lazy-loaded) in-grid <video>.src happened to be');

  await page.close();
});

test('tapping an image card opens a lightbox with a plain bigger <img> of the real url', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await unlockGrid(page, SAMPLE_ITEMS);

  // d3 (@alice image, lost-expired) is the oldest -> last card when sorted newest-first.
  await page.click('#ml-grid .vcard:last-child');
  await page.waitForSelector('#ml-lightbox-overlay.open', { timeout: 5000 });
  var img = page.locator('#ml-lightbox-content img');
  var src = await img.getAttribute('src');
  assert.equal(src, 'https://fal.media/y.png');

  await page.close();
});

test('the close button closes the lightbox and removes the media element (stops playback)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await unlockGrid(page, SAMPLE_ITEMS);

  await page.click('#ml-grid .vcard:first-child');
  await page.waitForSelector('#ml-lightbox-overlay.open', { timeout: 5000 });
  await page.click('#ml-lightbox-close');
  // state:'attached' (not the default 'visible') — a closed overlay is
  // `display:none`, so it can never satisfy a 'visible' wait; it's always
  // attached to the DOM though, just without/with the `open` class.
  await page.waitForSelector('#ml-lightbox-overlay:not(.open)', { state: 'attached', timeout: 5000 });
  var mediaCount = await page.locator('#ml-lightbox-content video, #ml-lightbox-content img').count();
  assert.equal(mediaCount, 0, 'the media element is removed on close, not just hidden');

  await page.close();
});

test('pressing Escape closes the lightbox', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await unlockGrid(page, SAMPLE_ITEMS);

  await page.click('#ml-grid .vcard:first-child');
  await page.waitForSelector('#ml-lightbox-overlay.open', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#ml-lightbox-overlay:not(.open)', { state: 'attached', timeout: 5000 });

  await page.close();
});

test('tapping the darkened backdrop outside the media closes the lightbox', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await unlockGrid(page, SAMPLE_ITEMS);

  await page.click('#ml-grid .vcard:first-child');
  await page.waitForSelector('#ml-lightbox-overlay.open', { timeout: 5000 });
  // Click a corner of the viewport, well clear of the centered media and
  // of the card's own original tap position (avoids the same-spot re-tap
  // guard in js/sheet-dismiss.js, which is about a real product bug, not
  // this test — this click is a genuinely different, deliberate spot).
  await page.mouse.click(4, 4);
  await page.waitForSelector('#ml-lightbox-overlay:not(.open)', { state: 'attached', timeout: 5000 });

  await page.close();
});

test('clicking inside the lightbox media itself does not close it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await unlockGrid(page, SAMPLE_ITEMS);

  await page.click('#ml-grid .vcard:last-child'); // image card — no native controls to intercept the click
  await page.waitForSelector('#ml-lightbox-overlay.open', { timeout: 5000 });
  // dispatchEvent rather than a real Playwright click — the img's `src`
  // (https://fal.media/...) is a fake fixture URL this test never mocks a
  // response for, so it never gets real intrinsic dimensions to satisfy
  // Playwright's own click-actionability (visibility) check. Dispatching
  // the click event directly still exercises the exact same app logic
  // (SheetDismiss's overlay listener checking e.target) without depending
  // on real image bytes loading.
  await page.locator('#ml-lightbox-content img').dispatchEvent('click');
  // Give any (incorrect) close handling a moment to fire before asserting it didn't.
  await page.waitForTimeout(150);
  var stillOpen = await page.locator('#ml-lightbox-overlay.open').count();
  assert.equal(stillOpen, 1, 'the lightbox stays open when the media itself is tapped');

  await page.close();
});
