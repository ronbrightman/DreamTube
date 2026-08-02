// test/claim-dream-retention-motivators-behavioral.test.js
//
// Real browser-driven coverage for claim-dream.html's retention-motivators
// build (tracker item for-product-claim-dream-html-retention-e-b27l7l):
//   1. PostHog is now genuinely loaded on this page (a founder-explicit,
//      2026-07-28 override of the page's earlier "no analytics at all"
//      default -- see the <head> comment in claim-dream.html) and fires a
//      claim_page_viewed baseline event exactly once per page load, no
//      matter which outcome the visit lands on.
//   2. The existing "maybe later" escape link (#just-watch-link) fires a
//      claim_page_maybe_later_clicked event on click, with its pre-existing
//      behavior (hiding already-in-view/mismatch-view/signup-view/itself)
//      completely unchanged -- a regression-proof of the "respect the no"
//      requirement.
//   3. Two short benefit bullets render next to the signup CTA
//      (#claim-benefits), arguing for completing signup without adding any
//      friction in front of the maybe-later exit.
//
// Follows test/funnel-distinct-id-behavioral.test.js's/
// test/first-video-created-behavioral.test.js's approach of reading
// PostHog calls straight out of the stub's own pending-call queue (window.posthog
// stays the pre-init stub array the whole test, since blockThirdParty
// aborts the real array.js bundle load) -- more reliable here than a
// monkeypatch, see those files' header comments for why.

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

/** Reads every posthog call made during this page load straight out of the PostHog stub's own pending-call queue. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function captureCallsNamed(calls, name) {
  return calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === name; });
}

function mockVerifyPendingClaim(page, response) {
  return page.route('**/.netlify/functions/verify-pending-claim', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

var READY_RESPONSE = {
  ok: true,
  email: 'watcher@example.com',
  caption: 'Flying over the ocean',
  style: 'Cinematic',
  videoUrl: 'https://cdn.fal/finished.mp4',
  status: 'ready'
};

test('claim_page_viewed fires exactly once on a ready, not-logged-in visit, carrying the ready status', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifyPendingClaim(page, READY_RESPONSE);

    await page.goto(baseUrl + '/claim-dream.html?pending=pd1&token=tok1', { waitUntil: 'domcontentloaded' });
    await page.locator('#signup-view').waitFor({ state: 'visible', timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var viewedCalls = captureCallsNamed(calls, 'claim_page_viewed');
    assert.equal(viewedCalls.length, 1, 'expected exactly one claim_page_viewed capture call');
    assert.equal(viewedCalls[0][2].status, 'ready');
    assert.equal(viewedCalls[0][2].hasParams, true);
  } finally {
    await context.close();
  }
});

test('claim_page_viewed still fires exactly once when the link is missing pending/token params', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/claim-dream.html', { waitUntil: 'domcontentloaded' });
    await page.locator('#error-view').waitFor({ state: 'visible', timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var viewedCalls = captureCallsNamed(calls, 'claim_page_viewed');
    assert.equal(viewedCalls.length, 1, 'expected exactly one claim_page_viewed capture call even on a malformed link');
    assert.equal(viewedCalls[0][2].status, 'missing_params');
    assert.equal(viewedCalls[0][2].hasParams, false);
  } finally {
    await context.close();
  }
});

test('claim_page_viewed fires with not_ready status when the dream has not finished generating yet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifyPendingClaim(page, { ok: false, error: 'E5: not ready yet' });

    await page.goto(baseUrl + '/claim-dream.html?pending=pd1&token=tok1', { waitUntil: 'domcontentloaded' });
    await page.locator('#error-view').waitFor({ state: 'visible', timeout: 5000 });

    var bodyText = await page.locator('#error-title').textContent();
    assert.equal(bodyText, 'Almost ready', 'existing not-ready copy must be unchanged');

    var calls = await readPostHogCalls(page);
    var viewedCalls = captureCallsNamed(calls, 'claim_page_viewed');
    assert.equal(viewedCalls.length, 1);
    assert.equal(viewedCalls[0][2].status, 'not_ready');
  } finally {
    await context.close();
  }
});

test('claim_page_viewed fires with invalid_or_expired status on any other verify-pending-claim rejection', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifyPendingClaim(page, { ok: false, error: 'E3: token mismatch' });

    await page.goto(baseUrl + '/claim-dream.html?pending=pd1&token=tok1', { waitUntil: 'domcontentloaded' });
    await page.locator('#error-view').waitFor({ state: 'visible', timeout: 5000 });

    var bodyText = await page.locator('#error-title').textContent();
    assert.equal(bodyText, "This link has expired", 'existing expired/invalid copy must be unchanged');

    var calls = await readPostHogCalls(page);
    var viewedCalls = captureCallsNamed(calls, 'claim_page_viewed');
    assert.equal(viewedCalls.length, 1);
    assert.equal(viewedCalls[0][2].status, 'invalid_or_expired');
  } finally {
    await context.close();
  }
});

