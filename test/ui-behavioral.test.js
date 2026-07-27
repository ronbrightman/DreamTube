// test/ui-behavioral.test.js
//
// Real browser-driven coverage for the four "mechanical correctness"
// fixes in commit 8842015 (js/store.js's signup password minimum,
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
// Also covers result.html's Save-button/OS-share-sheet fix, its topbar
// title-wrap fix, and the first-video-screen redesign (tracker.html's
// for-product-build-result-html-first-vide-mupiua) that later moved
// Explore/Profile out of the topbar and into a compact CTA pair in the
// panel, plus the 5 Advanced-screen/pricing fixes from commit ae7da62
// (the lighter --surface chip color shared with create.html's Advanced
// accordion, screen 14's
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

/** Pins start.html's screen-13 signup_email_first_variant A/B test (see that file's SIGNUP_VARIANT_KEY doc comment) to the control variant ('a' -- email + password shown together, unchanged), so a single fill-both-fields-then-click-once interaction (and any screen-13-copy assertion) stays deterministic instead of a 50/50 chance of landing on the email-first treatment variant, which hides #fn-password until a valid email is confirmed and shows different reassurance copy. Works on either a Page or a BrowserContext -- both expose addInitScript with the same signature. Must be called before any goto() on the same page/context. */
function pinSignupControlVariant(pageOrContext) {
  return pageOrContext.addInitScript(function () {
    localStorage.setItem('dreamtube_signup_variant', 'a');
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

/** Intercepts get-token-status.js's underlying fetch so tests can force a specific balance/countdown without a real Netlify Functions runtime -- used by the shop.html/style.html beta-messaging tests below. */
function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

/** Seeds js/store.js's localStorage state with a logged-in user (and account), then navigates to `path` -- the shortest way to reach an authenticated page (shop.html, style.html, ...) without driving signup for real. Mirrors seedResultPage's own seeding step below, minus the dream record that's specific to result.html. */
async function seedLoggedInUserAt(page, baseUrl, username, path) {
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

/**
 * screen 13's continue handler now also fires start-pending-generation.js
 * in parallel with signup (see start.html's startPendingGeneration()) --
 * without a route registered, that request 404s against the plain static
 * file server, which the app already treats as a safe failure, so this is
 * optional for correctness. Registered anyway for determinism/speed,
 * matching test/wizard-ui-behavioral.test.js's convention of explicit
 * routes over incidental 404 fallthrough. Fulfills as a failure (no
 * pendingId) -- tests using goToPricingScreen care about the screens
 * themselves, not the generate-during-signup mechanism (see the dedicated
 * "generate during signup" tests below for that coverage).
 */
function stubPendingGenerationAsUnavailable(page) {
  return page.route('**/.netlify/functions/start-pending-generation', function (route) {
    route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E7: insufficient_tokens' }) });
  });
}

/** Drives start.html's funnel tail (Advanced screens/11/13) up to the pricing screen (14), the same path any real signup takes after arriving from the marketing funnel with ?resume=1. Skipping on the first Advanced screen (characters) jumps straight past camera/scenery too -- see the "Skip on any of the 3 screens" test below -- so one skip click is enough to reach the transition screen from here. */
async function goToPricingScreen(page, email) {
  await pinSignupControlVariant(page);
  await stubPendingGenerationAsUnavailable(page);
  await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
  await page.click('#fn-adv-chars-skip');
  await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  await page.click('#fn-s11-continue');
  await page.waitForSelector('#fn-email', { timeout: 5000 });
  await page.fill('#fn-email', email);
  // 20 chars -- comfortably past the 3-char minimum DreamStore.signup()
  // enforces, so this helper doesn't itself trip over the finding this
  // file is also verifying.
  await page.fill('#fn-password', 'longenoughpassword1');
  await page.click('#fn-s13-continue');
  await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
}

test('signup with a 2-character password shows the new 3-char-minimum error text', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'shortpwuser');
    await page.fill('#login-email', 'shortpw@example.com');
    await page.fill('#login-password', '12'); // 2 chars -- one short of the minimum
    await page.click('#login-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('login-error');
      return !!(el && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    var errorText = await page.textContent('#login-error');
    assert.equal(errorText, 'Password must be at least 3 characters.');
    // Never actually signed up / navigated away.
    assert.match(page.url(), /login\.html/);
  } finally {
    await context.close();
  }
});

/**
 * Real incident (mobile founder test, 2026-07-24): a real account got
 * created with the literal username "__probe_throwaway_user__" -- the
 * signature shape a privacy-focused mobile browser/extension injects into
 * a field it detects via autocomplete="username" (both #login-username
 * here and wizard.html's #fn-username carry that attribute), before the
 * real user gets a chance to type their own choice. Confirms the new
 * client-side rejection (js/store.js's signup()) catches it before ever
 * reaching the server.
 */
test('signup with a __word__-shaped username (privacy-browser autofill-probe signature) is rejected client-side, not silently accepted', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', '__probe_throwaway_user__');
    await page.fill('#login-email', 'realuser@example.com');
    await page.fill('#login-password', 'longenoughpassword1');
    await page.click('#login-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('login-error');
      return !!(el && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    var errorText = await page.textContent('#login-error');
    assert.match(errorText, /doesn't look right/i);
    assert.match(page.url(), /login\.html/, 'never actually signed up / navigated away');
  } finally {
    await context.close();
  }
});

test('signup with an exactly-3-character password succeeds (friction-reduction: minimum lowered from 8 to 3)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'threecharpwuser');
    await page.fill('#login-email', 'threecharpw@example.com');
    await page.fill('#login-password', 'abc'); // exactly 3 chars -- previously would have failed at the old 8-char minimum
    await page.click('#login-submit');
    await page.waitForURL(/explore\.html/, { timeout: 5000 });
    assert.match(page.url(), /explore\.html/);
  } finally {
    await context.close();
  }
});

test('a pre-existing account with a sub-3-character password still logs in (no retroactive lockout)', async function (t) {
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
      // Simulates an account created before the 3-char minimum existed --
      // signup() itself would reject a password this short today, but
      // login() (and resetPasswordLocally's new check) must never
      // retroactively lock out an account that already has a short
      // password on file.
      state.accounts.legacyuser = { password: 'ab', email: 'legacy@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'legacyuser');
    await page.fill('#login-password', 'ab');
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

test('email capture screen (13) has no leftover subscription pricing copy', async function (t) {
  // Regression test for a bug review caught: the previous version of this
  // file only checked screen 14's rendered #app text for stale "$9.99 /
  // $5.00 / /mo" language. Screen 13 renders and is replaced by screen 14
  // before that later assertion runs (this is a single-page funnel that
  // reuses one #app container across screens), so a leftover subscription
  // line on screen 13 itself was never actually inspected and slipped
  // through. This test stops at screen 13 -- right after it renders, before
  // continuing past it -- specifically to catch that class of bug.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var bodyText = await page.textContent('#app');
    assert.doesNotMatch(bodyText, /\$9\.99|\$5\.00|\/mo\b|plans from/i, 'no subscription pricing should remain on the email capture screen');
    // Mobile-test fix (2026-07-24): the old mixed "200 tokens on signup" +
    // "we'll email your dream" copy is down to ONE message now -- the
    // token-count line is gone entirely from this screen (screen 14 still
    // mentions being free, just not in token-count terms here).
    assert.doesNotMatch(bodyText, /200 tokens/i, 'the token-count line must no longer appear on the email capture screen -- only one message belongs here now');
    assert.match(bodyText, /free to start/i, 'expected the screen to still mention it\'s free, just as part of the single remaining message');
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

test('result.html redesign: topbar keeps only back + share (plus title/mute/token-chip) -- the old Explore/Profile nav icons are gone from the topbar, replaced by the compact CTA pair in the panel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-nav-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#result-back', { timeout: 5000 });

    // The old #result-nav-explore/#result-nav-profile topbar links no
    // longer exist at all -- tracker.html's
    // for-product-build-result-html-first-vide-mupiua spec item 2.
    assert.equal(await page.locator('#result-nav-explore').count(), 0, 'the old topbar Explore nav icon must be gone');
    assert.equal(await page.locator('#result-nav-profile').count(), 0, 'the old topbar Profile nav icon must be gone');
    assert.equal(await page.locator('.topbar #result-nav-explore, .topbar #result-nav-profile').count(), 0);

    // Layout sanity: every remaining topbar element must have a real box
    // (not collapsed/hidden), and none of them may overlap each other.
    var boxes = await page.$$eval('.topbar #result-back, .topbar #mute-btn, .topbar #share-btn', function (els) {
      return els.map(function (el) {
        var r = el.getBoundingClientRect();
        return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      });
    });
    assert.equal(boxes.length, 3, 'expected back + mute + share, and nothing else, in the topbar icon cluster');
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
  } finally {
    await context.close();
  }
});

test('result.html redesign: the compact CTA pair (Explore dreams / My profile) in the panel has working links, sits above the quiet small-link row, and is visually small (a real shrink from the old full-size buttons)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-cta-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#result-cta-explore', { timeout: 5000 });

    var exploreHref = await page.$eval('#result-cta-explore', function (el) { return el.getAttribute('href'); });
    var profileHref = await page.$eval('#result-cta-profile', function (el) { return el.getAttribute('href'); });
    assert.equal(exploreHref, 'explore.html');
    assert.equal(profileHref, 'profile.html');

    // Deliberately small: the founder explicitly asked for the whole CTA
    // area to be shrunk -- a real regression check, not just presence.
    // The app's normal full-size .btn is ~15px vertical padding / ~14.5px
    // font (see css/styles.css's .btn rule); these must read meaningfully
    // smaller than that.
    var ctaBox = await page.$eval('#result-cta-explore', function (el) {
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return { height: r.height, fontSize: parseFloat(cs.fontSize) };
    });
    assert.ok(ctaBox.height < 40, 'the compact CTA pair should be visibly smaller than the app\'s normal full-size buttons (got height ' + ctaBox.height + 'px)');
    assert.ok(ctaBox.fontSize <= 13, 'the compact CTA pair\'s label should use a small font (got ' + ctaBox.fontSize + 'px)');

    // The CTA pair must sit above the quiet small-link row (Edit/Publish/
    // Make another/...), matching the approved mock's vertical order.
    var ctaRowBottom = await page.$eval('.result-cta-row', function (el) { return el.getBoundingClientRect().bottom; });
    var quietLinksTop = await page.$eval('.result-quiet-links', function (el) { return el.getBoundingClientRect().top; });
    assert.ok(ctaRowBottom <= quietLinksTop + 1, 'the CTA pair should sit above (or flush with) the quiet small-link row, not below it');

    // Clicking through actually navigates.
    await page.click('#result-cta-explore');
    await page.waitForURL(/explore\.html/, { timeout: 5000 });
    assert.match(page.url(), /explore\.html/);
  } finally {
    await context.close();
  }
});

test('result.html redesign: the dream-interpretation pill renders ABOVE the compact CTA pair, and still opens the same reflection sheet on tap', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-interp-pill-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#interp-cta-btn', { timeout: 5000 });

    var interpBottom = await page.$eval('#interp-cta-btn', function (el) { return el.getBoundingClientRect().bottom; });
    var ctaRowTop = await page.$eval('.result-cta-row', function (el) { return el.getBoundingClientRect().top; });
    assert.ok(interpBottom <= ctaRowTop + 1, 'the interpretation pill must render above the CTA pair (absorbs the interpretation-above-make-another cheap win)');

    // Behavior unchanged: tapping still opens the reflection bottom sheet.
    await page.route('**/.netlify/functions/*', function (route) { route.abort(); });
    await page.click('#interp-cta-btn');
    await page.waitForSelector('#sheet-interp-overlay.open', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('result.html redesign: the prompt/caption clamps to 2 lines by default and expands/collapses on click', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    var dreamId = 'd-clamp-test';
    var longCaption = 'I was flying over a city made entirely of glass, and every single window showed a different memory from my childhood, and no matter how hard I tried to land the streets kept turning into rivers and the rivers kept turning into staircases that led nowhere at all.';
    await page.evaluate(function (args) {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      if (!state.dreams) state.dreams = [];
      state.dreams.push({
        id: args.id,
        ownerHandle: '@tester',
        caption: args.caption,
        style: 'Cinematic',
        videoUrl: 'https://example.com/fake-video.mp4',
        isPublished: false,
        createdAt: new Date().toISOString()
      });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    }, { id: dreamId, caption: longCaption });
    await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#result-quote', { timeout: 5000 });

    // Font must actually be small, per spec.
    var fontSize = await page.$eval('#result-quote', function (el) { return parseFloat(getComputedStyle(el).fontSize); });
    assert.ok(fontSize <= 14, 'the caption should render in a small font (got ' + fontSize + 'px)');

    // Clamped to 2 lines by default -- with text this long, the full
    // (unclamped) height must be noticeably taller than the clamped box.
    var clampedHeight = await page.$eval('#result-quote', function (el) { return el.getBoundingClientRect().height; });
    var isClamped = await page.$eval('#result-quote', function (el) { return el.classList.contains('clamped'); });
    assert.ok(isClamped, 'the caption should start clamped');
    await page.waitForSelector('#result-quote-hint', { state: 'visible', timeout: 5000 });
    assert.match(await page.textContent('#result-quote-hint'), /Show more/);

    // Click to expand -- clamp class comes off, hint flips to "Show less",
    // and the box grows to fit the full text.
    await page.click('#result-quote');
    var expandedIsClamped = await page.$eval('#result-quote', function (el) { return el.classList.contains('clamped'); });
    assert.equal(expandedIsClamped, false, 'clicking the caption should remove the clamp');
    assert.match(await page.textContent('#result-quote-hint'), /Show less/);
    var expandedHeight = await page.$eval('#result-quote', function (el) { return el.getBoundingClientRect().height; });
    assert.ok(expandedHeight > clampedHeight, 'expanding should grow the box past its clamped height');

    // Click again to collapse back.
    await page.click('#result-quote');
    var recollapsedIsClamped = await page.$eval('#result-quote', function (el) { return el.classList.contains('clamped'); });
    assert.ok(recollapsedIsClamped, 'clicking again should re-clamp the caption');
    assert.match(await page.textContent('#result-quote-hint'), /Show more/);
  } finally {
    await context.close();
  }
});

test('result.html redesign: the bottom panel is a translucent gradient, not a solid black slab -- the video stays visible behind it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-scrim-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('.result-scrim', { timeout: 5000 });

    var bg = await page.$eval('.result-scrim', function (el) { return getComputedStyle(el).backgroundImage; });
    // Must be a gradient (not a flat solid fill), and its darkest stop must
    // not exceed the spec's ~0.72 ceiling (the old design peaked at 0.95).
    assert.match(bg, /gradient/, 'the scrim should be a gradient, not a flat fill');
    var alphaMatches = bg.match(/rgba?\([^)]*\)/g) || [];
    var maxAlpha = 0;
    alphaMatches.forEach(function (rgba) {
      var parts = rgba.replace(/rgba?\(|\)/g, '').split(',').map(function (s) { return parseFloat(s); });
      var alpha = parts.length === 4 ? parts[3] : 1;
      if (alpha > maxAlpha) maxAlpha = alpha;
    });
    assert.ok(maxAlpha <= 0.75, 'the scrim\'s darkest stop should not exceed ~0.72 (got ' + maxAlpha + '), no solid black slab');
    assert.ok(maxAlpha > 0, 'the scrim should still darken toward the bottom for text legibility');
  } finally {
    await context.close();
  }
});

