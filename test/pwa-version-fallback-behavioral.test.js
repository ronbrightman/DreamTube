// test/pwa-version-fallback-behavioral.test.js
//
// Real browser-driven coverage for the SECOND round of tracker item
// for-product-urgent-founder-gets-stale-pa-6dn54z (2026-08-04). The
// CACHE_VERSION auto-stamping fix (test/pwa-sw-update-behavioral.test.js's
// last test) is confirmed live and correct server-side on both production
// origins, but it only ever reaches a device that already has an OLD
// service worker registered from before that fix existed if the browser's
// own `registration.update()` byte-comparison check succeeds at least once
// -- and that check is specifically unreliable in Safari/WKWebView, the
// founder's actual real-world browsing context. This file covers the
// second, SW-lifecycle-INDEPENDENT safety net added for that gap: js/pwa.js's
// initVersionFallback()/checkVersionFallback(), which polls /version.json
// directly (no service worker involved at all) and reuses reloadWhenSafe()
// -- the exact same one-shot/typing/recording-safe reload guard
// test/pwa-sw-update-behavioral.test.js already exercises -- on a genuine
// version mismatch. See js/pwa.js's own header comment above
// initVersionFallback() for the full root-cause writeup.
//
// Covers:
//   1. First-ever check for a browser just records the version, no reload
//      (matches the existing controllerchange-on-first-load guard's own
//      "a brand new visitor shouldn't get a pointless reload" reasoning).
//   2. A LATER check that finds a genuinely different version triggers the
//      shared reloadWhenSafe() deferred reload -- proven via a REAL
//      version.json byte change on disk (the on-disk-deploy-simulation
//      pattern test/pwa-sw-update-behavioral.test.js's last test
//      established), not a synthetic event.
//   3. The typing guard (shared with the SW-driven reload path) is
//      respected: a version mismatch found while the user is actively
//      typing defers the reload until they stop.
//   4. A fetch failure (network error) never breaks the page and never
//      forces a reload -- defensive/best-effort everywhere, matching this
//      codebase's established discipline for every other analytics/PWA-
//      adjacent call.
//
// Same static-server + real Chromium approach, and the same helpers
// (blockThirdParty/safeGoto/seedUser/shrinkStaleThreshold/trackReloadAttempts/
// waitForCount/simulateHiddenThenVisible), as
// test/pwa-sw-update-behavioral.test.js -- duplicated here per this repo's
// own established convention of each behavioral test file owning its own
// copy of small fixtures like this rather than sharing one across files.
//
// One deliberate deviation: every test here also calls blockServiceWorker()
// (aborts the sw.js registration request) before navigating. Without it,
// simulateHiddenThenVisible() would ALSO trigger registerServiceWorker()'s
// own pre-existing hidden-tab reload (Gap 2's fix, already covered by
// test/pwa-sw-update-behavioral.test.js) -- that path fires on hidden
// duration alone, with no dependency on version.json at all, so it can
// race the version-fallback path this file exists to test and land the
// SAME reload first, well before this file's own async version.json
// compare has even written its result. Confirmed directly (not
// theoretical): this made the "genuine version change" test below flaky
// under real timing, not merely a full-suite contention artifact.
// Isolating sw.js out is also, deliberately, the single clearest possible
// demonstration of this fix's own core claim -- that it works even when
// the service worker layer is entirely unavailable/broken.

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
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

/**
 * Aborts the sw.js registration request outright, so navigator.serviceWorker
 * .register() rejects and registerServiceWorker()'s own visibilitychange
 * listener (the pre-existing Gap-2 hidden-tab reload fix,
 * test/pwa-sw-update-behavioral.test.js's own coverage) never attaches at
 * all. Deliberate, not incidental: this is what actually proves the
 * version-fallback mechanism is SW-lifecycle-INDEPENDENT, per this fix's
 * own brief — without it, simulateHiddenThenVisible() below would also
 * trigger that OTHER, already-covered reload path (which fires on hidden
 * duration alone, with no dependency on version.json at all), racing it
 * against the one this file exists to test and making which mechanism
 * actually caused a given reload ambiguous. Confirmed directly: leaving
 * sw.js registration active made this file's "genuine version change"
 * test genuinely flaky (the pre-existing SW path could win the race and
 * reload the page before this file's own async version.json compare had
 * even written its result), not a full-suite contention artifact.
 */