test('claim_page_viewed fires with fetch_failed status when verify-pending-claim itself is unreachable', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/verify-pending-claim', function (route) {
      route.abort('failed');
    });

    await page.goto(baseUrl + '/claim-dream.html?pending=pd1&token=tok1', { waitUntil: 'domcontentloaded' });
    await page.locator('#error-view').waitFor({ state: 'visible', timeout: 5000 });

    var bodyText = await page.locator('#error-title').textContent();
    assert.equal(bodyText, "Couldn't load your dream", 'existing network-failure copy must be unchanged');

    var calls = await readPostHogCalls(page);
    var viewedCalls = captureCallsNamed(calls, 'claim_page_viewed');
    assert.equal(viewedCalls.length, 1);
    assert.equal(viewedCalls[0][2].status, 'fetch_failed');
  } finally {
    await context.close();
  }
});

test('clicking #just-watch-link fires claim_page_maybe_later_clicked exactly once and leaves its existing hide-everything behavior unchanged', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifyPendingClaim(page, READY_RESPONSE);

    await page.goto(baseUrl + '/claim-dream.html?pending=pd1&token=tok1', { waitUntil: 'domcontentloaded' });
    var link = page.locator('#just-watch-link');
    await link.waitFor({ state: 'visible', timeout: 5000 });

    // Regression-proof of "respect the no": the link must still be present,
    // unobstructed and clickable before the click.
    assert.equal(await link.isVisible(), true);
    var box = await link.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'maybe-later link must have real, clickable dimensions');

    await link.click();

    // Existing behavior (unchanged): signup-view and the link itself hide.
    await page.waitForFunction(function () {
      var linkEl = document.getElementById('just-watch-link');
      var signupEl = document.getElementById('signup-view');
      return linkEl.style.display === 'none' && signupEl.style.display === 'none';
    }, null, { timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var clickCalls = captureCallsNamed(calls, 'claim_page_maybe_later_clicked');
    assert.equal(clickCalls.length, 1, 'expected exactly one claim_page_maybe_later_clicked capture call');
  } finally {
    await context.close();
  }
});

test('short benefit bullets render next to the signup CTA, without touching the maybe-later link', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifyPendingClaim(page, READY_RESPONSE);

    await page.goto(baseUrl + '/claim-dream.html?pending=pd1&token=tok1', { waitUntil: 'domcontentloaded' });
    await page.locator('#signup-view').waitFor({ state: 'visible', timeout: 5000 });

    var benefits = page.locator('#claim-benefits');
    await assert.doesNotReject(benefits.waitFor({ state: 'visible', timeout: 5000 }));

    var text = (await benefits.textContent()).trim();
    assert.match(text, /interpretation/i, 'must mention the dream interpretation benefit');
    assert.match(text, /explore/i, 'must mention the Explore benefit');

    // Bullets must be genuinely short, not paragraphs.
    var labels = await page.locator('#claim-benefits .proc-check-label').allTextContents();
    assert.equal(labels.length, 2, 'expected exactly two benefit bullets');
    labels.forEach(function (label) {
      assert.ok(label.length <= 60, 'benefit bullet must be short, got: "' + label + '" (' + label.length + ' chars)');
    });

    // The bullets sit next to the CTA, not in front of the maybe-later exit.
    var ctaBox = await page.locator('#claim-signup-btn').boundingBox();
    var benefitsBox = await benefits.boundingBox();
    assert.ok(ctaBox && benefitsBox, 'both the CTA and the benefits block must be visible with real dimensions');

    var linkVisible = await page.locator('#just-watch-link').isVisible();
    assert.equal(linkVisible, true, 'the maybe-later link must remain visible and untouched by the new benefits block');
  } finally {
    await context.close();
  }
});

test('a logged-in visitor whose email matches the pending dream never sees the signup-only benefit bullets (they use the one-tap save path instead)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifyPendingClaim(page, READY_RESPONSE);

    // Log in as the matching account first (same localStorage-seeding
    // convention as test/shop-behavioral.test.js's seedShopPage).
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@watcher', username: 'watcher' };
      if (!state.accounts) state.accounts = {};
      state.accounts.watcher = { password: 'testpass1', email: 'watcher@example.com' };
      if (!state.dreams) state.dreams = [];
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });

    await page.goto(baseUrl + '/claim-dream.html?pending=pd1&token=tok1', { waitUntil: 'domcontentloaded' });
    await page.locator('#already-in-view').waitFor({ state: 'visible', timeout: 5000 });

    var signupVisible = await page.locator('#signup-view').isVisible();
    assert.equal(signupVisible, false, 'signup-view (and its benefits block) must stay hidden for an already-matching logged-in visitor');

    var linkVisible = await page.locator('#just-watch-link').isVisible();
    assert.equal(linkVisible, true, 'the maybe-later link must still be shown regardless of which path (signup vs. one-tap save) is active');

    var calls = await readPostHogCalls(page);
    assert.equal(captureCallsNamed(calls, 'claim_page_viewed').length, 1);
  } finally {
    await context.close();
  }
});