test('result.html redesign: Edit / Publish / Make another / Save / Delete all still trigger their existing behaviors from the new quiet small-link row', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-quiet-links-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });

    // All five must be present in the quiet-link row and visible.
    var ids = ['open-edit-sheet', 'publish-btn', 'make-another-btn', 'save-video-btn', 'delete-btn'];
    for (var i = 0; i < ids.length; i++) {
      var visible = await page.locator('.result-quiet-links #' + ids[i]).isVisible();
      assert.ok(visible, '#' + ids[i] + ' should be visible inside .result-quiet-links');
    }

    // Edit still opens the edit sheet.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-overlay.open', { timeout: 5000 });
    await page.click('#edit-cancel');
    await page.waitForFunction(function () {
      var el = document.getElementById('sheet-edit-overlay');
      return el && !el.classList.contains('open');
    }, null, { timeout: 5000 });

    // Publish still opens the publish confirmation modal (unchanged
    // publish/unpublish behavior).
    await page.click('#publish-btn');
    await page.waitForSelector('#modal-publish.open', { timeout: 5000 });
    await page.click('#publish-confirm');
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && t.textContent === 'Published to Explore';
    }, null, { timeout: 5000 });

    // Delete still opens the delete confirmation modal.
    await page.click('#delete-btn');
    await page.waitForSelector('#modal-delete.open', { timeout: 5000 });
    await page.click('#delete-cancel');
    await page.waitForFunction(function () {
      var el = document.getElementById('modal-delete');
      return el && !el.classList.contains('open');
    }, null, { timeout: 5000 });

    // Make another still clears the draft and navigates to create.html.
    await page.click('#make-another-btn');
    await page.waitForURL(/create\.html/, { timeout: 5000 });
    assert.match(page.url(), /create\.html/);
  } finally {
    await context.close();
  }
});

