// test/push-install-gating-behavioral.test.js
//
// Real browser-driven coverage for the 2026-08-12 founder-approved PUSH-GATING
// fix (js/push-subscribe.js): the native push permission prompt
// (Notification.requestPermission) must fire ONLY when the app is running as
// the INSTALLED, standalone app AND push is genuinely supported — never in a
// plain browser tab or an in-app webview, where (on iOS especially) a "deny"
// permanently burns the origin's notification permission for a user who can't
// subscribe anyway. NON-installed users keep the install enticement (the iOS-
// tab fallback / A2HS nudge) untouched.
//
// Proves:
//   1. Non-standalone + capable (a normal desktop-Chromium tab): the real
//      "Notify me" soft-ask does NOT render — so its "Notify me" button (the
//      only thing that fires the native prompt) is never even reachable, and
//      no push_prompt_shown fires. PushSubscribe.isInstalledStandalone() is
//      false. This is the core of the fix: no native prompt where it'd burn.
//   2. Standalone + capable: the real soft-ask DOES render (push_prompt_shown),
//      isInstalledStandalone() is true, and tapping "Notify me" reaches the
//      native prompt — firing push_softask_accepted then push_prompt_granted
//      off the (stubbed) permission answer. So installed users get their clean
//      soft-ask -> native enable moment.
//   3. Non-installed iOS Safari tab (PushManager absent, not standalone): the
//      INSTALL fallback still shows (push_fallback_shown, the "add to home
//      screen" enticement) — proving the install path is preserved, not
//      weakened, for non-installed users.
//
// Follows test/a2hs-install-nudge-journey-behavioral.test.js's / test/pwa-
// stage0-behavioral.test.js's established conventions (same UA constants,
// blockThirdParty/safeGoto/seedUser/forceStandalone helpers, mocked generation
// so home.html parks on its notify card). Run with: node --test test/

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

var NORMAL_IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

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

async function seedUser(page, username) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var state = {
      user: { handle: '@' + u, username: u },
      accounts: {},
      draft: { caption: 'A dream about flying over the city', style: 'Cinematic', mediaType: 'video', sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, sourceImageUrl: null, audioOn: false, musicStyle: null },
      dreams: [],
      pendingJob: null,
      charactersByUser: {},
      likedIds: {}
    };
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    state.charactersByUser[u] = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
}

function mockGeneration(page) {
  return Promise.all([
    page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 150, claimable: false, nextClaimAt: 0, dailyClaimAmount: 20, streak: 0 }) });
    }),
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast/test-op' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    })
  ]);
}

/** Forces matchMedia('(display-mode: standalone)') true before any page script — simulates the installed/standalone app (same helper as the sibling behavioral suites). */
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

/** Stubs Notification.requestPermission to a spy that records calls and resolves `outcome`, BEFORE any page script — the only way to answer the native prompt deterministically (same technique as pwa-stage0's push tests). */
function stubNotificationPermission(page, outcome) {
  return page.addInitScript(function (o) {
    window.__reqPermCalls = 0;
    window.Notification = window.Notification || {};
    Object.defineProperty(window.Notification, 'permission', { value: 'default', configurable: true });
    window.Notification.requestPermission = function () { window.__reqPermCalls++; return Promise.resolve(o); };
  }, outcome);
}

/** Removes window.PushManager so PushSubscribe.isSupported() is false regardless of UA — the only way to simulate a real iOS Safari tab (Chromium always exposes PushManager even under an iOS UA). */
function stripPushManager(page) {
  return page.addInitScript(function () {
    try { delete window.PushManager; } catch (e) { window.PushManager = undefined; }
  });
}

function capturedEventNames(page) {
  return page.evaluate(function () {
    return (window.posthog && typeof window.posthog.slice === 'function')
      ? window.posthog.slice().filter(function (e) { return e[0] === 'capture'; }).map(function (e) { return e[1]; })
      : [];
  });
}

test('non-standalone capable tab: the real "Notify me" ask never renders — the native prompt is unreachable where an iOS deny would burn permission', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext(); // plain desktop Chromium tab: PushManager present, NOT standalone, not iOS
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGeneration(page);
    await stubNotificationPermission(page, 'granted');
    var username = 'pushgate' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html?generate=1');
    await page.waitForTimeout(600);

    var installed = await page.evaluate(function () { return window.PushSubscribe && PushSubscribe.isInstalledStandalone(); });
    assert.equal(installed, false, 'a plain tab is not the installed/standalone app');
    assert.equal(await page.locator('#push-ask-enable').count(), 0, 'the native-firing "Notify me" button must never render in a plain tab');
    assert.equal(await page.locator('#push-ask-card').count(), 0, 'no push ask card at all in a non-standalone, non-iOS tab');

    var names = await capturedEventNames(page);
    assert.equal(names.indexOf('push_prompt_shown'), -1, 'push_prompt_shown must not fire in a plain tab');
    assert.equal(await page.evaluate(function () { return window.__reqPermCalls; }), 0, 'the native permission prompt must never be requested here');
  } finally {
    await context.close();
  }
});

test('installed/standalone + capable: the real soft-ask renders and tapping it reaches the native prompt (push_softask_accepted -> push_prompt_granted)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGeneration(page);
    await stubNotificationPermission(page, 'granted');
    await forceStandalone(page); // simulate the installed home-screen app
    var username = 'pushinstalled' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html?generate=1');
    await page.waitForSelector('#push-ask-enable', { state: 'visible', timeout: 5000 });

    var installed = await page.evaluate(function () { return window.PushSubscribe && PushSubscribe.isInstalledStandalone(); });
    assert.equal(installed, true, 'the standalone launch is detected as installed');
    var shown = await capturedEventNames(page);
    assert.ok(shown.indexOf('push_prompt_shown') !== -1, 'the soft-ask card fires push_prompt_shown when it renders');

    await page.click('#push-ask-enable');
    await page.waitForFunction(function () {
      return window.posthog && window.posthog.some(function (e) { return e[0] === 'capture' && e[1] === 'push_prompt_granted'; });
    }, null, { timeout: 5000 });

    var after = await capturedEventNames(page);
    assert.ok(after.indexOf('push_softask_accepted') !== -1, 'tapping "Notify me" fires push_softask_accepted (the accept step)');
    assert.ok(after.indexOf('push_prompt_granted') !== -1, 'the native answer fires push_prompt_granted');
    assert.ok((await page.evaluate(function () { return window.__reqPermCalls; })) >= 1, 'the native permission prompt is reachable once installed');
  } finally {
    await context.close();
  }
});

test('non-installed iOS Safari tab: the INSTALL fallback still shows (push_fallback_shown) — install enticement preserved for non-installed users', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGeneration(page);
    await stripPushManager(page); // a real iOS tab exposes no PushManager
    var username = 'pushiosfb' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html?generate=1');
    await page.waitForSelector('#push-ask-install-cta', { state: 'visible', timeout: 5000 });

    assert.equal(await page.locator('#push-ask-enable').count(), 0, 'the native-firing ask must not render on an iOS tab');
    var bodyText = await page.textContent('#push-ask-card .push-ask-body');
    assert.match(bodyText, /home screen/i, 'the install-enticement fallback copy is shown');
    var names = await capturedEventNames(page);
    assert.ok(names.indexOf('push_fallback_shown') !== -1, 'push_fallback_shown fires — the install path is preserved for non-installed iOS users');
  } finally {
    await context.close();
  }
});
