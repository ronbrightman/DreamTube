// test/notify-likes-badge-behavioral.test.js
//
// Real browser-driven coverage for tracker.html's idea-notify-likes (v1
// scope, Manager-approved 2026-07-28): aggregate-like-count-only in-app
// notification — no per-liker identity, no email. Two pieces:
//   1. A small dot badge on the bottom-nav Profile tab (#nav-profile-badge),
//      visible from every page with a bottom nav (home.html/explore.html/
//      profile.html — grepped the whole repo for "bottom-nav" to confirm
//      exactly these 3 copies exist, see this branch's own notes).
//   2. An inline "Your dream got N new likes" line on profile.html itself
//      (#new-likes-banner), shown only when there's something new, cleared
//      once profile.html has actually been viewed.
//
// The only network call in this whole feature is profile.html's own
// page-load fetch of get-feed.js (DreamStore.refreshNewLikesCount, see
// js/store.js) — home.html/explore.html just read the cached total
// DreamStore.getCachedNewLikesCount() left behind, no fetch of their own.
//
// Follows test/feed-windowing-behavioral.test.js's and
// test/faq-section-behavioral.test.js's conventions: node:test + real
// Chromium via Playwright, get-feed mocked via page.route (matching
// feed-windowing's synthetic-feed shape), state seeded directly into
// localStorage, every page.goto wrapped against this sandbox's known
// intermittent third-party-host network stalls.

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Answers admin-paywall-toggle's isOwner check with false, same as faq-section-behavioral.test.js, so tests never depend on OWNER_EMAIL config. */
function mockOwnerCheck(page) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, source: 'env-default', isOwner: false }) });
  });
}

/** Mocks get-token-status so the profile.html token chip doesn't hang on a real network call. */
function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 220, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20 }) });
  });
}

/** Intercepts get-feed.js with a synthetic feed, matching feed-windowing-behavioral.test.js's own real-response-shape convention. */
function mockFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: null }) });
  });
}

/**
 * Seeds a logged-in "tester" account owning one published dream
 * (id: 'dream-1', likes: baseLikes locally). Matches
 * faq-section-behavioral.test.js's own seed helper shape.
 */
async function seedUser(page, baseLikes) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (baseLikes) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com', createdAt: Date.now() - 3 * 86400000 };
    state.dreams = [{
      id: 'dream-1', ownerHandle: '@tester', caption: 'A test dream', style: 'Cinematic',
      dur: '0:08', isPublished: true, videoUrl: 'https://example.com/dream-1.mp4',
      likes: baseLikes, likedByMe: false
    }];
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, baseLikes);
}

function syntheticFeed(likes) {
  return [{
    id: 'dream-1', caption: 'A test dream', style: 'Cinematic',
    videoUrl: 'https://example.com/dream-1.mp4', ownerHandle: '@tester',
    likes: likes, likedByMe: false, dur: '0:08'
  }];
}

test('profile.html: a dream that gained likes since last profile view shows the new-likes line and the nav badge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    // Local record says 3 likes; the shared feed says 7 -- 4 new likes
    // gained by someone else since this account last checked.
    await seedUser(page, 3);
    await mockFeed(page, syntheticFeed(7));
    await safeGoto(page, baseUrl + '/profile.html');

    await page.waitForSelector('#new-likes-banner[style*="flex"]');
    var text = await page.locator('#new-likes-banner-text').textContent();
    assert.equal(text, 'Your dream got 4 new likes');

    var badgeHidden = await page.locator('#nav-profile-badge').evaluate(function (el) { return el.hidden; });
    assert.equal(badgeHidden, false, 'Profile nav badge should be visible when there are new likes');
  } finally {
    await page.close();
  }
});

test('profile.html: a dream with no change in likes shows nothing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    await seedUser(page, 5);
    await mockFeed(page, syntheticFeed(5));
    await safeGoto(page, baseUrl + '/profile.html');

    // Give refreshNewLikesCount's fetch a moment to resolve, then assert
    // the banner/badge never appear.
    await page.waitForTimeout(300);
    var bannerDisplay = await page.locator('#new-likes-banner').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(bannerDisplay, 'none');
    var badgeHidden = await page.locator('#nav-profile-badge').evaluate(function (el) { return el.hidden; });
    assert.equal(badgeHidden, true);
  } finally {
    await page.close();
  }
});

test('profile.html: viewing it clears the badge, so a second visit with no further like changes shows nothing new', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    await seedUser(page, 2);
    await mockFeed(page, syntheticFeed(9)); // 7 new likes on first visit
    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForSelector('#new-likes-banner[style*="flex"]');
    assert.equal(await page.locator('#new-likes-banner-text').textContent(), 'Your dream got 7 new likes');

    // Second visit -- feed unchanged (still 9 likes), local record also
    // still says the old stale value (2) since nothing in this browser
    // ever touched it, but the baseline persisted by the first visit
    // should make this resolve to 0 new likes regardless.
    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForTimeout(300);
    var bannerDisplay = await page.locator('#new-likes-banner').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(bannerDisplay, 'none', 'second visit with no further changes must show nothing new');
    var badgeHidden = await page.locator('#nav-profile-badge').evaluate(function (el) { return el.hidden; });
    assert.equal(badgeHidden, true);
  } finally {
    await page.close();
  }
});

test('explore.html: the nav-profile badge also appears there, driven by the cached total from a prior profile.html visit', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    await seedUser(page, 1);
    await mockFeed(page, syntheticFeed(4)); // 3 new likes
    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForSelector('#new-likes-banner[style*="flex"]');

    // Now navigate to explore.html (no fetch of its own) -- it should
    // read the same cached pending count and show the badge too.
    await safeGoto(page, baseUrl + '/explore.html');
    var badgeHidden = await page.locator('#nav-profile-badge').evaluate(function (el) { return el.hidden; });
    assert.equal(badgeHidden, false, 'explore.html should also show the nav-profile badge');
  } finally {
    await page.close();
  }
});

test('explore.html: shows no badge when nothing new is cached', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/explore.html');
    var badgeHidden = await page.locator('#nav-profile-badge').evaluate(function (el) { return el.hidden; });
    assert.equal(badgeHidden, true);
  } finally {
    await page.close();
  }
});
