// test/a2hs-install-nudge-journey-behavioral.test.js
//
// Real browser-driven coverage for tracker item for-product-a2hs-install-
// nudge-3-founder-vcofk7 — the three founder-found A2HS nudge problems
// (unclear guidance, missing-option capability detection, one-shot
// disappearance) plus the push-notification fallback chaining added to
// this item's scope in a later tracker comment. Follows test/pwa-stage0-
// behavioral.test.js's/test/home-behavioral.test.js's established
// conventions (same UA constants, same blockThirdParty/safeGoto helpers,
// same seed-then-navigate shape) rather than inventing a new one.

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

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network, and every other *-behavioral.test.js's identical helper. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

async function safeGoto(page, url, opts) {
  try {
    await page.goto(url, Object.assign({ waitUntil: 'domcontentloaded' }, opts || {}));
  } catch (e) {
    await page.goto(url, Object.assign({ waitUntil: 'domcontentloaded' }, opts || {}));
  }
}

var IG_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2246; google/redfin/redfin:13; en_US; 538815920)';
var FB_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0.0.0.100;FBBV/1;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.0;FBSS/3;FBID/phone;FBLC/en_US]';
var NORMAL_IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

/** Seeds a logged-in account directly into localStorage — same shortcut every other behavioral test in this repo uses (see test/pwa-stage0-behavioral.test.js's identical seedUser). `extraAccountFields` merges onto the account record (e.g. { installVerified: true }). */
async function seedUser(page, username, extraAccountFields) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (args) {
    var state = {
      user: { handle: '@' + args.u, username: args.u },
      accounts: {},
      draft: { caption: 'A dream about flying over the city', style: 'Cinematic', mediaType: 'video', sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, sourceImageUrl: null, audioOn: false, musicStyle: null },
      dreams: [],
      pendingJob: null,
      charactersByUser: {},
      likedIds: {}
    };
    state.accounts[args.u] = Object.assign({ password: 'testpass1', email: args.u + '@example.com' }, args.extra || {});
    state.charactersByUser[args.u] = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { u: username, extra: extraAccountFields });
}

function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 220, claimable: false, nextClaimAt: 0, dailyClaimAmount: 20, streak: 0 }) });
  });
}

/** Mocks a generation that never completes -- keeps processing.html parked on the wait screen, same helper shape as test/pwa-stage0-behavioral.test.js's own mockNeverFinishingGeneration. */
function mockNeverFinishingGeneration(page) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast/test-op' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    })
  ]);
}

/**
 * Forces `window.matchMedia('(display-mode: standalone)').matches` to true
 * BEFORE any page script runs -- the exact same check PwaInstall.
 * isStandalone() reads (js/pwa.js), so this simulates "already installed,
 * launched from the home screen icon" for a test without a real installed
 * PWA. Must be an addInitScript (not a post-load page.evaluate) so
 * js/pwa.js's own on-load standalone check (which runs synchronously as
 * the script parses, before this test's own code gets a turn) sees it too.
 */
