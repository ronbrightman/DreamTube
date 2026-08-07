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
var settle = require('./helpers/settle').settle;
var signupFlow = require('./helpers/signup-flow');

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

/** Intercepts get-token-status.js's underlying fetch so tests can force a specific balance/countdown without a real Netlify Functions runtime -- used by the shop.html/style.html beta-messaging tests below. */
function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

/**
 * Records every call to window.posthog.capture into a Node-side array that
 * survives page navigation -- needed as of the screen-15-into-14 merge
 * (tracker item for-product-funnel-handoff-screens-theme-5ttymn): screen
 * 14's Continue now completes the funnel and navigates straight to
 * home.html/create.html in the same click, instead of staying on an
 * in-page confirmation screen (the old screen 15) the way a plain
 * page.evaluate() in-page monkeypatch could survive. Same
 * exposeBinding+addInitScript pattern test/meta-capi-behavioral.test.js's
 * installFbqRecorder uses for window.fbq, one level deeper: start.html's
 * PostHog snippet assigns `window.posthog = e` once (an array-turned-
 * object, not a plain function like fbq), and only later, inside
 * posthog.init(), does that same object get its own `capture` property
 * assigned (a locally-queuing stub, since blockThirdParty() aborts the
 * real array.js load -- see start.html's snippet comment). This wraps
 * BOTH assignments: an accessor on window.posthog captures the object the
 * moment it's created, then defines its own accessor for that object's
 * `capture` property so the later assignment inside init() is transparently
 * wrapped too. Must be installed on the context before any page.goto().
 */
async function installPosthogCaptureRecorder(context) {
  var calls = [];
  await context.exposeBinding('__recordPosthogCapture', function (source, args) {
    calls.push({ name: args[0], props: args[1] });
  });
  await context.addInitScript(function () {
    var realPosthog = null;
    Object.defineProperty(window, 'posthog', {
      configurable: true,
      get: function () { return realPosthog; },
      set: function (obj) {
        realPosthog = obj;
        if (obj && typeof obj === 'object') {
          var realCapture = null;
          var wrapper = function () {
            try { window.__recordPosthogCapture(Array.prototype.slice.call(arguments)); } catch (e) { /* recording must never break the real capture call below */ }
            if (typeof realCapture === 'function') return realCapture.apply(obj, arguments);
          };
          Object.defineProperty(obj, 'capture', {
            configurable: true,
            get: function () { return wrapper; },
            set: function (fn) { realCapture = fn; }
          });
        }
      }
    });
  });
  return calls;
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
  await stubPendingGenerationAsUnavailable(page);
  await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
  // As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
  // g64gjp), start.html's former characters and "preparing" transition
  // screens were removed outright -- a fresh ?resume=1 load lands directly
  // on screen 13.
  await signupFlow.advanceToPasswordStep(page, email);
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
    // login.html's default post-login landing page is now home.html, not
    // explore.html (tracker item for-product-build-homepage-wave-1-the-ri-
    // xr8mir) -- explore.html itself is unaffected, still one tap away.
    await page.waitForURL(/home\.html/, { timeout: 5000 });
    assert.match(page.url(), /home\.html/);
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
    // login.html's default post-login landing page is now home.html (see
    // the sibling test above's identical-purpose comment).
    await page.waitForURL(/home\.html/, { timeout: 5000 });
    assert.match(page.url(), /home\.html/);
  } finally {
    await context.close();
  }
});

test('Explore cards render without the removed repost icon, WITH the reintroduced comment action, and without a layout regression', async function (t) {
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

    // Exactly 4 actions per card as of Social Layer v2 slice 2 (comments —
    // docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
    // for-product-build-social-layer-v2-direct-34047c, open decision #3):
    // like + comments (js/comment-sheet.js) + share + the Report/Block
    // "More" action (js/report-sheet.js, tracker item
    // for-product-public-feed-safety-in-app-re-ppuw77). The comment icon's
    // reappearance here is a DELIBERATE, spec'd reintroduction — a real
    // comment sheet backing it, not the old dead placeholder this test
    // originally guarded against silently coming back. Repost stays gone
    // (see the repost-specific assertions below, still enforced). This
    // viewer is logged out for this test (no state.user seeded), and the
    // mocked dream isn't "mine" either way, so More is expected to render
    // here — see explore.html's cardHTML, which hides it only for d.mine.
    var actionCount = await page.$$eval('.feed-card .feed-actions .feed-action', function (els) { return els.length; });
    assert.equal(actionCount, 4, 'expected exactly like+comments+share+more actions per card, no repost');

    var actionsHTML = await page.$eval('.feed-card .feed-actions', function (el) { return el.innerHTML; });
    assert.ok(!/repost/i.test(actionsHTML), 'no leftover "repost" reference in the actions markup');
    // Distinctive path fragment unique to the removed repost SVG (js/icons.js)
    // -- guards against it somehow still being embedded even under a
    // different data-attribute/class name.
    assert.ok(actionsHTML.indexOf('M17 2l4 4-4 4') === -1, 'repost icon path should not be present');
    assert.equal(await page.locator('.feed-card .feed-actions [data-comments]').count(), 1, 'the reintroduced comment action must be present');
    assert.equal(await page.locator('.feed-card .feed-actions [data-more]').count(), 1, 'the new Report/Block "More" action must be present');

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
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    // As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), start.html's former characters and "preparing" transition
    // screens were removed outright -- a fresh ?resume=1 load lands directly
    // on screen 13.
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

test('pricing screen shows the static "Hundreds of dreams brought to life" proof line regardless of getSharedFeed() -- and no longer shows the trailing "This is DreamTube..." line', async function (t) {
  // Founder walkthrough punch list (2026-08-01, tracker item
  // for-product-founder-walkthrough-punch-li-t33k3y, item 4): the live
  // dreamsThisMonthCount stat on THIS screen (screen 14, "Never lose a
  // dream") is replaced with static copy -- this early in the product's
  // life a real live count reads as 0/tiny, which is worse than no number.
  // Screen 13's own proof strip is UNCHANGED (still the real live count --
  // see the two tests below) since the founder's ask was scoped to this
  // one screen specifically. The trailing "This is DreamTube -- quiet and
  // dark, like the room you just woke up in." line is deleted entirely
  // too (same item).
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var now = new Date();
    await mockGetFeed(page, [
      { id: 'a', publishedAt: now.toISOString() },
      { id: 'b', publishedAt: now.toISOString() }
    ]);
    await goToPricingScreen(page, 'buyer-resolved@example.com');
    await page.waitForSelector('.fn-proof-strip', { timeout: 5000 });
    var text = await page.textContent('.fn-proof-strip');
    assert.match(text, /Hundreds of dreams brought to life\./);
    assert.doesNotMatch(text, /\d/, 'must be static copy, never a live/computed number on this screen');

    var bodyText = await page.textContent('#app');
    assert.doesNotMatch(bodyText, /quiet and dark, like the room you just woke up in/i, 'the trailing "This is DreamTube..." line must be gone entirely, not reworded');
  } finally {
    await context.close();
  }
});

test('pricing screen still shows the static proof line even when getSharedFeed() fails (it no longer depends on the feed at all)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, null, { fail: true });
    await goToPricingScreen(page, 'buyer-failed@example.com');
    await page.waitForSelector('.fn-proof-strip', { timeout: 5000 });
    var text = await page.textContent('.fn-proof-strip');
    assert.match(text, /Hundreds of dreams brought to life\./, 'the static line must show regardless of the feed fetch outcome');
  } finally {
    await context.close();
  }
});

