// test/pwa-sw-update-behavioral.test.js
//
// Real browser-driven coverage for tracker item for-product-urgent-founder-
// gets-stale-pa-6dn54z (home.html showing the pre-deploy version hours
// after a real deploy, on real iPhone Safari). See js/pwa.js's own header
// comment above registerServiceWorker() for the full root-cause writeup;
// this file exercises the two fixes it describes:
//   1. A tab that's been hidden past window.__TEST_PWA_OVERRIDES__
//      .hiddenStaleThresholdMs gets a real reload the moment it becomes
//      visible again — the one signal guaranteed to fire even when iOS
//      Safari freezes a backgrounded tab without ever re-navigating it.
//   2. That reload is deferred (never interrupts) while the user looks to
//      be actively typing (document.activeElement is an input/textarea/
//      contenteditable), and fires once that stops.
//   3. A registration `controllerchange` (a genuinely new service worker
//      taking control) also triggers exactly one reload, same typing guard.
//
// Testing note, two real gotchas hit and confirmed via throwaway debug
// scripts before landing on this approach (not theoretical):
//   1. `location.reload` cannot be monkeypatched — Chromium exposes it as
//      a non-configurable, non-writable own property on the Location
//      object (confirmed directly: Object.defineProperty on it throws
//      "Cannot redefine property: reload").
//   2. Neither page.route() nor context.route() intercepts the resulting
//      navigation request once sw.js is actually registered and
//      controlling the page — the navigation is served via the service
//      worker's own `fetch` respondWith() (a separate execution context
//      Playwright's page/context-scoped routing doesn't reach), confirmed
//      by a route handler simply never firing for it while the page's own
//      `request` events (isNavigationRequest()) still fire normally for
//      the same navigation.
// So a reload attempt is observed here via the real, uncancellable
// navigation itself — counting `request` events for the page's own exact
// URL — rather than trying to prevent or monkeypatch it. The one real
// reload this lets through in the tests below is fine; none needs further
// page interaction after the count it's checking for.
//
// Follows test/pwa-stage0-behavioral.test.js's conventions closely (same
// blockThirdParty/safeGoto/seedUser helpers, same static-server + real
// Chromium approach) — this file covers the update/reload behavior that
// file's own tests don't touch.

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

