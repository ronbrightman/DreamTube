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

/** Drives start.html's funnel tail (screens 9/11/13) up to the pricing screen (14), the same path any real signup takes after arriving from the marketing funnel with ?resume=1. */
async function goToPricingScreen(page, email) {
  await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fn-s9-skip', { timeout: 5000 });
  await page.click('#fn-s9-skip');
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
