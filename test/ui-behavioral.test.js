// test/ui-behavioral.test.js
//
// Real browser-driven coverage for the four "mechanical correctness"
// fixes in commit 8842015 (js/store.js's 8-char signup password minimum,
// profile.html's account-settings rename, explore.html's disabled-icon
// removal, start.html's real dreams-this-month stat) plus the follow-up
// fix to resetPasswordLocally() (js/store.js) that enforces the same
// minimum on the forgot-password path. This repo has no existing browser-
// test convention (see docs/TESTING.md / test/*.test.js -- everything
// else here is netlify/functions unit coverage via node:test against the
// handler directly), so this file follows the same node:test/assert
// convention as the rest of test/*.test.js, just driving a real Chromium
// via Playwright instead of calling a function handler directly -- the
// four things this file checks (error text rendered in the DOM, a login
// redirect actually happening, icons literally absent from rendered
// markup, a stat line's real presence/absence) aren't observable by
// calling js/store.js's functions in isolation.
//
// Also covers result.html's Save-button/OS-share-sheet fix and its new
// Explore/Profile topbar nav links (title-wrap fix included), plus the 5
// Advanced-screen/pricing fixes from commit ae7da62 (the lighter --surface
// chip color shared with create.html's Advanced accordion, screen 14's
// genuinely-selectable pricing cards, and screen 14's new paywall content).
//
// The Advanced-screen dark-mode contrast test from that same commit has
// since been REPLACED, not just updated: the founder reversed that round's
// direction entirely (Advanced should never have gone dark theme at all --
// the earlier fix corrected a real contrast bug, but by giving the dark
// special case its own background instead of removing it). Advanced (the
// former single screen 9) is now three separate light "dawn"-phase funnel
// screens -- characters, camera, scenery -- covered by the tests below this
// comment's own section header.
//
// Playwright itself is NOT a project dependency (package.json has none of
// @playwright/test's usual entries) -- it's resolved from this sandbox's
// global install (see CLAUDE.md's "No test framework is wired in..."
// section), the same way the build agent already verifies changes by
// hand. If Playwright or the pinned Chromium binary isn't resolvable in
// whatever environment `npm test` runs in, every test in this file skips
// itself with a clear reason instead of failing the whole suite.

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel) -- none are needed for what these tests check, and this sandbox's outbound network can intermittently stall on them (see CLAUDE.md). */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Intercepts DreamStore.getSharedFeed()'s underlying fetch so tests can force a resolved or failed shared feed without a real Netlify Functions runtime. */
function mockGetFeed(page, feed, opts) {
  opts = opts || {};
  return page.route('**/.netlify/functions/get-feed', function (route) {
    if (opts.fail) { route.abort('failed'); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: null }) });
  });
}

/** Seeds js/store.js's localStorage state with a logged-in user and one of their own dreams (with a fake videoUrl), then navigates to result.html for it -- the shortest path to a real, authenticated result.html render without driving the whole create/processing flow. */
async function seedResultPage(page, baseUrl, dreamId) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (id) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.dreams) state.dreams = [];
    state.dreams.push({
      id: id,
      ownerHandle: '@tester',
      caption: 'A test dream about flying over mountains',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: new Date().toISOString()
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, dreamId);
  await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
}

/** Drives start.html's funnel tail (Advanced screens/11/13) up to the pricing screen (14), the same path any real signup takes after arriving from the marketing funnel with ?resume=1. Skipping on the first Advanced screen (characters) jumps straight past camera/scenery too -- see the "Skip on any of the 3 screens" test below -- so one skip click is enough to reach the transition screen from here. */
async function goToPricingScreen(page, email) {
  await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
  await page.click('#fn-adv-chars-skip');
  await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  await page.click('#fn-s11-continue');
  await page.waitForSelector('#fn-email', { timeout: 5000 });
  await page.fill('#fn-email', email);
  // 20 chars -- comfortably past the 8-char minimum this same commit
  // enforces in DreamStore.signup(), so this helper doesn't itself trip
  // over the finding this file is also verifying.
  await page.fill('#fn-password', 'longenoughpassword1');
  await page.click('#fn-s13-continue');
  await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
}

test('signup with a 7-character password shows the new 8-char-minimum error text', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'shortpwuser');
    await page.fill('#login-email', 'shortpw@example.com');
    await page.fill('#login-password', '1234567'); // 7 chars -- one short of the minimum
    await page.click('#login-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('login-error');
      return !!(el && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    var errorText = await page.textContent('#login-error');
    assert.equal(errorText, 'Password must be at least 8 characters.');
    // Never actually signed up / navigated away.
    assert.match(page.url(), /login\.html/);
  } finally {
    await context.close();
  }
});