test('result.html redesign: the top Share icon still keeps its publishes-if-private behavior, now rendered as the standard iOS-style share icon', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-share-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#share-btn svg', { timeout: 5000 });

    // Unpublished dream: Share must route through the publish modal first
    // (unchanged existing behavior), not a plain visual re-skin only.
    await page.click('#share-btn');
    await page.waitForSelector('#modal-publish.open', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('result.html topbar title stays on one line and does not overlap the back button or icon cluster at 320px', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // 320px is the narrowest realistic phone viewport (e.g. iPhone SE 1st
  // gen / older Android) -- the tightest width the three-icon-button
  // topbar (back + mute + share) has to share with the "Your Dream" title
  // (Explore/Profile moved out of the topbar entirely -- see the redesign
  // test above). The 375px test above doesn't include the title element in
  // its layout assertions at all, so it could not have caught the title
  // wrapping to two lines at this narrower width.
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
      '.topbar #result-back, .topbar #result-topbar-title, .topbar #mute-btn, .topbar #share-btn',
      function (els) {
        return els.map(function (el) {
          var r = el.getBoundingClientRect();
          return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        });
      }
    );
    assert.equal(boxes.length, 4, 'expected back + title + mute + share, and nothing else');
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

test('Advanced screen (characters): renders the light "dawn" phase -- light background, dark readable ink text -- never the removed dark-mode special case (camera/scenery screens are parked as of the 2026-07-24 founder decision, see tracker item for-product-two-post-handoff-app-pages-p-atr0r7, so only the characters screen remains in this family)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });

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
  } finally {
    await context.close();
  }
});

test('Advanced screen (characters) + transition: 5-dot progress bar, and Continue on the characters screen advances straight into the transition screen -- camera/scenery are parked (2026-07-24 founder decision) and no longer sit in between', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });

    var dotCount = await page.$$eval('.fn-progress i', function (els) { return els.length; });
    assert.equal(dotCount, 5, 'expected 5 progress dots -- characters + transition + email + pricing + confirmation (camera/scenery parked)');

    await page.click('#fn-adv-chars-continue');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    var cameraScreenRendered = await page.$('#fn-adv-camera-continue');
    var sceneryScreenRendered = await page.$('#fn-adv-scenery-continue');
    assert.equal(cameraScreenRendered, null, 'the parked camera screen must never render in between');
    assert.equal(sceneryScreenRendered, null, 'the parked scenery screen must never render in between');
  } finally {
    await context.close();
  }
});

test('Advanced screen (characters): Skip jumps straight to the transition screen (regression check for the dynamic PREPARING_STEP lookup now that camera/scenery are parked and removed from SCREEN_RENDERERS)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('Advanced screen (characters): the character add/select/edit interactions still write into staged state exactly as before (camera/scenery interactions are no longer reachable through the live flow -- see the parked-screens tests below)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
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
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Camera/scenery screens PARKED (founder decision 2026-07-24, tracker item
// for-product-two-post-handoff-app-pages-p-atr0r7): every real visitor
// reaching start.html's funnel tail arrives via ?resume=1 (a bare visit
// redirects to the marketing funnel before ever reaching these screens --
// see start.html's Entry guard), and the marketing funnel already folds
// camera/scenery info into the assembled caption text, so these two
// screens were pure redundant clicks. They're intentionally left in the
// file (parked, not deleted) for a later pass that folds them into the
// wizard, but must never appear in the live funnel tail.
// ===========================================================================

test('parked camera/scenery screens: the funnel tail never renders "Pick a camera view" or "Set the scene" for a caption WITH people-indicating language -- goes characters -> transition -> email directly', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });
    assert.equal(await page.$('#fn-adv-camera-continue'), null);
    assert.equal(await page.$('#fn-adv-scenery-continue'), null);

    await page.click('#fn-adv-chars-continue');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    assert.equal(await page.$('#fn-adv-camera-continue'), null);
    assert.equal(await page.$('#fn-adv-scenery-continue'), null);

    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    assert.equal(await page.$('#fn-adv-camera-continue'), null);
    assert.equal(await page.$('#fn-adv-scenery-continue'), null);

    // cameraView/sceneryTime/sceneryPlace are never set for a funnel-resumed
    // visitor now (their collection screens are parked) -- confirms the
    // draft is left at its default null shape rather than something
    // downstream (start-pending-generation.js's POST body) would choke on.
    var draft = await page.evaluate(function () { return DreamStore.getDraft(); });
    assert.equal(draft.cameraView, null);
    assert.equal(draft.sceneryTime, null);
    assert.equal(draft.sceneryPlace, null);
  } finally {
    await context.close();
  }
});

test('parked camera/scenery screens: the funnel tail never renders "Pick a camera view" or "Set the scene" for a caption with NO people-indicating language -- goes straight from load to the transition screen', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A sunset fading over calm ocean waves'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    assert.equal(await page.$('#fn-adv-chars-continue'), null, 'no people-indicating language -- characters screen must not render');
    assert.equal(await page.$('#fn-adv-camera-continue'), null, 'camera screen is parked -- must never render');
    assert.equal(await page.$('#fn-adv-scenery-continue'), null, 'scenery screen is parked -- must never render');

    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    assert.equal(await page.$('#fn-adv-camera-continue'), null);
    assert.equal(await page.$('#fn-adv-scenery-continue'), null);
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Founder mobile-test fix (2026-07-24), item (4): the "Add the people in
// your dream" characters screen. (a) only shows when the caption plausibly
// involves people; (c) the "Me" chip bug (saved but not auto-selected);
// (d) the pencil edit tap target.
// ===========================================================================

test('character screen (fix 1a): a caption with no people-indicating language skips the "Add the people in your dream" screen entirely, landing straight on the transition screen with 4 (not 5) progress dots (camera/scenery are parked as of the 2026-07-24 founder decision, so there is no longer a camera screen to land on)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A sunset fading over calm ocean waves'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    var charScreenEverRendered = await page.$('#fn-adv-chars-continue');
    assert.equal(charScreenEverRendered, null, 'the characters screen must not have rendered when the caption has no people-indicating language');
    var dotCount = await page.$$eval('.fn-progress i', function (els) { return els.length; });
    assert.equal(dotCount, 4, 'expected 4 progress dots -- transition + email + pricing + confirmation, characters/camera/scenery all skipped');
  } finally {
    await context.close();
  }
});

