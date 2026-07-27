// test/legal-pages-behavioral.test.js
//
// Real browser-driven smoke coverage for privacy.html/terms.html
// (tracker.html's for-product-create-a-real-privacy-policy-o3g56s item —
// DreamTube had no privacy policy or terms page anywhere on main before
// this, which blocks Meta's Facebook Login app from switching to Live
// mode and is table stakes now that real payments (Dodo) and retention
// emails are live). These are static legal-content pages, not interactive
// features, so this doesn't need heavy behavioral coverage — just proof
// the pages exist, load, name the real vendors this app actually uses,
// link to the real account-deletion entry point, cross-link each other,
// and that the two real in-app entry points (profile.html's Settings
// sheet, login.html's signup mode small-print) actually wire up to them.
//
// Follows test/faq-section-behavioral.test.js's conventions: node:test +
// real Chromium via Playwright, state seeded directly into localStorage,
// every page.goto wrapped against this sandbox's known intermittent
// third-party-host network stalls.

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

/** Mocks the real admin-paywall-toggle GET profile.html fires on load — always answers isOwner:false so tests never depend on OWNER_EMAIL config. */
function mockOwnerCheck(page) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, source: 'env-default', isOwner: false }) });
  });
}

/** Mocks the real get-token-status GET so profile.html's token chip doesn't hang on a real network call. */
function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 220, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 20 }) });
  });
}

/** Seeds a logged-in "tester" account, matching support-feedback-behavioral.test.js's own seed helper. */
async function seedUser(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com', createdAt: Date.now() - 3 * 86400000 };
    state.dreams = [];
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

// Every named vendor this build actually verified in the real code
// (js/analytics-config.js for PostHog/Meta, netlify/functions/dodo-webhook.js
// + create-checkout-session-dodo.js for Dodo, netlify/functions/dream-webhook.js
// + request-password-reset.js for Resend, netlify/functions/generate-video.js
// + generate-image.js + transcribe-audio.js for fal.ai) must actually be named
// in the privacy policy — this is what keeps the policy honest instead of
// generic boilerplate, per the tracker item's own instruction.
var EXPECTED_VENDOR_MENTIONS = ['fal.ai', 'Dodo', 'Resend', 'PostHog', 'Meta', 'Netlify'];

test('privacy.html loads and names every real data-sharing vendor', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/privacy.html');
    await assert.doesNotReject(page.title());
    assert.equal(await page.title(), 'Privacy Policy — DreamTube');

    var bodyText = await page.locator('body').innerText();
    EXPECTED_VENDOR_MENTIONS.forEach(function (vendor) {
      assert.ok(bodyText.indexOf(vendor) !== -1, 'expected privacy.html to mention ' + vendor);
    });

    // A real, working link to the actual account-deletion entry point
    // (profile.html's Settings > Danger zone > Delete account), not just
    // unlinked prose describing it.
    var deleteLink = page.locator('a[href="profile.html"]');
    assert.ok(await deleteLink.count() >= 1, 'expected a real link to profile.html (account deletion entry point)');

    // Cross-links to terms.html.
    var termsLink = page.locator('a[href="terms.html"]');
    assert.ok(await termsLink.count() >= 1, 'expected a link to terms.html');
  } finally {
    await page.close();
  }
});

test('terms.html loads and cross-links back to the privacy policy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/terms.html');
    assert.equal(await page.title(), 'Terms of Service — DreamTube');

    var bodyText = await page.locator('body').innerText();
    // Terms should mention the two real, distinguishing facts the tracker
    // item called out: AI-generated content has no quality guarantee, and
    // fal.ai is the model provider actually doing the generation.
    assert.ok(bodyText.indexOf('fal.ai') !== -1, 'expected terms.html to name fal.ai');
    assert.ok(/no.*guarantee|don.t guarantee/i.test(bodyText), 'expected terms.html to disclaim AI output quality');

    var privacyLink = page.locator('a[href="privacy.html"]');
    assert.ok(await privacyLink.count() >= 1, 'expected a link back to privacy.html');
  } finally {
    await page.close();
  }
});

test('profile.html Settings sheet has a Legal section linking to both pages', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    var sectionLabels = await page.locator('#sheet-account-overlay .section-label').allTextContents();
    assert.ok(sectionLabels.indexOf('Legal') !== -1, JSON.stringify(sectionLabels));

    var privacyHref = await page.locator('#sheet-account-overlay a[href="privacy.html"]').count();
    var termsHref = await page.locator('#sheet-account-overlay a[href="terms.html"]').count();
    assert.ok(privacyHref >= 1, 'expected a Privacy Policy link in the Settings sheet');
    assert.ok(termsHref >= 1, 'expected a Terms of Service link in the Settings sheet');
  } finally {
    await page.close();
  }
});

test('login.html signup mode shows terms/privacy small-print; login mode does not', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    // Default mode is login (no ?mode=signup) — the small-print must stay hidden.
    assert.equal(await page.locator('#signup-legal-note').isVisible(), false);

    await safeGoto(page, baseUrl + '/login.html?mode=signup');
    assert.equal(await page.locator('#signup-legal-note').isVisible(), true);
    var privacyHref = await page.locator('#signup-legal-note a[href="privacy.html"]').count();
    var termsHref = await page.locator('#signup-legal-note a[href="terms.html"]').count();
    assert.ok(privacyHref >= 1, 'expected a Privacy Policy link in the signup small-print');
    assert.ok(termsHref >= 1, 'expected a Terms link in the signup small-print');
  } finally {
    await page.close();
  }
});