test('a pre-existing account with a sub-8-character password still logs in (no retroactive lockout)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // First load seeds js/store.js's localStorage state.
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      if (!state.accounts) state.accounts = {};
      // Simulates an account created before the 8-char minimum existed --
      // signup() itself would reject a password this short today, but
      // login() (and resetPasswordLocally's new check) must never
      // retroactively lock out an account that already has a short
      // password on file.
      state.accounts.legacyuser = { password: 'abc', email: 'legacy@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'legacyuser');
    await page.fill('#login-password', 'abc');
    await page.click('#login-submit');
    await page.waitForURL(/explore\.html/, { timeout: 5000 });
    assert.match(page.url(), /explore\.html/);
  } finally {
    await context.close();
  }
});

test('Explore cards render without the removed comment/repost icons and without a layout regression', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, [
      { id: 'd1', caption: 'Test dream one', style: 'Cartoon', dur: '8s', ownerHandle: '@tester', likes: 3, videoUrl: null, publishedAt: new Date().toISOString() }
    ]);
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });

    var actionCount = await page.$$eval('.feed-card .feed-actions .feed-action', function (els) { return els.length; });
    assert.equal(actionCount, 2, 'expected exactly like+share actions per card, no comment/repost');

    var actionsHTML = await page.$eval('.feed-card .feed-actions', function (el) { return el.innerHTML; });
    assert.ok(!/repost/i.test(actionsHTML), 'no leftover "repost" reference in the actions markup');
    // Distinctive path fragments unique to the removed comment/repost SVGs
    // (js/icons.js) -- guards against the icons somehow still being
    // embedded even under a different data-attribute/class name.
    assert.ok(actionsHTML.indexOf('M21 11.5a8.4') === -1, 'comment icon path should not be present');
    assert.ok(actionsHTML.indexOf('M17 2l4 4-4 4') === -1, 'repost icon path should not be present');

    var box = await page.$eval('.feed-card .feed-actions', function (el) {
      var r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    });
    var viewport = page.viewportSize();
    assert.ok(box.height > 0, 'feed-actions should have a real, non-collapsed height');
    assert.ok(box.top >= 0 && box.bottom <= viewport.height, 'feed-actions should sit fully inside the viewport, not overflow from a stale disabled-icon layout rule');
  } finally {
    await context.close();
  }
});

test('pricing screen shows a real dreams-this-month count when getSharedFeed() resolves', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var now = new Date();
    var lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await mockGetFeed(page, [
      { id: 'a', publishedAt: now.toISOString() },
      { id: 'b', publishedAt: now.toISOString() },
      { id: 'c', publishedAt: lastMonth.toISOString() } // outside the current UTC month -- must not be counted
    ]);
    await goToPricingScreen(page, 'buyer-resolved@example.com');
    await page.waitForSelector('.fn-proof-strip', { timeout: 5000 });
    var text = await page.textContent('.fn-proof-strip');
    assert.match(text, /2 dreams brought to life this month/);
  } finally {
    await context.close();
  }
});

test('pricing screen omits the stat line entirely (never a fake number) when getSharedFeed() fails', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, null, { fail: true });
    await goToPricingScreen(page, 'buyer-failed@example.com');
    var proofStripCount = await page.$$eval('.fn-proof-strip', function (els) { return els.length; });
    assert.equal(proofStripCount, 0);
  } finally {
    await context.close();
  }
});