test('character screen (fix 1a): a caption WITH people-indicating language still shows the characters screen with all 5 progress dots, and Skip from it still lands on the correct transition screen when the characters screen was NOT skipped (regression test for the dynamic PREPARING_STEP lookup, now that camera/scenery are permanently absent from SCREEN_RENDERERS)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var contextA = await browser.newContext();
  try {
    var pageA = await contextA.newPage();
    await blockThirdParty(pageA);
    await pageA.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('We are walking through a quiet forest at dusk'), { waitUntil: 'domcontentloaded' });
    await pageA.waitForSelector('#fn-adv-chars-continue', { timeout: 5000 });
    var dotCount = await pageA.$$eval('.fn-progress i', function (els) { return els.length; });
    assert.equal(dotCount, 5, 'expected all 5 progress dots when the characters screen is shown ("we" is people-indicating)');

    // PREPARING_STEP must resolve to index 1 here (characters screen is
    // index 0) -- Skip must land on the transition screen, not accidentally
    // skip past it to email capture. This is exactly the bug a hardcoded
    // goToStep(N) would reintroduce once the characters screen's presence
    // shifts every later index by one.
    await pageA.click('#fn-adv-chars-skip');
    await pageA.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    var onEmailScreenAlready = await pageA.$('#fn-email');
    assert.equal(onEmailScreenAlready, null, 'must land on the transition screen, not skip straight past it to email capture');
  } finally {
    await contextA.close();
  }

  // When the characters screen IS skipped (no people-indicating language),
  // PREPARING_STEP must resolve to index 0 -- the transition screen is now
  // the very first screen rendered, with no Advanced screen before it at
  // all (camera/scenery are parked, so nothing sits between "page load" and
  // the transition screen for this caption shape).
  var contextB = await browser.newContext();
  try {
    var pageB = await contextB.newPage();
    await blockThirdParty(pageB);
    await pageB.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A sunset fading over calm ocean waves'), { waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    var onEmailScreenAlready = await pageB.$('#fn-email');
    assert.equal(onEmailScreenAlready, null, 'must land on the transition screen, not skip straight past it to email capture');
  } finally {
    await contextB.close();
  }
});

test('character screen (fix 1c): saving "Me" for the first time auto-selects its chip immediately, even when the caption has no literal "I"/"me" word (the original bug)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // "We" triggers the people heuristic (so this screen renders) but does
    // NOT literally contain "I" or "me" -- exactly the caption shape that
    // exposed the original bug (the old code only auto-selected "Me" when
    // the caption literally contained the word "I" or "me").
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('We are walking through a quiet forest at dusk'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#char-add-self', { timeout: 5000 });
    await page.click('#char-add-self');
    await page.waitForSelector('#sheet-character-overlay.open', { timeout: 5000 });
    await page.fill('#char-desc-input', 'A tall woman with curly brown hair');
    await page.click('#char-save-btn');
    await page.waitForSelector('.char-chip:has-text("Me")', { timeout: 5000 });
    var meSelected = await page.$eval('.char-chip:has-text("Me")', function (el) { return el.classList.contains('selected'); });
    assert.equal(meSelected, true, 'the Me chip must be selected right after its first save, regardless of caption wording');
  } finally {
    await context.close();
  }
});

test('character screen (fix 1c): re-saving an existing character after deliberately deselecting it does NOT silently re-select it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('We are walking through a quiet forest at dusk'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#char-add-other', { timeout: 5000 });
    await page.click('#char-add-other');
    await page.waitForSelector('#sheet-character-overlay.open', { timeout: 5000 });
    await page.fill('#char-name-input', 'Buddy');
    await page.fill('#char-desc-input', 'A friendly golden retriever');
    await page.click('#char-save-btn');
    await page.waitForSelector('.char-chip:has-text("Buddy")', { timeout: 5000 });
    var selectedAfterAdd = await page.$eval('.char-chip:has-text("Buddy")', function (el) { return el.classList.contains('selected'); });
    assert.equal(selectedAfterAdd, true, 'sanity check: a brand-new character is auto-selected on its first save');

    // Deliberately deselect it by tapping the chip itself (not the edit area).
    await page.click('.char-chip:has-text("Buddy") .chip-check');
    var deselected = await page.$eval('.char-chip:has-text("Buddy")', function (el) { return el.classList.contains('selected'); });
    assert.equal(deselected, false);

    // Reopen it to edit (via the chip-edit-area, which opens the sheet) and
    // save again with no real change.
    await page.click('.char-chip:has-text("Buddy") .chip-edit-area');
    await page.waitForSelector('#sheet-character-overlay.open', { timeout: 5000 });
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)', { timeout: 5000 });

    var selectedAfterReSave = await page.$eval('.char-chip:has-text("Buddy")', function (el) { return el.classList.contains('selected'); });
    assert.equal(selectedAfterReSave, false, 'editing and re-saving an already-deselected character must not silently re-select it');
  } finally {
    await context.close();
  }
});