function forceStandalone(page) {
  return page.addInitScript(function () {
    var real = window.matchMedia ? window.matchMedia.bind(window) : null;
    window.matchMedia = function (q) {
      if (String(q).indexOf('display-mode') !== -1) {
        return { matches: true, media: q, addListener: function () {}, removeListener: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
      }
      return real ? real(q) : { matches: false, media: q };
    };
  });
}

/**
 * Removes window.PushManager so PushSubscribe.isSupported() is false
 * regardless of UA string. Real Safari on iOS never exposes PushManager
 * to an ordinary browser tab at all, but Playwright's underlying engine
 * is always Chromium (which always exposes it) even when the UA string is
 * overridden to look like iOS -- this is the only way to actually simulate
 * the real unsupported case this test suite needs.
 */
function removePushManager(page) {
  return page.addInitScript(function () {
    try { delete window.PushManager; } catch (e) { /* ignore */ }
  });
}

function capturedEventNames(queue) {
  return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return entry[1]; });
}
function readPostHogCalls(page) {
  return page.evaluate(function () {
    return (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
  });
}

// ===================================================================
// 1. Visual aid — problem 1 (unclear guidance)
// ===================================================================

test('install nudge (iOS Safari): real visual aid matching Safari\'s actual toolbar (back / address bar / ••• More button, not a direct Share icon) + a Share menu-row + explicit scroll-down guidance + a softened, non-promising note', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var username = 'visualaid' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/profile.html');
    await safeGoto(page, baseUrl + '/profile.html'); // 2nd visit -- the repeat-visit trigger
    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });

    // A real SVG "•••" (More) icon inside the toolbar mock -- Safari's
    // actual bottom toolbar (per the founder's own screenshot correction)
    // has no direct Share icon at all, only this More button at the
    // bottom-right, which opens a menu with Share as its first item.
    var moreSvgCount = await page.locator('.install-nudge-toolbar-more svg').count();
    assert.equal(moreSvgCount, 1, 'expected a real inline SVG ••• (More) icon inside the toolbar mock, matching the actual Safari toolbar');

    // The toolbar mock itself must also show a back chevron and an
    // address-bar pill, matching the real screenshot's layout.
    assert.equal(await page.locator('.install-nudge-toolbar-back').count(), 1);
    assert.equal(await page.locator('.install-nudge-toolbar-url').count(), 1);

    // A second visual -- the small "Share" menu row that appears once the
    // More button is tapped -- must also be present, with the app's real
    // shareIos SVG icon (not just text).
    var menuRows = page.locator('#install-nudge-card .install-nudge-menurow');
    assert.equal(await menuRows.count(), 2, 'expected two menu-row visuals: the intermediate Share row, then Add to Home Screen');
    var shareRowText = await menuRows.nth(0).textContent();
    assert.match(shareRowText, /^Share$/i, 'the first menu-row visual must be the Share step, not skip straight to Add to Home Screen');
    var shareRowSvgCount = await menuRows.nth(0).locator('svg').count();
    assert.equal(shareRowSvgCount, 1, 'the Share row must carry a real inline SVG icon');

    var bodyText = await page.textContent('#install-nudge-card');
    assert.match(bodyText, /scroll down/i, 'must explicitly say to scroll down in the share sheet');
    assert.match(bodyText, /bottom-right/i, 'must describe roughly where the More button lives (bottom-right, per the founder\'s screenshot -- not the previous, incorrect bottom-center claim)');

    var addToHomeRowText = await menuRows.nth(1).textContent();
    assert.match(addToHomeRowText, /Add to Home Screen/i);

    var noteText = await page.textContent('#install-nudge-card .install-nudge-note');
    assert.match(noteText, /can vary/i, 'must never flatly promise the option will be there -- problem 2\'s softened-copy requirement');
  } finally {
    await context.close();
  }
});

// ===================================================================
// 2. Capability-detect-and-hide — problem 2, applied to the NEW homepage
//    journey card (the small card's own webview/platform gating already
//    has coverage in test/pwa-stage0-behavioral.test.js).
// ===================================================================

test('homepage journey card: hidden inside a detected in-app webview even though the account is otherwise iOS-eligible', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'homewebview' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);
    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('.nav-icon', { timeout: 5000 });

    var display = await page.locator('#card-install').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(display, 'none', 'must never show the A2HS journey card inside a detected in-app webview');
  } finally {
    await context.close();
  }
});

test('homepage journey card: hidden on a platform with nothing real to offer (desktop, no beforeinstallprompt captured, not iOS)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext(); // default desktop Chromium UA, no beforeinstallprompt ever fires in this test harness
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'homedesktop' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);
    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('.nav-icon', { timeout: 5000 });

    var display = await page.locator('#card-install').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(display, 'none', 'must never show the journey card when there is nothing actionable to offer');
  } finally {
    await context.close();
  }
});

