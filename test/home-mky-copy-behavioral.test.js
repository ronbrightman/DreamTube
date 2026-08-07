// test/home-mky-copy-behavioral.test.js
//
// Behavioral coverage for the Make-it-yours card's "install" vs "add to
// your home screen" copy split (tracker item for-product-build-ship-
// today-founder-app-zn9zyy's home-related portion, the founder-amendment
// comment, 2026-08-02T08:18) -- unified everywhere on that card (reward
// line, done-state, the inline install-row CTA + its supporting text, the
// no-PwaInstall webview fallback note) plus js/install-nudge.js's own
// small nudge card's fallback CTA button (the same split existed there
// too -- its head already said "Add DreamTube to your home screen", but
// its button underneath said "Install").
//
// RENAMED from home-hero-whisper-mky-copy-behavioral.test.js (tracker item
// for-product-founder-08-07-homepage-hero--015hgp): this file used to also
// cover the Tonight hero's "empty sky" moon + cycling whisper line, the
// OTHER disjoint piece of the same zn9zyy tracker item's home-related
// portion. The founder's 015hgp ruling replaced that whole card's
// unlogged prompt state (whisper included) with a single bare button, so
// the whisper feature itself no longer exists anywhere in home.html --
// that section's tests were deleted rather than updated (nothing left to
// assert), and this file was renamed to describe what it actually covers
// now that only piece 2 remains. See git history for the deleted whisper
// coverage if ever useful as a reference for reintroducing similar copy.
//
// Follows this repo's established Playwright/node:test convention (test/
// home-round4-behavioral.test.js's own seedHomeUser/mockTokenStatus/
// mockFeed/blockThirdParty shape) rather than inventing a new one.

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

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
  });
}

function mockFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
  });
}

/** Seeds a logged-in account directly into localStorage and navigates to home.html -- same shape as test/home-round4-behavioral.test.js's own seedHomeUser. */
async function seedHomeUser(page, opts) {
  opts = opts || {};
  var username = opts.username || 'tester';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {
      user: { handle: '@' + args.username, username: args.username },
      accounts: {},
      draft: {},
      dreams: args.dreams || []
    };
    state.accounts[args.username] = Object.assign({ password: 'testpass1', email: args.username + '@example.com', noRecallDates: args.noRecallDates || [] }, args.accountExtra || {});
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreams: opts.dreams, noRecallDates: opts.noRecallDates, accountExtra: opts.accountExtra });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

// ============================================================================
// MAKE-IT-YOURS CARD -- "install" vs "add to your home screen" unified
// ============================================================================

test('home.html: the Make-it-yours reward line and done-state both say "add to your home screen"/"phone", never bare "install"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var currentBalance = 220;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: currentBalance, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
    });
    await mockFeed(page, []);
    await page.route('**/.netlify/functions/claim-install-bonus', function (route) {
      currentBalance = 320;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, balance: 320 }) });
    });
    await page.addInitScript(function () {
      var real = window.matchMedia ? window.matchMedia.bind(window) : null;
      window.matchMedia = function (q) {
        if (String(q).indexOf('display-mode') !== -1) return { matches: true, media: q, addListener: function () {}, removeListener: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
        return real ? real(q) : { matches: false, media: q };
      };
    });
    await seedHomeUser(page, { username: 'mkycopytester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    var rewardText = await page.textContent('.mky-reward');
    assert.match(rewardText, /add.*your home screen/i, 'reward line must say "add ... your home screen", got: ' + rewardText);
    assert.doesNotMatch(rewardText, /\binstall\b/i, 'reward line must not say bare "install" anymore, got: ' + rewardText);

    // Claim it -- the done-state copy must ALSO use the unified phrase.
    await page.click('#mky-claim');
    await page.waitForSelector('#mky-done', { state: 'visible', timeout: 5000 });
    var doneText = await page.textContent('.mky-done-line');
    assert.match(doneText, /added to your phone/i, 'done-state must say "Added to your phone", got: ' + doneText);
    assert.match(doneText, /claimed/i);
    assert.doesNotMatch(doneText, /\binstalled\b/i, 'done-state must not say "Installed" anymore, got: ' + doneText);
  } finally {
    await context.close();
  }
});

