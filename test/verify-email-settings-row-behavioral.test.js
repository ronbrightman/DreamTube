// test/verify-email-settings-row-behavioral.test.js
//
// Real browser-driven coverage for profile.html's Settings -> "Verify your
// email" on-demand row (tracker item for-product-no-on-demand-way-to-open-
// ema-ebj04z) — founder repro 2026-08-07: he dismissed/missed js/email-
// verify-sheet.js's one-shot "next visit" auto-show (home.html) and had no
// way to reopen it short of triggering another purchase. This row is that
// on-demand entry point into the SAME sheet (see js/email-verify-sheet.js,
// covered separately in test/email-verify-sheet-behavioral.test.js) — no
// new verification logic here, just visibility + wiring.
//
// Follows test/whatsapp-morning-capture-opt-in-behavioral.test.js's
// conventions: node:test + real Chromium via Playwright (resolved from
// this sandbox's global install, not a project dependency — see
// CLAUDE.md), state seeded straight into localStorage, no local Netlify
// Functions runtime available (see test/helpers/static-server.js's own
// header) so every network call the sheet itself makes is intercepted via
// page.route(), and every navigation wrapped against this sandbox's known
// intermittent outbound-network stalls on third-party hosts.

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel). */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Wraps page.goto so a transient network stall on a blocked-in-vain third-party request doesn't crash the whole run -- see CLAUDE.md's environment-quirk note. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Seeds a signed-in "tester" account with a given emailVerified state, same shortcut every other profile.html suite in this repo uses. */
async function seedUser(page, emailVerified) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (verified) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester', authToken: 'fake-auth-token' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com', emailVerified: verified };
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = [];
    if (!state.dreams) state.dreams = [];
    if (!state.draft) {
      state.draft = { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null };
    }
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, emailVerified);
}

/** Intercepts every network call the sheet itself can make once opened -- same shape as test/email-verify-sheet-behavioral.test.js's own mocks. */
function mockVerifySheetEndpoints(page, opts) {
  opts = opts || {};
  var calls = { verify: [], resend: 0 };
  page.route('**/.netlify/functions/verify-email-code', function (route) {
    calls.verify.push(JSON.parse(route.request().postData() || '{}'));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.verifyResponse || { ok: true }) });
  });
  page.route('**/.netlify/functions/resend-verification-code', function (route) {
    calls.resend++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return calls;
}

async function openSettings(page) {
  await page.click('#account-btn');
  await page.waitForSelector('#sheet-account-overlay.open');
}

test('profile.html Settings: "Verify your email" row is shown for a signed-in account with emailVerified:false', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockVerifySheetEndpoints(page);
    await seedUser(page, false);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    assert.equal(await page.locator('#verify-email-row').isVisible(), true);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: "Verify your email" row is absent for an already-verified account (emailVerified:true)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockVerifySheetEndpoints(page);
    await seedUser(page, true);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    assert.equal(await page.locator('#verify-email-row').isVisible(), false);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: "Verify your email" row is absent for a password account where emailVerified was never set (defaults true)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockVerifySheetEndpoints(page);
    await seedUser(page, undefined);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    assert.equal(await page.locator('#verify-email-row').isVisible(), false);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: "Verify your email" row never appears for a signed-out visitor', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // No seedUser() call -- a genuinely signed-out visitor lands on
    // profile.html and is redirected/gated by the page's own login guard
    // before Settings is ever reachable. We just confirm the row itself
    // never renders as visible in that state.
    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForTimeout(300);

    var row = page.locator('#verify-email-row');
    if (await row.count()) {
      assert.equal(await row.isVisible(), false);
    }
  } finally {
    await page.close();
  }
});

test('profile.html Settings: clicking the row opens js/email-verify-sheet.js with source:"settings"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockVerifySheetEndpoints(page);
    await seedUser(page, false);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    var capturedSources = [];
    await page.exposeFunction('__captureVerifySheetSource', function (src) { capturedSources.push(src); });
    // profile.html's own inline PostHog snippet (head of the page) already
    // installs a real, queueing window.posthog stub before this evaluate
    // runs -- monkey-patch .capture itself rather than only-if-absent, or
    // this silently patches nothing.
    await page.evaluate(function () {
      window.posthog = window.posthog || {};
      var original = window.posthog.capture;
      window.posthog.capture = function (name, props) {
        if (name === 'email_verify_sheet_shown') window.__captureVerifySheetSource((props && props.source) || null);
        if (typeof original === 'function') original.apply(this, arguments);
      };
    });

    await page.click('#verify-email-row');
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.waitForTimeout(100); // let the exposeFunction round trip to Node settle

    assert.deepEqual(capturedSources, ['settings']);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: verifying the code hides the row immediately, without closing/reopening Settings', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockVerifySheetEndpoints(page);
    await seedUser(page, false);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    assert.equal(await page.locator('#verify-email-row').isVisible(), true);

    await page.click('#verify-email-row');
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.fill('#email-verify-code-input', '123456');
    await page.click('#email-verify-submit-btn');
    await page.waitForSelector('#email-verify-sheet-done', { state: 'visible', timeout: 4000 });
    await page.click('#email-verify-done-close-btn');

    // Settings sheet itself was never closed throughout this flow.
    assert.match(await page.locator('#sheet-account-overlay').getAttribute('class'), /open/);
    assert.equal(await page.locator('#verify-email-row').isVisible(), false);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: dismissing the sheet via "Not now" without verifying leaves the row visible', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockVerifySheetEndpoints(page);
    await seedUser(page, false);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    await page.click('#verify-email-row');
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.click('#email-verify-later-link');
    await page.waitForSelector('#email-verify-sheet-overlay:not(.open)', { timeout: 4000 });

    assert.equal(await page.locator('#verify-email-row').isVisible(), true);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: reopening Settings after a same-session verification through a different entry point also reflects the row as hidden', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockVerifySheetEndpoints(page);
    await seedUser(page, false);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);
    assert.equal(await page.locator('#verify-email-row').isVisible(), true);

    // Simulate verification having completed through a DIFFERENT entry
    // point than this row's own click handler (e.g. the emailed link --
    // see verify-email-link.js -- or the sheet opened from elsewhere in
    // the app) by calling the same public DreamStore API that path would
    // also call, which updates the same in-memory cache
    // getAccountEmailVerified() reads. Close and reopen Settings -- the
    // row must recompute on next open per that same convention, even
    // without ever having used this row's own click handler in-between.
    await page.evaluate(function () { return DreamStore.verifyEmailCode('123456'); });
    assert.equal(calls.verify.length, 1);
    await page.click('#account-cancel');
    await page.waitForSelector('#sheet-account-overlay:not(.open)');
    await openSettings(page);

    assert.equal(await page.locator('#verify-email-row').isVisible(), false);
  } finally {
    await page.close();
  }
});
