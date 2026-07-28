// test/shop-behavioral.test.js
//
// Real browser-driven coverage for shop.html's Dodo Payments checkout
// wiring: clicking a token-pack button posts to
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 50, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100 }) });
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

test('all three token-pack buttons are enabled and say "Buy" (no longer disabled "Coming soon")', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedShopPage(page);

    var pack100 = page.locator('#shop-buy-pack100');
    var pack300 = page.locator('#shop-buy-pack300');
    var pack700 = page.locator('#shop-buy-pack700');
    await assert.doesNotReject(pack100.waitFor({ state: 'visible', timeout: 5000 }));
    assert.equal(await pack100.isDisabled(), false);
    assert.equal(await pack300.isDisabled(), false);
    assert.equal(await pack700.isDisabled(), false);
    assert.equal((await pack100.textContent()).trim(), 'Buy');
    assert.equal((await pack300.textContent()).trim(), 'Buy');
    assert.equal((await pack700.textContent()).trim(), 'Buy');
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

    await page.click('#shop-buy-pack700');
    await page.waitForURL(/checkout=success/, { timeout: 5000 });

    assert.deepEqual(capturedBody, { email: 'shopper@example.com', pack: 'pack700' });
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

    var button = page.locator('#shop-buy-pack100');
    await button.click();

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, null, { timeout: 5000 });

    assert.equal(await button.isDisabled(), false);
    assert.equal((await button.textContent()).trim(), 'Buy');
    // Never actually navigated away on a failed checkout-session call.
    assert.match(page.url(), /shop\.html/);
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

    await page.click('#shop-buy-pack100');
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
