// test/interp-analytics-behavioral.test.js
//
// PostHog instrumentation for result.html's "What might this dream mean?"
// interpretation pill — tracker item for-product-instrument-the-existing-
// inte-wbkgkx: this pill had ZERO events before this branch (open rate,
// completion, read time all unmeasured), and these are the Reach inputs
// for the whole upcoming interpretation-flagship roadmap. Deliberately
// NEUTRAL event names (interp_opened/interp_completed/interp_regenerated/
// interp_closed) — never anything health/therapy-flavored, since this
// app's ad-pixel domain is the same web property Meta's health-classifier
// scans (a standing firewall, not a one-off caution).
//
// Follows test/shop-purchase-conversion-behavioral.test.js's own
// established "read straight out of the PostHog stub's pending-call
// queue" convention (readPostHogCalls) rather than monkeypatching
// posthog.capture, and test/ui-behavioral.test.js's seedResultPage helper
// shape for getting a real, authenticated result.html render.

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

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Seeds a logged-in account owning one dream with no saved interpretation yet, matching test/ui-behavioral.test.js's own seedResultPage shape. */
async function seedResultPage(page, dreamId, extra) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var id = args.id, extra = args.extra || {};
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.dreams) state.dreams = [];
    state.dreams.push(Object.assign({
      id: id,
      ownerHandle: '@tester',
      caption: 'A test dream about flying over mountains',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: new Date().toISOString()
    }, extra));
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { id: dreamId, extra: extra });
  await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
}

/** Mocks interpret-dream.js with a fixed response, matching js/store.js's generateInterpretation's expected {interpretation} shape. */
function mockInterpretDream(page, text) {
  return page.route('**/.netlify/functions/interpret-dream', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: text || 'A reflection on flight and freedom.' }) });
  });
}

/** Reads every posthog.capture(...) call recorded so far, same convention as test/shop-purchase-conversion-behavioral.test.js's readPostHogCalls. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function captures(phCalls, eventName) {
  return phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === eventName; });
}

test('result.html: tapping the interpretation pill fires interp_opened, and a successful fresh generation fires interp_completed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, 'You are exploring new heights of freedom.');
    await seedResultPage(page, 'd-interp-opened-completed');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#interp-ready', { state: 'visible', timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'interp_opened').length, 1, 'expected exactly one interp_opened capture');
    assert.equal(captures(phCalls, 'interp_completed').length, 1, 'expected exactly one interp_completed capture once the text actually renders');
    // Never health/therapy-flavored -- the standing ad-pixel-domain firewall
    // this item's own detail text calls out explicitly.
    var allNames = phCalls.filter(function (e) { return e[0] === 'capture'; }).map(function (e) { return e[1]; });
    allNames.forEach(function (name) {
      assert.doesNotMatch(name, /therap|mental.?health|anxiety|depress|diagnos/i, 'event name "' + name + '" must never be health/therapy-flavored');
    });
  } finally {
    await context.close();
  }
});

test('result.html: revisiting an already-interpreted dream (cached, no network call) still fires interp_opened + interp_completed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // No mock for interpret-dream -- if the revisit path ever accidentally
    // hit the network, this would 404/fail loudly rather than silently
    // passing, proving the cached-text branch is what actually fired.
    await seedResultPage(page, 'd-interp-revisit', { interpretationText: 'Already-saved reflection text.', interpretationAt: Date.now() });

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#interp-ready', { state: 'visible', timeout: 5000 });
    var bodyText = await page.locator('#interp-text-body').textContent();
    assert.equal(bodyText, 'Already-saved reflection text.');

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'interp_opened').length, 1);
    assert.equal(captures(phCalls, 'interp_completed').length, 1);
  } finally {
    await context.close();
  }
});

test('result.html: tapping Regenerate fires interp_regenerated (once), distinct from the initial open/complete pair', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, 'First reflection.');
    await seedResultPage(page, 'd-interp-regenerate');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#interp-ready', { state: 'visible', timeout: 5000 });

    await mockInterpretDream(page, 'Regenerated reflection.');
    await page.click('#interp-regenerate-btn');
    await page.waitForFunction(function () {
      var el = document.getElementById('interp-text-body');
      return el && el.textContent === 'Regenerated reflection.';
    }, null, { timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'interp_regenerated').length, 1, 'expected exactly one interp_regenerated capture');
    assert.equal(captures(phCalls, 'interp_completed').length, 2, 'both the initial generation and the regenerate each fire their own interp_completed');
  } finally {
    await context.close();
  }
});

test('result.html: closing the sheet via the explicit Close link fires interp_closed with a real read_time_ms', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, 'A reflection to read.');
    await seedResultPage(page, 'd-interp-close-button');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#interp-ready', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(50); // ensure a nonzero, real elapsed read time
    await page.click('#interp-close-btn');

    var phCalls = await readPostHogCalls(page);
    var closedCaptures = captures(phCalls, 'interp_closed');
    assert.equal(closedCaptures.length, 1, 'expected exactly one interp_closed capture');
    var readTimeMs = closedCaptures[0][2] && closedCaptures[0][2].read_time_ms;
    assert.ok(typeof readTimeMs === 'number' && readTimeMs >= 0, 'read_time_ms must be a real, non-negative elapsed duration, got ' + readTimeMs);
  } finally {
    await context.close();
  }
});

test('result.html: dismissing the sheet by tapping OUTSIDE (not the Close link) still fires interp_closed with a read time -- the more common real-world dismiss gesture must not silently skip tracking', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, 'A reflection to read, dismissed by tap-outside.');
    await seedResultPage(page, 'd-interp-tap-outside');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#interp-ready', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(50);

    // Tap the dimmed overlay area outside the sheet card itself -- the
    // SheetDismiss.wire tap-outside path, a completely different code path
    // from #interp-close-btn's own click handler.
    await page.click('#sheet-interp-overlay', { position: { x: 5, y: 5 } });
    await page.waitForFunction(function () {
      var el = document.getElementById('sheet-interp-overlay');
      return el && !el.classList.contains('open');
    }, null, { timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    var closedCaptures = captures(phCalls, 'interp_closed');
    assert.equal(closedCaptures.length, 1, 'tap-outside dismissal must fire interp_closed too, not just the explicit Close link');
    var readTimeMs = closedCaptures[0][2] && closedCaptures[0][2].read_time_ms;
    assert.ok(typeof readTimeMs === 'number' && readTimeMs >= 0, 'read_time_ms must be a real, non-negative elapsed duration, got ' + readTimeMs);
  } finally {
    await context.close();
  }
});

test('result.html: never opening the interpretation sheet at all fires none of the interp_* events', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'd-interp-never-opened');
    await page.waitForSelector('#interp-cta-btn', { timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    ['interp_opened', 'interp_completed', 'interp_regenerated', 'interp_closed'].forEach(function (name) {
      assert.equal(captures(phCalls, name).length, 0, 'expected zero ' + name + ' captures when the pill is never tapped');
    });
  } finally {
    await context.close();
  }
});
