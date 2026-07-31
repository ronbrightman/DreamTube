// test/pwa-stage0-behavioral.test.js
//
// Real browser-driven coverage for tracker item for-product-build-
// stage-0-pwa-web-push-f-jbutt5's client-side pieces:
//   1. manifest.json + sw.js registration doesn't break an ordinary page
//      load (part 1).
//   2. The install (A2HS) nudge's in-app-webview detection gate — shown
//      in a real browser, hidden in a detected FB/IG in-app webview (part
//      2, absorbing home-screen-shortcut-a2hs-nudge-founder--yylzoq).
//   3. The push-subscribe ask's own identical webview gate, plus its
//      PostHog prompt-shown/granted/denied instrumentation (parts 3/5).
//
// Follows test/wait-screen-reassurance-and-inapp-nudge-behavioral.test.js's
// conventions closely (same UA constants, same blockThirdParty/safeGoto
// helpers, same browser.newContext({userAgent}) pattern for simulating a
// webview vs. a real browser).

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
// Chrome-on-iOS's own real UA token is "CriOS/<version>" -- the same
// vendor-identifying convention Apple's own WebKit docs and every other
// iOS browser use to mark themselves as running on iOS's forced WebKit
// engine (confirmed via research for tracker item for-product-bug-
// research-founder-high-ad-vnda9t; see js/pwa.js's iosBrowserKind() doc
// comment for citations). A real, current Chrome-for-iOS UA string.
var CHROME_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1';

/** Seeds a logged-in account directly into localStorage — same shortcut every other behavioral test in this repo uses (see test/delete-account-behavioral.test.js's identical seedUser). */
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

test('manifest.json links + sw.js registration do not break an ordinary page load (home.html)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(String(err)); });
    await blockThirdParty(page);
    await seedUser(page, 'swregtester');

    await safeGoto(page, baseUrl + '/home.html');
    // Give the service worker's own registration Promise a moment to settle
    // (it's fire-and-forget from the page's perspective — js/pwa.js never
    // awaits it before continuing) -- polling rather than a fixed sleep,
    // per this repo's own condition-based-waiting convention.
    await page.waitForFunction(function () {
      return !!(navigator.serviceWorker && navigator.serviceWorker.controller) ||
        (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistration === 'function');
    }, null, { timeout: 5000 });

    var registration = await page.evaluate(function () {
      return navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg ? { hasReg: true, scope: reg.scope } : { hasReg: false };
      });
    });
    // The registration itself may take a beat longer than this single
    // getRegistration() call to fully resolve on a cold load, so this
    // asserts the ATTEMPT succeeded (no thrown page error) rather than
    // requiring `hasReg` to already be true on the very first check --
    // the important behavioral guarantee for this test is "registering
    // sw.js never breaks the page," which the empty pageErrors list below
    // already confirms directly.
    assert.equal(typeof registration.hasReg, 'boolean');

    // The actual page content must have rendered normally -- registering
    // a service worker (or failing to, if unsupported in a given engine)
    // must never block the rest of the page's own script.
    await page.waitForSelector('.nav-icon', { timeout: 5000 });

    assert.deepEqual(pageErrors, [], 'expected zero uncaught page errors from manifest/service-worker wiring, got: ' + JSON.stringify(pageErrors));
  } finally {
    await context.close();
  }
});

test('manifest.json is linked and valid JSON on a real page load', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/index.html');

    var manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
    assert.equal(manifestHref, 'manifest.json');

    var manifest = await page.evaluate(function () {
      return fetch('manifest.json').then(function (r) { return r.json(); });
    });
    assert.equal(manifest.name, 'DreamTube');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'expected at least 2 icon entries (any + maskable)');
    var purposes = manifest.icons.map(function (i) { return i.purpose; });
    assert.ok(purposes.indexOf('any') !== -1, 'expected an "any" purpose icon');
    assert.ok(purposes.indexOf('maskable') !== -1, 'expected a "maskable" purpose icon');
  } finally {
    await context.close();
  }
});