function blockServiceWorker(page) {
  return page.route(/\/sw\.js(\?.*)?$/, function (route) { route.abort(); });
}

async function safeGoto(page, url, opts) {
  try {
    await page.goto(url, Object.assign({ waitUntil: 'domcontentloaded' }, opts || {}));
  } catch (e) {
    await page.goto(url, Object.assign({ waitUntil: 'domcontentloaded' }, opts || {}));
  }
}

/** Seeds a logged-in account directly into localStorage — same shortcut every other behavioral test in this repo uses (see test/delete-account-behavioral.test.js's identical seedUser). */
async function seedUser(page, username, baseUrlOverride) {
  await safeGoto(page, (baseUrlOverride || baseUrl) + '/login.html');
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

/** Sets window.__TEST_PWA_OVERRIDES__.hiddenStaleThresholdMs before js/pwa.js's top-level IIFE runs on the next navigation, so the test doesn't need to wait 30 real minutes. initVersionFallback() reuses this exact same hiddenStaleThresholdMs() function/override, per this fix's own brief not to invent a second timing scheme. */
function shrinkStaleThreshold(page, thresholdMs) {
  return page.addInitScript(function (threshold) {
    window.__TEST_PWA_OVERRIDES__ = { hiddenStaleThresholdMs: threshold };
  }, thresholdMs);
}

/**
 * Counts real navigation requests to `pageUrl` from here on — the
 * observable signature of a `location.reload()` call (see
 * test/pwa-sw-update-behavioral.test.js's identical helper for why
 * location.reload can't be monkeypatched and its request can't reliably
 * be intercepted once a service worker controls the page — this file
 * mirrors that approach even though its own trigger never touches the
 * service worker, for consistency and because the underlying reload is
 * the exact same reloadWhenSafe() call either way).
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
 * page.evaluate() immediately after a just-triggered location.reload() can
 * land in the exact window where the OLD execution context is being torn
 * down mid-navigation, throwing "Execution context was destroyed, most
 * likely because of a navigation" — confirmed directly (not theoretical):
 * a single page.waitForLoadState('domcontentloaded') in between was NOT
 * enough to reliably avoid this (it can itself resolve against the
 * pre-navigation state depending on exactly when the underlying request
 * fired vs. when Playwright's navigation tracking picks it up). Retries
 * the evaluate on that specific error until the new page has genuinely
 * settled, rather than guessing at one fixed delay.
 */
async function evaluateAfterReload(page, fn) {
  var lastErr = null;
  for (var i = 0; i < 30; i++) {
    try {
      return await page.evaluate(fn);
    } catch (e) {
      if (!/Execution context was destroyed/.test(e.message || '')) throw e;
      lastErr = e;
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
  }
  throw lastErr;
}

/** Waits for js/pwa.js's initVersionFallback() to have actually finished its page-load-time checkVersionFallback() call, via the precise __versionFallbackReady promise it exposes for exactly this purpose -- same reasoning as test/pwa-sw-update-behavioral.test.js's waitForSwWired (a fixed-delay guess would be genuinely flaky against real async scheduling). */
async function waitForVersionFallbackReady(page) {
  await page.waitForFunction(function () {
    return !!(window.PwaInstall && window.PwaInstall.__versionFallbackReady);
  }, null, { timeout: 8000 });
  await page.evaluate(function () { return window.PwaInstall.__versionFallbackReady; });
}

/** Simulates the tab going hidden then becoming visible again `elapsedMs` later, by shadowing document.visibilityState as an own property (a well-established technique for this exact un-fakeable-otherwise browser state) and dispatching the real event js/pwa.js listens for. Identical to test/pwa-sw-update-behavioral.test.js's own helper. */
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

/**
 * Builds an isolated temp directory that symlinks every real repo entry
 * EXCEPT version.json (so home.html/js/css/etc. all serve exactly as they
 * really are, with zero duplication), and writes a real, standalone
 * version.json into it -- the same "simulate a real deploy by overwriting
 * one file on disk between requests" technique
 * test/pwa-sw-update-behavioral.test.js's last test established for sw.js,
 * applied here to version.json instead. Returns { tmpDir, versionPath }.
 */
function makeDeployRoot(initialVersionPayload) {
  var repoRoot = path.join(__dirname, '..');
  var tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dreamtube-versiondeploy-'));
  var EXCLUDE = { 'version.json': true, '.git': true, 'node_modules': true, '.claude': true };
  fs.readdirSync(repoRoot).forEach(function (name) {
    if (EXCLUDE[name]) return;
    fs.symlinkSync(path.join(repoRoot, name), path.join(tmpDir, name));
  });
  var versionPath = path.join(tmpDir, 'version.json');
  fs.writeFileSync(versionPath, JSON.stringify(initialVersionPayload, null, 2) + '\n');
  return { tmpDir: tmpDir, versionPath: versionPath };
}

test('first-ever check for a browser records the version.json baseline, no reload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var deploy = makeDeployRoot({ version: 'v-baseline-1' });
  var deployServer = null;
  var context = null;
  try {
    deployServer = await staticServer.start({ root: deploy.tmpDir });
    var deployBaseUrl = deployServer.url;

    context = await browser.newContext();
    var page = await context.newPage();
    await blockThirdParty(page);
    await blockServiceWorker(page);
    var username = 'verfirst' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username, deployBaseUrl);

    await safeGoto(page, deployBaseUrl + '/home.html');
    var reloadCounter = trackReloadAttempts(page, deployBaseUrl + '/home.html');
    await waitForVersionFallbackReady(page);

    var stored = await page.evaluate(function () { return localStorage.getItem('dreamtube_last_known_version_v1'); });
    assert.equal(stored, 'v-baseline-1', 'expected the first-ever check to record version.json\'s version as a baseline');

    await page.waitForTimeout(200); // give a wrongly-firing reload a chance to happen
    assert.equal(reloadCounter.count, 0, 'a brand new browser with nothing previously recorded must not be reloaded on its very first check');
  } finally {
    if (context) await context.close();
    if (deployServer) await deployServer.close();
    fs.rmSync(deploy.tmpDir, { recursive: true, force: true });
  }
});