test('result.html Save always triggers a real file download, never the OS share sheet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // acceptDownloads is required for Chromium to actually fire a 'download'
  // event for the blob: URL + <a download> flow saveVideo() uses, instead
  // of just navigating to it.
  var context = await browser.newContext({ acceptDownloads: true });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Spies on navigator.share/canShare from before any page script runs,
    // so a regression that re-adds the share-sheet branch would show up as
    // shareCalls > 0 even though canShare (if the browser exposes it at
    // all) would say true. Also forces canShare to true, the exact iOS
    // Safari condition the founder's original complaint depended on --
    // this test should fail if that branch were still reachable even under
    // the most share-sheet-favorable browser conditions.
    await page.addInitScript(function () {
      window.__shareCalls = 0;
      navigator.share = function () { window.__shareCalls++; return Promise.resolve(); };
      navigator.canShare = function () { return true; };
    });

    var dreamId = 'd-save-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#save-video-btn:not([disabled])', { timeout: 5000 });

    // Mocks the fal.ai CDN fetch saveVideo() makes -- no real network call,
    // no dependency on an external host being reachable from this sandbox.
    await page.route('https://example.com/fake-video.mp4', function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('fake mp4 bytes') });
    });

    var downloadPromise = page.waitForEvent('download', { timeout: 5000 });
    await page.click('#save-video-btn');
    var download = await downloadPromise;

    assert.equal(download.suggestedFilename(), 'dreamtube-' + dreamId + '.mp4');
    var shareCalls = await page.evaluate(function () { return window.__shareCalls; });
    assert.equal(shareCalls, 0, 'navigator.share must never be called by Save, even when canShare would say yes');

    // Confirms the toast reflects a plain save, and the button re-enables
    // afterward instead of getting stuck on "Saving...".
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && t.textContent === 'Video saved';
    }, null, { timeout: 5000 });
    var btnDisabled = await page.$eval('#save-video-btn', function (el) { return el.disabled; });
    assert.equal(btnDisabled, false);
  } finally {
    await context.close();
  }
});

test('result.html topbar has working Explore and Profile nav links that do not overlap the title or each other', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-nav-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#result-nav-explore', { timeout: 5000 });

    var exploreHref = await page.$eval('#result-nav-explore', function (el) { return el.getAttribute('href'); });
    var profileHref = await page.$eval('#result-nav-profile', function (el) { return el.getAttribute('href'); });
    assert.equal(exploreHref, 'explore.html');
    assert.equal(profileHref, 'profile.html');

    // Layout sanity: every topbar element must have a real box (not
    // collapsed/hidden), and none of them may overlap each other --
    // guards against the four-icon-button right-hand cluster crowding out
    // the title or wrapping onto the video underneath.
    var boxes = await page.$$eval('.topbar #result-back, .topbar #mute-btn, .topbar #share-btn, .topbar #result-nav-explore, .topbar #result-nav-profile', function (els) {
      return els.map(function (el) {
        var r = el.getBoundingClientRect();
        return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      });
    });
    assert.equal(boxes.length, 5, 'expected back + mute + share + explore + profile all present');
    boxes.forEach(function (b) {
      assert.ok(b.width > 0 && b.height > 0, b.id + ' should have a real, non-collapsed box');
    });
    for (var i = 0; i < boxes.length; i++) {
      for (var j = i + 1; j < boxes.length; j++) {
        var a = boxes[i], b = boxes[j];
        var overlapsHorizontally = a.left < b.right && b.left < a.right;
        var overlapsVertically = a.top < b.bottom && b.top < a.bottom;
        assert.ok(!(overlapsHorizontally && overlapsVertically), a.id + ' and ' + b.id + ' should not visually overlap');
      }
    }

    // Nav links must not collide with the result-panel (Edit/Save/Publish/
    // Delete etc.) sitting at the bottom of this immersive full-bleed page.
    var panelTop = await page.$eval('.result-panel', function (el) { return el.getBoundingClientRect().top; });
    var navBottom = Math.max.apply(null, boxes.map(function (b) { return b.bottom; }));
    assert.ok(navBottom < panelTop, 'topbar nav must sit entirely above the result-panel');

    // Clicking through actually navigates.
    await page.click('#result-nav-explore');
    await page.waitForURL(/explore\.html/, { timeout: 5000 });
    assert.match(page.url(), /explore\.html/);
  } finally {
    await context.close();
  }
});

