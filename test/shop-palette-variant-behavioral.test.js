// test/shop-palette-variant-behavioral.test.js
//
// Real browser-driven coverage for the shop palette A/B test added per
// docs/SHOP_PALETTE_REDESIGN_SPEC.md §8: shop.html's inline variant-
// assignment script (dreamtube_shop_variant in localStorage, sticky
// per-browser, sampled once via Math.random() < 0.5 and never reassigned),
// the resulting shop-variant-a/shop-variant-b body class that
// css/styles.css keys the "best value" pack's border/badge color off of,
// and the shop_palette_variant_shown PostHog event + posthog.register()
// call that rides the variant along on every later event from that
// browser. Follows test/shop-behavioral.test.js's seedShopPage/
// mockTokenStatus/blockThirdParty conventions and
// test/first-video-created-behavioral.test.js's approach to reading
// PostHog calls straight out of the stub's own pending-call queue (see
// that file's header comment for why that's more reliable here than a
// monkeypatch — blockThirdParty aborts the real array.js bundle load, so
// window.posthog stays the stub array the whole test).

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

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 50, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 100 }) });
  });
}

/** Same seeding approach as test/shop-behavioral.test.js's seedShopPage — logs in via localStorage state written on a login.html visit, optionally pre-seeding dreamtube_shop_variant before the shop.html navigation so a test can control the "repeat visit" precondition. */
async function seedShopPage(page, opts) {
  opts = opts || {};
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@shopper', username: 'shopper' };
    if (!state.accounts) state.accounts = {};
    state.accounts.shopper = { password: 'testpass1', email: o.email || 'shopper@example.com' };
    if (!state.dreams) state.dreams = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    if (o.presetVariant) localStorage.setItem('dreamtube_shop_variant', o.presetVariant);
  }, opts);
  await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
}

/** Reads every posthog call made during this page load straight out of the PostHog stub's own pending-call queue (window.posthog is the array itself until array.js loads and drains it — blocked here by blockThirdParty). */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

test('a fresh visit (no stored variant) assigns "a" or "b" and persists it in localStorage', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedShopPage(page);

    var stored = await page.evaluate(function () { return localStorage.getItem('dreamtube_shop_variant'); });
    assert.ok(stored === 'a' || stored === 'b', 'expected a fresh visit to assign and persist "a" or "b", got ' + JSON.stringify(stored));
  } finally {
    await context.close();
  }
});

test('a repeat visit with an existing stored variant keeps the same variant (no reassignment)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedShopPage(page, { presetVariant: 'a' });

    var storedAfterFirstLoad = await page.evaluate(function () { return localStorage.getItem('dreamtube_shop_variant'); });
    assert.equal(storedAfterFirstLoad, 'a');

    // Reload several times — a real reassignment bug would show up as a coin
    // flip on some fraction of these.
    for (var i = 0; i < 5; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      var stored = await page.evaluate(function () { return localStorage.getItem('dreamtube_shop_variant'); });
      assert.equal(stored, 'a', 'variant must stay "a" across reload #' + i);
    }
  } finally {
    await context.close();
  }
});

test('variant "a" applies shop-variant-a to the body and the accent-trust color to the best-value pack', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedShopPage(page, { presetVariant: 'a' });

    var hasClass = await page.evaluate(function () { return document.body.classList.contains('shop-variant-a'); });
    assert.equal(hasClass, true);
    var hasOtherClass = await page.evaluate(function () { return document.body.classList.contains('shop-variant-b'); });
    assert.equal(hasOtherClass, false);

    var borderColor = await page.evaluate(function () {
      var el = document.querySelector('.token-pack-card.best');
      return getComputedStyle(el).borderTopColor;
    });
    // --accent-trust: #6C8CFF -> rgb(108, 140, 255)
    assert.equal(borderColor, 'rgb(108, 140, 255)');
  } finally {
    await context.close();
  }
});

test('variant "b" applies shop-variant-b to the body and the accent-value color to the best-value pack', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedShopPage(page, { presetVariant: 'b' });

    var hasClass = await page.evaluate(function () { return document.body.classList.contains('shop-variant-b'); });
    assert.equal(hasClass, true);
    var hasOtherClass = await page.evaluate(function () { return document.body.classList.contains('shop-variant-a'); });
    assert.equal(hasOtherClass, false);

    var borderColor = await page.evaluate(function () {
      var el = document.querySelector('.token-pack-card.best');
      return getComputedStyle(el).borderTopColor;
    });
    // --accent-value: #D9A653 -> rgb(217, 166, 83)
    assert.equal(borderColor, 'rgb(217, 166, 83)');
  } finally {
    await context.close();
  }
});

test('shop_palette_variant_shown fires once per page view with the assigned variant, and posthog.register carries it too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedShopPage(page, { presetVariant: 'b' });

    var calls = await readPostHogCalls(page);

    var captureCalls = calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'shop_palette_variant_shown'; });
    assert.equal(captureCalls.length, 1, 'expected exactly one shop_palette_variant_shown capture call per page view');
    assert.deepEqual(captureCalls[0][2], { variant: 'b' });

    var registerCalls = calls.filter(function (entry) { return entry[0] === 'register'; });
    assert.equal(registerCalls.length, 1, 'expected exactly one posthog.register call');
    assert.deepEqual(registerCalls[0][1], { shop_palette_variant: 'b' });
  } finally {
    await context.close();
  }
});