test('result.html: Save is gone entirely (redundant with Share) -- no #save-video-btn anywhere, and Delete is an ordinary quiet link', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-no-save-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });

    assert.equal(await page.locator('#save-video-btn').count(), 0, '#save-video-btn must not exist anywhere on the page -- Save was removed entirely');

    var deleteBtn = page.locator('#delete-btn');
    assert.ok(await deleteBtn.isVisible(), '#delete-btn should be visible as an ordinary quiet link');
    assert.ok(await page.locator('.result-quiet-links #delete-btn').count() > 0, '#delete-btn must live inside .result-quiet-links, same row as Edit/Publish/Make another');
    assert.ok(await deleteBtn.evaluate(function (el) { return el.classList.contains('danger'); }), '#delete-btn should carry the danger-tint modifier class on its icon, not full red/emphasized styling');
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: no topbar and no back/share chips over the video -- only mute lives there; back is via Bar-A, share lives in the hero\'s own tag row', async function (t) {
  // Founder walkthrough punch list (2026-08-01, tracker item
  // for-product-founder-walkthrough-punch-li-t33k3y, Manager addition B):
  // the founder confirmed via fresh screenshots that the approved final
  // has NO top chrome at all, overriding this build's own earlier,
  // deliberate deviation from the static result-mock3 sketch (which kept
  // back+share as real chips). #result-back is removed entirely (Bar-A's
  // Home/Explore/Profile tabs replace it); #share-btn survives, same id
  // and click behavior, just relocated out of the video into the hero's
  // own .tagrow.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-nav-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#mute-btn', { timeout: 5000 });

    // The .topbar element itself is gone entirely now (this screen has no
    // topbar at all per the founder-approved mock) -- not just emptied.
    assert.equal(await page.locator('.topbar').count(), 0, 'the .topbar element must not exist anywhere on the page');
    assert.equal(await page.locator('#result-nav-explore').count(), 0, 'the old topbar Explore nav icon must be gone');
    assert.equal(await page.locator('#result-nav-profile').count(), 0, 'the old topbar Profile nav icon must be gone');
    assert.equal(await page.locator('#result-topbar-title').count(), 0, 'the topbar page title must not exist anywhere on the page');
    assert.equal(await page.locator('#result-back').count(), 0, '#result-back must not exist anywhere on the page -- removed entirely, not just hidden');

    // Only mute is left over the video frame -- a real, non-collapsed box.
    var chipsOverVideo = await page.locator('#dreamvideo-frame .dv-chip').count();
    assert.equal(chipsOverVideo, 1, 'only mute should remain as a chip over the video');
    var muteBox = await page.locator('#mute-btn').boundingBox();
    assert.ok(muteBox && muteBox.width > 0 && muteBox.height > 0, 'mute should have a real, non-collapsed box');

    // Share now lives in the hero's own tag row, next to the Private/
    // Public state tag -- outside the video frame entirely.
    assert.equal(await page.locator('#dreamvideo-frame #share-btn').count(), 0, 'share must no longer be inside the video frame');
    var shareInTagRow = await page.locator('.tagrow #share-btn').count();
    assert.equal(shareInTagRow, 1, 'share must live in the hero\'s .tagrow now, alongside the Private/Public tag');
    var shareBox = await page.locator('#share-btn').boundingBox();
    assert.ok(shareBox && shareBox.width > 0 && shareBox.height > 0, 'the relocated share pill should have a real, non-collapsed box');
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: the section-6 cuts are still cut -- no Explore/Profile CTA pair, no style tag anywhere on the page, and the "Tomorrow: log your next dream" strip is removed entirely', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-cuts-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });

    assert.equal(await page.locator('#result-cta-explore').count(), 0, 'the Explore CTA button must not exist anywhere on the page');
    assert.equal(await page.locator('#result-cta-profile').count(), 0, 'the My-profile CTA button must not exist anywhere on the page');
    assert.equal(await page.locator('.result-cta-row').count(), 0, 'the compact CTA row must not exist anywhere on the page');
    assert.equal(await page.locator('#result-style-tag').count(), 0, 'the "Style: X" tag must not exist anywhere on the page');

    // Founder amendment (2026-07-31, round 2 of this build): the "Tomorrow:
    // log your next dream" strip the earlier round-3 mock still showed is
    // REMOVED entirely, not just restyled -- no .nextstrip markup, no
    // "Tomorrow" text anywhere on the page.
    assert.equal(await page.locator('.nextstrip').count(), 0, 'the "Tomorrow: log your next dream" strip must not exist anywhere on the page');
    var appText = await page.$eval('#app', function (el) { return el.innerText; });
    assert.ok(appText.indexOf('Tomorrow') === -1, 'no "Tomorrow" copy should render anywhere on the page (got: ' + JSON.stringify(appText.slice(0, 400)) + ')');

    // The privacy tag SURVIVES the cut -- only the style tag went.
    assert.ok(await page.locator('#result-privacy-tag').isVisible(), 'the Private/Public tag must still be there');
    assert.equal((await page.textContent('#result-privacy-tag')).trim(), 'Private');
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: the ONE hero is the interpretation entry -- a full-width emphasized pill above the quiet row that opens the Interpreter\'s Chamber for THIS dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-hero-interpret-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#interp-cta-btn', { timeout: 5000 });

    var heroText = (await page.textContent('#interp-cta-btn')).replace(/\s+/g, ' ').trim();
    assert.match(heroText, /What does this dream mean\?/, 'the hero should carry the founder-specified copy (got: ' + heroText + ')');

    // It reads as the HERO: spans the ritual card's full inner width, a
    // real full-size tap target, and a heavy label.
    var hero = await page.$eval('#interp-cta-btn', function (el) {
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var card = document.querySelector('.hcard.hero').getBoundingClientRect();
      var cardCS = getComputedStyle(document.querySelector('.hcard.hero'));
      // border-box sizing (this codebase's global `*{box-sizing:border-box}`
      // reset): getBoundingClientRect().width includes the 1px border on
      // each side, so the content box the hero actually sits in is
      // narrower than that by the border width too, not just the padding.
      var innerWidth = card.width - parseFloat(cardCS.paddingLeft) - parseFloat(cardCS.paddingRight) - parseFloat(cardCS.borderLeftWidth) - parseFloat(cardCS.borderRightWidth);
      return {
        height: r.height,
        fontSize: parseFloat(cs.fontSize),
        fontWeight: parseInt(cs.fontWeight, 10),
        width: r.width,
        innerWidth: innerWidth
      };
    });
    assert.ok(Math.abs(hero.width - hero.innerWidth) < 2, 'the hero should span the card\'s full inner width (got ' + hero.width + ' vs ' + hero.innerWidth + ')');
    assert.ok(hero.height >= 44, 'the hero must be a real full-size tap target, >= the 44px mobile minimum (got ' + hero.height + 'px)');
    assert.ok(hero.fontSize >= 13, 'the hero label should be a real, readable size (got ' + hero.fontSize + 'px)');
    assert.ok(hero.fontWeight >= 700, 'the hero label should be heavy (got ' + hero.fontWeight + ')');

    // It is the LAST thing above the quiet row.
    var heroBottom = await page.$eval('#interp-cta-btn', function (el) { return el.getBoundingClientRect().bottom; });
    var quietTop = await page.$eval('.result-quiet-links', function (el) { return el.getBoundingClientRect().top; });
    assert.ok(heroBottom <= quietTop + 1, 'the hero must sit above the quiet small-link row');

    // And it is the ONLY emphasized full-width CTA on a normal (video)
    // dream -- the image-only Turn-into-video hero is hidden here.
    assert.equal(await page.locator('#turn-video-btn').isVisible(), false, 'the Turn-into-video hero must stay hidden for a video dream');

    // Tapping opens the SAME Interpreter's Chamber home.html's Chamber card
    // opens (js/interpret-experience.js).
    await page.route('**/.netlify/functions/*', function (route) { route.abort(); });
    await page.click('#interp-cta-btn');
    await page.waitForSelector('#itp-root.open', { timeout: 5000 });
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: the hero opens the Chamber linked to THIS dream -- not the latest dream, not an ambiguous default -- when the account has several dreams', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // The result-entry half of tracker item
  // for-product-chamber-dream-linkage-is-unc-00s2dr. home.html's Chamber
  // card always opens the LATEST completed dream; entering from result must
  // instead operate on whichever dream this screen is showing.
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      state.dreams = [
        { id: 'd-oldest', ownerHandle: '@tester', caption: 'The oldest dream, about a glass staircase', style: 'Cinematic', videoUrl: 'https://example.com/a.mp4', isPublished: false, createdAt: '2026-07-01T00:00:00.000Z' },
        { id: 'd-middle', ownerHandle: '@tester', caption: 'The middle dream, about a red horse', style: 'Anime', videoUrl: 'https://example.com/b.mp4', isPublished: false, createdAt: '2026-07-10T00:00:00.000Z' },
        { id: 'd-latest', ownerHandle: '@tester', caption: 'The newest dream, about an empty city', style: 'Realistic', videoUrl: 'https://example.com/c.mp4', isPublished: false, createdAt: '2026-07-28T00:00:00.000Z' }
      ];
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=d-oldest', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#interp-cta-btn', { timeout: 5000 });

    await page.evaluate(function () {
      window.__openedWith = [];
      var realOpen = window.InterpretExperience.open;
      window.InterpretExperience.open = function (dreamId) {
        window.__openedWith.push(dreamId);
        return realOpen.apply(this, arguments);
      };
    });
    await page.route('**/.netlify/functions/*', function (route) { route.abort(); });
    await page.click('#interp-cta-btn');
    await page.waitForSelector('#itp-root.open', { timeout: 5000 });

    var openedWith = await page.evaluate(function () { return window.__openedWith; });
    assert.deepEqual(openedWith, ['d-oldest'], 'the Chamber must be opened for the dream result.html is showing (d-oldest), not the account\'s latest dream');
  } finally {
    await context.close();
  }
});