test('result.html topbar title stays on one line and does not overlap the back button or icon cluster at 320px', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // 320px is the narrowest realistic phone viewport (e.g. iPhone SE 1st
  // gen / older Android) -- the tightest width the five-icon-button
  // topbar (back + mute + share + explore + profile) has to share with
  // the "Your Dream" title. The 375px test above doesn't include the
  // title element in its layout assertions at all, so it could not have
  // caught the title wrapping to two lines at this narrower width.
  var context = await browser.newContext({ viewport: { width: 320, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-nav-320-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#result-topbar-title', { timeout: 5000 });

    // Single-line check via Range.getClientRects(): the title <div> is a
    // block box, so its own bounding rect is always a single rect whether
    // or not the text inside it wraps -- that's why the 375px test's
    // per-element overlap check alone can't catch a wrap regression. A
    // Range over the text content yields one client rect per visual
    // *fragment* -- note this is fragments, not strictly lines: an
    // overflow:hidden + text-overflow:ellipsis element legitimately
    // produces more than one rect for genuinely single-line text (a rect
    // for the visible portion and one for the clipped remainder), so
    // rect *count* alone can't distinguish "single line, ellipsis-clipped"
    // from "wrapped to two lines" -- confirmed by hand against this exact
    // element. What does distinguish them is vertical position: a real
    // line-wrap puts fragments at different `top` offsets, while
    // same-line ellipsis fragments all share one `top`.
    var lineInfo = await page.$eval('#result-topbar-title', function (el) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var rects = Array.from(range.getClientRects());
      var tops = rects.map(function (r) { return Math.round(r.top); });
      var distinctLines = tops.filter(function (t, i) { return tops.indexOf(t) === i; }).length;
      return { distinctLines: distinctLines, text: el.textContent };
    });
    assert.equal(lineInfo.text, 'Your Dream', 'title text should render un-truncated at 320px since "Your Dream" is short enough to fit');
    assert.equal(lineInfo.distinctLines, 1, 'title text should render on a single visual line (one distinct top offset among its rects), not wrap to two lines');

    // Redundant height-based check for the same regression: a wrapped
    // two-line title would roughly double the box's height past one
    // line-height; this stays comfortably under that even allowing for
    // rounding/font-metric slop.
    var heightInfo = await page.$eval('#result-topbar-title', function (el) {
      var cs = getComputedStyle(el);
      var lineHeight = parseFloat(cs.lineHeight);
      if (isNaN(lineHeight)) lineHeight = parseFloat(cs.fontSize) * 1.2;
      return { height: el.getBoundingClientRect().height, lineHeight: lineHeight };
    });
    assert.ok(
      heightInfo.height <= heightInfo.lineHeight * 1.5,
      'title box height (' + heightInfo.height + 'px) should stay at single-line height (~' + heightInfo.lineHeight + 'px), not double from wrapping'
    );

    // Full overlap sweep including the title this time -- guards against
    // both the wrap itself and any future crowding that makes the title
    // physically collide with the back button or the icon-button cluster.
    var boxes = await page.$$eval(
      '.topbar #result-back, .topbar #result-topbar-title, .topbar #mute-btn, .topbar #share-btn, .topbar #result-nav-explore, .topbar #result-nav-profile',
      function (els) {
        return els.map(function (el) {
          var r = el.getBoundingClientRect();
          return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        });
      }
    );
    assert.equal(boxes.length, 6, 'expected back + title + mute + share + explore + profile all present');
    boxes.forEach(function (b) {
      assert.ok(b.width > 0 && b.height > 0, b.id + ' should have a real, non-collapsed box');
    });
    for (var i = 0; i < boxes.length; i++) {
      for (var j = i + 1; j < boxes.length; j++) {
        var a = boxes[i], b = boxes[j];
        var overlapsHorizontally = a.left < b.right && b.left < a.right;
        var overlapsVertically = a.top < b.bottom && b.top < a.bottom;
        assert.ok(!(overlapsHorizontally && overlapsVertically), a.id + ' and ' + b.id + ' should not visually overlap');
      }
    }
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Advanced screen (9) / pricing screen (14) fixes -- commit ae7da62.
// ===========================================================================

test('Advanced screens (characters/camera/scenery): all three render the light "dawn" phase -- light background, dark readable ink text -- never the removed dark-mode special case', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });

    async function assertLightDawnScreen() {
      var appClasses = await page.$eval('#app', function (el) { return el.className; });
      assert.match(appClasses, /\bfunnel-app\b/);
      assert.ok(!/\bfn-dark-mode\b/.test(appClasses), 'the removed dark-mode special case must never apply to an Advanced screen');

      // #FBEFEA (the dawn gradient's first stop, same value as the base
      // --dawn-1 token) as rgb -- confirms the real light gradient is
      // applied via applyPhase(), not just "isn't black".
      var bgImage = await page.$eval('#app', function (el) { return getComputedStyle(el).backgroundImage; });
      assert.match(bgImage, /251,\s*239,\s*234/, 'expected the dawn gradient (#FBEFEA) as the background');

      // #3A3350 / rgb(58, 51, 80) -- the light-phase --fn-ink color. Must
      // NOT be the real app's white --text-primary (the old fn-dark-mode
      // headline override), which combined with the light background here
      // would be a near-invisible white-on-white regression.
      var headlineColor = await page.$eval('.fn-headline', function (el) { return getComputedStyle(el).color; });
      assert.equal(headlineColor, 'rgb(58, 51, 80)', 'expected the dawn-phase --fn-ink color');
      assert.notEqual(headlineColor, 'rgb(255, 255, 255)', 'must not still be the removed dark-mode --text-primary override');
    }

    await assertLightDawnScreen();
    await page.click('#fn-adv-chars-continue');
    await page.waitForSelector('#fn-adv-camera-continue', { timeout: 5000 });
    await assertLightDawnScreen();
    await page.click('#fn-adv-camera-continue');
    await page.waitForSelector('#fn-adv-scenery-continue', { timeout: 5000 });
    await assertLightDawnScreen();
  } finally {
    await context.close();
  }
});