test('character chip edit tap target (fix 1d): .chip-edit-area\'s padding is comfortably close to the ~44px mobile tap-target guideline, not the old ~32px version', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('We are walking through a quiet forest at dusk'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#char-add-other', { timeout: 5000 });
    await page.click('#char-add-other');
    await page.waitForSelector('#sheet-character-overlay.open', { timeout: 5000 });
    await page.fill('#char-name-input', 'Buddy');
    await page.fill('#char-desc-input', 'A friendly golden retriever');
    await page.click('#char-save-btn');
    await page.waitForSelector('.char-chip:has-text("Buddy")', { timeout: 5000 });

    var box = await page.$eval('.char-chip:has-text("Buddy") .chip-edit-area', function (el) {
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return { height: r.height, paddingTop: parseFloat(cs.paddingTop), paddingBottom: parseFloat(cs.paddingBottom) };
    });
    // The element's own rendered box already includes its padding (the
    // matching negative margin only affects position/overlap with
    // neighbors, not the box's own size) -- confirms the padding bump from
    // 8px to 14px top/bottom actually landed, not just that some padding
    // exists at all.
    assert.ok(box.paddingTop >= 13, 'expected the bumped top padding (was 8px, now 14px) on .chip-edit-area, got ' + box.paddingTop);
    assert.ok(box.paddingBottom >= 13, 'expected the bumped bottom padding (was 8px, now 14px) on .chip-edit-area, got ' + box.paddingBottom);
    assert.ok(box.height >= 40, 'expected a tap target comfortably close to the ~44px mobile guideline, got ' + box.height + 'px (was ~32px before this fix)');
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
    await pinSignupControlVariant(context);
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

test('pricing screen (14): mobile-test fix -- the old wall-of-text (value bullets + token-math card + "coming soon" pack pricing) is gone, replaced with one short signup-grant message, with no "beta" framing, plan cards, or payment/checkout language left behind', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await goToPricingScreen(page, 'paywall-content@example.com');
    await page.waitForSelector('.fn-token-free-card', { timeout: 5000 });

    var cardText = await page.textContent('.fn-token-free-card');
    // Store-launch copy sweep (tracker item
    // for-product-store-launch-copy-sweep-purc-m6xhkx): "Still in beta" /
    // "Free to try and enjoy right now" is gone -- a real, live
    // contradiction once Dodo Payments checkout actually went live.
    // Replaced with the real signup grant (220 tokens, matching
    // lib/entitlements.js's INITIAL_GRANT and wizard.html's own
    // renderSignup screen). "No card needed" is still accurate and kept.
    assert.doesNotMatch(cardText, /still in beta/i, 'the beta framing must be gone now that the store is live');
    assert.match(cardText, /free to start/i);
    assert.match(cardText, /220 tokens/i, 'should state the real signup grant, matching entitlements.js\'s INITIAL_GRANT');
    assert.match(cardText, /no card needed/i);

    var bodyText = await page.textContent('#app');
    // The dense value-prop checklist, token-math breakdown, and "coming
    // soon" token-pack tiles are gone entirely per founder feedback ("too
    // much text ... reads as scary") -- replaced with the one short
    // message above.
    assert.doesNotMatch(bodyText, /200 tokens/i, 'the token-count breakdown must be gone from this screen');
    assert.doesNotMatch(bodyText, /100 more free every day/i);
    assert.doesNotMatch(bodyText, /coming soon/i);
    assert.doesNotMatch(bodyText, /\$1\.99|\$8\.95/, 'the token-pack price tiles must be gone from this pre-signup screen');
    assert.doesNotMatch(bodyText, /\$9\.99|\$5\.00|\/mo\b/, 'no subscription pricing should remain on this screen');

    var valueCardCount = await page.$$eval('.fn-value-card', function (els) { return els.length; });
    assert.equal(valueCardCount, 0, 'the old value-bullet card must no longer render');
    var packRowCount = await page.$$eval('.fn-pack-row', function (els) { return els.length; });
    assert.equal(packRowCount, 0, 'the old token-pack price tiles must no longer render');
    var priceCardCount = await page.$$eval('.fn-price-card', function (els) { return els.length; });
    assert.equal(priceCardCount, 0, 'no plan cards should be rendered anymore');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Founder mobile-test fix (2026-07-24), item (7): generate-during-signup.
// Ported from wizard.html's renderContact/renderSignup mechanism (see
// test/wizard-ui-behavioral.test.js for that file's own coverage) --
// start.html has no separate contact-only step, so screen 13's Continue
// fires start-pending-generation.js in PARALLEL with the real signup call
// instead of sequentially after it. See start.html's startPendingGeneration()
// for the full rationale/fallback behavior.
// ===========================================================================

test('start.html: generate-during-signup -- screen 13\'s Continue starts a pending generation in parallel with signup, and success adopts + resumes it straight through processing.html with no second submission', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);

    var startPendingCalls = [];
    var claimCalls = [];
    var videoStatusCalls = 0;

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      var body = JSON.parse(route.request().postData());
      startPendingCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-start-test-1', operationName: 'fal:fake-model:req-1' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    // processing.html resumes the adopted pendingJob by polling video-status
    // with the SAME operationName the pre-signup call returned above --
    // resolving it immediately proves no second generate-video.js/
    // start-pending-generation.js submission ever happened.
    await page.route('**/.netlify/functions/video-status*', function (route) {
      videoStatusCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    });
    await page.route('https://example.com/fake-video.mp4', function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
    });

    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await page.fill('#fn-email', 'start-pending-test@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Must reach screen 14 -- proves signup succeeded AND the pending call
    // was awaited (both settle before Continue advances the funnel).
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    assert.equal(startPendingCalls.length, 1, 'start-pending-generation must be called exactly once, from screen 13\'s Continue');
    assert.equal(startPendingCalls[0].email, 'start-pending-test@example.com');
    assert.equal(startPendingCalls[0].caption, 'I had a dream about flying');
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, right after signup succeeds');
    assert.equal(claimCalls[0].pendingId, 'pd-start-test-1');

    var pendingJob = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJob, 'the pending job must already be adopted into DreamStore by the time screen 14 renders');
    assert.equal(pendingJob.operationName, 'fal:fake-model:req-1');

    // Click through pricing + confirmation to processing.html, and confirm
    // it resumes the ALREADY-adopted job rather than submitting a fresh one.
    await page.click('#fn-s14-continue');
    await page.waitForSelector('#fn-s15-continue', { timeout: 5000 });
    await page.click('#fn-s15-continue');
    await page.waitForURL(/result\.html\?id=/, { timeout: 15000 });
    assert.equal(startPendingCalls.length, 1, 'must never re-submit generation after signup -- the whole point of adoptPendingGeneration');
    assert.ok(videoStatusCalls >= 1, 'processing.html must actually resume polling the adopted job');
  } finally {
    await context.close();
  }
});

test('start.html: generate-during-signup -- if the pre-signup generation call fails, signup still completes normally and falls back to a fresh generation at processing.html (resilient, not a dead end)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E7: insufficient_tokens' }) });
    });

    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await page.fill('#fn-email', 'start-pending-fallback@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Must still reach screen 14 despite the pre-signup call failing.
    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });
    var pendingJob = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.equal(pendingJob, null, 'no pendingJob should have been adopted since the pre-signup call failed');
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.ok(draft.caption, 'draft caption must still be set for the fallback fresh-generation path at processing.html');
  } finally {
    await context.close();
  }
});

test('start.html: generate-during-signup -- REGRESSION: signup failing AFTER the parallel pending-generation call already succeeded must NOT re-fire a second real, billed generation when the visitor retries with the same email', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);

    var startPendingCalls = [];
    var claimCalls = [];
    var signupAttempts = 0;

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      var body = JSON.parse(route.request().postData());
      startPendingCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-retry-test-1', operationName: 'fal:fake-model:req-retry-1' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    // register-account: reject the FIRST attempt (the real shape
    // DreamStore.signup expects -- see js/store.js's mapRegisterError),
    // succeed the second -- this is exactly the scenario the review
    // flagged: signup fails AFTER the parallel pending-generation call
    // already succeeded (a real fal submission + real 100-token spend).
    await page.route('**/.netlify/functions/register-account', function (route) {
      signupAttempts++;
      if (signupAttempts === 1) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E8: email_taken' }) });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'retrytester', email: 'retry-same-email@example.com' }) });
      }
    });

    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await page.fill('#fn-email', 'retry-same-email@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // First attempt: signup rejected, error shown -- pending-generation
    // already fired once (and succeeded, per the mock above).
    await page.waitForFunction(function () {
      var el = document.getElementById('fn-signup-error');
      return !!(el && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    assert.equal(startPendingCalls.length, 1, 'start-pending-generation should have fired exactly once so far');

    // Retry with the SAME email -- an entirely normal thing to do after a
    // rejected signup attempt -- must NOT fire a second real, billed
    // generation call; the already-succeeded pending job must be reused.
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });

    assert.equal(startPendingCalls.length, 1, 'REGRESSION GUARD: start-pending-generation must still have fired only once -- reusing the already-succeeded pending job on retry, never re-submitting a second real generation for the same email');
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, using the already-started pending job');
    assert.equal(claimCalls[0].pendingId, 'pd-retry-test-1');

    var pendingJob = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJob, 'the single pending job from the first attempt must still be the one adopted');
    assert.equal(pendingJob.operationName, 'fal:fake-model:req-retry-1');
  } finally {
    await context.close();
  }
});

test('start.html: generate-during-signup -- a visitor who changes to a DIFFERENT email after a rejected signup gets a fresh pending-generation call for the new email (not silently reusing the old one, which would fail claim-pending-generation\'s ownership check)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);

    var startPendingCalls = [];
    var signupAttempts = 0;

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      var body = JSON.parse(route.request().postData());
      startPendingCalls.push(body);
      var n = startPendingCalls.length;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-email-change-' + n, operationName: 'fal:fake-model:req-email-change-' + n }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      signupAttempts++;
      if (signupAttempts === 1) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E8: email_taken' }) });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'emailchanger', email: 'second-email@example.com' }) });
      }
    });

    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await page.fill('#fn-email', 'first-email@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');
    await page.waitForFunction(function () {
      var el = document.getElementById('fn-signup-error');
      return !!(el && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    assert.equal(startPendingCalls.length, 1);

    // Change to a genuinely different email and retry.
    await page.fill('#fn-email', 'second-email@example.com');
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });

    assert.equal(startPendingCalls.length, 2, 'a genuinely different email must get its own fresh pending-generation call, not reuse the first email\'s');
    assert.equal(startPendingCalls[1].email, 'second-email@example.com');
    var pendingJob = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.equal(pendingJob.operationName, 'fal:fake-model:req-email-change-2', 'the adopted job must be the one started for the email signup actually succeeded under');
  } finally {
    await context.close();
  }
});