/** Reads every posthog.capture(...) call recorded so far. blockThirdParty() aborts PostHog's real asset, so the snippet in each page's <head> leaves window.posthog as its own queueing array — entries are ['capture', eventName, props]. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    return (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
  });
}

test('result.html ritual-card rebuild: tapping the hero fires result_hero_interpret with first_video:true on the account\'s only video, and first_video:false once it has more', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  for (var i = 0; i < 2; i++) {
    var onlyDream = i === 0;
    var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
      await page.evaluate(function (single) {
        var raw = localStorage.getItem('dreamtube_state_v1');
        var state = raw ? JSON.parse(raw) : {};
        state.user = { handle: '@tester', username: 'tester' };
        if (!state.accounts) state.accounts = {};
        state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
        state.dreams = [
          { id: 'd-event-target', ownerHandle: '@tester', caption: 'A dream about a golden city', style: 'Cinematic', videoUrl: 'https://example.com/a.mp4', isPublished: false, createdAt: '2026-07-20T00:00:00.000Z' }
        ];
        if (!single) {
          state.dreams.push({ id: 'd-event-other', ownerHandle: '@tester', caption: 'An earlier dream', style: 'Anime', videoUrl: 'https://example.com/b.mp4', isPublished: false, createdAt: '2026-07-10T00:00:00.000Z' });
        }
        localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
      }, onlyDream);
      await page.goto(baseUrl + '/result.html?id=d-event-target', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#interp-cta-btn', { timeout: 5000 });

      await page.route('**/.netlify/functions/*', function (route) { route.abort(); });
      await page.click('#interp-cta-btn');
      await page.waitForSelector('#itp-root.open', { timeout: 5000 });

      var calls = await readPostHogCalls(page);
      var events = calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'result_hero_interpret'; });
      assert.equal(events.length, 1, 'exactly one result_hero_interpret should fire per hero tap (only-dream: ' + onlyDream + ')');
      var props = events[0][2] || {};
      assert.equal(
        props.first_video,
        onlyDream,
        'first_video should be ' + onlyDream + ' when this ' + (onlyDream ? 'is' : 'is not') + ' the account\'s only completed video'
      );
      assert.equal(typeof props.first_video, 'boolean', 'first_video must be a real boolean, not a truthy value');
    } finally {
      await context.close();
    }
  }
});

test('result.html ritual-card rebuild: the token chip is off-screen on an ordinary result, and comes back only in the image-only state whose Turn-into-video hero is untouched', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    function measureInterp(pg) {
      return pg.$eval('#interp-cta-btn', function (el) {
        var cs = getComputedStyle(el);
        return { fontSize: parseFloat(cs.fontSize), height: el.getBoundingClientRect().height, quiet: el.classList.contains('quiet') };
      });
    }

    // (a) Video dream -- chip hidden, interpretation entry IS the hero.
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, baseUrl, 'd-chip-video-test');
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });
    assert.equal(await page.locator('#result-token-chip-slot').isVisible(), false, 'the token chip must be off-screen on an ordinary video result');
    var videoInterp = await measureInterp(page);
    assert.equal(videoInterp.quiet, false, 'the interpretation entry must be the full hero when it is the only hero on screen');
    // "Only you can see your reading" reassurance micro-line deleted
    // entirely (founder walkthrough punch list, 2026-08-01, tracker item
    // for-product-founder-walkthrough-punch-li-t33k3y, item 6) to recover
    // vertical space that was clipping the card's bottom on some
    // viewports.
    assert.equal(await page.locator('#interp-hero-micro').count(), 0, 'the hero\'s reassurance micro line must be gone entirely, not just hidden');

    // (b) Image-only dream -- chip back, Turn-into-video hero present with
    //     its token-cost pill intact (founder-explicit: untouched).
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      state.dreams.push({
        id: 'd-chip-image-test', ownerHandle: '@tester', caption: 'An image-only dream', style: 'Cinematic',
        imageUrl: 'https://example.com/fake-image.jpg', isPublished: false, createdAt: new Date().toISOString()
      });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=d-chip-image-test', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#turn-video-btn', { timeout: 5000 });
    assert.ok(await page.locator('#turn-video-btn').isVisible(), 'the Turn-into-video hero must show for an image-only dream');
    assert.match(await page.textContent('#turn-video-btn'), /100 tokens/, 'the Turn-into-video hero must keep its visible token cost (founder-explicit, unchanged)');
    assert.ok(await page.locator('#result-token-chip-slot').isVisible(), 'the token chip must come back in the image-only state');
    var imageInterp = await measureInterp(page);
    assert.equal(imageInterp.quiet, true, 'the interpretation entry must step down to its quiet treatment while the Turn-into-video hero is on screen');
    assert.ok(imageInterp.fontSize < videoInterp.fontSize, 'the quiet treatment should use a smaller label than the hero (got ' + imageInterp.fontSize + ' vs ' + videoInterp.fontSize + ')');
    assert.ok(imageInterp.height < videoInterp.height, 'the quiet treatment should be shorter than the hero (got ' + imageInterp.height + ' vs ' + videoInterp.height + ')');
    var turnVideoHeight = await page.$eval('#turn-video-btn', function (el) { return el.getBoundingClientRect().height; });
    assert.ok(turnVideoHeight > imageInterp.height, 'the Turn-into-video hero must stay the largest CTA in the image-only state');
    assert.equal(await page.locator('#interp-hero-micro').count(), 0, 'the hero micro line must be gone entirely here too');
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: the daily-claim sheet no longer auto-opens on this page (Home owns it) and this page no longer fires the repeat-visit install nudge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/token-status*', function (route) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ balance: 40, claimable: true, claimAmount: 100, nextClaimAt: null, streak: 1 })
      });
    });
    var dreamId = 'd-no-autoclaim-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });
    await page.waitForTimeout(1200);

    var claimSheetOpen = await page.evaluate(function () {
      var open = document.querySelectorAll('.sheet-overlay.open, .modal-overlay.open');
      return Array.prototype.map.call(open, function (el) { return el.id; });
    });
    assert.deepEqual(claimSheetOpen, [], 'nothing should auto-open over the result screen -- the daily-claim auto-open is removed from this page (got: ' + JSON.stringify(claimSheetOpen) + ')');
    assert.equal(await page.locator('#install-nudge-card').count(), 0, 'the repeat-visit install nudge must no longer render on this page (Home owns it)');

    var src = await page.evaluate(function () {
      var raw = Array.prototype.map.call(document.querySelectorAll('script:not([src])'), function (s) { return s.textContent; }).join('\n');
      return raw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')  // block comments
        .replace(/^[ \t]*\/\/.*$/gm, ' ');  // whole-line // comments
    });
    assert.ok(src.indexOf('maybeAutoOpenClaimSheet') === -1, 'result.html must not call PurchaseSheet.maybeAutoOpenClaimSheet at all');
    assert.ok(src.indexOf("'repeat-visit'") === -1, 'result.html must not init the repeat-visit install nudge trigger at all');
    assert.ok(src.indexOf("'session-transfer'") !== -1, 'the session-transfer install-nudge trigger must STAY on this page');
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: the prompt/caption clamps to 2 lines by default and expands/collapses on click', async function (t) {
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

    var fontSize = await page.$eval('#result-quote', function (el) { return parseFloat(getComputedStyle(el).fontSize); });
    assert.ok(fontSize <= 14, 'the caption should render in a small font (got ' + fontSize + 'px)');

    var clampedHeight = await page.$eval('#result-quote', function (el) { return el.getBoundingClientRect().height; });
    var isClamped = await page.$eval('#result-quote', function (el) { return el.classList.contains('clamped'); });
    assert.ok(isClamped, 'the caption should start clamped');
    await page.waitForSelector('#result-quote-hint', { state: 'visible', timeout: 5000 });
    assert.match(await page.textContent('#result-quote-hint'), /Show more/);

    await page.click('#result-quote');
    var expandedIsClamped = await page.$eval('#result-quote', function (el) { return el.classList.contains('clamped'); });
    assert.equal(expandedIsClamped, false, 'clicking the caption should remove the clamp');
    assert.match(await page.textContent('#result-quote-hint'), /Show less/);
    var expandedHeight = await page.$eval('#result-quote', function (el) { return el.getBoundingClientRect().height; });
    assert.ok(expandedHeight > clampedHeight, 'expanding should grow the box past its clamped height');

    await page.click('#result-quote');
    var recollapsedIsClamped = await page.$eval('#result-quote', function (el) { return el.classList.contains('clamped'); });
    assert.ok(recollapsedIsClamped, 'clicking again should re-clamp the caption');
    assert.match(await page.textContent('#result-quote-hint'), /Show more/);
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: Fresh (Private) vs Published visual states -- the state tag flips label/style, and tapping it while published reverts to private', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-statetag-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#result-privacy-tag', { timeout: 5000 });

    // Fresh state.
    assert.equal((await page.textContent('#result-privacy-tag')).trim(), 'Private');
    assert.equal(await page.locator('#result-privacy-tag.pub').count(), 0, 'the tag must not carry the .pub class while private');

    // Publish it.
    await page.click('#publish-btn');
    await page.waitForSelector('#modal-publish.open', { timeout: 5000 });
    await page.click('#publish-confirm');
    await page.waitForFunction(function () {
      var el = document.getElementById('result-privacy-tag');
      return el && el.classList.contains('pub');
    }, null, { timeout: 5000 });
    assert.match(await page.textContent('#result-privacy-tag'), /Public/);

    // Publish quiet-link becomes a navigational "Live on Explore" once
    // published -- unpublishing moves to the state tag tap instead (the
    // approved mock's own interaction model).
    assert.match(await page.textContent('#publish-btn'), /Live on Explore/);

    // Tapping the state tag while published reverts to private.
    await page.click('#result-privacy-tag');
    await page.waitForFunction(function () {
      var el = document.getElementById('result-privacy-tag');
      return el && !el.classList.contains('pub');
    }, null, { timeout: 5000 });
    assert.equal((await page.textContent('#result-privacy-tag')).trim(), 'Private');
    assert.match(await page.textContent('#publish-btn'), /Publish/);

    // Tapping the tag while already private is a no-op (nothing to revert).
    var dreamsAfter = await page.evaluate(function (id) {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return state.dreams.find(function (d) { return d.id === id; });
    }, dreamId);
    assert.equal(dreamsAfter.isPublished, false);
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: Publish still opens the publish confirmation modal, and once published it navigates to Explore instead of re-toggling', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-publish-nav-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });

    await page.click('#publish-btn');
    await page.waitForSelector('#modal-publish.open', { timeout: 5000 });
    await page.click('#publish-confirm');
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && t.textContent === 'Published to Explore';
    }, null, { timeout: 5000 });

    await page.click('#publish-btn'); // now "Live on Explore" -- navigates
    await page.waitForURL(/explore\.html/, { timeout: 5000 });
    assert.match(page.url(), /explore\.html/);
  } finally {
    await context.close();
  }
});

test('result.html FINAL placement (founder\'s 2026-07-31 amendment): Publish / Make another / Edit / Delete are the exactly-4 quiet links in that order, and Delete still runs the exact same confirm-then-delete flow', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-quiet-links-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });

    var ids = ['publish-btn', 'make-another-btn', 'open-edit-sheet', 'delete-btn'];
    for (var i = 0; i < ids.length; i++) {
      var visible = await page.locator('.result-quiet-links #' + ids[i]).isVisible();
      assert.ok(visible, '#' + ids[i] + ' should be visible inside .result-quiet-links');
    }
    var quietLinkCount = await page.locator('.result-quiet-links button').count();
    assert.equal(quietLinkCount, 4, 'the quiet-link row should have exactly 4 buttons, no more, no overflow-trigger sibling');

    // Order is Publish / Make another / Edit / Delete -- the founder's
    // final 2026-07-31 amendment on top of the approved mock (Edit moved
    // to sit next to Delete).
    var order = await page.$$eval('.result-quiet-links button', function (els) {
      return els.map(function (el) { return el.id; });
    });
    assert.deepEqual(order, ['publish-btn', 'make-another-btn', 'open-edit-sheet', 'delete-btn'], 'quiet-row order should be Publish / Make another / Edit / Delete');

    // No stale overflow-menu/old-placement ids anywhere.
    assert.equal(await page.locator('#result-more-btn').count(), 0, '#result-more-btn (the old overflow trigger) must not exist anywhere on the page');
    assert.equal(await page.locator('#result-more-menu').count(), 0, '#result-more-menu must not exist anywhere on the page');
    assert.equal(await page.locator('#overflow-delete-link').count(), 0, '#overflow-delete-link must not exist anywhere on the page');
    assert.equal(await page.locator('#edit-delete-link').count(), 0, '#edit-delete-link (the Edit-sheet placement) must not exist anywhere on the page');

    // Delete reads as an ORDINARY quiet link, not emphasized/red overall --
    // only its icon carries a danger tint (tracker.html's
    // for-product-result-quiet-row-v5-founder--4dnf5u).
    var deleteBtn = page.locator('#delete-btn');
    var deleteBtnColor = await deleteBtn.evaluate(function (el) { return getComputedStyle(el).color; });
    var editBtnColor = await page.locator('#open-edit-sheet').evaluate(function (el) { return getComputedStyle(el).color; });
    assert.equal(deleteBtnColor, editBtnColor, 'the Delete link\'s own text color must match the other quiet links exactly -- no full-red/emphasized styling');

    // Edit still opens an edit sheet -- the new default edit-delta sheet
    // (docs/EDIT_MECHANISM_SPEC.md) as of this feature, not the old full
    // mini-wizard directly (that one's still reachable via "Start over
    // instead", covered in test/sheet-dismiss-behavioral.test.js).
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open', { timeout: 5000 });
    await page.click('#delta-cancel');
    await page.waitForFunction(function () {
      var el = document.getElementById('sheet-edit-delta-overlay');
      return el && !el.classList.contains('open');
    }, null, { timeout: 5000 });

    // Delete -- clicking it opens the SAME confirmation modal, same copy,
    // same Cancel/Delete buttons, and the real deletion mechanics
    // (DreamStore.deleteDream + navigation to profile.html) are untouched.
    await page.click('#delete-btn');
    await page.waitForSelector('#modal-delete.open', { timeout: 5000 });
    assert.match(await page.textContent('#delete-modal-body'), /can't be undone/);

    await page.click('#delete-cancel');
    await page.waitForFunction(function () {
      var el = document.getElementById('modal-delete');
      return el && !el.classList.contains('open');
    }, null, { timeout: 5000 });
    var stillThereAfterCancel = await page.evaluate(function (id) {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return state.dreams.some(function (d) { return d.id === id; });
    }, dreamId);
    assert.ok(stillThereAfterCancel, 'cancelling should not delete the dream');

    await page.click('#delete-btn');
    await page.waitForSelector('#modal-delete.open', { timeout: 5000 });
    await page.click('#delete-confirm');
    await page.waitForURL(/profile\.html/, { timeout: 5000 });
    assert.match(page.url(), /profile\.html/);
    var stillThereAfterDelete = await page.evaluate(function (id) {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return state.dreams.some(function (d) { return d.id === id; });
    }, dreamId);
    assert.equal(stillThereAfterDelete, false, 'confirming delete should actually remove the dream from the store');
  } finally {
    await context.close();
  }
});

test('result.html: Make another still clears the draft and navigates to create.html (unchanged behavior)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, baseUrl, 'd-make-another-test');
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });

    await page.click('#make-another-btn');
    await page.waitForURL(/create\.html/, { timeout: 5000 });
    assert.match(page.url(), /create\.html/);
  } finally {
    await context.close();
  }
});

test('result.html: deleting a published dream still shows the extended Explore-removal warning (unchanged copy)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-overflow-delete-published-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.evaluate(function (id) {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      state.dreams.forEach(function (d) { if (d.id === id) d.isPublished = true; });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    }, dreamId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.result-quiet-links', { timeout: 5000 });

    await page.click('#delete-btn');
    await page.waitForSelector('#modal-delete.open', { timeout: 5000 });
    assert.match(await page.textContent('#delete-modal-body'), /removed from Explore immediately/, 'a published dream should still get the extended warning copy');
  } finally {
    await context.close();
  }
});

test('result.html ritual-card rebuild: the relocated Share pill (in the hero\'s tag row) still keeps its publishes-if-private behavior', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-share-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#share-btn svg', { timeout: 5000 });
    assert.equal(await page.locator('.tagrow #share-btn').count(), 1, 'share must render inside the hero\'s .tagrow');

    // Unpublished dream: Share must route through the publish modal first
    // (unchanged existing behavior), not a plain visual re-skin only.
    await page.click('#share-btn');
    await page.waitForSelector('#modal-publish.open', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('result.html: mute (the only remaining video chip) and the relocated Share pill both stay real >=32px tap targets and lay out with no overlap at 320px', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 320, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreamId = 'd-nav-320-test';
    await seedResultPage(page, baseUrl, dreamId);
    await page.waitForSelector('#mute-btn', { timeout: 5000 });

    assert.equal(await page.locator('.topbar').count(), 0, 'the .topbar element must be gone entirely at 320px too');
    assert.equal(await page.locator('#result-back').count(), 0, '#result-back must not exist at 320px either');

    var boxes = await page.$$eval(
      '#mute-btn, #share-btn',
      function (els) {
        return els.map(function (el) {
          var r = el.getBoundingClientRect();
          return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        });
      }
    );
    assert.equal(boxes.length, 2, 'expected mute + the relocated share pill, and nothing else');
    // 0.1px epsilon: .heroshare's CSS already declares min-height:32px
    // explicitly (result.html) -- the shortfall observed here (e.g.
    // 31.999969482421875) is Chromium's own sub-pixel layout float
    // rounding on a border-box element with a 1px border, not a real,
    // perceptible tap-target regression. A strict >=32 comparison makes
    // this assertion fail on exactly the intended value.
    var TAP_TARGET_EPSILON = 0.1;
    boxes.forEach(function (b) {
      assert.ok(b.width > 0 && b.height > 0, b.id + ' should have a real, non-collapsed box at 320px');
      assert.ok(b.width >= 32 - TAP_TARGET_EPSILON && b.height >= 32 - TAP_TARGET_EPSILON, b.id + ' should stay a real tap target at 320px (got ' + b.width + 'x' + b.height + ')');
    });
    // Not over the video and not overlapping each other -- different
    // regions of the card entirely now (mute over the video, share in the
    // tag row well below it), but still worth a cheap overlap check.
    var a = boxes[0], b = boxes[1];
    var overlapsHorizontally = a.left < b.right && b.left < a.right;
    var overlapsVertically = a.top < b.bottom && b.top < a.bottom;
    assert.ok(!(overlapsHorizontally && overlapsVertically), 'mute and the relocated share pill should not visually overlap');
  } finally {
    await context.close();
  }
});

test('result.html FINAL placement: all 4 quiet links fit on a single row at 375px and 320px, including for an image-type dream where the Turn-into-video CTA is also present', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  for (var i = 0; i < 2; i++) {
    var width = i === 0 ? 375 : 320;
    for (var j = 0; j < 2; j++) {
      var isImageDream = j === 1;
      var context = await browser.newContext({ viewport: { width: width, height: 800 } });
      try {
        var page = await context.newPage();
        await blockThirdParty(page);
        var dreamId = 'd-quiet-row-fit-' + width + '-' + (isImageDream ? 'image' : 'video');
        if (isImageDream) {
          await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
          await page.evaluate(function (id) {
            var raw = localStorage.getItem('dreamtube_state_v1');
            var state = raw ? JSON.parse(raw) : {};
            state.user = { handle: '@tester', username: 'tester' };
            if (!state.accounts) state.accounts = {};
            state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
            if (!state.dreams) state.dreams = [];
            state.dreams.push({
              id: id, ownerHandle: '@tester', caption: 'A test dream, image only', style: 'Cinematic',
              imageUrl: 'https://example.com/fake-image.jpg', isPublished: false, createdAt: new Date().toISOString()
            });
            localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
          }, dreamId);
          await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
        } else {
          await seedResultPage(page, baseUrl, dreamId);
        }
        await page.waitForSelector('.result-quiet-links', { timeout: 5000 });
        if (isImageDream) {
          await page.waitForSelector('#turn-video-btn[style*="flex"]', { timeout: 5000 });
        }

        var boxes = await page.$$eval('.result-quiet-links button', function (els) {
          return els.map(function (el) {
            var r = el.getBoundingClientRect();
            return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          });
        });
        assert.equal(boxes.length, 4, 'expected exactly the 4 quiet links at ' + width + 'px (image dream: ' + isImageDream + ')');
        boxes.forEach(function (b) {
          assert.ok(b.width > 0 && b.height > 0, b.id + ' should have a real, non-collapsed box at ' + width + 'px');
        });
        var tops = boxes.map(function (b) { return b.top; });
        var maxTopDelta = Math.max.apply(null, tops) - Math.min.apply(null, tops);
        assert.ok(maxTopDelta < 4, 'all 4 quiet links should sit on a single row at ' + width + 'px (image dream: ' + isImageDream + '), got a ' + maxTopDelta + 'px top spread');
        for (var a = 0; a < boxes.length; a++) {
          for (var b2 = a + 1; b2 < boxes.length; b2++) {
            var overlaps = boxes[a].left < boxes[b2].right && boxes[b2].left < boxes[a].right;
            assert.ok(!overlaps, boxes[a].id + ' and ' + boxes[b2].id + ' should not overlap at ' + width + 'px');
          }
        }
      } finally {
        await context.close();
      }
    }
  }
});

// ===== Fullscreen dream playback (founder amendment, 2026-07-31) =====
// Tapping the video/play-badge/watch-pill opens the SAME <video> element
// full-bleed -- native fullscreen where available/allowed, an in-app
// full-viewport overlay fallback (with this page's own existing mute +
// tap-to-toggle controls) where it isn't (the FB/IG in-app-webview case the
// founder specifically flagged). document.fullscreenEnabled is the real,
// feature-detected signal for "is native fullscreen allowed here" -- these
// tests drive both branches by stubbing that signal directly, exactly the
// mechanism result.html's own code reads, rather than guessing at a UA
// string.
test('result.html fullscreen playback: tapping the video calls the native Fullscreen API when the embedding context allows it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await context.addInitScript(function () {
      window.__fullscreenCalls = [];
      HTMLMediaElement.prototype.requestFullscreen = function () {
        window.__fullscreenCalls.push('requestFullscreen');
        return Promise.resolve();
      };
      Object.defineProperty(document, 'fullscreenEnabled', { get: function () { return true; }, configurable: true });
    });
    await seedResultPage(page, baseUrl, 'd-fullscreen-native-test');
    await page.waitForSelector('#dreamvideo-frame', { timeout: 5000 });

    await page.click('#dreamvideo-frame');
    await page.waitForFunction(function () { return window.__fullscreenCalls && window.__fullscreenCalls.length > 0; }, null, { timeout: 5000 });
    var calls = await page.evaluate(function () { return window.__fullscreenCalls; });
    assert.deepEqual(calls, ['requestFullscreen']);
    assert.equal(await page.locator('.player-overlay.open').count(), 0, 'the in-app overlay fallback must not open when native fullscreen succeeds');
  } finally {
    await context.close();
  }
});

test('result.html fullscreen playback: falls back to the in-app full-viewport overlay (with its own mute + tap-to-toggle controls) when native fullscreen is disabled -- the FB/IG in-app-webview case', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Simulate the FB/IG in-app-webview restriction: no iOS-specific API,
    // and the standard Fullscreen API reports itself as disabled -- exactly
    // what a webview that's turned off native fullscreen via
    // Permissions-Policy looks like from script.
    await context.addInitScript(function () {
      delete HTMLVideoElement.prototype.webkitEnterFullscreen;
      Object.defineProperty(document, 'fullscreenEnabled', { get: function () { return false; }, configurable: true });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { get: function () { return false; }, configurable: true });
    });
    await seedResultPage(page, baseUrl, 'd-fullscreen-fallback-test');
    await page.waitForSelector('#dreamvideo-frame', { timeout: 5000 });

    await page.click('#dreamvideo-frame');
    await page.waitForSelector('.player-overlay.open', { timeout: 5000 });
    // The SAME <video> element must now live inside the overlay, not a
    // second copy.
    var videoInOverlay = await page.locator('.player-overlay #result-video').count();
    assert.equal(videoInOverlay, 1, 'the same #result-video element must be reparented into the overlay, not duplicated');

    // The overlay's own mute control works and is synced with the in-card
    // one.
    var mutedBefore = await page.$eval('#result-video', function (v) { return v.muted; });
    await page.click('#player-mute-btn');
    var mutedAfter = await page.$eval('#result-video', function (v) { return v.muted; });
    assert.notEqual(mutedBefore, mutedAfter, 'the overlay\'s mute chip must actually toggle the real video\'s muted state');

    // Closing restores the video to the card.
    await page.click('#player-close-btn');
    await page.waitForFunction(function () {
      var overlay = document.getElementById('player-overlay');
      return overlay && !overlay.classList.contains('open');
    }, null, { timeout: 5000 });
    var videoBackInCard = await page.locator('#dreamvideo-frame #result-video').count();
    assert.equal(videoBackInCard, 1, 'closing the overlay must move the video back into the card, not leave it stranded');
  } finally {
    await context.close();
  }
});

test('result.html fullscreen playback: the external "Watch your dream" pill opens the same fullscreen player as tapping the video itself', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await context.addInitScript(function () {
      delete HTMLVideoElement.prototype.webkitEnterFullscreen;
      Object.defineProperty(document, 'fullscreenEnabled', { get: function () { return false; }, configurable: true });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { get: function () { return false; }, configurable: true });
    });
    await seedResultPage(page, baseUrl, 'd-watchpill-test');
    await page.waitForSelector('#watch-pill', { timeout: 5000 });

    // The pill is a real, visible affordance OUTSIDE the video itself --
    // not just an in-video badge (founder amendment 2).
    assert.ok(await page.locator('#watch-pill').isVisible(), '#watch-pill must be a real, visible control outside the video');
    var pillBox = await page.$eval('#watch-pill', function (el) { return el.getBoundingClientRect(); });
    var videoBox = await page.$eval('#dreamvideo-frame', function (el) { return el.getBoundingClientRect(); });
    assert.ok(pillBox.top >= videoBox.bottom - 1, 'the watch pill must sit outside (below) the video frame, not inside it');

    await page.click('#watch-pill');
    await page.waitForSelector('.player-overlay.open', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('result.html fullscreen playback: the watch pill and play badge are both hidden for an image-only dream -- there is nothing to "watch"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      if (!state.dreams) state.dreams = [];
      state.dreams.push({
        id: 'd-watchpill-image-test', ownerHandle: '@tester', caption: 'An image-only dream', style: 'Cinematic',
        imageUrl: 'https://example.com/fake-image.jpg', isPublished: false, createdAt: new Date().toISOString()
      });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=d-watchpill-image-test', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#result-image', { timeout: 5000 });

    assert.equal(await page.locator('#watch-pill').isVisible(), false, 'the watch pill must be hidden for an image-only dream');
    assert.equal(await page.locator('#result-play-badge').isVisible(), false, 'the in-video play badge must be hidden for an image-only dream');
  } finally {
    await context.close();
  }
});


// ===========================================================================
// Advanced screen (9) / pricing screen (14) fixes -- commit ae7da62.
//
// REMOVED (not replaced): start.html's Advanced > Characters screen
// (renderScreenAdvChars) and its caption-based "does this dream involve
// people?" heuristic (captionSuggestsPeople) were removed outright
// 2026-07-31 -- founder ruling (tracker item
// for-product-urgent-founder-screenshots-i-g64gjp) enforcing the same
// "too many options, no mid-funnel customizing" call already made
// 2026-07-29 about this exact class of mid-funnel step: character setup
// belongs only in create.html's own Advanced section now. Everything that
// used to have dedicated coverage here -- the "dawn" light-phase rendering,
// the 4-dot vs 3-dot progress bar depending on caption wording, the dynamic
// PREPARING_STEP lookup across a variable-length SCREEN_RENDERERS, the
// character add/select/edit interactions writing into `staged`, and the
// "Me" chip auto-select bug fix -- no longer applies; there is no longer a
// caption-dependent screen to show, hide, or index around. The
// chip-edit-area tap-target fix is still real (shared CSS/markup with
// create.html's own Advanced accordion), so it's kept, ported to
// create.html just below. The camera/scenery screens PARKED alongside the
// old characters screen (founder decision 2026-07-24, tracker item
// for-product-two-post-handoff-app-pages-p-atr0r7) are UNAFFECTED by this
// removal and still get their own (now simplified) check.
// ===========================================================================

test('parked camera/scenery screens never render in start.html\'s funnel tail, and the removed characters screen never renders either, regardless of caption wording', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying with my sister'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    assert.ok((await page.$('#fn-adv-chars-continue')) === null, 'the removed characters screen must never render');
    assert.ok((await page.$('#fn-adv-camera-continue')) === null, 'the parked camera screen must never render');
    assert.ok((await page.$('#fn-adv-scenery-continue')) === null, 'the parked scenery screen must never render');

    var dotCount = await page.$$eval('.fn-progress i', function (els) { return els.length; });
    assert.equal(dotCount, 2, 'expected exactly 2 progress dots -- email + pricing/confirmation, the only two screens left in the funnel tail');

    // cameraView/sceneryTime/sceneryPlace are never set for a funnel-resumed
    // visitor (their collection screens are parked) -- confirms the draft
    // is left at its default null shape rather than something downstream
    // (start-pending-generation.js's POST body) would choke on.
    var draft = await page.evaluate(function () { return DreamStore.getDraft(); });
    assert.equal(draft.cameraView, null);
    assert.equal(draft.sceneryTime, null);
    assert.equal(draft.sceneryPlace, null);
  } finally {
    await context.close();
  }
});

test('create.html: Advanced accordion chip-edit-area padding is comfortably close to the ~44px mobile tap-target guideline, not the old ~32px version (ported from start.html\'s own copy of this fix, since removed along with start.html\'s Advanced > Characters screen -- tracker item for-product-urgent-founder-screenshots-i-g64gjp)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Real signup via the UI, so create.html's own "must be logged in" guard
    // passes -- same pattern as the "Advanced accordion chips render..."
    // test just below.
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'chipedgetester');
    await page.fill('#login-email', 'chipedgetester@example.com');
    await page.fill('#login-password', 'longenoughpassword1');
    await page.click('#login-submit');
    await page.waitForURL(/home\.html/, { timeout: 5000 });

    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });
    await page.click('#choice-write');
    await page.click('#adv-toggle');
    await page.waitForSelector('.adv-section.open', { timeout: 5000 });

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
    // Just reaching an authenticated state here -- the destination itself
    // (now home.html, not explore.html, see the login-redirect tests above)
    // doesn't matter since the very next line navigates straight to
    // create.html regardless.
    await page.waitForURL(/home\.html/, { timeout: 5000 });

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
    // Just reaching an authenticated state here -- the destination itself
    // (now home.html, not explore.html, see the login-redirect tests above)
    // doesn't matter since the very next line navigates straight to
    // create.html regardless.
    await page.waitForURL(/home\.html/, { timeout: 5000 });

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

test('pricing screen (14, now the token intro + confirmation): Continue completes the funnel directly (the former screen 15 was folded in -- tracker item for-product-funnel-handoff-screens-theme-5ttymn) and fires the renamed acknowledgment tracking event (no plan involved anymore)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    // Must be installed before goToPricingScreen's own page.goto() below --
    // see installPosthogCaptureRecorder's own comment for why a plain
    // in-page monkeypatch (this test's old approach) no longer survives
    // now that Continue navigates away in the same click.
    var phCalls = await installPosthogCaptureRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await goToPricingScreen(page, 'token-intro@example.com');
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });

    await page.click('#fn-s14-continue');
    // Continue now fires completeFunnel() directly (no separate screen 15
    // to land on first) -- confirms the funnel actually completed. Lands
    // on home.html now, not processing.html (tracker item for-product-
    // funnel-ending-v2-founder-ins-tfuu0q removed that page).
    await page.waitForURL(/home\.html/, { timeout: 8000, waitUntil: 'domcontentloaded' });

    var continuedCalls = phCalls.filter(function (c) { return c.name === 'funnel_token_intro_continued'; });
    var completedCalls = phCalls.filter(function (c) { return c.name === 'funnel_completed'; });
    var oldBypassedCalls = phCalls.filter(function (c) { return c.name === 'funnel_pricing_bypassed'; });
    var oldPlanSelectedCalls = phCalls.filter(function (c) { return c.name === 'funnel_plan_selected'; });
    assert.equal(continuedCalls.length, 1, 'expected exactly one funnel_token_intro_continued call, from Continue');
    assert.equal(continuedCalls[0].props.step, 14);
    assert.equal(completedCalls.length, 1, 'expected exactly one funnel_completed call, from the same Continue click now that screen 15 is folded in');
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
    // Replaced with the real signup grant (320 tokens, matching
    // lib/entitlements.js's INITIAL_GRANT and wizard.html's own
    // renderSignup screen). "No card needed" is still accurate and kept.
    assert.doesNotMatch(cardText, /still in beta/i, 'the beta framing must be gone now that the store is live');
    assert.match(cardText, /free to start/i);
    assert.match(cardText, /320 tokens/i, 'should state the real signup grant, matching entitlements.js\'s INITIAL_GRANT');
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

test('start.html: generate-during-signup -- screen 13\'s Continue starts a pending generation in parallel with signup, and success adopts + resumes it straight through home.html with no second submission', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
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
    // home.html resumes the adopted pendingJob by polling video-status
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

    await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    // As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), start.html's former characters and "preparing" transition
    // screens were removed outright -- a fresh ?resume=1 load lands directly
    // on screen 13.
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await signupFlow.advanceToPasswordStep(page, 'start-pending-test@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Must reach screen 14 -- proves signup succeeded AND the pending call
    // was awaited (both settle before Continue advances the funnel).
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'start-pending-generation must be called exactly once, from screen 13\'s Continue');
    assert.equal(startPendingCalls[0].email, 'start-pending-test@example.com');
    assert.equal(startPendingCalls[0].caption, 'I had a dream about flying');
    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, right after signup succeeds');
    assert.equal(claimCalls[0].pendingId, 'pd-start-test-1');

    var pendingJob = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJob, 'the pending job must already be adopted into DreamStore by the time screen 14 renders');
    assert.equal(pendingJob.operationName, 'fal:fake-model:req-1');

    // Click through pricing + confirmation to home.html, and confirm it
    // resumes the ALREADY-adopted job rather than submitting a fresh one.
    // Screen 14's Continue now completes the funnel directly (the former
    // standalone screen 15 confirmation was folded into it -- tracker item
    // for-product-funnel-handoff-screens-theme-5ttymn), so there's no
    // separate screen to click through anymore. Lands directly on home.html
    // now (tracker item for-product-funnel-ending-v2-founder-ins-tfuu0q --
    // processing.html/the old redirect to result.html are both gone); the
    // generating tile resolving confirms the adopted job actually completed.
    await page.click('#fn-s14-continue');
    await page.waitForURL(/home\.html/, { timeout: 15000 });
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 15000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'must never re-submit generation after signup -- the whole point of adoptPendingGeneration');
    assert.ok(videoStatusCalls >= 1, 'home.html must actually resume polling the adopted job');
  } finally {
    await context.close();
  }
});

test('start.html: generate-during-signup -- if the pre-signup generation call fails, signup still completes normally and falls back to a fresh generation at home.html (resilient, not a dead end)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E7: insufficient_tokens' }) });
    });
    // home.html's own fresh-submission fallback (?generate=1) genuinely
    // calls DreamStore.generateVideo() now -- mocked here (unlike the old
    // version of this test, which only ever needed to prove the INPUTS to
    // that fallback were correct, since processing.html's own separately-
    // tested runGeneration() was trusted to pick them up) so this test can
    // observe the fallback actually firing, not just its precondition.
    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fake-model:req-start-fallback' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    // As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), start.html's former characters and "preparing" transition
    // screens were removed outright -- a fresh ?resume=1 load lands directly
    // on screen 13.
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await signupFlow.advanceToPasswordStep(page, 'start-pending-fallback@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Must still reach screen 14 despite the pre-signup call failing.
    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });
    var pendingJob = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.equal(pendingJob, null, 'no pendingJob should have been adopted since the pre-signup call failed');
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.ok(draft.caption, 'draft caption must still be set for the fallback fresh-generation path at home.html');

    await page.click('#fn-s14-continue');
    // Lands on home.html carrying ?generate=1 (see that page's own "Fresh
    // in-app generation submission" script block, which strips the param
    // via history.replaceState almost immediately -- not asserted on here
    // to avoid a race with that strip) -- a real generation genuinely gets
    // submitted from the intact draft, proving the fallback actually works
    // end to end, not just that its inputs were correct.
    await page.waitForURL(/home\.html/, { timeout: 15000 });
    await page.waitForFunction(function () {
      return !!(window.DreamStore && window.DreamStore.getPendingJob());
    }, null, { timeout: 10000 });
  } finally {
    await context.close();
  }
});

test('start.html: generate-during-signup -- REGRESSION: signup failing AFTER the parallel pending-generation call already succeeded must NOT re-fire a second real, billed generation when the visitor retries with the same email', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
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

    await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    // As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), start.html's former characters and "preparing" transition
    // screens were removed outright -- a fresh ?resume=1 load lands directly
    // on screen 13.
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await signupFlow.advanceToPasswordStep(page, 'retry-same-email@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // First attempt: signup rejected, error shown -- pending-generation
    // already fired once (and succeeded, per the mock above).
    await page.waitForFunction(function () {
      var el = document.getElementById('fn-signup-error');
      return !!(el && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'start-pending-generation should have fired exactly once so far');

    // Retry with the SAME email -- an entirely normal thing to do after a
    // rejected signup attempt -- must NOT fire a second real, billed
    // generation call; the already-succeeded pending job must be reused.
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });

    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'REGRESSION GUARD: start-pending-generation must still have fired only once -- reusing the already-succeeded pending job on retry, never re-submitting a second real generation for the same email');
    await settle(function () { return claimCalls.length >= 1; });
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

    await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    // As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), start.html's former characters and "preparing" transition
    // screens were removed outright -- a fresh ?resume=1 load lands directly
    // on screen 13.
    await signupFlow.advanceToPasswordStep(page, 'first-email@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');
    await page.waitForFunction(function () {
      var el = document.getElementById('fn-signup-error');
      return !!(el && el.textContent.trim().length);
    }, null, { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1);

    // Change to a genuinely different email and retry -- via the "Change
    // email" link (the password step's own #fn-email is readonly, so it
    // can't be refilled directly), the same escape hatch a real visitor
    // switching emails would use.
    await page.click('#fn-s13-change-email');
    await signupFlow.advanceToPasswordStep(page, 'second-email@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });

    await settle(function () { return startPendingCalls.length >= 2; });
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

    await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    // As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), start.html's former characters and "preparing" transition
    // screens were removed outright -- a fresh ?resume=1 load lands directly
    // on screen 13.
    await signupFlow.advanceToPasswordStep(page, 'first-email@example.com');
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
    // Via the "Change email" link, same reasoning as the test above.
    await page.click('#fn-s13-change-email');
    await signupFlow.advanceToPasswordStep(page, 'second-email@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
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
    await settle(function () { return claimCalls.length >= 1; });
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
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });
    // As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), start.html's former characters and "preparing" transition
    // screens were removed outright -- a fresh ?resume=1 load lands directly
    // on screen 13.
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
    await mockTokenStatus(page, { balance: 150, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0, hasMadeFirstPurchase: true });
    await seedLoggedInUserAt(page, baseUrl, 'shopbetatester', '/shop.html');
    await page.waitForSelector('#shop-cost-banner', { timeout: 5000 });

    var bannerText = await page.textContent('#shop-cost-banner');
    // Store-launch copy sweep (tracker item
    // for-product-store-launch-copy-sweep-purc-m6xhkx): "Free during
    // beta -- no card needed" / "nothing to buy right now" directly
    // contradicted the live Buy buttons right below it once Dodo
    // Payments checkout actually went live -- replaced with the real
    // cost facts (must match lib/entitlements.js's real
    // VIDEO_TOKEN_COST/IMAGE_TOKEN_COST/DAILY_CLAIM_AMOUNT, not
    // stale/guessed numbers). Still true after "The Vault" redesign
    // (tracker item for-product-build-ship-today-founder-app-zn9zyy).
    assert.doesNotMatch(bannerText, /free during beta/i, 'the beta framing must be gone now that the store is live');
    assert.doesNotMatch(bannerText, /nothing to buy right now/i, 'must not claim there is nothing to buy -- live packs are right below it');
    assert.match(bannerText, /100 tokens/i, 'should state the real video cost');
    assert.match(bannerText, /10\b/, 'should state the real image cost');
    assert.match(bannerText, /free/i, 'should still mention the free daily grant exists');

    // Token packs are real, live purchases (Dodo Payments), each button
    // stating its own exact price ("Pay $X.XX") -- see
    // test/shop-behavioral.test.js for full pack-button coverage.
    var buttonText = (await page.textContent('#shop-buy-pack199')).trim();
    assert.match(buttonText, /^Pay \$1\.99$/, 'buy buttons must state the exact price, not a generic "Buy"');

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
    await mockTokenStatus(page, { balance: 0, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
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
    assert.match(sheetText, /claim 100 free tokens in/i, 'the free daily-claim path must stay visible alongside the buy CTA, never hidden');
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
    await mockTokenStatus(page, { balance: 0, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    await seedResultPage(page, baseUrl, 'd-quota-modal-test');
    await page.waitForSelector('#open-edit-sheet', { timeout: 5000 });
    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet's #edit-generate-again this test uses.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open', { timeout: 5000 });
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#edit-generate-again', { timeout: 5000 });
    await page.click('#edit-generate-again');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var sheetText = await page.textContent('#purchase-sheet-overlay');
    assert.match(sheetText, /\$\d/, 'the one-tap purchase CTA must show a real price now -- the store launched');
    assert.match(sheetText, /claim 100 free tokens in/i, 'the free daily-claim path must stay visible alongside the buy CTA, never hidden');
    assert.match(sheetText, /Secure checkout via Dodo/i);
  } finally {
    await context.close();
  }
});

/**
 * Bug report (profile-improvements-kwivqb): "+100 in now" (the token
 * countdown) never resets once it reaches "now" -- because the page's 60s
 * setInterval only re-rendered the SAME cached tokenStatus object, it never
 * re-fetched get-token-status.js, so once nextClaimAt passed, the displayed
 * countdown froze there forever even though the account had already become
 * claimable server-side. Fix: once nextClaimAt has passed, the interval
 * callback re-fetches instead of just re-formatting. Uses page.clock to
 * fast-forward past both the claim-eligible time and the 60s interval
 * without a real wait, and a second get-token-status.js route response (a
 * distinctly different claimable state) to prove a genuine second fetch
 * happened, not just a re-render of the first response.
 *
 * This property was originally asserted on profile.html AND shop.html,
 * since both carried a countdown. profile.html no longer has one at all:
 * the founder-approved Profile night restyle (tracker item
 * for-product-build-founder-approved-2026--to6ew2) replaced its chip with
 * js/purchase-sheet.js's plain, claim-free variant and deleted the polling
 * interval outright -- home.html is the sole claim/ritual surface now. The
 * profile.html copies of this test and of the two claimable-state tests
 * that followed it were removed alongside that behavior rather than left
 * asserting something deleted on purpose; shop.html keeps every one of
 * those properties, and test/profile-night-restyle-behavioral.test.js
 * asserts the claim UI is genuinely gone from Profile.
 */