test('Advanced screens (characters/camera/scenery): 7-dot progress bar, and Continue advances one step at a time through all three screens into the transition screen', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });

    var dotCount = await page.$$eval('.fn-progress i', function (els) { return els.length; });
    assert.equal(dotCount, 7, 'expected 7 progress dots -- characters/camera/scenery + transition + email + pricing + confirmation');

    await page.click('#fn-adv-chars-continue');
    await page.waitForSelector('#fn-adv-camera-continue', { timeout: 5000 });
    await page.click('#fn-adv-camera-continue');
    await page.waitForSelector('#fn-adv-scenery-continue', { timeout: 5000 });
    await page.click('#fn-adv-scenery-continue');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('Advanced screens (characters/camera/scenery): Skip on any of the 3 screens jumps straight to the transition screen, not just past that one screen', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  // Skip from Characters (1 of 3) -- straight to the transition screen.
  var contextA = await browser.newContext();
  try {
    var pageA = await contextA.newPage();
    await blockThirdParty(pageA);
    await pageA.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
    await pageA.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await pageA.click('#fn-adv-chars-skip');
    await pageA.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  } finally {
    await contextA.close();
  }

  // Skip from Camera (2 of 3) -- straight to the transition screen, not to Scenery.
  var contextB = await browser.newContext();
  try {
    var pageB = await contextB.newPage();
    await blockThirdParty(pageB);
    await pageB.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });
    await pageB.click('#fn-adv-chars-continue');
    await pageB.waitForSelector('#fn-adv-camera-skip', { timeout: 5000 });
    await pageB.click('#fn-adv-camera-skip');
    await pageB.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  } finally {
    await contextB.close();
  }

  // Skip from Scenery (3 of 3) -- straight to the transition screen.
  var contextC = await browser.newContext();
  try {
    var pageC = await contextC.newPage();
    await blockThirdParty(pageC);
    await pageC.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
    await pageC.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });
    await pageC.click('#fn-adv-chars-continue');
    await pageC.waitForSelector('#fn-adv-camera-continue', { timeout: 5000 });
    await pageC.click('#fn-adv-camera-continue');
    await pageC.waitForSelector('#fn-adv-scenery-skip', { timeout: 5000 });
    await pageC.click('#fn-adv-scenery-skip');
    await pageC.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  } finally {
    await contextC.close();
  }
});