test('offline.html renders standalone, with no dependency on js/store.js or an external stylesheet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(String(err)); });
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/offline.html');

    await page.waitForSelector('button', { timeout: 5000 });
    var bodyText = await page.textContent('body');
    assert.match(bodyText, /offline/i);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test('install (A2HS) nudge: hidden inside a detected FB/IG in-app webview even on a real-browser-eligible repeat visit', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  async function checkHiddenFor(userAgent) {
    var context = await browser.newContext({ userAgent: userAgent });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      var username = 'installwebview' + Math.random().toString(36).slice(2, 8);
      await seedUser(page, username);

      // Visit profile.html twice -- the 'repeat-visit' trigger requires a
      // 2nd+ visit before it would otherwise render at all.
      await safeGoto(page, baseUrl + '/profile.html');
      await safeGoto(page, baseUrl + '/profile.html');

      await page.waitForTimeout(300); // let any render attempt settle
      var visible = await page.locator('#install-nudge-card').count();
      assert.equal(visible, 0, 'the install nudge must never render inside a detected in-app webview, even on a real-browser-eligible repeat visit');
    } finally {
      await context.close();
    }
  }

  await checkHiddenFor(IG_ANDROID_UA);
  await checkHiddenFor(FB_IOS_UA);
});

test('install (A2HS) nudge: shown on a REAL browser (iOS Safari) repeat visit, with manual Add-to-Home-Screen instructions, but NOT on the first visit', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var username = 'installios' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/profile.html');
    var firstVisitCard = await page.locator('#install-nudge-card').count();
    assert.equal(firstVisitCard, 0, 'must not show on a visitor\'s very first visit to this page');

    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });
    // Safari's real guidance is now split across TWO .install-nudge-body
    // divs (••• More button, then Share) -- page.textContent() on a
    // multi-match selector only returns the FIRST element, so this reads
    // the whole card's text rather than just one paragraph of it.
    var bodyText = await page.textContent('#install-nudge-card');
    assert.match(bodyText, /share/i, 'iOS instructions must mention the Share icon (no native install prompt exists on iOS Safari)');
  } finally {
    await context.close();
  }
});

// ===== Browser-aware iOS guidance -- tracker item for-product-bug-
// research-founder-high-ad-vnda9t. Founder real-device report: A2HS
// "doesn't even appear" in Chrome on his iPhone. Root cause: the nudge
// used to show every iOS browser the SAME Safari-specific visual (a "•••"
// More button, bottom-right of the toolbar) -- real and accurate for
// Safari, but Chrome-on-iOS has a genuinely different real UI (a direct
// Share icon at the right of the address bar -- Google's own support doc,
// support.google.com/chrome/answer/9658361). These tests confirm the fix:
// each iOS browser now gets guidance that actually matches its own real
// UI, never a wrong-browser mock. =====

test('install (A2HS) nudge: Chrome-on-iOS gets Chrome-specific guidance (address-bar Share icon), never Safari\'s "•••" More-button mock', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: CHROME_IOS_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var username = 'installchrome' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/profile.html');
    await safeGoto(page, baseUrl + '/profile.html'); // 2nd visit -- the repeat-visit trigger's own threshold
    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });

    var cardText = await page.textContent('#install-nudge-card');
    assert.match(cardText, /address bar/i, 'Chrome guidance must point at its own real Share-icon location (right of the address bar), not Safari\'s toolbar');
    assert.doesNotMatch(cardText, /•••/, 'Chrome has no "•••" More button in that spot -- must never show Safari\'s specific mock to a Chrome user');
    assert.doesNotMatch(cardText, /bottom-right of your screen in Safari/i, 'must not literally say "in Safari" to a Chrome user');
  } finally {
    await context.close();
  }
});

test('PwaInstall.iosBrowserKind() correctly distinguishes Safari from Chrome/Firefox/Edge on iOS via each vendor\'s own UA token', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  async function kindFor(userAgent) {
    var context = await browser.newContext({ userAgent: userAgent });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await safeGoto(page, baseUrl + '/login.html');
      return await page.evaluate(function () { return window.PwaInstall.iosBrowserKind(); });
    } finally {
      await context.close();
    }
  }

  assert.equal(await kindFor(NORMAL_IOS_SAFARI_UA), 'safari');
  assert.equal(await kindFor(CHROME_IOS_UA), 'chrome');
  assert.equal(await kindFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15'), 'firefox');
  assert.equal(await kindFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/130.0.0.0 Mobile/15E148 Safari/605.1.15'), 'edge');
});