test('home.html: the Make-it-yours install row\'s inline CTA (native prompt available) says "Add to home screen", not "Install" -- and its supporting copy above it uses the unified phrase too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT }); // default desktop-ish UA -- not iOS, no Android menu-fallback branch
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'mkyinlinectatester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    await page.click('#mky-install-row');
    await page.waitForSelector('#mky-inline-install-btn', { state: 'visible', timeout: 2000 });
    var btnText = (await page.textContent('#mky-inline-install-btn')).trim();
    assert.match(btnText, /add to home screen/i, 'expected the inline CTA to say "Add to home screen", got: ' + btnText);
    assert.doesNotMatch(btnText, /^install\b/i, 'must not still say "Install", got: ' + btnText);

    var expText = await page.textContent('#mky-install-exp');
    assert.match(expText, /adding it to your home screen verifies/i, 'the supporting copy above the CTA must use the unified phrase too, got: ' + expText);
  } finally {
    await context.close();
  }
});

test('home.html: the Make-it-yours webview-fallback note (no PwaInstall/InstallNudge available) says "add DreamTube to your home screen", not "install DreamTube"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    // Prevent js/pwa.js and js/install-nudge.js from ever loading, so
    // window.PwaInstall/InstallNudge stay genuinely undefined -- the exact
    // branch this note is scoped to (see home.html's own
    // renderMkyInstallExp). A plain window.PwaInstall=undefined stub via
    // addInitScript does NOT work here -- those scripts reassign it
    // themselves once they load, clobbering the stub.
    await page.route('**/js/pwa.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }); });
    await page.route('**/js/install-nudge.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }); });
    await seedHomeUser(page, { username: 'mkywebviewfallbacktester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    await page.click('#mky-install-row');
    var expText = await page.textContent('#mky-install-exp');
    assert.match(expText, /add dreamtube to your home screen/i, 'expected the unified phrase, got: ' + expText);
    assert.doesNotMatch(expText, /install dreamtube/i, 'must not still say "install DreamTube", got: ' + expText);
  } finally {
    await context.close();
  }
});

/** Same technique test/install-first-door-behavioral.test.js's own mockBeforeInstallPromptCapturedEarly uses -- fires a synthetic beforeinstallprompt BEFORE the page's real js/pwa.js listener attaches, so PwaInstall.canPromptInstall() is genuinely true by the time InstallNudge.render() runs (a one-shot synchronous call, no later re-render), landing on the real-native-prompt "else" branch rather than the iOS/Android-menu-fallback branches. */
function mockBeforeInstallPromptCapturedEarly(page, outcome) {
  return page.addInitScript(function (o) {
    var realAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (type === 'beforeinstallprompt' && this === window && typeof listener === 'function') {
        var fakeEvent = new Event('beforeinstallprompt', { cancelable: true });
        fakeEvent.prompt = function () { fakeEvent.__prompted = true; };
        fakeEvent.userChoice = Promise.resolve({ outcome: o });
        try { listener(fakeEvent); } catch (e) { /* ignore */ }
      }
      return realAdd.call(this, type, listener, opts);
    };
  }, outcome || 'accepted');
}

test('js/install-nudge.js: the small nudge card\'s own fallback CTA (a captured native prompt, non-iOS) also says "Add to home screen", matching its own head\'s "Add DreamTube to your home screen" -- same naming split the founder flagged, fixed in the same sweep', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36' });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await mockBeforeInstallPromptCapturedEarly(page, 'accepted');
    await seedHomeUser(page, { username: 'nudgectatester', dreams: [] });
    // profile.html's repeat-visit trigger -- 2nd real-browser visit fires the small card.
    await page.goto(baseUrl + '/profile.html', { waitUntil: 'domcontentloaded' });
    await page.goto(baseUrl + '/profile.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });

    var headText = await page.textContent('.install-nudge-head');
    assert.match(headText, /add dreamtube to your home screen/i);

    await page.waitForSelector('#install-nudge-action', { state: 'visible', timeout: 2000 });
    var btnText = (await page.textContent('#install-nudge-action')).trim();
    assert.match(btnText, /add to home screen/i, 'expected the small card\'s own CTA to match its head\'s phrasing, got: ' + btnText);
    assert.doesNotMatch(btnText, /^install\b/i, 'must not still say "Install", got: ' + btnText);
  } finally {
    await context.close();
  }
});