test('homepage journey card: a beforeinstallprompt that arrives AFTER this script already ran (Android/Chrome\'s real, common timing) still makes the card appear and become clickable in the SAME page load, not just on a later reload (review finding)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext(); // default desktop Chromium UA -- beforeinstallprompt never fires on its own in this test harness, so this is genuinely simulating the "not yet available" starting state
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'homelateprompt' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);
    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('.nav-icon', { timeout: 5000 });

    // Confirms the starting state genuinely has nothing to offer yet --
    // this test would be meaningless if the card were already visible.
    var initialDisplay = await page.locator('#card-install').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(initialDisplay, 'none', 'must start hidden -- nothing captured yet, same as the desktop-with-nothing-to-offer case');

    // Dispatches a REAL beforeinstallprompt-shaped event through the actual
    // window listener js/pwa.js registers -- not a stub of canOfferInstall
    // itself -- so this exercises the genuine code path: pwa.js's real
    // listener sets its real deferredPrompt AND dispatches the real
    // dreamtube:install-capability-changed event this fix listens for.
    await page.evaluate(function () {
      var fakeEvent = new Event('beforeinstallprompt', { cancelable: true });
      fakeEvent.prompt = function () {};
      fakeEvent.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(fakeEvent);
    });

    // The card must appear WITHOUT a reload, and its own click wiring
    // (which the pre-fix code only ever attached if the card was already
    // visible on the very first synchronous pass) must actually work.
    await page.waitForSelector('#card-install', { state: 'visible', timeout: 2000 });
    await page.click('#install-hcard-btn');
    await page.waitForSelector('#install-sheet-overlay.open', { timeout: 2000 });
  } finally {
    await context.close();
  }
});

test('homepage journey card: hidden once the account is genuinely verified installed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'homeverified' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username, { installVerified: true });
    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('.nav-icon', { timeout: 5000 });

    var display = await page.locator('#card-install').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(display, 'none', 'a genuinely verified-installed account must never see the journey card again');
  } finally {
    await context.close();
  }
});

// ===================================================================
// 3. Persistence — problem 3 (one-shot disappearance)
// ===================================================================

test('homepage journey card: shown for an iOS-eligible, not-yet-verified account, has no dismiss control, and stays visible across a reload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'homepersist' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#card-install', { state: 'visible', timeout: 5000 });

    // Deliberately has no X/dismiss control -- unlike every other nudge card in this app.
    var dismissCount = await page.locator('#card-install button:not(#install-hcard-btn)').count();
    assert.equal(dismissCount, 0, 'the persistent journey card must have no dismiss control at all');

    await safeGoto(page, baseUrl + '/home.html'); // reload, same browser/account
    await page.waitForSelector('#card-install', { state: 'visible', timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('homepage journey card: dismissing the SMALL nudge card elsewhere never hides the persistent homepage card', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'homesmalldismiss' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    // Trigger + dismiss the SMALL nudge card on profile.html (repeat-visit trigger).
    await safeGoto(page, baseUrl + '/profile.html');
    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });
    await page.click('#install-nudge-dismiss');
    assert.equal(await page.locator('#install-nudge-card').count(), 0);

    var dismissed = await page.evaluate(function () { return DreamStore.getInstallNudgeDismissed(); });
    assert.equal(dismissed, true, 'sanity check: the small card\'s own device-level dismiss flag really is now set');

    // The persistent homepage card must be UNAFFECTED by that flag.
    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#card-install', { state: 'visible', timeout: 5000 });
  } finally {
    await context.close();
  }
});

// ===================================================================
// 4. Real verified-completion signal — the other half of problem 3
// ===================================================================

test('standalone-mode page load marks getInstallVerified() true for the signed-in account, and the journey card is already hidden on that same load', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await forceStandalone(page);
    await mockTokenStatus(page);
    var username = 'standaloneverify' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('.nav-icon', { timeout: 5000 });

    var verified = await page.evaluate(function () { return DreamStore.getInstallVerified(); });
    assert.equal(verified, true, 'a standalone-mode load for a signed-in account must mark getInstallVerified() true');

    var display = await page.locator('#card-install').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(display, 'none', 'the journey card must already be hidden on the very same standalone load that verified it');
  } finally {
    await context.close();
  }
});

test('standalone-mode marking is idempotent and never fires for a signed-OUT load', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await forceStandalone(page);
    // No seedUser -- signed OUT.
    await safeGoto(page, baseUrl + '/index.html');
    var errored = false;
    page.on('pageerror', function () { errored = true; });
    await page.waitForTimeout(200);
    assert.equal(errored, false, 'standalone detection on a signed-out load must never throw');
  } finally {
    await context.close();
  }
});