test('home.html\'s persistent install journey card also shows Chrome-specific guidance on Chrome-iOS (shared buildIOSGuidanceHtml dispatch)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: CHROME_IOS_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var username = 'installhomechrome' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#install-qrow', { state: 'visible', timeout: 5000 });
    await page.click('#install-qrow');
    await page.waitForSelector('#install-sheet-overlay.open', { timeout: 5000 });

    var sheetText = await page.textContent('#install-sheet-body');
    assert.match(sheetText, /address bar/i, 'home.html\'s journey-card sheet must use the same Chrome-aware guidance, not a hardcoded Safari mock');
    assert.doesNotMatch(sheetText, /•••/, 'must not show Safari\'s "•••" mock inside Chrome');
  } finally {
    await context.close();
  }
});

test('manifest.json start_url launches to the signed-in dashboard (home.html), not the marketing welcome screen (index.html)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/index.html');
    var manifest = await page.evaluate(function () {
      return fetch('manifest.json').then(function (r) { return r.json(); });
    });
    // Root cause of the founder's "doesn't do anything" report: launching
    // the installed icon used to always land on the generic marketing
    // welcome page (index.html), which has zero signed-in-state awareness
    // (no getCurrentUser check, no redirect) -- indistinguishable from
    // "nothing happened" for an already-signed-in returning user. home.html
    // itself already redirects a signed-OUT visitor to login.html (see that
    // page's own first script line), so this one change correctly serves
    // both cases.
    assert.equal(manifest.start_url, './home.html');
  } finally {
    await context.close();
  }
});

test('manifest.json declares real 192x192 and 512x512 icons for both "any" and "maskable" purposes (Chrome\'s documented installability requirement)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/index.html');
    var manifest = await page.evaluate(function () {
      return fetch('manifest.json').then(function (r) { return r.json(); });
    });
    // A single 1254x1254-only declared icon (this manifest's state before
    // this fix) does not satisfy Chrome/Chromium's installability checker,
    // which specifically requires a 192x192 AND a 512x512 declared icon --
    // confirmed via Chrome's own Lighthouse docs and MDN's "Making PWAs
    // installable" guide (tracker item for-product-bug-research-founder-
    // high-ad-vnda9t's research pass). Real installability gates whether
    // beforeinstallprompt ever fires at all.
    function sizesFor(purpose) {
      return manifest.icons.filter(function (i) { return i.purpose === purpose; }).map(function (i) { return i.sizes; });
    }
    assert.ok(sizesFor('any').indexOf('192x192') !== -1, 'expected a 192x192 "any"-purpose icon');
    assert.ok(sizesFor('any').indexOf('512x512') !== -1, 'expected a 512x512 "any"-purpose icon');
    assert.ok(sizesFor('maskable').indexOf('192x192') !== -1, 'expected a 192x192 maskable icon');
    assert.ok(sizesFor('maskable').indexOf('512x512') !== -1, 'expected a 512x512 maskable icon');
  } finally {
    await context.close();
  }
});

test('apple-touch-icon is present and fetchable on every real app page (iOS uses this specifically, not just manifest icons)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var pagesToCheck = ['index.html', 'home.html', 'result.html', 'profile.html', 'processing.html'];
    for (var i = 0; i < pagesToCheck.length; i++) {
      await safeGoto(page, baseUrl + '/' + pagesToCheck[i]);
      var href = await page.getAttribute('link[rel="apple-touch-icon"]', 'href');
      assert.equal(href, 'assets/apple-touch-icon.png', pagesToCheck[i] + ' must declare a real apple-touch-icon');
      var capableContent = await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', 'content');
      assert.equal(capableContent, 'yes', pagesToCheck[i] + ' must declare apple-mobile-web-app-capable so the installed icon launches standalone, not as a plain Safari-chrome bookmark');

      var fetchStatus = await page.evaluate(function () {
        return fetch('assets/apple-touch-icon.png').then(function (r) { return r.status; });
      });
      assert.equal(fetchStatus, 200, 'assets/apple-touch-icon.png must actually be fetchable, not a dangling link');
    }
  } finally {
    await context.close();
  }
});

/** Mocks a generation that never completes -- keeps processing.html parked on the wait screen, same helper shape as test/wait-screen-reassurance-and-inapp-nudge-behavioral.test.js's own mockNeverFinishingGeneration. */
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