test('start.html: generate-during-signup -- REGRESSION: a stale start-pending-generation response for an ABANDONED email must not clobber the shared pending state once a newer call (for a changed email) has already started, even if the stale one resolves LAST', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);

    // All three of these are held open (not fulfilled inline) so the test
    // -- not real timing -- controls the exact settlement order: both
    // start-pending-generation calls resolve (reordered, second-email's
    // FIRST, first-email's abandoned one LAST) BEFORE the second signup
    // attempt is allowed to succeed. This matters because the vulnerable
    // read only happens once signup succeeds (see renderScreen13's click
    // handler: pendingPromise.then(claim/adopt/next) runs inside
    // attemptSignup's success callback) -- an earlier version of this test
    // fulfilled the two start-pending-generation routes back-to-back
    // without gating signup on anything, and it passed even against the
    // unfixed code, because the current click's own promise chain always
    // finished consuming the correct value microtasks before the abandoned
    // response was even sent. Only forcing the abandoned response to land
    // AFTER the correct one but BEFORE signup's own success is delivered
    // actually exercises the vulnerable window.
    var capturedPendingRoutes = [];
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      var body = JSON.parse(route.request().postData());
      capturedPendingRoutes.push({ body: body, route: route });
    });
    var claimCalls = [];
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    var signupAttempts = 0;
    var secondSignupRoute = null;
    await page.route('**/.netlify/functions/register-account', function (route) {
      signupAttempts++;
      if (signupAttempts === 1) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E8: email_taken' }) });
      } else {
        secondSignupRoute = route; // held open -- fulfilled explicitly below
      }
    });

    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await page.fill('#fn-email', 'first-email@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');
    // Signup for "first-email" is rejected quickly (a fast DB check) --
    // its own start-pending-generation call, deliberately held open above,
    // is still "in flight" from the test's perspective (unfulfilled).
    await page.waitForFunction(function () {
      var el = document.getElementById('fn-signup-error');
      return !!(el && el.textContent.trim().length);
    }, null, { timeout: 5000 });

    // Visitor corrects to a different email BEFORE the first call has
    // resolved at all -- exactly the trigger condition from the review.
    await page.fill('#fn-email', 'second-email@example.com');
    await page.click('#fn-s13-continue');

    /** Polls a Node-side condition -- there's no in-app hook exposing these closure-private variables, so this is the only way to know each held-open route has actually arrived. */
    function waitFor(conditionFn, what) {
      return new Promise(function (resolve, reject) {
        var deadline = Date.now() + 5000;
        (function poll() {
          if (conditionFn()) { resolve(); return; }
          if (Date.now() > deadline) { reject(new Error(what + ' never arrived')); return; }
          setTimeout(poll, 25);
        })();
      });
    }

    await waitFor(function () { return capturedPendingRoutes.length >= 2; }, 'both start-pending-generation requests');
    assert.equal(capturedPendingRoutes[0].body.email, 'first-email@example.com');
    assert.equal(capturedPendingRoutes[1].body.email, 'second-email@example.com');
    await waitFor(function () { return !!secondSignupRoute; }, 'the second register-account request');

    // Resolve the SECOND (current) pending-generation call first, with the
    // correct data...
    await capturedPendingRoutes[1].route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ pendingId: 'pd-second-real', operationName: 'fal:fake-model:req-second-real' })
    });
    // ...then the FIRST (abandoned) call resolves LAST, out of order,
    // BEFORE signup itself is allowed to succeed. A correct fix discards
    // this write because a newer attempt has since started; a buggy one
    // lets it silently overwrite the shared state that signup's own
    // success handler is about to read.
    await capturedPendingRoutes[0].route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ pendingId: 'pd-first-abandoned', operationName: 'fal:fake-model:req-first-abandoned' })
    });
    // Only NOW does signup for "second-email" succeed -- this is what
    // actually triggers the vulnerable read (pendingPromise.then(claim/
    // adopt/next) in the click handler).
    await secondSignupRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'reorderedtester', email: 'second-email@example.com' }) });

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });

    var pendingJob = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJob, 'a pending job must have been adopted');
    assert.equal(pendingJob.operationName, 'fal:fake-model:req-second-real', 'REGRESSION GUARD: the adopted job must be the SECOND (current) email\'s, never the first, abandoned email\'s -- even though the abandoned response arrived last, right before signup succeeded');
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, for the real (second) pending job');
    assert.equal(claimCalls[0].pendingId, 'pd-second-real');
    assert.equal(claimCalls[0].email, 'second-email@example.com');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Tracker items for-product-add-we-will-email-your-dream-z63dy2 (email
// reassurance microcopy) and for-product-beta-free-offer-in-app-short-jaalf6
// (beta/free mode + shortened onboarding) -- both founder-approved,
// coordinated via tracker.html by the growth session. Real user replay
// evidence showed a drop-off exactly at the funnel's email-capture screen
// (13) right after finishing the dream-text + character screens; separately,
// a founder test flagged the app's own paywall/pricing surfaces as needing
// explicit "free during beta, no card needed" framing (most of that turned
// out to already be shipped by the token-economy pivot -- these tests cover
// the specific gaps that were still open: the email-ask reassurance line,
// and (at the time) the beta-free framing on shop.html/style.html's
// out-of-tokens modal). The shop.html banner test below is since rewritten
// again -- the store-launch copy sweep (tracker item
// for-product-store-launch-copy-sweep-purc-m6xhkx) replaced that "beta"
// framing entirely once the store actually went live (2026-07-27), since
// by then it was a real, live contradiction, not just get-ahead-of-it copy.
// ===========================================================================

test('email capture screen (13) shows the reassurance microcopy explaining why email is asked', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var bodyText = await page.textContent('#app');
    assert.match(bodyText, /email you your dream the moment it.s ready/i, 'expected the WHY/what-happens-next reassurance line right on the email-capture screen');
  } finally {
    await context.close();
  }
});

test('login.html signup mode shows the same email reassurance microcopy, hidden entirely in login mode', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Login mode (default, no ?mode=signup): no email field at all, so the
    // reassurance tied to it must not be visible either.
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    var hintVisibleInLoginMode = await page.isVisible('#email-hint');
    assert.equal(hintVisibleInLoginMode, false, 'the email reassurance line must not show up in login mode, where there is no email field');

    // Signup mode: email field appears, and so should the reassurance
    // right alongside it.
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    var hintVisibleInSignupMode = await page.isVisible('#email-hint');
    assert.equal(hintVisibleInSignupMode, true);
    var hintText = await page.textContent('#email-hint');
    assert.match(hintText, /email you your dream the moment it.s ready/i);
  } finally {
    await context.close();
  }
});

test('shop.html leads with the real per-generation cost line, not stale "beta"/"nothing to buy" framing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 150, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 20, grantCeiling: 200, atCeiling: false });
    await seedLoggedInUserAt(page, baseUrl, 'shopbetatester', '/shop.html');
    await page.waitForSelector('#shop-cost-banner', { timeout: 5000 });

    var bannerText = await page.textContent('#shop-cost-banner');
    // Store-launch copy sweep (tracker item
    // for-product-store-launch-copy-sweep-purc-m6xhkx): "Free during
    // beta -- no card needed" / "nothing to buy right now" directly
    // contradicted the three live Buy buttons right below it once Dodo
    // Payments checkout actually went live -- replaced with the real
    // cost facts (must match lib/entitlements.js's real
    // VIDEO_TOKEN_COST/IMAGE_TOKEN_COST/DAILY_GRANT_AMOUNT/
    // GRANT_CEILING, not stale/guessed numbers).
    assert.doesNotMatch(bannerText, /free during beta/i, 'the beta framing must be gone now that the store is live');
    assert.doesNotMatch(bannerText, /nothing to buy right now/i, 'must not claim there is nothing to buy -- three live packs are right below it');
    assert.match(bannerText, /100 tokens/i, 'should state the real video cost');
    assert.match(bannerText, /10\b/, 'should state the real image cost');
    assert.match(bannerText, /free/i, 'should still mention the free daily grant exists');

    // Token packs are real, live purchases (Dodo Payments) -- see
    // test/shop-behavioral.test.js for full "Buy" button coverage, and
    // the "promoted to primary" assertion below (same tracker item --
    // the buttons were still styled as de-emphasized/secondary from the
    // beta era even after Dodo checkout went live).
    var buttonClasses = await page.getAttribute('#shop-buy-pack100', 'class');
    assert.match(buttonClasses, /\bbtn-primary\b/, 'buy buttons must be promoted to primary styling now that the store is live');
    assert.doesNotMatch(buttonClasses, /\bbtn-secondary\b/);

    var trustLine = await page.textContent('#shop-trust-line');
    assert.match(trustLine, /Dodo Payments/i);
    assert.match(trustLine, /one-time purchase/i);
    assert.match(trustLine, /no subscription/i);
    assert.match(trustLine, /receipt/i);
  } finally {
    await context.close();
  }
});

