// test/token-daily-grant-copy-behavioral.test.js
//
// Regression coverage for review findings across two branches:
// (1) image-generation branch — style.html, result.html, shop.html
// (#shop-countdown), and profile.html all hardcoded the literal number
// "100" in their daily-free-grant copy ("...you'll get 100 more
// automatically...", "Next 100 free tokens in...", "+100 in...").
// entitlements.js's DAILY_GRANT_AMOUNT was retuned 100 -> 10 as part of
// this same branch (docs/IMAGE_GENERATION_SPEC.md §2b-revised) but these
// four hardcoded strings were missed — two (style.html/result.html) were
// disclosed as known-stale, two (shop.html/profile.html) were NOT and are
// not even scoped to the image feature (DAILY_GRANT_AMOUNT is global, so
// every user would have seen a 10x-wrong number regardless of ever
// touching image generation).
// (2) raise-daily-token-award-to-200 branch (10 -> 200, 2026-07-26),
// review round 2 — a FIFTH such location, shop.html's #shop-cap-note
// ("Free tokens are capped — 100 every 24 hours..."), a different
// phrasing again that slipped past the grep patterns used to find the
// first four.
//
// Fix: all four now read tokenStatus.dailyGrantAmount live instead of a
// hardcoded literal (see js/store.js's getTokenStatus / get-token-status.js
// / lib/entitlements.js's getTokenStatus, which already return this field
// for exactly this purpose). These tests mock a deliberately distinctive
// dailyGrantAmount (7 -- not 10, not 100, and not 20/200 as of the
// 2026-07-26 night "Token Economy C" retune) so a pass actually proves the
// copy is read live, not coincidentally matching whatever the real
// constant happens to be today.
//
// (3) tracker item for-product-bug-founder-high-token-chip--kn1v8t
// (2026-07-26 night, founder-reported): shop.html's #shop-cap-note "up to
// N banked" grant-ceiling literal used to NOT be read live at all (it was
// a hardcoded 200) -- fixed as part of that same item by adding
// `grantCeiling` to get-token-status.js's / lib/entitlements.js's
// getTokenStatus response, alongside the `atCeiling` flag that fixed the
// actual reported bug (a permanent "+20 in now" for any at-ceiling
// account). The cap-note test below now mocks a deliberately distinctive
// grantCeiling too, for the same "prove it's live, not coincidence"
// reason as dailyGrantAmount above.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var DISTINCTIVE_GRANT = 7;
var DISTINCTIVE_CEILING = 321;

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

// The two tests below used to check the old #modal-quota-body's static
// "you'll get N more automatically" copy on style.html/result.html.
// That modal was replaced by the out-of-tokens purchase sheet (tracker
// item for-product-build-out-of-tokens-purchase-2y8hyw) — the equivalent
// "read the live daily-grant number, not a hardcoded literal" concern now
// lives in the sheet's own wait-line (js/purchase-sheet.js's
// waitLineText(), unit-tested directly in test/purchase-sheet.test.js).
// These two are now real-browser regression coverage that style.html/
// result.html actually WIRE the live tokenStatus into that wait line —
// the balance is set low enough to actually trigger the sheet, since
// (unlike the old always-rendered modal copy) the wait line only renders
// once the sheet is shown.
test('style.html: the purchase sheet\'s wait line reads the live dailyGrantAmount, not a hardcoded 100', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 5, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: DISTINCTIVE_GRANT, grantCeiling: 200, atCeiling: false });
    await seedLoggedInUserWithDraftAt(page, 'dailygrantstyle', '/style.html');
    await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });
    // Give the async getTokenStatus() a moment to resolve.
    await page.waitForTimeout(250);

    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var waitLine = await page.textContent('#ps-wait-line');
    assert.match(waitLine, new RegExp(DISTINCTIVE_GRANT + ' free tokens in'));
    assert.doesNotMatch(waitLine, /100 free tokens/);
  } finally {
    await context.close();
  }
});

test('result.html: the purchase sheet\'s wait line reads the live dailyGrantAmount, not a hardcoded 100', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 5, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: DISTINCTIVE_GRANT, grantCeiling: 200, atCeiling: false });

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

    await page.click('#open-edit-sheet');
    await page.click('#edit-generate-again');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var waitLine = await page.textContent('#ps-wait-line');
    assert.match(waitLine, new RegExp(DISTINCTIVE_GRANT + ' free tokens in'));
    assert.doesNotMatch(waitLine, /100 free tokens/);
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

test('shop.html: the "Free tokens are capped" note reads the live dailyGrantAmount AND grantCeiling, not hardcoded literals', async function (t) {
  // Review round 2 on raise-daily-token-award-to-200: a THIRD hardcoded
  // copy of the daily-grant number ("100 every 24 hours"), distinct from
  // #shop-countdown above and missed by the grep patterns used to find
  // the other two locations (result.html/style.html's #modal-quota-body).
  // Later, tracker item for-product-bug-founder-high-token-chip--kn1v8t
  // fixed the "up to N banked" half of this same note to also read
  // tokenStatus.grantCeiling live instead of a hardcoded 200 -- mocking a
  // deliberately distinctive grantCeiling here (321, not 200/500) proves
  // that half is live too, not coincidentally matching today's real value.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: DISTINCTIVE_GRANT, grantCeiling: DISTINCTIVE_CEILING, atCeiling: false });
    await seedLoggedInUserAt(page, 'dailygrantshopcap', '/shop.html');
    await page.waitForSelector('#shop-cap-note', { timeout: 5000 });
    await page.waitForFunction(function () {
      var el = document.getElementById('shop-cap-note');
      return el && el.textContent.indexOf('capped') !== -1 && !/100 every 24 hours/.test(el.textContent);
    }, { timeout: 5000 });

    var capNote = await page.textContent('#shop-cap-note');
    assert.match(capNote, new RegExp(DISTINCTIVE_GRANT + ' every 24 hours'));
    assert.doesNotMatch(capNote, /100 every 24 hours/);
    assert.match(capNote, new RegExp('up to ' + DISTINCTIVE_CEILING + ' banked'), 'the grant ceiling should be read live off tokenStatus.grantCeiling');
    assert.doesNotMatch(capNote, /up to 200 banked/, 'must not still show the old hardcoded ceiling literal');
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