/** Seeds a logged-in account directly into localStorage — same shortcut every other behavioral test in this repo uses (see test/delete-account-behavioral.test.js's identical seedUser). */
async function seedUser(page, username) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var state = {
      user: { handle: '@' + u, username: u },
      accounts: {},
      draft: { caption: '', style: 'Cinematic', mediaType: 'video', sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, sourceImageUrl: null, audioOn: false, musicStyle: null },
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

/** Sets window.__TEST_PWA_OVERRIDES__.hiddenStaleThresholdMs before js/pwa.js's top-level IIFE runs on the next navigation, so the test doesn't need to wait 30 real minutes. */
function shrinkStaleThreshold(page, thresholdMs) {
  return page.addInitScript(function (threshold) {
    window.__TEST_PWA_OVERRIDES__ = { hiddenStaleThresholdMs: threshold };
  }, thresholdMs);
}

/**
 * Counts real navigation requests to `pageUrl` from here on — the
 * observable signature of a `location.reload()` call, given it can't be
 * monkeypatched and its resulting request can't be intercepted once sw.js
 * is controlling the page (see header comment). Lets every actual reload
 * through rather than aborting it; no test here needs the page to survive
 * past the count it's checking for.
 */
function trackReloadAttempts(page, pageUrl) {
  var counter = { count: 0 };
  page.on('request', function (req) {
    if (req.isNavigationRequest() && req.url() === pageUrl) counter.count++;
  });
  return counter;
}

/** Polls a Node-side counter (can't use page.waitForFunction — the thing being awaited lives in Node, not the page) until it's > 0 or the timeout elapses. */
async function waitForCount(counter, timeoutMs) {
  var start = Date.now();
  while (counter.count === 0 && Date.now() - start < timeoutMs) {
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
  }
  return counter.count;
}

/**
 * Waits for js/pwa.js's registerServiceWorker() to have actually finished
 * attaching its controllerchange/visibilitychange listeners, via the
 * precise __swListenersReady promise it exposes for exactly this purpose.
 * An earlier version of this helper instead waited for
 * navigator.serviceWorker.controller to become truthy plus a fixed 250ms
 * buffer -- confirmed (via repeated standalone runs of the same scenario
 * outside node --test) to be genuinely flaky, since how long after
 * `controller` becomes non-null the .then() callback that attaches those
 * listeners actually runs is real, variable async scheduling, not a fixed
 * duration a buffer can reliably outrun.
 */
async function waitForSwWired(page) {
  await page.waitForFunction(function () {
    return !!(window.PwaInstall && window.PwaInstall.__swListenersReady);
  }, null, { timeout: 8000 });
  await page.evaluate(function () { return window.PwaInstall.__swListenersReady; });
}

/** Simulates the tab going hidden then becoming visible again `elapsedMs` later, by shadowing document.visibilityState as an own property (a well-established technique for this exact un-fakeable-otherwise browser state) and dispatching the real event js/pwa.js listens for. */
async function simulateHiddenThenVisible(page, elapsedMs) {
  await page.evaluate(function () {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(elapsedMs);
  await page.evaluate(function () {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('reloads a tab that was hidden past the stale threshold the moment it becomes visible again', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await shrinkStaleThreshold(page, 50);
    var username = 'swstale' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await waitForSwWired(page);
    var reloadCounter = trackReloadAttempts(page, baseUrl + '/home.html');

    await simulateHiddenThenVisible(page, 150); // hidden for 150ms, threshold is 50ms

    var calls = await waitForCount(reloadCounter, 3000);
    assert.equal(calls, 1, 'expected exactly one reload once the tab resurfaced past the stale threshold');
  } finally {
    await context.close();
  }
});

test('does NOT reload a tab hidden for less than the stale threshold', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await shrinkStaleThreshold(page, 5000); // 5s threshold
    var username = 'swfresh' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await waitForSwWired(page);
    var reloadCounter = trackReloadAttempts(page, baseUrl + '/home.html');

    await simulateHiddenThenVisible(page, 100); // hidden for only 100ms, well under the 5s threshold

    await page.waitForTimeout(300); // give any (wrongly-firing) reload a chance to happen
    assert.equal(reloadCounter.count, 0, 'a brief app-switch must never force a reload of a page someone is actively using');
  } finally {
    await context.close();
  }
});

test('defers the stale-tab reload while the user is actively typing, then fires once they stop', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await shrinkStaleThreshold(page, 50);
    var username = 'swtyping' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    // create.html's #dream-text is a real free-text dream field -- the
    // exact "mid-typing on create.html/wizard.html" scenario this guard
    // exists for (see js/pwa.js's isEditingSomething). ?write=1 (same
    // deep-link convention home.html's own "Write it" card uses) jumps
    // straight into Write mode so #dream-text is visible immediately,
    // rather than landing on the Build/Write/Record choice screen first.
    await safeGoto(page, baseUrl + '/create.html?write=1');
    await waitForSwWired(page);
    var reloadCounter = trackReloadAttempts(page, baseUrl + '/create.html?write=1');

    await page.waitForSelector('#dream-text', { state: 'visible', timeout: 5000 });
    await page.focus('#dream-text');
    await page.keyboard.type('a dream about');

    await simulateHiddenThenVisible(page, 150); // past the 50ms threshold

    await page.waitForTimeout(300);
    assert.equal(reloadCounter.count, 0, 'must not reload out from under someone actively typing a draft');

    // Now stop typing (blur the field) -- the deferred reload should fire.
    await page.evaluate(function () { document.activeElement && document.activeElement.blur(); });
    var calls = await waitForCount(reloadCounter, 3000);
    assert.equal(calls, 1, 'expected the deferred reload to fire once typing stopped');
  } finally {
    await context.close();
  }
});

test('a controllerchange event (a new service worker taking control) triggers exactly one reload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await shrinkStaleThreshold(page, 999999); // irrelevant to this test -- only controllerchange is exercised
    var username = 'swcontroller' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    await waitForSwWired(page);
    var reloadCounter = trackReloadAttempts(page, baseUrl + '/home.html');

    // Both dispatches happen back-to-back in the SAME synchronous tick,
    // before the real (uncancellable, per header comment) navigation from
    // the first one has had any chance to actually commit -- this is
    // exactly the window js/pwa.js's in-page reloadOnceGuard exists to
    // cover (the event "can in principle fire more than once across a
    // page's lifetime" per that file's own comment). Spacing these two
    // dispatches apart instead would let the first's real reload complete
    // and hand the second dispatch to a brand-new page instance with its
    // own fresh guard -- a real, correct new reload for THAT instance, not
    // a regression, so it wouldn't actually exercise the guard at all.
    await page.evaluate(function () {
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
    });

    var calls = await waitForCount(reloadCounter, 3000);
    assert.equal(calls, 1, 'expected a reload once a controllerchange fires');
    await page.waitForTimeout(300); // let a wrongly-firing second reload request show up if it exists

    assert.equal(reloadCounter.count, 1, 'expected exactly one reload total across two back-to-back controllerchange events (one-shot guard)');
  } finally {
    await context.close();
  }
});
