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
// Also covers the 5 Advanced-screen/pricing fixes from commit ae7da62
// (start.html screen 9's dark-mode contrast bug, its restructure into 3
// numbered .adv-step sections, the lighter --surface chip color shared
// with create.html's Advanced accordion, screen 14's genuinely-selectable
// pricing cards, and screen 14's new paywall content) -- see the tests
// below tagged "Advanced screen" / "create.html" / "pricing screen".
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

// ===========================================================================
// Advanced screen (9) / pricing screen (14) fixes -- commit ae7da62.
// ===========================================================================

test('Advanced screen (9): dark-mode contrast fix -- #app gets a real black background, and the headline renders in a light, readable color', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-s9-skip', { timeout: 5000 });

    var appClasses = await page.$eval('#app', function (el) { return el.className; });
    assert.match(appClasses, /\bfunnel-app\b/);
    assert.match(appClasses, /\bfn-dark-mode\b/);

    // --bg-app is #000 (css/styles.css) -- the bug this fixes was #app
    // falling back to the light pastel gradient instead of this rule.
    // #app.funnel-app has `transition:background .4s ease`, so the very
    // first read right after load can catch mid-transition (an intermediate
    // rgba, not the settled color) -- wait for the transition to actually
    // finish landing on black before asserting, instead of a blind sleep.
    await page.waitForFunction(function () {
      var el = document.getElementById('app');
      return getComputedStyle(el).backgroundColor === 'rgb(0, 0, 0)';
    }, null, { timeout: 5000 });
    var appBg = await page.$eval('#app', function (el) { return getComputedStyle(el).backgroundColor; });
    assert.equal(appBg, 'rgb(0, 0, 0)', 'expected the real dark-mode background (--bg-app), not the light pastel gradient');

    // --text-primary is #fff -- must NOT be the light-phase ink color
    // (#3A3350 / rgb(58, 51, 80)), which is what produced dark-on-dark
    // (near-invisible) text against the black background pre-fix.
    var headlineColor = await page.$eval('.fn-headline', function (el) { return getComputedStyle(el).color; });
    assert.equal(headlineColor, 'rgb(255, 255, 255)', 'expected the light dark-mode ink color (--text-primary)');
    assert.notEqual(headlineColor, 'rgb(58, 51, 80)', 'must not still be the light-phase fn-ink color -- that combined with the black background is dark-on-dark');
    assert.notEqual(headlineColor, appBg, 'headline color and background must differ -- guards against a white-on-white or dark-on-dark regression either direction');
  } finally {
    await context.close();
  }
});

test('Advanced screen (9): restructured into 3 numbered steps, and the character/camera/scenery interactions inside them still work', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-s9-skip', { timeout: 5000 });

    var steps = await page.$$eval('.adv-step', function (els) {
      return els.map(function (el) {
        var num = el.querySelector('.adv-step-num');
        var label = el.querySelector('.adv-sub-label');
        return { num: num ? num.textContent.trim() : null, label: label ? label.textContent.trim() : null };
      });
    });
    assert.equal(steps.length, 3, 'expected exactly 3 .adv-step sections');
    assert.deepEqual(steps.map(function (s) { return s.num; }), ['1', '2', '3']);
    assert.deepEqual(steps.map(function (s) { return s.label; }), ['Characters', 'Camera view', 'Scenery']);

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

    // --- Camera view: single-select chip row, writes straight into
    // DreamStore's draft. ---
    await page.click('#camera-chip-row [data-camera="Wide shot"]');
    var cameraSelected = await page.$eval('#camera-chip-row [data-camera="Wide shot"]', function (el) { return el.classList.contains('selected'); });
    assert.equal(cameraSelected, true);
    var cameraDraftValue = await page.evaluate(function () { return DreamStore.getDraft().cameraView; });
    assert.equal(cameraDraftValue, 'Wide shot');

    // --- Scenery: two independent single-select rows (time, place). ---
    await page.click('#scenery-time-row [data-scenery-time="Night"]');
    await page.click('#scenery-place-row [data-scenery-place="Nature"]');
    var sceneryTimeSelected = await page.$eval('#scenery-time-row [data-scenery-time="Night"]', function (el) { return el.classList.contains('selected'); });
    var sceneryPlaceSelected = await page.$eval('#scenery-place-row [data-scenery-place="Nature"]', function (el) { return el.classList.contains('selected'); });
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

test('pricing screen (14): clicking a non-default plan card updates its selected state, and that clicked plan (not the original default) is what gets tracked when continuing past pricing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    // goToPricingScreen doesn't pass a motivations param, so MOTIVATION_PLAN
    // has no match and the default recommendation -- and therefore the
    // default selectedPlan -- is Yearly. Confirmed below before relying on it.
    await goToPricingScreen(page, 'plan-picker@example.com');
    await page.waitForSelector('.fn-price-card[data-plan="Yearly"]', { timeout: 5000 });

    var yearlySelectedBefore = await page.$eval('.fn-price-card[data-plan="Yearly"]', function (el) { return el.classList.contains('selected'); });
    assert.equal(yearlySelectedBefore, true, 'Yearly should be the default-selected plan with no motivation data');

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

    await page.click('.fn-price-card[data-plan="Monthly"]');

    var monthlySelectedAfter = await page.$eval('.fn-price-card[data-plan="Monthly"]', function (el) { return el.classList.contains('selected'); });
    var yearlySelectedAfter = await page.$eval('.fn-price-card[data-plan="Yearly"]', function (el) { return el.classList.contains('selected'); });
    assert.equal(monthlySelectedAfter, true, 'the clicked card should now show the selected state');
    assert.equal(yearlySelectedAfter, false, 'the previously-selected card should lose the selected state');
    var monthlyAriaPressed = await page.getAttribute('.fn-price-card[data-plan="Monthly"]', 'aria-pressed');
    assert.equal(monthlyAriaPressed, 'true');

    await page.click('#fn-s14-continue');
    await page.waitForSelector('#fn-s15-continue', { timeout: 5000 });

    var phCalls = await page.evaluate(function () { return window.__phCalls; });
    var planSelectedCalls = phCalls.filter(function (c) { return c.name === 'funnel_plan_selected'; });
    var pricingBypassedCalls = phCalls.filter(function (c) { return c.name === 'funnel_pricing_bypassed'; });
    assert.equal(planSelectedCalls.length, 1, 'expected exactly one funnel_plan_selected call, from the click above');
    assert.equal(planSelectedCalls[0].props.plan, 'Monthly');
    assert.equal(pricingBypassedCalls.length, 1, 'expected exactly one funnel_pricing_bypassed call, from Continue');
    assert.equal(pricingBypassedCalls[0].props.plan, 'Monthly', 'must record the plan actually clicked, not the original default');
  } finally {
    await context.close();
  }
});

test('pricing screen (14): renders the value bullets, cancel-anytime line, and secure-checkout trust line', async function (t) {
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

    var footText = await page.textContent('.fn-value-foot');
    assert.match(footText, /cancel anytime/i, 'expected a cancel-anytime line');
    assert.match(footText, /secure checkout/i, 'expected a secure-checkout trust line');
    assert.match(footText, /payment details are never stored/i, 'expected the trust line to actually say what "secure" means here');
  } finally {
    await context.close();
  }
});
