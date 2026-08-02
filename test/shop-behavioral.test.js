// test/shop-behavioral.test.js
//
// Real browser-driven coverage for shop.html ("The Vault", founder-approved
// 2026-08-02, tracker item for-product-build-ship-today-founder-app-zn9zyy)'s
// Dodo Payments checkout wiring: clicking a token-pack button posts to
// create-checkout-session-dodo.js and redirects the browser to the
// returned URL on success; a failure (the realistic case until real Dodo
// env vars exist — see docs/PAYWALL_SETUP.md) re-enables the button and
// shows a toast instead of leaving the UI stuck; and the
// ?checkout=success/cancelled return-trip banner. Follows the same
// Playwright-over-a-real-static-server convention as
// test/ui-behavioral.test.js (see that file's own header for why: no
// bundler/dev-server, Playwright resolved from the sandbox global
// install, self-skipping if unavailable rather than failing the suite).

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, hasMadeFirstPurchase: true }) });
  });
}

/**
 * Seeds a logged-in account with an email and navigates to shop.html —
 * same approach as test/ui-behavioral.test.js's seedResultPage: reads
 * whatever js/store.js's own load() already wrote to localStorage on the
 * login.html visit (a full seed() shape — draft/charactersByUser/
 * likedIds/etc.) and merges user/accounts/dreams onto it, rather than
 * replacing the whole blob. Replacing it outright with only
 * user/accounts/dreams (no `draft`) makes load()'s
 * `parsed.draft.characterIds` dereference throw on the very next page
 * load, which load() silently catches and treats as corrupt state — so
 * it resets to a fresh, logged-out seed() and getCurrentUser() comes
 * back null, redirecting straight to login.html instead of showing
 * shop.html at all.
 */
async function seedShopPage(page, email) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (email) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@shopper', username: 'shopper' };
    if (!state.accounts) state.accounts = {};
    state.accounts.shopper = { password: 'testpass1', email: email };
    if (!state.dreams) state.dreams = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, email === undefined ? 'shopper@example.com' : email);
  await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
}

test('all four pack buttons are enabled and state their exact price ("Pay $X.XX"), not a generic "Buy"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // hasMadeFirstPurchase: false so the hero (pack099) is visible too.
    await mockTokenStatus(page, { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, hasMadeFirstPurchase: false });
    await seedShopPage(page);

    var pack099 = page.locator('#shop-buy-pack099');
    var pack199 = page.locator('#shop-buy-pack199');
    var pack499 = page.locator('#shop-buy-pack499');
    var pack999 = page.locator('#shop-buy-pack999');
    await assert.doesNotReject(pack099.waitFor({ state: 'visible', timeout: 5000 }));
    assert.equal(await pack099.isDisabled(), false);
    assert.equal(await pack199.isDisabled(), false);
    assert.equal(await pack499.isDisabled(), false);
    assert.equal(await pack999.isDisabled(), false);
    assert.match((await pack099.textContent()).trim(), /Pay \$0\.99/);
    assert.match((await pack199.textContent()).trim(), /Pay \$1\.99/);
    assert.match((await pack499.textContent()).trim(), /Pay \$4\.99/);
    assert.match((await pack999.textContent()).trim(), /Pay \$9\.99/);
  } finally {
    await context.close();
  }
});

test('the welcome-offer hero (pack099) is hidden once hasMadeFirstPurchase is true, and only pack199/499/999 remain', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, hasMadeFirstPurchase: true });
    await seedShopPage(page);

    await page.waitForFunction(function () {
      var el = document.getElementById('shop-balance');
      return el && el.textContent === '50';
    }, null, { timeout: 5000 });

    var heroVisible = await page.isVisible('#shop-hero-offer');
    assert.equal(heroVisible, false, 'the one-time starter hero must not show to an account that already bought a pack');
    // The starter button itself only exists inside the hero -- confirm it's
    // not duplicated as a regular pack card elsewhere on the page either.
    assert.equal(await page.locator('#shop-buy-pack099').count(), 1, 'the starter button element exists exactly once (inside the now-hidden hero), never duplicated as a visible card');
  } finally {
    await context.close();
  }
});