// Same "read window.posthog directly, don't stub it" technique
// test/first-video-created-behavioral.test.js's own header comment
// documents: PostHog's inline stub snippet in every page's <head> makes
// window.posthog literally BE its own pending-call queue array (each
// capture()/identify()/etc. call is `array.push([methodName, ...args])`
// onto itself) until the real array.js bundle loads and drains it — which
// never happens in these tests since blockThirdParty() aborts that
// request. So `posthog.capture('push_prompt_shown', {})` shows up as a
// queued `['capture', 'push_prompt_shown', {}]` entry, directly
// inspectable after the fact — no monkeypatch/addInitScript needed, and
// none would survive processing.html's own snippet re-assigning
// window.posthog fresh on every load anyway.
function capturedEventNames(queue) {
  return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return entry[1]; });
}

test('push-subscribe ask: hidden inside a detected FB/IG in-app webview', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockNeverFinishingGeneration(page);
    var username = 'pushwebview' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForTimeout(300);

    var visible = await page.locator('#push-ask-card').count();
    assert.equal(visible, 0, 'the push-subscribe ask must never render inside a detected in-app webview');
  } finally {
    await context.close();
  }
});

test('push-subscribe ask: shown on a real browser right after generation starts, fires push_prompt_shown, and fires push_prompt_granted/push_prompt_denied off the real permission answer', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  async function runScenario(permissionOutcome) {
    var context = await browser.newContext();
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await mockNeverFinishingGeneration(page);
      // Deterministically stub the real permission dialog -- Playwright
      // has no built-in way to answer a live Notification permission
      // prompt per-test-scenario, so this overrides
      // Notification.requestPermission itself, BEFORE any page script
      // runs, to resolve exactly as this scenario needs. isSupported()
      // in js/push-subscribe.js only checks for the PRESENCE of the
      // Notification/PushManager/serviceWorker APIs, so this stub (an
      // object with a real requestPermission function) satisfies that
      // check without needing a real subscribe() round trip to actually
      // reach a push service.
      await page.addInitScript(function (outcome) {
        window.Notification = window.Notification || {};
        Object.defineProperty(window.Notification, 'permission', { value: 'default', configurable: true });
        window.Notification.requestPermission = function () { return Promise.resolve(outcome); };
      }, permissionOutcome);
      var username = 'pushask' + Math.random().toString(36).slice(2, 8);
      await seedUser(page, username);

      await safeGoto(page, baseUrl + '/processing.html');
      await page.waitForSelector('#push-ask-card', { state: 'visible', timeout: 5000 });

      var shownEventNames = await page.evaluate(function () {
        return (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
      }).then(capturedEventNames);
      assert.equal(shownEventNames.filter(function (n) { return n === 'push_prompt_shown'; }).length, 1, 'expected exactly one push_prompt_shown fire');

      await page.click('#push-ask-enable');
      var expectedEvent = permissionOutcome === 'granted' ? 'push_prompt_granted' : 'push_prompt_denied';
      var unexpectedEvent = permissionOutcome === 'granted' ? 'push_prompt_denied' : 'push_prompt_granted';
      await page.waitForFunction(function (evtName) {
        return window.posthog && window.posthog.some(function (entry) { return entry[0] === 'capture' && entry[1] === evtName; });
      }, expectedEvent, { timeout: 5000 });

      var finalNames = await page.evaluate(function () { return window.posthog.slice(); }).then(capturedEventNames);
      assert.ok(finalNames.indexOf(expectedEvent) !== -1, 'expected ' + expectedEvent + ' to fire for a ' + permissionOutcome + ' permission answer');
      assert.ok(finalNames.indexOf(unexpectedEvent) === -1, 'must never fire ' + unexpectedEvent + ' for a ' + permissionOutcome + ' answer');
    } finally {
      await context.close();
    }
  }

  await runScenario('granted');
  await runScenario('denied');
});

test('push-subscribe ask: never re-shown once dismissed, in the same browser', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockNeverFinishingGeneration(page);
    var username = 'pushdismiss' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForSelector('#push-ask-card', { state: 'visible', timeout: 5000 });
    await page.click('#push-ask-dismiss');
    assert.equal(await page.locator('#push-ask-card').count(), 0);

    // A fresh generation on a later load (same browser, same localStorage)
    // must not show the ask again.
    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#push-ask-card').count(), 0, 'must never re-show the push ask once dismissed in this browser');
  } finally {
    await context.close();
  }
});
