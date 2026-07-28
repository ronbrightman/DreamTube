// test/shop-first-purchase-callout-behavioral.test.js
//
// Real browser-driven coverage for shop.html's first-purchase +50% bonus
// callout (tracker item for-product-shop-first-purchase-50-bonus-bzx2d4).
// Founder feedback (2026-07-27 live shop review): the old static ".auth-sub"
// line ("First pack: +50% bonus tokens, automatically applied.") styled
// this like fine print even though it's this page's single strongest
// purchase motivator — the research that introduced the bonus called it
// the most proven payer-conversion lever. Promoted to a real, big-type,
// accent-styled callout (#shop-first-purchase-callout / .first-purchase-
// callout in css/styles.css), shown ONLY when get-token-status.js's
// hasMadeFirstPurchase field comes back explicitly false — showing this
// claim to a visitor who already redeemed the bonus would be false
// advertising per the founder's own words.
//
// Follows test/shop-behavioral.test.js's/shop-palette-variant-behavioral
// .test.js's seedShopPage/mockTokenStatus/blockThirdParty conventions.

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0, hasMadeFirstPurchase: false }) });
  });
}

/** Same seeding approach as test/shop-palette-variant-behavioral.test.js's seedShopPage — logs in via localStorage state written on a login.html visit, optionally pre-seeding dreamtube_shop_variant so a test can pin the palette variant. */
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

function calloutLocator(page) {
  return page.locator('#shop-first-purchase-callout');
}

test('shows a genuinely prominent, visible callout with the exact "first pack"/"automatically" copy when hasMadeFirstPurchase is false', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0, hasMadeFirstPurchase: false });
    await seedShopPage(page, { presetVariant: 'a' });

    var callout = calloutLocator(page);
    await assert.doesNotReject(callout.waitFor({ state: 'visible', timeout: 5000 }));

    var text = (await callout.textContent()).trim();
    assert.match(text, /first pack/i, 'copy must mention "first pack"');
    assert.match(text, /automatically/i, 'copy must mention "automatically"');
    assert.match(text, /\+50%/, 'copy must state the exact +50% bonus');
    // Must not overstate the claim as applying beyond the first pack.
    assert.doesNotMatch(text, /every pack|all packs|each purchase/i);

    // Genuinely prominent, not fine print: real visible box dimensions and
    // a real headline font size well above this page's small ".auth-sub"
    // fine-print copy (12.5px elsewhere on this page).
    var box = await callout.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'callout must have real visible dimensions');

    var headlineFontSize = await page.evaluate(function () {
      var el = document.querySelector('.first-purchase-callout-headline');
      return el && parseFloat(getComputedStyle(el).fontSize);
    });
    assert.ok(headlineFontSize >= 18, 'headline font size must read as prominent (>=18px), got ' + headlineFontSize);

    // The old small/faint static line must be gone, not left duplicated
    // alongside the new callout.
    var bodyText = await page.textContent('body');
    var oldLineCount = (bodyText.match(/First pack: \+50% bonus tokens, automatically applied\./g) || []).length;
    assert.equal(oldLineCount, 0, 'the old small/faint static line must be removed, not left duplicated alongside the new callout');
  } finally {
    await context.close();
  }
});

test('does NOT render when hasMadeFirstPurchase is true (repeat buyer already used the bonus)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 200, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0, hasMadeFirstPurchase: true });
    await seedShopPage(page);

    // Give renderBalance() a moment to run (waits on the balance number
    // actually reflecting the mocked status, proving the response landed
    // and was processed before asserting the callout stayed hidden).
    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent === '200';
    }, null, { timeout: 5000 });

    var isVisible = await calloutLocator(page).isVisible();
    assert.equal(isVisible, false, 'must not show the first-purchase bonus claim to a visitor who already made a first purchase');
  } finally {
    await context.close();
  }
});

test('does NOT render when hasMadeFirstPurchase is missing from the response (fails toward not showing a possibly-false claim)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Old/degraded response shape with no hasMadeFirstPurchase field at all.
    await mockTokenStatus(page, { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20 });
    await seedShopPage(page);

    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent === '50';
    }, null, { timeout: 5000 });

    var isVisible = await calloutLocator(page).isVisible();
    assert.equal(isVisible, false, 'a missing hasMadeFirstPurchase field must default to NOT showing the callout');
  } finally {
    await context.close();
  }
});

test('does NOT render when the token-status fetch fails outright', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E1: boom' }) });
    });
    await seedShopPage(page);

    // Give loadBalance()'s .catch() a moment to run (balance falls back to
    // the em dash placeholder on a fetch failure).
    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent === '–';
    }, null, { timeout: 5000 });

    var isVisible = await calloutLocator(page).isVisible();
    assert.equal(isVisible, false, 'a fetch failure must default to NOT showing the callout, never an unconditional claim');
  } finally {
    await context.close();
  }
});

test('styles correctly under both shop-variant-a and shop-variant-b palette variants without duplicating the whole suite', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0, hasMadeFirstPurchase: false });

    // Variant A — periwinkle-blue (--accent-trust: #6C8CFF -> rgb(108, 140, 255)),
    // same color the "best value" pack card's own A/B border uses in this variant.
    await seedShopPage(page, { presetVariant: 'a' });
    await calloutLocator(page).waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(function () {
      var el = document.querySelector('.first-purchase-callout-headline');
      return el && getComputedStyle(el).color === 'rgb(108, 140, 255)';
    }, null, { timeout: 5000 });
    var colorA = await page.evaluate(function () {
      return getComputedStyle(document.querySelector('.first-purchase-callout-headline')).color;
    });
    assert.equal(colorA, 'rgb(108, 140, 255)');

    // Variant B — muted warm gold (--accent-value: #D9A653 -> rgb(217, 166, 83)).
    await context.close();
    context = await browser.newContext();
    var page2 = await context.newPage();
    await blockThirdParty(page2);
    await mockTokenStatus(page2, { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0, hasMadeFirstPurchase: false });
    await seedShopPage(page2, { presetVariant: 'b' });
    await calloutLocator(page2).waitFor({ state: 'visible', timeout: 5000 });
    await page2.waitForFunction(function () {
      var el = document.querySelector('.first-purchase-callout-headline');
      return el && getComputedStyle(el).color === 'rgb(217, 166, 83)';
    }, null, { timeout: 5000 });
    var colorB = await page2.evaluate(function () {
      return getComputedStyle(document.querySelector('.first-purchase-callout-headline')).color;
    });
    assert.equal(colorB, 'rgb(217, 166, 83)');
  } finally {
    await context.close();
  }
});
