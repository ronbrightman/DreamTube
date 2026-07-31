// test/barA-nav-rollout-behavioral.test.js
//
// Real browser coverage for the founder-urgent Bar A nav rollout —
// tracker items for-product-urgent-founder-roll-the-new--8pyek3 (roll
// the Profile night dock to home.html + explore.html) and
// for-product-hotfix-now-founder-urgent-re-w743iy (result.html stranding
// hotfix), built together since both need the exact same shared
// js/bottom-nav.js renderer. Supersedes
// for-product-bug-design-pass-find-bottom--g0m6ck.
//
// Founder's own words, verbatim: "The bottom nav bar is not the same
// across screens so make it like it is in the profile screen — in the
// homepage and in explore."
//
// This file specifically pins the cross-page properties the rollout is
// about — the same properties test/profile-night-restyle-behavioral.test.js
// already covers in depth for profile.html alone:
//   1. All four pages (home/explore/profile/result) render the SAME Bar A
//      `.night-dock` — the old `.bottom-nav` is gone everywhere, not just
//      restyled on one page.
//   2. Tab order is Home/Explore/+/Profile on every one of them.
//   3. The avatar-as-Profile-icon treatment (a real photo, or a fallback
//      initial) works from EVERY page, not just profile.html — it reads
//      the same DreamStore "Me" character everywhere.
//   4. result.html specifically no longer strands a first-time user —
//      real, functional Home/Explore/Profile links exist, and the dock
//      overlays the video without covering the Publish/Edit/Make
//      another/Delete row underneath it.
//
// Playwright resolution/skip convention matches every other browser test
// in this repo (see test/ui-behavioral.test.js's own header comment).

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

function mockTokenStatus(page, status) {
  var body = Object.assign({ balance: 240, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 }, status || {});
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

function mockFeed(page) {
  return page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
  });
}

/** Seeds a logged-in "tester" account, optional dreams + a self character, and optionally one dream to view on result.html. */
async function seedUser(page, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (opts) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = opts.selfCharacter ? [opts.selfCharacter] : [];
    state.dreams = opts.dreams || [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { dreams: opts.dreams || [], selfCharacter: opts.selfCharacter || null });
}

async function openPage(page, path, opts) {
  opts = opts || {};
  await blockThirdParty(page);
  await mockFeed(page);
  await mockTokenStatus(page, opts.tokenStatus);
  await seedUser(page, opts);
  await safeGoto(page, baseUrl + path);
}

var PAGES = [
  { path: '/home.html', active: 'home' },
  { path: '/explore.html', active: 'explore' },
  { path: '/profile.html', active: 'profile' },
  { path: '/result.html?id=dtest1', active: null }
];

function resultDream() {
  return {
    id: 'dtest1',
    ownerHandle: '@tester',
    caption: 'A test dream about flying over mountains',
    style: 'Cinematic',
    videoUrl: 'https://example.com/fake-video.mp4',
    isPublished: false,
    createdAt: new Date().toISOString()
  };
}