test('shop.html: the token countdown re-fetches (not just re-renders stale data) once it reaches "now", revealing the claim button', async function (t) {
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
        ? { balance: 90, claimable: false, nextClaimAt: Date.now() + 30000, dailyClaimAmount: 10, streak: 0 }
        : { balance: 90, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 10, streak: 0 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await seedLoggedInUserAt(page, baseUrl, 'shopcountdownstuck', '/shop.html');
    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent.indexOf('90') !== -1;
    }, null, { timeout: 5000 });
    await settle(function () { return callCount >= 1; });
    assert.equal(callCount, 1);

    await page.clock.fastForward(65000);
    await page.waitForSelector('#shop-claim-btn:visible', { timeout: 5000 });

    await settle(function () { return callCount >= 2; });
    assert.equal(callCount, 2, 'expected exactly one re-fetch once the countdown reached "now"');
    var countdownText = await page.textContent('#shop-countdown');
    assert.doesNotMatch(countdownText, /in now/i, 'must not still read "in now" after the re-fetch');
  } finally {
    await context.close();
  }
});

/**
 * 2026-07-28 daily-claim switch (tracker item
 * for-product-build-the-daily-token-claim--fngrwd): the old ≥200
 * GRANT_CEILING this section used to test (tracker item
 * for-product-bug-founder-high-token-chip--kn1v8t -- a permanent "+20 in
 * now" for any at-ceiling account) is RETIRED ENTIRELY, not just fixed
 * again -- see lib/entitlements.js's own doc block for why no ceiling is
 * needed anymore (nothing accrues without an active claim tap, so there's
 * nothing left for a ceiling to guard against). The equivalent honesty
 * property this section now tests: a CLAIMABLE account (any balance, no
 * ceiling-adjacent special-casing) shows the live "Claim +N free" copy,
 * never a stale "+N in now" countdown, and does NOT re-fetch on every 60s
 * tick just because it's sitting in the (now perfectly stable, not
 * permanently-past) claimable state.
 */