test('appinstalled event marks getInstallVerified() true and immediately hides the visible journey card in the SAME session', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'appinstalledverify' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#card-install', { state: 'visible', timeout: 5000 });

    var verifiedBefore = await page.evaluate(function () { return DreamStore.getInstallVerified(); });
    assert.equal(verifiedBefore, false);

    await page.evaluate(function () { window.dispatchEvent(new Event('appinstalled')); });

    await page.waitForFunction(function () {
      return getComputedStyle(document.getElementById('card-install')).display === 'none';
    }, null, { timeout: 5000 });

    var verifiedAfter = await page.evaluate(function () { return DreamStore.getInstallVerified(); });
    assert.equal(verifiedAfter, true, 'appinstalled must mark getInstallVerified() true for the signed-in account');
  } finally {
    await context.close();
  }
});

// ===================================================================
// 5. Push-notification fallback chaining (later tracker-comment addition)
// ===================================================================

test('push wait-screen: iOS real-browser-tab (PushManager absent, not standalone) shows the install fallback, and "See how" expands the shared iOS guidance', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await removePushManager(page);
    await mockNeverFinishingGeneration(page);
    var username = 'pushfallback' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForSelector('#push-ask-card', { state: 'visible', timeout: 5000 });

    var bodyText = await page.textContent('#push-ask-card .push-ask-body');
    assert.match(bodyText, /home screen/i, 'expected the chained "add to home screen" fallback message, not silence');

    var shownNames = capturedEventNames(await readPostHogCalls(page));
    assert.ok(shownNames.indexOf('push_fallback_shown') !== -1, 'expected push_fallback_shown to fire');

    await page.click('#push-ask-install-cta');
    await page.waitForSelector('#push-ask-install-guidance', { state: 'visible', timeout: 5000 });
    var guidanceSvgCount = await page.locator('#push-ask-install-guidance .install-nudge-toolbar-more svg').count();
    assert.equal(guidanceSvgCount, 1, 'expected the SAME shared iOS guidance (the toolbar mock\'s ••• More icon + copy) to expand in place');

    var tappedNames = capturedEventNames(await readPostHogCalls(page));
    assert.ok(tappedNames.indexOf('push_fallback_install_cta_tapped') !== -1, 'expected push_fallback_install_cta_tapped to fire on tap');
  } finally {
    await context.close();
  }
});

test('push wait-screen: no fallback once already running standalone, even with PushManager absent', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await removePushManager(page);
    await forceStandalone(page);
    await mockNeverFinishingGeneration(page);
    var username = 'pushstandalone' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#push-ask-card').count(), 0, 'must not show the fallback once already standalone -- that is not the iOS-browser-tab case');
  } finally {
    await context.close();
  }
});

test('push wait-screen: no fallback for a non-iOS unsupported reason (stays exactly as silent as before)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext(); // default desktop Chromium UA -- not iOS
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await removePushManager(page);
    await mockNeverFinishingGeneration(page);
    var username = 'pushdesktopunsupported' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#push-ask-card').count(), 0, 'a non-iOS unsupported reason must stay silent, not show the iOS-specific fallback');
  } finally {
    await context.close();
  }
});

test('push wait-screen: no fallback inside a detected in-app webview', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await removePushManager(page);
    await mockNeverFinishingGeneration(page);
    var username = 'pushwebviewfallback' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#push-ask-card').count(), 0, 'the standing in-app-webview rule must suppress the fallback too, not just the real ask');
  } finally {
    await context.close();
  }
});

test('push wait-screen: real support still shows the normal "Notify me" ask, never the fallback copy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext(); // desktop Chromium: PushManager present, not iOS
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.addInitScript(function () {
      window.Notification = window.Notification || {};
      Object.defineProperty(window.Notification, 'permission', { value: 'default', configurable: true });
      window.Notification.requestPermission = function () { return Promise.resolve('denied'); };
    });
    await mockNeverFinishingGeneration(page);
    var username = 'pushrealask' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForSelector('#push-ask-card', { state: 'visible', timeout: 5000 });
    var bodyText = await page.textContent('#push-ask-card .push-ask-body');
    assert.match(bodyText, /takes a minute or two/i, 'expected the real ask copy');
    assert.doesNotMatch(bodyText, /home screen/i, 'must never show the fallback copy when push genuinely works here');
  } finally {
    await context.close();
  }
});
