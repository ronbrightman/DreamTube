// test/install-first-door-behavioral.test.js
//
// Real browser-driven coverage for tracker item for-product-install-first-
// door-founder-d-b60cls -- the founder-directed guided two-step
// webview-escape -> install flow:
//   STEP 1 -- home.html's .webview-card gets an explicit "Step 1 of 2"
//   label.
//   STEP 2 -- the post-session-transfer install moment (js/install-nudge.js
//   render(), trigger: 'session-transfer') gets an explicit "Step 2 of 2"
//   label plus two new platform-aware branches: Android without a captured
//   beforeinstallprompt falls back to a real "look in your browser's menu"
//   visual instead of staying silent, and iPhone on a non-Safari browser
//   gets pointed at Safari (the only iOS browser capable of A2HS) instead
//   of browser-specific menu-hunting.
//   Also covers home.html's own install-qrow elevating into the same
//   "Step 2 of 2" state right after a fresh session transfer (its own
//   install surface, reusing the same builders rather than a second
//   floating card), and the new install_verified PostHog event
//   (js/store.js's markInstallVerified) that makes install-verified rate
//   measurable at all.
//
// Follows test/session-transfer-behavioral.test.js's/test/a2hs-install-
// nudge-journey-behavioral.test.js's established conventions (same UA
// constants, same blockThirdParty/safeGoto/seedUser shapes, same
// mockVerifySessionTransfer stub for a real ?bt= consumption).

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

var NORMAL_IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
var CHROME_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1';
var NORMAL_ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';
var IG_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2246; google/redfin/redfin:13; en_US; 538815920)';
var FB_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0.0.0.100;FBBV/1;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.0;FBSS/3;FBID/phone;FBLC/en_US]';

/** Seeds a logged-in account directly into localStorage -- same shortcut every other behavioral test in this repo uses. `extraAccountFields` merges onto the account record (e.g. { installVerified: true }). */
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

/** Stubs POST /.netlify/functions/verify-session-transfer to always vouch for `username` -- same shape as test/session-transfer-behavioral.test.js's own mockVerifySessionTransfer, trimmed to what this file needs (no single-use/authToken assertions here, those already have their own dedicated coverage). */
function mockVerifySessionTransferOk(page, username) {
  return page.route('**/.netlify/functions/verify-session-transfer', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: username, email: username + '@example.com', authToken: 'test-auth-token-for-' + username }) });
  });
}

/**
 * Navigates a SIGNED-OUT browser to `path?bt=<token>` with verify-session-
 * transfer mocked to vouch for `username` -- the real client mechanism
 * (DreamStore.consumeSessionTransferTokenFromUrlSync, a synchronous XHR --
 * see that function's own doc comment in js/store.js) commits the session
 * and sets DreamStore.wasSessionJustTransferred() true for this exact load,
 * which is what makes InstallNudge's `trigger: 'session-transfer'` (Step 2)
 * eligible in the first place. Real mechanism, not a stubbed flag.
 */
async function gotoWithFreshSessionTransfer(page, path, username) {
  await mockVerifySessionTransferOk(page, username);
  await safeGoto(page, baseUrl + path + (path.indexOf('?') === -1 ? '?' : '&') + 'bt=test-token-' + username);
}

/**
 * Makes the VERY NEXT `beforeinstallprompt` listener js/pwa.js registers
 * fire synchronously, with a real-shaped fake event (`prompt`/`userChoice`),
 * the instant it's registered -- guaranteeing PwaInstall's own
 * `deferredPrompt` is already set before install-nudge.js's later
 * `InstallNudge.init()` call runs (both execute later in the same
 * synchronous script-load sequence). Unlike test/a2hs-install-nudge-
 * journey-behavioral.test.js's own "arrives after" test (which dispatches
 * AFTER the page settles, deliberately simulating the delayed-arrival
 * case), this file needs the event captured BEFORE render() ever runs, to
 * exercise the real "Android WITH a captured prompt shows a real Install
 * button" Step 2 path -- render() is a one-shot synchronous call with no
 * later re-render, unlike home.html's own capability-changed listener.
 */
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

