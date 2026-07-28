// test/owner-topup-target-behavioral.test.js
//
// Real browser-driven coverage for profile.html's owner-topup-block once it
// grew a target-account field (tracker item
// for-product-extend-owner-top-up-with-a-t-2hmopn — gifting tokens to
// another account by username, e.g. the founder's son's account
// benbrightman14). Follows test/support-feedback-behavioral.test.js's own
// conventions: node:test + real Chromium via Playwright, state seeded
// directly into localStorage, every page.goto wrapped against this
// sandbox's known intermittent third-party-host network stalls, and the
// real owner-topup-tokens.js network call intercepted via page.route() (no
// local Netlify Functions runtime is available to these tests).
//
// This is the actual end-to-end UI chain owner-topup-tokens.test.js's unit
// tests don't reach: the target-username <input> exists with the right id,
// its value actually gets forwarded in the request body, a successful
// gifted top-up does NOT clobber the signed-in owner's own displayed token
// balance (the bug this whole feature could easily introduce if the
// response were blindly applied), a 404 (unknown target) surfaces a clear
// toast and leaves the field/balance alone, and the owner_topup analytics
// event actually fires with the right props.

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Same helper as support-feedback-behavioral.test.js's own — always answers isOwner per the test's own choice, never depends on real OWNER_EMAIL config. */
function mockOwnerCheck(page, isOwner) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, source: 'env-default', isOwner: !!isOwner }) });
  });
}

/** Same helper as support-feedback-behavioral.test.js's own — the OWNER'S OWN starting balance/status, distinct from whatever owner-topup-tokens.js is mocked to return for a gifted top-up below. */
function mockTokenStatus(page, opts) {
  opts = opts || {};
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        balance: opts.balance !== undefined ? opts.balance : 300,
        nextGrantAt: Date.now() + 3600000,
        dailyGrantAmount: 20,
        grantCeiling: 200,
        atCeiling: false
      })
    });
  });
}

/** Intercepts owner-topup-tokens.js — captures every request body and lets the test control the response. */
function mockOwnerTopup(page, responder) {
  var calls = [];
  return {
    calls: calls,
    install: function () {
      return page.route('**/.netlify/functions/owner-topup-tokens', function (route) {
        var body = JSON.parse(route.request().postData() || '{}');
        calls.push(body);
        var result = responder(body);
        route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
      });
    }
  };
}

async function seedOwnerUser(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@founder', username: 'founder' };
    if (!state.accounts) state.accounts = {};
    state.accounts.founder = { password: 'ownerpass1', email: 'founder@dreamtube.example', createdAt: Date.now() - 30 * 86400000 };
    state.dreams = [];
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.founder = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

/**
 * Stubs window.posthog (installed before any app script runs) so owner_topup
 * analytics can be asserted on without a real PostHog network dependency.
 * `__loaded: true` is load-bearing: profile.html's own embedded PostHog
 * snippet only overwrites `window.posthog` with its real stub-queue object
 * when `window.posthog.__loaded` is falsy (see that snippet's own
 * `e.__SV||(window.posthog && window.posthog.__loaded)||(...)` guard) — so
 * without this flag the snippet clobbers this stub's `capture` before
 * profile.html's own track() ever gets a chance to call it. `init` is a
 * no-op since the snippet unconditionally calls `posthog.init(...)` right
 * after, uncaught by any try/catch.
 */
async function installPosthogStub(page) {
  await page.addInitScript(function () {
    window.__capturedEvents = [];
    window.posthog = {
      __loaded: true,
      init: function () {},
      capture: function (name, props) { window.__capturedEvents.push({ name: name, props: props }); }
    };
  });
}

test('profile.html owner top-up: target field defaults blank, gifting a valid target credits THEM, never overwriting the owner\'s own displayed balance', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await installPosthogStub(page);
  await mockOwnerCheck(page, true);
  await mockTokenStatus(page, { balance: 300 });
  var topup = mockOwnerTopup(page, function (body) {
    assert.equal(body.email, 'founder@dreamtube.example');
    assert.equal(body.amount, 800);
    assert.equal(body.targetUsername, 'benbrightman14');
    return {
      status: 200,
      body: {
        balance: 1020, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 20,
        grantCeiling: 200, atCeiling: false, hasMadeFirstPurchase: false,
        creditedEmail: 'ben@example.com', targetUsername: 'benbrightman14'
      }
    };
  });
  await topup.install();
  try {
    await seedOwnerUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');
    await page.waitForSelector('#owner-topup-block', { state: 'visible' });

    var ownBalanceBefore = await page.locator('#profile-tokens-balance').textContent();
    assert.equal(ownBalanceBefore, '300 tokens', 'sanity: the owner\'s own balance is showing before the gifted top-up');

    await page.fill('#owner-topup-target', 'benbrightman14');
    await page.fill('#owner-topup-amount', '800');
    await page.click('#owner-topup-btn');

    await page.waitForSelector('.toast.show');
    var toastText = await page.locator('#toast').textContent();
    assert.match(toastText, /benbrightman14/);
    assert.match(toastText, /1020/);

    assert.equal(topup.calls.length, 1);

    // The critical regression this whole feature could introduce: crediting
    // someone ELSE's account must never overwrite what the page shows as
    // the SIGNED-IN OWNER'S OWN balance.
    var ownBalanceAfter = await page.locator('#profile-tokens-balance').textContent();
    assert.equal(ownBalanceAfter, '300 tokens', 'a gifted top-up must not clobber the owner\'s own displayed balance');

    // The target field clears after a successful gifted top-up.
    assert.equal(await page.locator('#owner-topup-target').inputValue(), '');

    // owner_topup analytics event fired with the target account for auditability.
    var events = await page.evaluate(function () { return window.__capturedEvents; });
    var ownerTopupEvents = events.filter(function (e) { return e.name === 'owner_topup'; });
    assert.equal(ownerTopupEvents.length, 1);
    assert.equal(ownerTopupEvents[0].props.amount, 800);
    assert.equal(ownerTopupEvents[0].props.target, 'benbrightman14');
    assert.equal(ownerTopupEvents[0].props.self_top_up, false);
  } finally {
    await page.close();
  }
});

