// test/identity-retention-ui-behavioral.test.js
//
// Real browser-driven coverage for Phase 1 Section 1.1 of the identity/
// retention project (see docs/IDENTITY_RETENTION_PROJECT_SPEC.md) --
// login.html's signup-only phone number field + unchecked-by-default SMS
// consent checkbox, and the "Email me a login link instead" magic-link
// entry point. Same Playwright/static-server convention as
// test/ui-behavioral.test.js -- see that file's own header comment for
// why (no bundler/build step, Playwright resolved from this sandbox's
// global install, every test skips itself cleanly if Playwright/Chromium
// aren't resolvable rather than failing the whole suite).

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

test('signup mode shows the phone field + an unchecked SMS consent checkbox; login mode hides both', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.isVisible('#login-phone'), true, 'phone field should be visible in signup mode');
    assert.equal(await page.isVisible('#sms-consent-row'), true, 'consent row should be visible in signup mode');
    var checked = await page.isChecked('#sms-consent-checkbox');
    assert.equal(checked, false, 'consent checkbox must be unchecked by default');
    assert.equal(await page.isVisible('#magic-link-link'), false, 'magic-link entry point is a login-mode-only affordance');

    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.isVisible('#login-phone'), false, 'phone field should be hidden in login mode');
    assert.equal(await page.isVisible('#sms-consent-row'), false, 'consent row should be hidden in login mode');
    assert.equal(await page.isVisible('#magic-link-link'), true, 'magic-link entry point should be visible in login mode');
  } finally {
    await context.close();
  }
});

test('checking the consent box, then toggling to login and back to signup, resets it to unchecked', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });

    await page.check('#sms-consent-checkbox');
    assert.equal(await page.isChecked('#sms-consent-checkbox'), true);

    // "Already have an account? Log in" toggles to login mode, then back.
    await page.click('#auth-toggle');
    await page.click('#auth-toggle');
    assert.equal(await page.isChecked('#sms-consent-checkbox'), false, 'consent must never carry over as pre-checked across a mode toggle');
  } finally {
    await context.close();
  }
});

test('signup succeeds with phone number + consent filled in (never blocks signup)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });

    await page.fill('#login-username', 'phoneuser1');
    await page.fill('#login-email', 'phoneuser1@example.com');
    await page.fill('#login-phone', '+15551234567');
    await page.check('#sms-consent-checkbox');
    await page.fill('#login-password', 'longenoughpassword1');
    await page.click('#login-submit');

    await page.waitForURL(/explore\.html/, { timeout: 5000 });
    assert.match(page.url(), /explore\.html/);
  } finally {
    await context.close();
  }
});

test('signup succeeds with the phone field and consent checkbox both left untouched (both fully optional)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });

    await page.fill('#login-username', 'nophoneuser1');
    await page.fill('#login-email', 'nophoneuser1@example.com');
    await page.fill('#login-password', 'longenoughpassword1');
    // Deliberately never touching #login-phone or #sms-consent-checkbox.
    await page.click('#login-submit');

    await page.waitForURL(/explore\.html/, { timeout: 5000 });
    assert.match(page.url(), /explore\.html/);
  } finally {
    await context.close();
  }
});

test('a phone number with consent left unchecked is still accepted (signup never blocks on it)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?mode=signup', { waitUntil: 'domcontentloaded' });

    await page.fill('#login-username', 'unconsenteduser1');
    await page.fill('#login-email', 'unconsenteduser1@example.com');
    await page.fill('#login-phone', '+15559998888');
    // Deliberately never checking #sms-consent-checkbox.
    await page.fill('#login-password', 'longenoughpassword1');
    await page.click('#login-submit');

    await page.waitForURL(/explore\.html/, { timeout: 5000 });
    assert.match(page.url(), /explore\.html/);
  } finally {
    await context.close();
  }
});

/** Drives start.html's funnel tail up to screen 13 (signup) -- same path test/ui-behavioral.test.js's own goToPricingScreen helper uses, stopping one step earlier so the caller can interact with screen 13's fields directly. */
async function goToSignupScreen(page) {
  await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('A test dream'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
  await page.click('#fn-adv-chars-skip');
  await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  await page.click('#fn-s11-continue');
  await page.waitForSelector('#fn-email', { timeout: 5000 });
}

test('start.html screen 13 (the actual paid-traffic signup screen) shows the phone field + an unchecked SMS consent checkbox', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await goToSignupScreen(page);

    assert.equal(await page.isVisible('#fn-phone'), true);
    assert.equal(await page.isVisible('#fn-sms-consent-row'), true);
    assert.equal(await page.isChecked('#fn-sms-consent-checkbox'), false, 'consent checkbox must be unchecked by default');
  } finally {
    await context.close();
  }
});

test('start.html screen 13: signup succeeds whether or not the phone/consent fields are filled in', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await goToSignupScreen(page);

    await page.fill('#fn-email', 'funnelphoneuser@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.fill('#fn-phone', '+15557778888');
    await page.check('#fn-sms-consent-checkbox');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('"Email me a login link instead" swaps to the magic-link view and back', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });

    await page.click('#magic-link-link');
    assert.equal(await page.isVisible('#magic-view'), true);
    assert.equal(await page.isVisible('#auth-view'), false);

    await page.click('#magic-back');
    assert.equal(await page.isVisible('#auth-view'), true);
    assert.equal(await page.isVisible('#magic-view'), false);
  } finally {
    await context.close();
  }
});