test('Advanced screens (characters/camera/scenery): the character add/select/edit, camera selection, and scenery selection interactions on each screen still write into DreamStore/staged state exactly as before', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });

    // --- Characters: add a character via the sheet, confirm it's rendered
    // selected by default, then toggle it off by clicking the chip itself
    // (not its nested edit area, which opens the sheet instead). ---
    await page.click('#char-add-other');
    await page.waitForSelector('#sheet-character-overlay.open', { timeout: 5000 });
    await page.fill('#char-name-input', 'Buddy');
    await page.fill('#char-desc-input', 'A friendly golden retriever');
    await page.click('#char-save-btn');
    await page.waitForSelector('.char-chip:has-text("Buddy")', { timeout: 5000 });
    var buddySelectedAfterAdd = await page.$eval('.char-chip:has-text("Buddy")', function (el) { return el.classList.contains('selected'); });
    assert.equal(buddySelectedAfterAdd, true, 'a newly added non-self character should be auto-selected');
    await page.click('.char-chip:has-text("Buddy") .chip-check');
    var buddySelectedAfterToggle = await page.$eval('.char-chip:has-text("Buddy")', function (el) { return el.classList.contains('selected'); });
    assert.equal(buddySelectedAfterToggle, false, 'clicking the chip (outside the edit area) should toggle its selection off');

    await page.click('#fn-adv-chars-continue');
    await page.waitForSelector('#fn-adv-camera-continue', { timeout: 5000 });

    // --- Camera view: single-select .fn-chip row on its own screen, writes
    // straight into DreamStore's draft. ---
    await page.click('#camera-chip-row [data-camera="Wide shot"]');
    var cameraSelected = await page.$eval('#camera-chip-row [data-camera="Wide shot"]', function (el) { return el.classList.contains('sel'); });
    assert.equal(cameraSelected, true);
    var cameraDraftValue = await page.evaluate(function () { return DreamStore.getDraft().cameraView; });
    assert.equal(cameraDraftValue, 'Wide shot');

    await page.click('#fn-adv-camera-continue');
    await page.waitForSelector('#fn-adv-scenery-continue', { timeout: 5000 });

    // --- Scenery: two independent single-select .fn-chip rows (time, place)
    // on its own screen. ---
    await page.click('#scenery-time-row [data-scenery-time="Night"]');
    await page.click('#scenery-place-row [data-scenery-place="Nature"]');
    var sceneryTimeSelected = await page.$eval('#scenery-time-row [data-scenery-time="Night"]', function (el) { return el.classList.contains('sel'); });
    var sceneryPlaceSelected = await page.$eval('#scenery-place-row [data-scenery-place="Nature"]', function (el) { return el.classList.contains('sel'); });
    assert.equal(sceneryTimeSelected, true);
    assert.equal(sceneryPlaceSelected, true);
    var draft = await page.evaluate(function () { return DreamStore.getDraft(); });
    assert.equal(draft.sceneryTime, 'Night');
    assert.equal(draft.sceneryPlace, 'Nature');
  } finally {
    await context.close();
  }
});

test('create.html: Advanced accordion chips render with the new lighter --surface color (not --surface-alt), and remain clickable/selectable', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Real signup via the UI (same flow as this file's first test), so
    // create.html's own "must be logged in" guard passes. State persists
    // via localStorage across the navigation below -- same context/origin.
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'chiptester');
    await page.fill('#login-email', 'chiptester@example.com');
    await page.fill('#login-password', 'longenoughpassword1');
    await page.click('#login-submit');
    await page.waitForURL(/explore\.html/, { timeout: 5000 });

    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });
    await page.click('#choice-write');
    await page.click('#adv-toggle');
    await page.waitForSelector('.adv-section.open', { timeout: 5000 });

    // .opt-chip (camera/scenery) is always present as static markup.
    var optChipBg = await page.$eval('#camera-chip-row .opt-chip', function (el) { return getComputedStyle(el).backgroundColor; });
    assert.equal(optChipBg, 'rgb(26, 26, 26)', 'expected --surface (#1a1a1a), not the old --surface-alt (#242424)');

    // .char-chip only exists once a character has been added. A newly
    // added non-self character is auto-selected (same as on the funnel),
    // and .selected has its own deliberate white-fill override (unrelated
    // to this fix -- see css/styles.css), so the unselected-state
    // background is checked here after toggling selection off.
    await page.click('#char-add-other');
    await page.waitForSelector('#sheet-character-overlay.open', { timeout: 5000 });
    await page.fill('#char-name-input', 'Rex');
    await page.fill('#char-desc-input', 'A big friendly dog');
    await page.click('#char-save-btn');
    await page.waitForSelector('.char-chip:has-text("Rex")', { timeout: 5000 });
    var selectedBeforeToggle = await page.$eval('.char-chip:has-text("Rex")', function (el) { return el.classList.contains('selected'); });
    assert.equal(selectedBeforeToggle, true, 'newly added character chip is auto-selected, same as on the funnel');

    // Still clickable/selectable after the color change -- exercises the
    // same shared click handlers create.html and start.html both use.
    await page.click('.char-chip:has-text("Rex") .chip-check');
    var selectedAfterToggle = await page.$eval('.char-chip:has-text("Rex")', function (el) { return el.classList.contains('selected'); });
    assert.equal(selectedAfterToggle, false);

    var charChipBg = await page.$eval('.char-chip:has-text("Rex")', function (el) { return getComputedStyle(el).backgroundColor; });
    assert.equal(charChipBg, 'rgb(26, 26, 26)', 'expected --surface (#1a1a1a), not the old --surface-alt (#242424)');

    await page.click('#camera-chip-row [data-camera="Close-up"]');
    var cameraSelected = await page.$eval('#camera-chip-row [data-camera="Close-up"]', function (el) { return el.classList.contains('selected'); });
    assert.equal(cameraSelected, true);
  } finally {
    await context.close();
  }
});