test('a genuine version.json change on disk (simulating a real deploy) triggers exactly one reload once the tab resurfaces', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var deploy = makeDeployRoot({ version: 'v-deploy-old' });
  var deployServer = null;
  var context = null;
  try {
    deployServer = await staticServer.start({ root: deploy.tmpDir });
    var deployBaseUrl = deployServer.url;

    context = await browser.newContext();
    var page = await context.newPage();
    await blockThirdParty(page);
    await blockServiceWorker(page);
    await shrinkStaleThreshold(page, 50);
    var username = 'verchanged' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username, deployBaseUrl);

    await safeGoto(page, deployBaseUrl + '/home.html');
    await waitForVersionFallbackReady(page); // records the baseline (v-deploy-old), no reload yet

    var reloadCounter = trackReloadAttempts(page, deployBaseUrl + '/home.html');

    // Simulate a real deploy: overwrite version.json on disk with a
    // genuinely different version -- the exact diff scripts/generate-
    // version.js produces on every real build.
    fs.writeFileSync(deploy.versionPath, JSON.stringify({ version: 'v-deploy-new' }, null, 2) + '\n');

    // The tab resurfacing past the (shrunk) stale threshold is what
    // triggers the next real check against the now-changed version.json —
    // reusing registerServiceWorker()'s own hidden-tab timing scheme, per
    // this fix's own brief.
    await simulateHiddenThenVisible(page, 150); // hidden for 150ms, threshold is 50ms

    var calls = await waitForCount(reloadCounter, 5000);
    assert.equal(calls, 1, 'expected exactly one reload once a genuinely different version.json was observed');

    // The reload counted above is a real, uncancellable navigation (see
    // test/pwa-sw-update-behavioral.test.js's header comment on why
    // location.reload can't be monkeypatched) -- reading localStorage
    // immediately afterward can race the old execution context tearing
    // down mid-navigation ("Execution context was destroyed"), so this
    // retries past that specific, expected race rather than a single
    // evaluate call (see evaluateAfterReload's own comment).
    var stored = await evaluateAfterReload(page, function () { return localStorage.getItem('dreamtube_last_known_version_v1'); });
    assert.equal(stored, 'v-deploy-new', 'expected the newly-observed version to be recorded');
  } finally {
    if (context) await context.close();
    if (deployServer) await deployServer.close();
    fs.rmSync(deploy.tmpDir, { recursive: true, force: true });
  }
});

