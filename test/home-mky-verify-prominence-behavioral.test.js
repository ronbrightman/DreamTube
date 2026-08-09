// test/home-mky-verify-prominence-behavioral.test.js
//
// Real browser-driven coverage for tracker item for-product-auto-drive-
// email-verify-earl-qzq652 (founder-authorized 2026-08-09), part 1: the
// email-verification bonus row on home.html's "Make it yours" card
// (#mky) used to be the FOURTH and LAST row in that accordion, after
// install/copy-link/bookmark -- easy to scroll past even though it's the
// only one of the four that actually gates a real capability (posting;
// see publish-dream.js's E8 email_not_verified block). This file asserts
// the fix actually landed: the row is now FIRST in DOM order whenever it
// applies, and carries a visually distinct "priority" treatment (a
// dedicated CSS class, not just another identical list row) rather than
// asserting anything about exact colors/pixels (this suite doesn't do
// visual-regression screenshots -- see docs/TESTING.md).
//
// Follows this repo's established seedHomeUser/mockTokenStatus convention
// (see test/email-verify-sheet-behavioral.test.js's own header comment).

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 100, claimable: false, nextClaimAt: 0, dailyClaimAmount: 100, streak: 0 }) });
  });
}

/** Seeds a signed-in account and navigates to home.html -- same shape as test/email-verify-sheet-behavioral.test.js's own seedHomeUser. */
async function seedHomeUser(page, opts) {
  opts = opts || {};
  var username = opts.username || 'mkyprominencetester';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {};
    state.user = { handle: '@' + args.username, username: args.username, authToken: args.authToken || 'fake-auth-token' };
    state.accounts = {};
    state.accounts[args.username] = {
      password: args.password === undefined ? 'testpass1' : args.password,
      email: args.username + '@example.com',
      emailVerified: args.emailVerified
    };
    state.dreams = [];
    state.draft = {};
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    if (args.presetSessionMarker) sessionStorage.setItem('dreamtube_email_verify_sheet_shown', '1');
  }, { username: username, emailVerified: opts.emailVerified, password: opts.password, authToken: opts.authToken, presetSessionMarker: !!opts.presetSessionMarker });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

test('mky prominence: the email-verify row is the FIRST child of .mky-rows for an unverified account -- ahead of install/copy/bookmark, not the 4th/last row', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    // presetSessionMarker keeps the deferred-verify sheet from auto-opening
    // and stealing focus -- this test only cares about the row's position.
    await seedHomeUser(page, { emailVerified: false, password: null, presetSessionMarker: true });

    await page.waitForSelector('#mky-item-verify:not([hidden])', { timeout: 4000 });

    var order = await page.evaluate(function () {
      var rows = document.querySelectorAll('#mky-rows .mky-item, .mky-rows .mky-item');
      var container = document.querySelector('.mky-rows');
      var ids = Array.prototype.map.call(container.children, function (el) { return el.id; });
      return ids;
    });
    assert.equal(order[0], 'mky-item-verify', 'the verify row must be the FIRST item in .mky-rows source order, ahead of install/copy/bookmark -- got order: ' + order.join(', '));
  } finally {
    await context.close();
  }
});

test('mky prominence: the verify row carries the .priority CSS class (a distinct visual treatment) and a sub-copy line naming the real stakes -- not just another plain accordion row', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null, presetSessionMarker: true });

    await page.waitForSelector('#mky-item-verify:not([hidden])', { timeout: 4000 });

    var rowClass = await page.locator('#mky-verify-row').getAttribute('class');
    assert.match(rowClass, /\bpriority\b/, 'the verify row button must carry a distinct .priority class, not the plain .mky-row treatment shared by install/copy/bookmark');

    var installRowClass = await page.locator('#mky-install-row').getAttribute('class');
    assert.doesNotMatch(installRowClass, /\bpriority\b/, 'the priority treatment must be specific to the verify row, not accidentally applied everywhere');

    var subCopy = await page.locator('#mky-verify-row .mky-row-sub').textContent();
    assert.match(subCopy, /post/i, 'the row must explain WHY it matters (it gates posting), not just repeat "Verify your email" with no stakes named');
  } finally {
    await context.close();
  }
});

test('mky prominence: a VERIFIED account never sees the row at all, so the reorder is invisible to anyone who already verified (install/copy/bookmark stay first for them)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: true, password: null });

    await page.waitForSelector('#mky', { timeout: 4000 });
    var hidden = await page.evaluate(function () { return document.getElementById('mky-item-verify').hidden; });
    assert.equal(hidden, true, 'a verified account must never see the verify row, reordered or not');

    var firstChildId = await page.evaluate(function () {
      var container = document.querySelector('.mky-rows');
      return container.children[0].id;
    });
    assert.equal(firstChildId, 'mky-item-verify', 'sanity: the hidden verify item is still the first DOM child (hidden attribute, not removal) -- install stays the first VISIBLE row for a verified account');
  } finally {
    await context.close();
  }
});

test('mky prominence: tapping the reordered row still opens the verify sheet exactly as before (source: bonus_row) -- the reorder did not break the click handler', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null, presetSessionMarker: true });

    await page.waitForSelector('#mky-item-verify:not([hidden])', { timeout: 4000 });
    await page.click('#mky-verify-row');
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
  } finally {
    await context.close();
  }
});