test('profile.html owner top-up: leaving the target field blank still self-tops-up exactly as before — regression', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await installPosthogStub(page);
  await mockOwnerCheck(page, true);
  await mockTokenStatus(page, { balance: 300 });
  var topup = mockOwnerTopup(page, function (body) {
    assert.equal(body.email, 'founder@dreamtube.example');
    assert.equal(body.amount, 500);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'targetUsername'), false, 'a blank target must not even be sent, matching the original request shape');
    return {
      status: 200,
      body: {
        balance: 800, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 20,
        grantCeiling: 200, atCeiling: false, hasMadeFirstPurchase: false,
        creditedEmail: 'founder@dreamtube.example', targetUsername: null
      }
    };
  });
  await topup.install();
  try {
    await seedOwnerUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');
    await page.waitForSelector('#owner-topup-block', { state: 'visible' });

    assert.equal(await page.locator('#owner-topup-target').inputValue(), '', 'target field defaults blank, i.e. self-top-up');
    await page.fill('#owner-topup-amount', '500');
    await page.click('#owner-topup-btn');

    await page.waitForSelector('.toast.show');
    var toastText = await page.locator('#toast').textContent();
    assert.match(toastText, /800/);
    assert.doesNotMatch(toastText, /benbrightman/);

    assert.equal(topup.calls.length, 1);

    // Self-top-up DOES redraw the owner's own displayed balance.
    var ownBalanceAfter = await page.locator('#profile-tokens-balance').textContent();
    assert.equal(ownBalanceAfter, '800 tokens', 'a genuine self-top-up must still update the displayed balance, same as before targetUsername existed');

    var events = await page.evaluate(function () { return window.__capturedEvents; });
    var ownerTopupEvents = events.filter(function (e) { return e.name === 'owner_topup'; });
    assert.equal(ownerTopupEvents.length, 1);
    assert.equal(ownerTopupEvents[0].props.target, 'self');
    assert.equal(ownerTopupEvents[0].props.self_top_up, true);
  } finally {
    await page.close();
  }
});

test('profile.html owner top-up: an unknown target username surfaces a clear error toast and touches nothing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await installPosthogStub(page);
  await mockOwnerCheck(page, true);
  await mockTokenStatus(page, { balance: 300 });
  var topup = mockOwnerTopup(page, function () {
    return { status: 404, body: { error: 'E6: target_account_not_found' } };
  });
  await topup.install();
  try {
    await seedOwnerUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');
    await page.waitForSelector('#owner-topup-block', { state: 'visible' });

    await page.fill('#owner-topup-target', 'nobody-with-this-username');
    await page.fill('#owner-topup-amount', '800');
    await page.click('#owner-topup-btn');

    await page.waitForSelector('.toast.show');
    var toastText = await page.locator('#toast').textContent();
    assert.match(toastText, /No account found/i);

    var ownBalanceAfter = await page.locator('#profile-tokens-balance').textContent();
    assert.equal(ownBalanceAfter, '300 tokens', 'a rejected target lookup must not touch the owner\'s own displayed balance');

    var events = await page.evaluate(function () { return window.__capturedEvents; });
    var ownerTopupEvents = events.filter(function (e) { return e.name === 'owner_topup'; });
    assert.equal(ownerTopupEvents.length, 0, 'a failed top-up must not fire the owner_topup success event');
  } finally {
    await page.close();
  }
});

test('profile.html owner top-up: the target field is hidden along with the rest of owner tools for a non-owner account', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await installPosthogStub(page);
  await mockOwnerCheck(page, false);
  await mockTokenStatus(page, { balance: 150 });
  try {
    await seedOwnerUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    assert.equal(await page.locator('#owner-topup-block').isVisible(), false);
    assert.equal(await page.locator('#owner-topup-target').isVisible(), false);
  } finally {
    await page.close();
  }
});
