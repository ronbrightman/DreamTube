// test/email-verify-sheet-behavioral.test.js
//
// Real browser-driven coverage for js/email-verify-sheet.js's "next visit"
// deferred-verification trigger (tracker item for-product-build-
// passwordless-signup-fo-at2fko), wired on home.html. Follows this repo's
// established seedHomeUser/mockTokenStatus convention (see test/home-
// behavioral.test.js's own header comment for the full "why this shape"
// writeup).

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

/** Seeds a signed-in account (optionally passwordless/unverified) and navigates to home.html, mirroring test/home-behavioral.test.js's seedHomeUser. */
async function seedHomeUser(page, opts) {
  opts = opts || {};
  var username = opts.username || 'pwlesstester';
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

test('email-verify-sheet: an UNVERIFIED account is offered the code prompt on this (fresh) visit to home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    var copy = await page.locator('#email-verify-sheet-copy').textContent();
    assert.match(copy, /pwlesstester@example\.com/);
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: entering the correct code marks the account verified and shows the confirmation view', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    var verifyCalls = [];
    await page.route('**/.netlify/functions/verify-email-code', function (route) {
      verifyCalls.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.fill('#email-verify-code-input', '123456');
    await page.click('#email-verify-submit-btn');

    await page.waitForSelector('#email-verify-sheet-done', { state: 'visible', timeout: 4000 });
    assert.equal(verifyCalls.length, 1);
    assert.equal(verifyCalls[0].code, '123456');
    assert.equal(verifyCalls[0].authToken, 'fake-auth-token');

    // Local cache actually updated -- a page reload must not re-offer it.
    var nowVerified = await page.evaluate(function () { return DreamStore.getAccountEmailVerified(); });
    assert.equal(nowVerified, true);
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: a wrong code shows an inline error and does NOT close the sheet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    await page.route('**/.netlify/functions/verify-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E6: invalid_code' }) });
    });

    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.fill('#email-verify-code-input', '000000');
    await page.click('#email-verify-submit-btn');

    await page.waitForSelector('#email-verify-sheet-error:not(:empty)', { timeout: 4000 });
    assert.equal(await page.locator('#email-verify-sheet-overlay').getAttribute('class'), 'sheet-overlay open');
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: "Resend code" calls the resend endpoint', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    var resendCalls = 0;
    await page.route('**/.netlify/functions/resend-verification-code', function (route) {
      resendCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    // Opening the sheet now auto-sends a code (founder repro 2026-08-07:
    // the copy claimed "we sent a code" while nothing had been sent) —
    // so by the time the sheet is open, one call has already happened.
    await page.waitForFunction(function () { return true; });
    var manualBaseline = resendCalls;
    assert.equal(manualBaseline, 1, 'opening the sheet must itself send a code — the copy promises one');
    await page.click('#email-verify-resend-link');
    await page.waitForFunction(function () {
      return document.getElementById('email-verify-resend-link').textContent.indexOf('Sent') !== -1;
    }, { timeout: 3000 });
    assert.equal(resendCalls, 2, 'manual Resend still works on top of the auto-send');
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: a VERIFIED account is never shown the prompt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: true, password: null });

    await page.waitForTimeout(1800); // longer than the 1200ms scheduling delay
    assert.equal(await page.locator('#email-verify-sheet-overlay').count(), 0, 'the sheet must never even mount for a verified account');
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: a PASSWORD-based account (emailVerified defaults true, never explicitly set) is never shown the prompt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    // emailVerified left undefined -- the exact shape a real password-
    // signup local account has (js/store.js's own local mirror never
    // wrote this field before this feature existed) -- must default to
    // "don't ever gate/prompt", never crash on a missing field.
    await seedHomeUser(page, { emailVerified: undefined, password: 'testpass1' });

    await page.waitForTimeout(1800);
    assert.equal(await page.locator('#email-verify-sheet-overlay').count(), 0);
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: does NOT reopen on this same tab session once already offered (e.g. the immediate post-signup landing)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null, presetSessionMarker: true });

    await page.waitForTimeout(1800);
    assert.equal(await page.locator('#email-verify-sheet-overlay').count(), 0, 'a tab that already marked this session as offered must stay silent');
  } finally {
    await context.close();
  }
});


test('email-verify-sheet: the on-open auto-send fires ONCE per page load — dismissing and re-opening the sheet does not send again', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });
    var resendCalls = 0;
    await page.route('**/.netlify/functions/resend-verification-code', function (route) {
      resendCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.click('#email-verify-later-link');
    await page.evaluate(function () { EmailVerifySheet.show({ source: 'test_reopen' }); });
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 3000 });
    await page.waitForTimeout(400);
    assert.equal(resendCalls, 1, 're-opening in the same page load reuses the already-sent code (manual Resend covers a lost email)');
  } finally {
    await context.close();
  }
});