// The two tests below used to assert style.html's/result.html's
// #modal-quota was a purely free/automatic wait state that must NEVER show
// a dollar amount -- correct for the (pre-store-launch) beta period this
// app was in when they were written. Founder directive 2026-07-26 (tracker
// item for-product-build-out-of-tokens-purchase-2y8hyw), on the eve of the
// real store launch, explicitly SUPERSEDES that framing: "the store must
// come up whenever a user tries any action without enough tokens" -- a
// real one-tap purchase CTA with a real price, replacing #modal-quota with
// the out-of-tokens purchase sheet (js/purchase-sheet.js). The one part of
// the OLD requirement that still holds, and is now spec'd explicitly
// rather than just implied by "no dollar amounts": the free daily-grant
// path must stay honest and visible, never hidden, alongside the new buy
// CTA -- these two tests are rewritten to check exactly that balance.
test("style.html's out-of-tokens purchase sheet shows a real price AND keeps the free daily-grant path honest and visible (supersedes the old beta-era 'no dollar amounts' framing per founder directive 2026-07-26)", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 0, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 100, grantCeiling: 200, atCeiling: false });
    await seedLoggedInUserAt(page, baseUrl, 'quotasheettester', '/create.html');
    await page.click('#choice-write');
    await page.fill('#dream-text', 'A dream about flying over a glowing city at night');
    await page.click('#write-continue');
    await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });
    await page.click('.style-card[data-style="Cartoon"]');
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var sheetText = await page.textContent('#purchase-sheet-overlay');
    assert.match(sheetText, /\$\d/, 'the one-tap purchase CTA must show a real price now -- the store launched');
    assert.match(sheetText, /100 free tokens in/i, 'the free daily-grant path must stay visible alongside the buy CTA, never hidden');
    assert.match(sheetText, /Secure checkout via Dodo/i);
  } finally {
    await context.close();
  }
});

test("result.html's out-of-tokens purchase sheet (reached from Generate Again) reads the same way as style.html's -- a real price AND the honest free daily-grant path, both visible", async function (t) {
  // Regression test for a review finding on the ORIGINAL #modal-quota this
  // sheet replaced: result.html had its own separate copy of that markup,
  // not a shared component, and a fix applied to style.html alone missed
  // it. js/purchase-sheet.js structurally closes that recurring bug class
  // (tracker.html's recurring-pattern-a-ui-copy-behavior-fix-9mmjgh) --
  // one shared module, not per-page hand-copies -- so this test now mainly
  // proves that's actually true in practice on this call site too.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 0, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 100, grantCeiling: 200, atCeiling: false });
    await seedResultPage(page, baseUrl, 'd-quota-modal-test');
    await page.waitForSelector('#open-edit-sheet', { timeout: 5000 });
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#edit-generate-again', { timeout: 5000 });
    await page.click('#edit-generate-again');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var sheetText = await page.textContent('#purchase-sheet-overlay');
    assert.match(sheetText, /\$\d/, 'the one-tap purchase CTA must show a real price now -- the store launched');
    assert.match(sheetText, /100 free tokens in/i, 'the free daily-grant path must stay visible alongside the buy CTA, never hidden');
    assert.match(sheetText, /Secure checkout via Dodo/i);
  } finally {
    await context.close();
  }
});

/**
 * Bug report (profile-improvements-kwivqb): "+100 in now" (the token
 * countdown) never resets once it reaches "now" -- because profile.html's
 * 60s setInterval only re-rendered the SAME cached tokenStatus object, it
 * never re-fetched get-token-status.js, so once nextGrantAt passed, the
 * displayed balance/countdown froze there forever even though a real grant
 * had already landed server-side. Fix: once nextGrantAt has passed, the
 * interval callback re-fetches instead of just re-formatting. Uses
 * page.clock to fast-forward past both the grant time and the 60s interval
 * without a real wait, and a second get-token-status.js route response
 * (a distinctly different balance) to prove a genuine second fetch
 * happened, not just a re-render of the first response.
 */
test('profile.html: the token countdown re-fetches (not just re-renders stale data) once it reaches "now"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.clock.install({ time: Date.now() });

    var callCount = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      callCount++;
      var body = callCount === 1
        ? { balance: 90, nextGrantAt: Date.now() + 30000, dailyGrantAmount: 10 } // grant due in 30s
        : { balance: 100, nextGrantAt: Date.now() + 86400000, dailyGrantAmount: 10 }; // post-grant state
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await seedLoggedInUserAt(page, baseUrl, 'countdownstuck', '/profile.html');
    await page.waitForFunction(function () {
      var el = document.getElementById('profile-tokens-balance');
      return el && el.textContent.indexOf('90') !== -1;
    }, null, { timeout: 5000 });
    assert.equal(callCount, 1, 'sanity: exactly one fetch on initial load');

    // Advance past the 30s grant time, then past the 60s interval tick --
    // the interval callback should notice nextGrantAt already passed and
    // re-fetch, landing on the second (post-grant) mocked response.
    await page.clock.fastForward(65000);
    await page.waitForFunction(function () {
      var el = document.getElementById('profile-tokens-balance');
      return el && el.textContent.indexOf('100') !== -1;
    }, null, { timeout: 5000 });

    assert.equal(callCount, 2, 'expected exactly one re-fetch once the countdown reached "now"');
    var metaText = await page.textContent('#profile-tokens-meta');
    assert.doesNotMatch(metaText, /in now/i, 'must not still read "in now" after the re-fetch picks up the new nextGrantAt');
  } finally {
    await context.close();
  }
});

test('shop.html: the token countdown re-fetches (not just re-renders stale data) once it reaches "now"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.clock.install({ time: Date.now() });

    var callCount = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      callCount++;
      var body = callCount === 1
        ? { balance: 90, nextGrantAt: Date.now() + 30000, dailyGrantAmount: 10 }
        : { balance: 100, nextGrantAt: Date.now() + 86400000, dailyGrantAmount: 10 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await seedLoggedInUserAt(page, baseUrl, 'shopcountdownstuck', '/shop.html');
    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent.indexOf('90') !== -1;
    }, null, { timeout: 5000 });
    assert.equal(callCount, 1);

    await page.clock.fastForward(65000);
    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent.indexOf('100') !== -1;
    }, null, { timeout: 5000 });

    assert.equal(callCount, 2, 'expected exactly one re-fetch once the countdown reached "now"');
    var countdownText = await page.textContent('#shop-countdown');
    assert.doesNotMatch(countdownText, /in now/i, 'must not still read "in now" after the re-fetch picks up the new nextGrantAt');
  } finally {
    await context.close();
  }
});

/**
 * Second founder report of a stuck-countdown bug class (tracker item
 * for-product-bug-founder-high-token-chip--kn1v8t, screenshot
 * 2026-07-26 23:19): the founder's own profile, balance 1500 (well above
 * the 200-token ceiling), showed "1500 tokens · +20 in now" PERMANENTLY.
 * Unlike the earlier c995790 fix (a stuck countdown that just needed a
 * re-fetch once nextGrantAt genuinely passed), this account is AT the
 * ceiling on purpose -- entitlements.js's syncTokens deliberately holds
 * the daily grant back and never bumps lastGrantAt once balance >=
 * GRANT_CEILING (200), so nextGrantAt stays in the past forever and no
 * amount of re-fetching ever produces a future nextGrantAt again. There
 * was previously NO correct rendering for this state at all -- every
 * renderer collapsed a past nextGrantAt to "now" and showed "+N in now"
 * indefinitely, which reads as "due right this second" when really the
 * drip is simply paused. Fix: get-token-status.js now returns an explicit
 * `atCeiling` boolean (see lib/entitlements.js's getTokenStatus), and
 * profile.html/shop.html both branch on it to show honest "paused" copy
 * instead of ever formatting a countdown from a past nextGrantAt.
 */
