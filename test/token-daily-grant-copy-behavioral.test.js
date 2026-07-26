// test/token-daily-grant-copy-behavioral.test.js
//
// Regression coverage for a review finding on the image-generation branch:
// style.html, result.html, shop.html, and profile.html all hardcoded the
// literal number "100" in their daily-free-grant copy ("...you'll get 100
// more automatically...", "Next 100 free tokens in...", "+100 in...").
// entitlements.js's DAILY_GRANT_AMOUNT was retuned 100 -> 10 as part of
// this same branch (docs/IMAGE_GENERATION_SPEC.md §2b-revised) but these
// four hardcoded strings were missed — two (style.html/result.html) were
// disclosed as known-stale, two (shop.html/profile.html) were NOT and are
// not even scoped to the image feature (DAILY_GRANT_AMOUNT is global, so
// every user would have seen a 10x-wrong number regardless of ever
// touching image generation).
//
// Fix: all four now read tokenStatus.dailyGrantAmount live instead of a
// hardcoded literal (see js/store.js's getTokenStatus / get-token-status.js
// / lib/entitlements.js's getTokenStatus, which already return this field
// for exactly this purpose). These tests mock a deliberately distinctive
// dailyGrantAmount (7 -- not 10, not 100, and not 200 as of the 2026-07-26
// retune) so a pass actually proves the copy is read live, not
// coincidentally matching whatever the real constant happens to be today.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var DISTINCTIVE_GRANT = 7;

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

async function seedLoggedInUserAt(page, username, path) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded' });
}

/** Seeds a logged-in account with a real draft (caption+style) directly in localStorage -- the cheapest way to reach style.html without driving create.html's chip flow for real. */
async function seedLoggedInUserWithDraftAt(page, username, path) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    state.draft = Object.assign({}, state.draft, { caption: 'A dream about flying', style: null, mediaType: null, sourceImageUrl: null });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded' });
}

test('style.html: #modal-quota-body reads the live dailyGrantAmount for both Video and Image copy, not a hardcoded 100', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: DISTINCTIVE_GRANT });
    await seedLoggedInUserWithDraftAt(page, 'dailygrantstyle', '/style.html');
    await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });
    // Give the async getTokenStatus() a moment to resolve and re-render.
    await page.waitForTimeout(250);

    var videoCopy = await page.textContent('#modal-quota-body');
    assert.match(videoCopy, new RegExp('get ' + DISTINCTIVE_GRANT + ' more automatically'));
    assert.doesNotMatch(videoCopy, /get 100 more/);

    await page.click('.media-type-btn[data-media-type="image"]');
    var imageCopy = await page.textContent('#modal-quota-body');
    assert.match(imageCopy, new RegExp('get ' + DISTINCTIVE_GRANT + ' more automatically'));
    assert.doesNotMatch(imageCopy, /get 100 more/);
  } finally {
    await context.close();
  }
});

test('result.html: #modal-quota-body reads the live dailyGrantAmount, not a hardcoded 100', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: DISTINCTIVE_GRANT });

    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@dailygrantresult', username: 'dailygrantresult' };
      if (!state.accounts) state.accounts = {};
      state.accounts.dailygrantresult = { password: 'testpass1', email: 'dailygrantresult@example.com' };
      if (!state.dreams) state.dreams = [];
      state.dreams.push({ id: 'dream-daily-grant', ownerHandle: '@dailygrantresult', caption: 'x', style: 'Cartoon', mediaType: 'video', videoUrl: 'https://example.com/fake-video.mp4', dur: '0:08', isPublished: false, likes: 0, likedByMe: false });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=dream-daily-grant', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);

    var copy = await page.textContent('#modal-quota-body');
    assert.match(copy, new RegExp('get ' + DISTINCTIVE_GRANT + ' more automatically'));
    assert.doesNotMatch(copy, /get 100 more/);
  } finally {
    await context.close();
  }
});

test('shop.html: the countdown reads the live dailyGrantAmount, not a hardcoded "Next 100 free tokens"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: DISTINCTIVE_GRANT });
    await seedLoggedInUserAt(page, 'dailygrantshop', '/shop.html');
    await page.waitForSelector('#shop-countdown:not(:empty)', { timeout: 5000 });

    var countdown = await page.textContent('#shop-countdown');
    assert.match(countdown, new RegExp('Next ' + DISTINCTIVE_GRANT + ' free tokens in'));
    assert.doesNotMatch(countdown, /Next 100 free tokens/);
  } finally {
    await context.close();
  }
});

test('profile.html: the token countdown reads the live dailyGrantAmount, not a hardcoded "+100 in"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Balance must be >= 100 (VIDEO_TOKEN_COST) or profile.html shows "Out of tokens" instead of the countdown.
    await mockTokenStatus(page, { balance: 500, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: DISTINCTIVE_GRANT });
    await seedLoggedInUserAt(page, 'dailygrantprofile', '/profile.html');
    await page.waitForSelector('#profile-tokens-meta:not(:empty)', { timeout: 5000 });

    var meta = await page.textContent('#profile-tokens-meta');
    assert.match(meta, new RegExp('\\+' + DISTINCTIVE_GRANT + ' in'));
    assert.doesNotMatch(meta, /\+100 in/);
  } finally {
    await context.close();
  }
});