test('shop.html: a claimable balance shows the "Claim N free tokens" button, never "in now"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1500, claimable: true, nextClaimAt: Date.now() - 3600000, dailyClaimAmount: 20, streak: 4 });
    await seedLoggedInUserAt(page, baseUrl, 'foundermaxedshop', '/shop.html');
    await page.waitForSelector('#shop-claim-btn:visible', { timeout: 5000 });

    var balance = await page.textContent('#shop-balance');
    assert.match(balance, /1500/);

    var countdown = await page.textContent('#shop-countdown');
    assert.doesNotMatch(countdown, /in now/i, 'must never render "in now" for a claimable account');
    var claimLabel = await page.textContent('#shop-claim-label');
    assert.match(claimLabel, /Claim 20 free tokens/i);
  } finally {
    await context.close();
  }
});

test('shop.html: a claimable account never re-fetches on the 60s countdown tick', async function (t) {
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
        balance: 1500, claimable: true, nextClaimAt: Date.now() - 3600000, dailyClaimAmount: 20, streak: 4
      }) });
    });

    await seedLoggedInUserAt(page, baseUrl, 'ceilingnopollshop', '/shop.html');
    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent.indexOf('1500') !== -1;
    }, null, { timeout: 5000 });
    await settle(function () { return callCount >= 1; });
    assert.equal(callCount, 1, 'sanity: exactly one fetch on initial load');

    await page.clock.fastForward(65000);
    await page.clock.fastForward(65000);

    await settle(function () { return callCount >= 1; });
    assert.equal(callCount, 1, 'must not re-fetch on any tick while already claimable');
    var claimBtnVisible = await page.isVisible('#shop-claim-btn');
    assert.equal(claimBtnVisible, true, 'should still show the claim button after ticks with no re-fetch');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// REMOVED (2026-07-30, tracker item
// for-product-build-founder-approved-2026--to6ew2): three further
// profile.html token-chip tests lived here -- "a NOT-yet-claimable balance
// still shows a normal live countdown", plus the media-aware low-balance
// label pair from tracker item for-product-store-launch-copy-sweep-purc-m6xhkx
// ("Low" for a balance that can still afford a 10-token image, "Out of
// tokens" only below that). None of those states exist on Profile anymore:
// the founder-approved night restyle replaced its chip with
// js/purchase-sheet.js's PLAIN variant, which renders the balance and a
// Shop link and nothing else. That removes copy, never accuracy -- the
// plain chip states no affordability claim at all, so the honesty bug
// m6xhkx fixed cannot recur there. The compact topbar chip on
// create/style/result keeps its own low-balance treatment, the shop keeps
// the full countdown/claim coverage above, and
// test/profile-night-restyle-behavioral.test.js pins the plain chip's
// actual shape.
// ===========================================================================