test('profile.html: an at-ceiling balance (>= 200) shows honest "paused" copy, never "+N in now"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Mirrors the exact founder-reported state: balance 1500 (well above
    // the 200 ceiling), nextGrantAt already in the past (lastGrantAt was
    // never bumped while held back), atCeiling true.
    await mockTokenStatus(page, { balance: 1500, nextGrantAt: Date.now() - 3600000, dailyGrantAmount: 20, grantCeiling: 200, atCeiling: true });
    await seedLoggedInUserAt(page, baseUrl, 'foundermaxed', '/profile.html');
    await page.waitForSelector('#profile-tokens-meta:not(:empty)', { timeout: 5000 });

    var balance = await page.textContent('#profile-tokens-balance');
    assert.match(balance, /1500 tokens/);

    var meta = await page.textContent('#profile-tokens-meta');
    assert.doesNotMatch(meta, /in now/i, 'must never render "+N in now" for an at-ceiling account');
    assert.doesNotMatch(meta, /\+20 in/i, 'must not render a countdown at all while at ceiling');
    assert.match(meta, /paused/i, 'should say something honest about the drip being paused');
    assert.match(meta, /20/, 'should still mention the daily amount that is paused');
  } finally {
    await context.close();
  }
});

test('shop.html: an at-ceiling balance (>= 200) shows honest "paused" copy, never "in now"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1500, nextGrantAt: Date.now() - 3600000, dailyGrantAmount: 20, grantCeiling: 200, atCeiling: true });
    await seedLoggedInUserAt(page, baseUrl, 'foundermaxedshop', '/shop.html');
    await page.waitForSelector('#shop-countdown:not(:empty)', { timeout: 5000 });

    var balance = await page.textContent('#shop-balance');
    assert.match(balance, /1500/);

    var countdown = await page.textContent('#shop-countdown');
    assert.doesNotMatch(countdown, /in now/i, 'must never render "in now" for an at-ceiling account');
    assert.doesNotMatch(countdown, /^Next 20 free tokens in/i, 'must not render the normal countdown copy while at ceiling');
    assert.match(countdown, /paused/i, 'should say something honest about the drip being paused');
  } finally {
    await context.close();
  }
});

/**
 * Follow-up from fix-token-chip-at-ceiling-display (commit 8156f1e),
 * tracker item token-countdown-60s-refetch-timer-polls--o12s5e: the two
 * "re-fetches once it reaches now" tests above prove the interval DOES
 * re-fetch once nextGrantAt passes for a normal account. But for an
 * at-ceiling account, entitlements.js's syncTokens deliberately never
 * bumps lastGrantAt while balance is at/above GRANT_CEILING, so
 * nextGrantAt sits in the past PERMANENTLY -- without the atCeiling
 * check, that same "nextGrantAt <= now -> refetch" branch would fire a
 * real get-token-status.js fetch every single 60s tick, forever, for as
 * long as the page stays open. Not a display bug (rendering was already
 * correct) -- unbounded, unnecessary network polling. Fix: skip the
 * refetch branch when tokenStatus.atCeiling is true.
 */
test('profile.html: an at-ceiling account never re-fetches on the 60s countdown tick', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.clock.install({ time: Date.now() });

    var callCount = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      callCount++;
      // Always the same at-ceiling state -- nextGrantAt permanently in
      // the past, exactly like a real held-back grant never bumps it.
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        balance: 1500, nextGrantAt: Date.now() - 3600000, dailyGrantAmount: 20, grantCeiling: 200, atCeiling: true
      }) });
    });

    await seedLoggedInUserAt(page, baseUrl, 'ceilingnopoll', '/profile.html');
    await page.waitForFunction(function () {
      var el = document.getElementById('profile-tokens-balance');
      return el && el.textContent.indexOf('1500') !== -1;
    }, null, { timeout: 5000 });
    assert.equal(callCount, 1, 'sanity: exactly one fetch on initial load');

    // Two full interval ticks -- an at-ceiling account's nextGrantAt is
    // always in the past, so the old code would re-fetch on every tick.
    await page.clock.fastForward(65000);
    await page.clock.fastForward(65000);

    assert.equal(callCount, 1, 'must not re-fetch on any tick while atCeiling is true -- nextGrantAt never becomes "not passed" for this account');
    var metaText = await page.textContent('#profile-tokens-meta');
    assert.match(metaText, /paused/i, 'should still render the honest paused copy after ticks with no re-fetch');
  } finally {
    await context.close();
  }
});

test('shop.html: an at-ceiling account never re-fetches on the 60s countdown tick', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.clock.install({ time: Date.now() });

    var callCount = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      callCount++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        balance: 1500, nextGrantAt: Date.now() - 3600000, dailyGrantAmount: 20, grantCeiling: 200, atCeiling: true
      }) });
    });

    await seedLoggedInUserAt(page, baseUrl, 'ceilingnopollshop', '/shop.html');
    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent.indexOf('1500') !== -1;
    }, null, { timeout: 5000 });
    assert.equal(callCount, 1, 'sanity: exactly one fetch on initial load');

    await page.clock.fastForward(65000);
    await page.clock.fastForward(65000);

    assert.equal(callCount, 1, 'must not re-fetch on any tick while atCeiling is true -- nextGrantAt never becomes "not passed" for this account');
    var countdownText = await page.textContent('#shop-countdown');
    assert.match(countdownText, /paused/i, 'should still render the honest paused copy after ticks with no re-fetch');
  } finally {
    await context.close();
  }
});

test('profile.html: a balance just under the ceiling (199) still shows a normal live countdown, not the paused copy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 199, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 20, grantCeiling: 200, atCeiling: false });
    await seedLoggedInUserAt(page, baseUrl, 'notyetmaxed', '/profile.html');
    await page.waitForSelector('#profile-tokens-meta:not(:empty)', { timeout: 5000 });

    var meta = await page.textContent('#profile-tokens-meta');
    assert.doesNotMatch(meta, /paused/i, 'a below-ceiling balance must show the real countdown, not the at-ceiling copy');
    assert.match(meta, /\+20 in/, 'should show the normal live countdown');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Media-aware low-balance label (hardening fix, tracker item
// for-product-store-launch-copy-sweep-purc-m6xhkx): profile.html used to
// flatly label any balance under 100 (VIDEO_TOKEN_COST) as "Out of tokens",
// even though a balance of, say, 50 can still afford the 10-token image
// path -- literally false for that user. Fixed to distinguish "genuinely
// can't afford anything" (< IMAGE_TOKEN_COST, 10) from "can't afford a
// video but can still afford an image" (>= 10, < 100), which now reads
// "Low" instead.
// ===========================================================================

test('profile.html: a balance that can still afford an image (e.g. 50) shows "Low", not "Out of tokens"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 20, grantCeiling: 200, atCeiling: false });
    await seedLoggedInUserAt(page, baseUrl, 'lowbalanceimageok', '/profile.html');
    await page.waitForSelector('#profile-tokens-meta:not(:empty)', { timeout: 5000 });

    var meta = await page.textContent('#profile-tokens-meta');
    assert.doesNotMatch(meta, /out of tokens/i, 'a balance that can still afford a 10-token image must not claim the user is entirely out of tokens');
    assert.match(meta, /low/i, 'should read as "Low" instead');
  } finally {
    await context.close();
  }
});

test('profile.html: a balance that can\'t even afford an image (e.g. 5) still shows "Out of tokens"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 5, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 20, grantCeiling: 200, atCeiling: false });
    await seedLoggedInUserAt(page, baseUrl, 'trulyoutoftokens', '/profile.html');
    await page.waitForSelector('#profile-tokens-meta:not(:empty)', { timeout: 5000 });

    var meta = await page.textContent('#profile-tokens-meta');
    assert.match(meta, /out of tokens/i, 'a balance below even the cheapest generation type is genuinely out of tokens');
  } finally {
    await context.close();
  }
});