function capturedEventNames(queue) {
  return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return entry[1]; });
}
function capturesOf(queue, name) {
  return queue.filter(function (entry) { return entry[0] === 'capture' && entry[1] === name; }).map(function (entry) { return entry[2]; });
}
function readPostHogCalls(page) {
  return page.evaluate(function () {
    return (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
  });
}

/**
 * Forces `window.matchMedia('(display-mode: standalone)').matches` to true
 * BEFORE any page script runs -- same helper as test/a2hs-install-nudge-
 * journey-behavioral.test.js's own forceStandalone.
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

// ===================================================================
// 1. STEP 1 of 2 -- home.html's webview-escape card
// ===================================================================

test('home.html: the webview-escape card is explicitly labeled "Step 1 of 2"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var username = 'step1label' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);
    await safeGoto(page, baseUrl + '/home.html');

    await page.waitForSelector('#webview-card', { state: 'visible', timeout: 5000 });
    var labelText = await page.textContent('#webview-card .webview-steplabel');
    assert.match(labelText, /Step 1 of 2/);
  } finally {
    await context.close();
  }
});

// ===================================================================
// 2. STEP 2 of 2 framing -- the floating small card (create.html/
//    result.html), trigger: 'session-transfer'
// ===================================================================

test('create.html: right after a fresh session transfer, the install card is explicitly labeled "Step 2 of 2" (iOS Safari)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'step2safari' + Math.random().toString(36).slice(2, 8);
    await gotoWithFreshSessionTransfer(page, '/create.html', username);

    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });
    var labelText = await page.textContent('#install-nudge-card .install-nudge-steplabel');
    assert.match(labelText, /Step 2 of 2/);
    // Safari's own real guidance must still be exactly what it was before
    // this item (2026-07-29 revision) -- the "•••" More-button toolbar mock.
    assert.equal(await page.locator('#install-nudge-card .install-nudge-toolbar-more svg').count(), 1, 'Safari must keep its own real toolbar mock, unaffected by Step 2 framing');
  } finally {
    await context.close();
  }
});

test('profile.html repeat-visit trigger: the small card is NOT labeled "Step 2 of 2" (that framing is Step-2-only)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'repeatnostep' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);
    await safeGoto(page, baseUrl + '/profile.html');
    await safeGoto(page, baseUrl + '/profile.html'); // 2nd visit -- the repeat-visit trigger's own threshold

    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#install-nudge-card .install-nudge-steplabel').count(), 0, 'the repeat-visit trigger must never show Step 2 framing -- only the post-webview-escape moment does');
  } finally {
    await context.close();
  }
});

// ===================================================================
// 3. Android beforeinstallprompt path (Step 2)
// ===================================================================

test('create.html Step 2, Android WITH a captured beforeinstallprompt: shows a real "Install" button that calls the real native prompt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_ANDROID_CHROME_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockBeforeInstallPromptCapturedEarly(page, 'accepted');
    var username = 'androidrealprompt' + Math.random().toString(36).slice(2, 8);
    await gotoWithFreshSessionTransfer(page, '/create.html', username);

    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });
    var labelText = await page.textContent('#install-nudge-card .install-nudge-steplabel');
    assert.match(labelText, /Step 2 of 2/);
    await page.waitForSelector('#install-nudge-action', { state: 'visible', timeout: 2000 });
    assert.equal(await page.locator('#install-nudge-card .install-nudge-toolbar-highlight').count(), 0, 'must show the real button, not the menu-fallback visual, when a prompt was actually captured');

    await page.click('#install-nudge-action');
    // A real accepted outcome dismisses the nudge and removes the card.
    await page.waitForSelector('#install-nudge-card', { state: 'detached', timeout: 3000 });

    var outcomeCalls = capturesOf(await readPostHogCalls(page), 'install_nudge_outcome');
    assert.ok(outcomeCalls.some(function (p) { return p && p.outcome === 'accepted' && p.trigger === 'session-transfer'; }), 'expected install_nudge_outcome to fire with the real accepted outcome and the session-transfer trigger');
  } finally {
    await context.close();
  }
});

test('create.html Step 2, Android WITHOUT a captured beforeinstallprompt: falls back to a real "look in your browser menu" visual instead of staying silent', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_ANDROID_CHROME_UA }); // no beforeinstallprompt ever fires in this test harness
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'androidnoPrompt' + Math.random().toString(36).slice(2, 8);
    await gotoWithFreshSessionTransfer(page, '/create.html', username);

    // Before this fix, hasSomethingToOffer() was false for Android without
    // a captured prompt, so the whole nudge silently no-op'd at exactly
    // this guided moment -- the dead end this item exists to close.
    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });
    var labelText = await page.textContent('#install-nudge-card .install-nudge-steplabel');
    assert.match(labelText, /Step 2 of 2/);

    assert.equal(await page.locator('#install-nudge-action').count(), 0, 'must never show a fake real-prompt button when no prompt was actually captured');
    assert.equal(await page.locator('#install-nudge-card .install-nudge-toolbar-highlight svg').count(), 1, 'expected the real vertical "⋮" overflow-menu icon mock');
    var menuRowText = await page.textContent('#install-nudge-card .menu-row-replica-label');
    assert.match(menuRowText, /Install app/i);
  } finally {
    await context.close();
  }
});

test('home.html Step 2 (own Make-it-yours install row), Android WITHOUT a captured beforeinstallprompt: expanding the row shows "Step 2 of 2" and the menu fallback, not a dead end', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_ANDROID_CHROME_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'homeandroidstep2' + Math.random().toString(36).slice(2, 8);
    await gotoWithFreshSessionTransfer(page, '/home.html', username);

    // Tracker item for-product-build-ship-founder-approved--9ta1j0 folded
    // the old install-qrow's own Step 2 elevation into this card's install
    // row instead of a second floating sheet -- SAME builders, reached
    // through the accordion now.
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });
    await page.click('#mky-install-row');
    await page.waitForSelector('#mky-item-install.open', { timeout: 2000 });
    var eyebrowText = await page.textContent('#mky-install-exp .mky-step-eyebrow');
    assert.match(eyebrowText, /Step 2 of 2/);

    assert.equal(await page.locator('#mky-install-exp #install-sheet-android-btn').count(), 0, 'must not offer a fake real-install button with nothing captured');
    var expLabel = await page.textContent('#mky-install-exp .menu-row-replica-label');
    assert.match(expLabel, /Install app/i);
  } finally {
    await context.close();
  }
});

// ===================================================================
// 4. iPhone Safari-vs-non-Safari branching (Step 2)
// ===================================================================

test('create.html Step 2, iPhone on Chrome (non-Safari): pointed at Safari instead of Chrome-specific menu-hunting, with a real x-safari-https:// link and a copy-link fallback', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: CHROME_IOS_UA, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'iosstep2chrome' + Math.random().toString(36).slice(2, 8);
    await gotoWithFreshSessionTransfer(page, '/create.html', username);

    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });
    var labelText = await page.textContent('#install-nudge-card .install-nudge-steplabel');
    assert.match(labelText, /Step 2 of 2/);

    var cardText = await page.textContent('#install-nudge-card');
    assert.match(cardText, /Safari/, 'must point the visitor at Safari');
    assert.doesNotMatch(cardText, /address bar/i, 'must NOT show Chrome\'s own address-bar-Share-icon guidance at this guided moment -- the founder\'s directive is a deliberate simplification here');
    assert.doesNotMatch(cardText, /Edit Actions/i, 'must not show Chrome\'s "Edit Actions" quirk copy either -- that belongs to the unchanged repeat-visit/home.html guidance, not Step 2');

    var href = await page.getAttribute('#install-nudge-open-safari', 'href');
    // x-safari-http:// (not https) is CORRECT here -- this test's local
    // Playwright server serves the page over plain http, and the real
    // code (buildIOSOpenInSafariHtml) converts based on the page's own
    // actual protocol, never hardcoding https.
    assert.match(href, /^x-safari-https?:\/\//, 'expected a real x-safari-http(s):// link to force-open Safari');
    // NOT asserting a `bt=` token is present: this test's session (like
    // the real Step 2 scenario -- a webview handoff into a physically
    // separate browser-tab storage context) was established purely via
    // commitTransferredSession, which never caches a local password (see
    // that function in js/store.js), so mintSessionTransferToken() -- the
    // best-effort async refresh wireIOSOpenInSafari attempts, same
    // mechanism DreamStore.maintainSessionTransferUrl() already uses --
    // structurally cannot mint a fresh one here. That refresh is a real
    // improvement for a browser context that DOES have a cached password
    // (e.g. a returning user re-entering via webview after having logged
    // in locally before), but landing in Safari signed OUT is the honest,
    // expected outcome for a first-ever transfer-only context -- which is
    // exactly why the copy above says "if it doesn't do anything, copy
    // and paste" rather than promising a signed-in landing.

    // Always-available fallback -- never a single unverifiable button and
    // nothing else.
    await page.click('#install-nudge-copy-for-safari');
    var noteText = await page.textContent('#install-nudge-safari-fallback');
    assert.match(noteText, /Copied/i);
    var clipboardText = await page.evaluate(function () { return navigator.clipboard.readText(); });
    assert.equal(clipboardText, page.url());
  } finally {
    await context.close();
  }
});

test('profile.html repeat-visit trigger, iPhone on Chrome: KEEPS the existing Chrome-specific address-bar guidance, unaffected by Step 2\'s Safari-redirect simplification', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: CHROME_IOS_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'chromerepeatunchanged' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);
    await safeGoto(page, baseUrl + '/profile.html');
    await safeGoto(page, baseUrl + '/profile.html');

    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });
    var cardText = await page.textContent('#install-nudge-card');
    assert.match(cardText, /address bar/i, 'the pre-existing, tested Chrome-on-iOS guidance must be completely unaffected outside Step 2');
    assert.equal(await page.locator('#install-nudge-open-safari').count(), 0, 'the Safari-redirect is Step-2-only, must not appear here');
  } finally {
    await context.close();
  }
});

test('home.html Step 2 (own Make-it-yours install row), iPhone on Chrome: expanding the row also redirects to Safari, same builders as the floating card', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: CHROME_IOS_UA, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'homeioschromestep2' + Math.random().toString(36).slice(2, 8);
    await gotoWithFreshSessionTransfer(page, '/home.html', username);

    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });
    await page.click('#mky-install-row');
    await page.waitForSelector('#mky-item-install.open', { timeout: 2000 });

    var href = await page.getAttribute('#mky-install-exp #install-nudge-open-safari', 'href');
    // x-safari-http:// is correct for this local http test server -- see
    // the sibling assertion above for the full reasoning.
    assert.match(href, /^x-safari-https?:\/\//);
    var expText = await page.textContent('#mky-install-exp');
    assert.doesNotMatch(expText, /address bar/i);
  } finally {
    await context.close();
  }
});

// ===================================================================
// 5. MEASURE -- the new install_verified PostHog event
// ===================================================================

test('install_verified fires exactly once, with source "standalone_load", the first time a signed-in account loads in standalone mode', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await forceStandalone(page);
    await mockTokenStatus(page);
    var username = 'installverifiedevt' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForFunction(function () { return DreamStore.getInstallVerified() === true; }, null, { timeout: 3000 });

    var calls = capturesOf(await readPostHogCalls(page), 'install_verified');
    assert.equal(calls.length, 1, 'expected install_verified to fire exactly once');
    assert.equal(calls[0].source, 'standalone_load');
  } finally {
    await context.close();
  }
});

test('install_verified fires with source "appinstalled" when that real completion event fires', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'appinstalledevt' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('.nav-icon', { timeout: 5000 });
    await page.evaluate(function () { window.dispatchEvent(new Event('appinstalled')); });
    await page.waitForFunction(function () { return DreamStore.getInstallVerified() === true; }, null, { timeout: 3000 });

    var calls = capturesOf(await readPostHogCalls(page), 'install_verified');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, 'appinstalled');
  } finally {
    await context.close();
  }
});

test('an already-verified-installed account never gets the small install card, even on the repeat-visit trigger (canOfferInstall now excludes it everywhere, not just home.html\'s row)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var username = 'verifiedneverdupe' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username, { installVerified: true });
    await safeGoto(page, baseUrl + '/profile.html');
    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#install-nudge-card').count(), 0, 'a genuinely verified-installed account must never see the small card either');
  } finally {
    await context.close();
  }
});