test('Bar A: all four pages render the exact same night dock, in the exact same tab order — the old .bottom-nav is gone everywhere', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    for (var i = 0; i < PAGES.length; i++) {
      var page = await context.newPage();
      var dreams = PAGES[i].path.indexOf('result.html') !== -1 ? [resultDream()] : [];
      await openPage(page, PAGES[i].path, { dreams: dreams });
      await page.waitForSelector('.night-dock', { timeout: 5000 });

      assert.equal(await page.locator('.bottom-nav').count(), 0, PAGES[i].path + ' must not render the old .bottom-nav');

      var hrefs = await page.locator('.night-dock a').evaluateAll(function (els) {
        return els.map(function (el) { return el.getAttribute('href'); });
      });
      assert.deepEqual(hrefs, ['home.html', 'explore.html', 'create.html', 'profile.html'], PAGES[i].path + ' tab order must be Home/Explore/+/Profile');

      // Genuinely overlaid (absolutely positioned), not sticky/in-flow —
      // the "over the video/content" treatment, identical everywhere.
      var position = await page.locator('.night-dock').evaluate(function (el) { return getComputedStyle(el).position; });
      assert.equal(position, 'absolute', PAGES[i].path + ' dock must be absolutely positioned like profile.html');

      var activeCount = await page.locator('.night-dock .night-dock-item.active').count();
      if (PAGES[i].active) {
        assert.equal(activeCount, 1, PAGES[i].path + ' must have exactly one active tab');
        var activeHref = await page.locator('.night-dock .night-dock-item.active').getAttribute('href');
        assert.equal(activeHref, PAGES[i].active + '.html');
      } else {
        assert.equal(activeCount, 0, PAGES[i].path + ' is not one of Home/Explore/Profile itself — no tab should read as active');
      }

      await page.close();
    }
  } finally {
    await context.close();
  }
});

test('Bar A: the avatar-as-Profile-icon treatment (a real photo) works from every page, not just profile.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var selfCharacter = {
      id: 'cself1', name: 'Ron', isSelf: true,
      photoDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    };
    for (var i = 0; i < PAGES.length; i++) {
      var page = await context.newPage();
      var dreams = PAGES[i].path.indexOf('result.html') !== -1 ? [resultDream()] : [];
      await openPage(page, PAGES[i].path, { dreams: dreams, selfCharacter: selfCharacter });
      await page.waitForSelector('.night-dock', { timeout: 5000 });
      await page.waitForSelector('#dock-avatar img', { timeout: 5000 });
      assert.equal(await page.locator('#dock-avatar img').count(), 1, PAGES[i].path + ' must render the Me character\'s real photo in the dock');
      await page.close();
    }
  } finally {
    await context.close();
  }
});

test('Bar A: with no self-photo set, the dock falls back to the display name\'s initial (never a placeholder glyph) — checked on explore.html, which can also render logged out', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await openPage(page, '/explore.html', { selfCharacter: { id: 'cself1', name: 'Dana', isSelf: true } });
    await page.waitForSelector('.night-dock', { timeout: 5000 });
    assert.equal((await page.locator('#dock-avatar').textContent()).trim(), 'D');
  } finally {
    await context.close();
  }
});

test('result.html: the stranding bug is fixed — a first-time user has real, functional links to Home/Explore/Profile, and the dock never covers the quiet-links row underneath it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await openPage(page, '/result.html?id=dtest1', { dreams: [resultDream()] });
    await page.waitForSelector('.night-dock', { timeout: 5000 });

    // Real navigation, not just markup — tapping Explore actually leaves
    // this screen. (Home/Profile go through the same anchor rendering, so
    // one real navigation is enough to prove the links are live, not just
    // present in the DOM.)
    await page.click('#nav-explore');
    await page.waitForURL('**/explore.html');

    // Re-open and check the geometry property that actually matters: the
    // dock must sit at or below the bottom of the Publish/Edit/Make
    // another/Delete row, never covering a real tap target.
    var page2 = await context.newPage();
    await openPage(page2, '/result.html?id=dtest1', { dreams: [resultDream()] });
    await page2.waitForSelector('.night-dock', { timeout: 5000 });
    await page2.waitForSelector('.result-quiet-links', { timeout: 5000 });
    var geom = await page2.evaluate(function () {
      var row = document.querySelector('.result-quiet-links').getBoundingClientRect();
      var dock = document.querySelector('.night-dock').getBoundingClientRect();
      return { rowBottom: row.bottom, dockTop: dock.top };
    });
    assert.ok(geom.rowBottom <= geom.dockTop + 1, 'the quiet-links row (Publish/Edit/Make another/Delete) must not be covered by the dock (row bottom ' + geom.rowBottom + ' vs dock top ' + geom.dockTop + ')');
    await page2.close();
  } finally {
    await context.close();
  }
});