test('create.html: keyboard-mash gibberish in the Write textarea is blocked with an inline error, but real text (including non-Latin scripts) and the existing length gate are unaffected', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'gibberishtester');
    await page.fill('#login-email', 'gibberishtester@example.com');
    await page.fill('#login-password', 'longenoughpassword1');
    await page.click('#login-submit');
    await page.waitForURL(/explore\.html/, { timeout: 5000 });

    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });
    await page.click('#choice-write');
    await page.waitForSelector('#dream-text', { timeout: 5000 });

    // 1. The exact reported string -- pure keyboard mashing, well past the
    // 8-char minimum, mostly-Latin, essentially no vowels.
    await page.fill('#dream-text', 'qdqwdwqwdqqwdqwd');
    await page.waitForFunction(function () {
      var el = document.getElementById('dream-text-error');
      return !!(el && el.style.display !== 'none' && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    var gibberishDisabled = await page.$eval('#write-continue', function (el) { return el.disabled; });
    assert.equal(gibberishDisabled, true, 'Continue must stay disabled for gibberish input');
    var errorText = await page.textContent('#dream-text-error');
    assert.match(errorText, /doesn't look like a real dream description/i);

    // 2. A real English dream description -- should clear the error and
    // enable Continue.
    await page.fill('#dream-text', '');
    await page.fill('#dream-text', 'I was flying over a city made of glass');
    await page.waitForFunction(function () {
      var el = document.getElementById('write-continue');
      return el && !el.disabled;
    }, null, { timeout: 5000 });
    var realTextErrorVisible = await page.$eval('#dream-text-error', function (el) { return el.style.display !== 'none'; });
    assert.equal(realTextErrorVisible, false, 'no gibberish error for a normal real dream description');

    // 3. A short real Hebrew dream description ("I dreamed I was flying over
    // the city") -- non-Latin script, must NOT be flagged even though it has
    // zero Latin vowels, since the vowel heuristic only applies to
    // mostly-Latin text.
    await page.fill('#dream-text', '');
    await page.fill('#dream-text', 'חלמתי שאני עף מעל העיר');
    await page.waitForFunction(function () {
      var el = document.getElementById('char-count');
      return el && /character/.test(el.textContent);
    }, null, { timeout: 5000 });
    var hebrewDisabled = await page.$eval('#write-continue', function (el) { return el.disabled; });
    assert.equal(hebrewDisabled, false, 'Continue must enable for real non-Latin (Hebrew) dream text');
    var hebrewErrorVisible = await page.$eval('#dream-text-error', function (el) { return el.style.display !== 'none'; });
    assert.equal(hebrewErrorVisible, false, 'no gibberish error for real Hebrew dream text');

    // 4. The pre-existing length-only gate still works independently of the
    // new gibberish check -- short real text stays disabled with no
    // gibberish error shown (it never gets that far).
    await page.fill('#dream-text', '');
    await page.fill('#dream-text', 'short');
    await page.waitForFunction(function () {
      var el = document.getElementById('char-count');
      return el && el.textContent.indexOf('5 characters') !== -1;
    }, null, { timeout: 5000 });
    var shortDisabled = await page.$eval('#write-continue', function (el) { return el.disabled; });
    assert.equal(shortDisabled, true, 'Continue must stay disabled below the 8-char minimum');
    var shortErrorVisible = await page.$eval('#dream-text-error', function (el) { return el.style.display !== 'none'; });
    assert.equal(shortErrorVisible, false, 'length gate alone should not show the gibberish error text');

    // 5. Digit-only input, past the 8-char minimum -- zero letters at all,
    // so it must NOT be able to masquerade as "non-Latin script" and skip
    // the check. This is the confirmed blocking bug: digit-only text used
    // to divide out to "not primarily Latin" and sail through as real.
    await page.fill('#dream-text', '');
    await page.fill('#dream-text', '12345678');
    await page.waitForFunction(function () {
      var el = document.getElementById('dream-text-error');
      return !!(el && el.style.display !== 'none' && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    var digitsDisabled = await page.$eval('#write-continue', function (el) { return el.disabled; });
    assert.equal(digitsDisabled, true, 'Continue must stay disabled for digit-only input');
    var digitsErrorText = await page.textContent('#dream-text-error');
    assert.match(digitsErrorText, /doesn't look like a real dream description/i);

    // 6. Punctuation-only input, past the 8-char minimum -- same zero-letter
    // case as digits, must also be blocked rather than skipped.
    await page.fill('#dream-text', '');
    await page.fill('#dream-text', '........');
    await page.waitForFunction(function () {
      var el = document.getElementById('dream-text-error');
      return !!(el && el.style.display !== 'none' && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    var punctDisabled = await page.$eval('#write-continue', function (el) { return el.disabled; });
    assert.equal(punctDisabled, true, 'Continue must stay disabled for punctuation-only input');
    var punctErrorText = await page.textContent('#dream-text-error');
    assert.match(punctErrorText, /doesn't look like a real dream description/i);

    // 7. All-whitespace input that trims to "" -- passes the raw-length gate
    // (8 raw characters, so n < 8 does not fire) but must still be blocked
    // once trimmed, rather than slipping through as an empty "description".
    await page.fill('#dream-text', '');
    await page.fill('#dream-text', '        ');
    await page.waitForFunction(function () {
      var el = document.getElementById('dream-text-error');
      return !!(el && el.style.display !== 'none' && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    var whitespaceDisabled = await page.$eval('#write-continue', function (el) { return el.disabled; });
    assert.equal(whitespaceDisabled, true, 'Continue must stay disabled for all-whitespace input that trims to empty');
    var whitespaceErrorText = await page.textContent('#dream-text-error');
    assert.match(whitespaceErrorText, /doesn't look like a real dream description/i);
  } finally {
    await context.close();
  }
});

test('pricing screen (14, now the token intro): Continue advances to the confirmation screen and fires the renamed acknowledgment tracking event (no plan involved anymore)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await goToPricingScreen(page, 'token-intro@example.com');
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });

    // Spy on posthog.capture the same way start.html's own track() calls it
    // -- this funnel is a single in-page SPA (no real navigation between
    // screens 9-15), so a plain in-page monkeypatch survives for the rest
    // of this test without needing meta-capi-behavioral.test.js's
    // addInitScript/exposeBinding recorder (that one exists specifically to
    // survive a real page navigation, which doesn't happen here).
    await page.evaluate(function () {
      window.__phCalls = [];
      var orig = window.posthog.capture.bind(window.posthog);
      window.posthog.capture = function (name, props) {
        window.__phCalls.push({ name: name, props: props });
        return orig(name, props);
      };
    });

    await page.click('#fn-s14-continue');
    await page.waitForSelector('#fn-s15-continue', { timeout: 5000 });

    var phCalls = await page.evaluate(function () { return window.__phCalls; });
    var continuedCalls = phCalls.filter(function (c) { return c.name === 'funnel_token_intro_continued'; });
    var oldBypassedCalls = phCalls.filter(function (c) { return c.name === 'funnel_pricing_bypassed'; });
    var oldPlanSelectedCalls = phCalls.filter(function (c) { return c.name === 'funnel_plan_selected'; });
    assert.equal(continuedCalls.length, 1, 'expected exactly one funnel_token_intro_continued call, from Continue');
    assert.equal(continuedCalls[0].props.step, 14);
    assert.equal(oldBypassedCalls.length, 0, 'the old funnel_pricing_bypassed event name must not still fire');
    assert.equal(oldPlanSelectedCalls.length, 0, 'there is no plan to select anymore, so this old event must never fire');
  } finally {
    await context.close();
  }
});

test('pricing screen (14, now the token intro): renders the value bullets and the free-tokens copy, with no plan cards or payment/checkout language left behind', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await goToPricingScreen(page, 'paywall-content@example.com');
    await page.waitForSelector('.fn-value-card', { timeout: 5000 });

    var valueText = await page.textContent('.fn-value-card');
    assert.match(valueText, /Turn your dream descriptions into AI-generated videos/);
    assert.match(valueText, /Personalize with your own style and characters/);
    assert.match(valueText, /Save your dreams and publish them to Explore/);

    var bodyText = await page.textContent('#app');
    assert.match(bodyText, /200 free tokens/i, 'expected the honest free-tokens headline');
    assert.match(bodyText, /100 more every day/i);
    assert.match(bodyText, /no card needed/i);
    assert.match(bodyText, /token shop coming soon/i);
    assert.doesNotMatch(bodyText, /\$9\.99|\$5\.00|\/mo\b/, 'no subscription pricing should remain on this screen');

    var priceCardCount = await page.$$eval('.fn-price-card', function (els) { return els.length; });
    assert.equal(priceCardCount, 0, 'no plan cards should be rendered anymore');
  } finally {
    await context.close();
  }
});