test('defers the version-mismatch reload while the user is actively typing, then fires once they stop', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var deploy = makeDeployRoot({ version: 'v-typing-old' });
  var deployServer = null;
  var context = null;
  try {
    deployServer = await staticServer.start({ root: deploy.tmpDir });
    var deployBaseUrl = deployServer.url;

    context = await browser.newContext();
    var page = await context.newPage();
    await blockThirdParty(page);
    await blockServiceWorker(page);
    await shrinkStaleThreshold(page, 50);
    var username = 'vertyping' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username, deployBaseUrl);

    // create.html's #dream-text — same "mid-typing on create.html/wizard.html"
    // scenario test/pwa-sw-update-behavioral.test.js's own typing-guard test
    // exercises for the SW-driven reload path; this proves the SAME shared
    // guard also covers the version-fallback-driven path.
    await safeGoto(page, deployBaseUrl + '/create.html?write=1');
    await waitForVersionFallbackReady(page); // records the baseline, no reload yet

    var reloadCounter = trackReloadAttempts(page, deployBaseUrl + '/create.html?write=1');

    fs.writeFileSync(deploy.versionPath, JSON.stringify({ version: 'v-typing-new' }, null, 2) + '\n');

    await page.waitForSelector('#dream-text', { state: 'visible', timeout: 5000 });
    await page.focus('#dream-text');
    await page.keyboard.type('a dream about');

    await simulateHiddenThenVisible(page, 150); // past the 50ms threshold -- triggers the version check

    await page.waitForTimeout(400);
    assert.equal(reloadCounter.count, 0, 'must not reload out from under someone actively typing a draft, even when a real version mismatch was found');

    // Now stop typing (blur the field) -- the deferred reload should fire,
    // via the exact same reloadWhenSafe()/attempt() guard the SW-driven
    // path uses (visibilitychange/focusout re-check).
    await page.evaluate(function () { document.activeElement && document.activeElement.blur(); });
    var calls = await waitForCount(reloadCounter, 3000);
    assert.equal(calls, 1, 'expected the deferred reload to fire once typing stopped');
  } finally {
    if (context) await context.close();
    if (deployServer) await deployServer.close();
    fs.rmSync(deploy.tmpDir, { recursive: true, force: true });
  }
});

test('a version.json fetch failure never breaks the page and never forces a reload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = null;
  try {
    context = await browser.newContext();
    var page = await context.newPage();
    await blockThirdParty(page);
    await blockServiceWorker(page);

    // Force every /version.json request to fail at the network level —
    // the real shape of "a fetch failure" this fix must be defensive
    // against (a transient network blip, an offline device, a CDN hiccup).
    await page.route(/\/version\.json(\?.*)?$/, function (route) {
      route.abort('failed');
    });

    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(err); });

    var username = 'verfail' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);

    await safeGoto(page, baseUrl + '/home.html');
    var reloadCounter = trackReloadAttempts(page, baseUrl + '/home.html');
    await waitForVersionFallbackReady(page); // must still resolve even though the fetch itself failed

    var stored = await page.evaluate(function () { return localStorage.getItem('dreamtube_last_known_version_v1'); });
    assert.equal(stored, null, 'a failed fetch must never fabricate a recorded version');

    await page.waitForTimeout(200);
    assert.equal(reloadCounter.count, 0, 'a fetch failure must never trigger a reload');
    assert.deepEqual(pageErrors, [], 'a fetch failure must never throw an uncaught error onto the page');

    // The page must still be fully usable — home.html's own real DOM
    // rendered normally, unaffected by the failed background check.
    var title = await page.title();
    assert.ok(title && title.length > 0, 'the page must still have loaded and rendered normally despite the version.json fetch failing');
  } finally {
    if (context) await context.close();
  }
});