test('clicking a pack button posts {email, pack} and redirects to the returned checkout url on success', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedShopPage(page);

    var capturedBody = null;
    await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
      capturedBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: baseUrl + '/shop.html?checkout=success', sessionId: 'cks_test' }) });
    });

    await page.click('#shop-buy-pack999');
    await page.waitForURL(/checkout=success/, { timeout: 5000 });

    assert.deepEqual(capturedBody, { email: 'shopper@example.com', pack: 'pack999' });
  } finally {
    await context.close();
  }
});

test('a failed checkout-session call re-enables the button and shows a toast, never leaves it stuck', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedShopPage(page);

    await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E2: missing_api_key' }) });
    });

    var button = page.locator('#shop-buy-pack199');
    var originalLabel = (await button.textContent()).trim();
    await button.click();

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, null, { timeout: 5000 });

    assert.equal(await button.isDisabled(), false);
    assert.equal((await button.textContent()).trim(), originalLabel);
    // Never actually navigated away on a failed checkout-session call.
    assert.match(page.url(), /shop\.html/);
  } finally {
    await context.close();
  }
});

test('a starter-already-used (E9) failure shows the specific "welcome offer already used" toast, not the generic try-again copy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // hasMadeFirstPurchase: false so the hero (and its pack099 button) is
    // visible to click, even though the server will refuse it (simulates
    // a race: another tab completed a purchase moments ago).
    await mockTokenStatus(page, { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, hasMadeFirstPurchase: false });
    await seedShopPage(page);

    await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'E9: starter_already_used' }) });
    });

    await page.waitForSelector('#shop-buy-pack099', { state: 'visible', timeout: 5000 });
    await page.click('#shop-buy-pack099');

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, null, { timeout: 5000 });

    var toastText = await page.textContent('#toast');
    assert.match(toastText, /already been used/i);
  } finally {
    await context.close();
  }
});

test('returning with ?checkout=success shows a "payment received" toast and clears the query param', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@shopper', username: 'shopper' };
      if (!state.accounts) state.accounts = {};
      state.accounts.shopper = { password: 'testpass1', email: 'shopper@example.com' };
      if (!state.dreams) state.dreams = [];
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show') && /payment received/i.test(t.textContent);
    }, null, { timeout: 5000 });

    assert.doesNotMatch(page.url(), /checkout=success/);
  } finally {
    await context.close();
  }
});

test('an account with no email on file gets a clear inline message instead of a network call', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      // Legacy account, predates email being required — no email on file.
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@noemail', username: 'noemail' };
      if (!state.accounts) state.accounts = {};
      state.accounts.noemail = { password: 'testpass1', email: null };
      if (!state.dreams) state.dreams = [];
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });

    var calledCheckout = false;
    await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
      calledCheckout = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://example.com', sessionId: 'x' }) });
    });

    await page.click('#shop-buy-pack199');
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, null, { timeout: 5000 });

    assert.equal(calledCheckout, false, 'must not call the checkout endpoint with no email to send');
    var toastText = await page.textContent('#toast');
    assert.match(toastText, /add an email/i);
  } finally {
    await context.close();
  }
});

test('per-pack dreams/tokens/value copy is computed correctly on each card', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, hasMadeFirstPurchase: true });
    await seedShopPage(page);
    await page.waitForSelector('#pack199-dreams', { timeout: 5000 });

    assert.equal((await page.textContent('#pack199-dreams')).trim(), '5 dream videos');
    assert.equal((await page.textContent('#pack199-tokens')).trim(), '500 tokens · or 50 dream images');
    assert.equal((await page.textContent('#pack199-value')).trim(), '$0.40 per dream');

    assert.equal((await page.textContent('#pack499-dreams')).trim(), '15 dream videos');
    assert.equal((await page.textContent('#pack499-tokens')).trim(), '1500 tokens · or 150 dream images');
    assert.equal((await page.textContent('#pack499-value')).trim(), '$0.33 per dream');

    assert.equal((await page.textContent('#pack999-dreams')).trim(), '40 dream videos');
    assert.equal((await page.textContent('#pack999-tokens')).trim(), '4000 tokens · or 400 dream images');
    assert.equal((await page.textContent('#pack999-value')).trim(), '$0.25 per dream');
  } finally {
    await context.close();
  }
});
