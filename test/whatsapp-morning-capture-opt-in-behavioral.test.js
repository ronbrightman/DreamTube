// test/whatsapp-morning-capture-opt-in-behavioral.test.js
//
// Real browser-driven coverage for profile.html's new Settings ->
// "Morning reminder" WhatsApp opt-in (tracker item for-product-build-
// whatsapp-morning-captu-skez3n, step 3) — the UI half of
// save-whatsapp-number.js, whose own request/response contract is covered
// directly (no browser) in test/save-whatsapp-number.test.js.
//
// Follows test/profile-me-character-behavioral.test.js's conventions:
// node:test + real Chromium via Playwright (resolved from this sandbox's
// global install, not a project dependency — see CLAUDE.md), state seeded
// straight into localStorage, no local Netlify Functions runtime available
// (see test/helpers/static-server.js's own header) so every call to
// save-whatsapp-number.js is intercepted via page.route(), and every
// navigation wrapped against this sandbox's known intermittent outbound-
// network stalls on third-party hosts.

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

/** Seeds a signed-in "tester" account, same shortcut every other profile.html suite in this repo uses. */
async function seedUser(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = [];
    if (!state.dreams) state.dreams = [];
    if (!state.draft) {
      state.draft = { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null };
    }
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

/**
 * Intercepts profile.html's calls to save-whatsapp-number.js (no local
 * Netlify Functions runtime is available to these tests — see
 * test/helpers/static-server.js's own doc comment, same pattern
 * test/profile-me-character-behavioral.test.js's mockGenerateAvatar uses
 * for a different endpoint). `existingNumber` seeds what the GET prefill
 * returns; every POST is recorded into `calls` and, unless `postResponse`
 * overrides it, echoes back a normalized-looking success using whatever
 * `whatsappNumber` the client actually sent.
 */
function mockSaveWhatsappNumber(page, opts) {
  opts = opts || {};
  var calls = { posts: [] };
  page.route('**/.netlify/functions/save-whatsapp-number*', function (route) {
    var request = route.request();
    if (request.method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, whatsappNumber: opts.existingNumber || null }) });
      return;
    }
    var body = JSON.parse(request.postData() || '{}');
    calls.posts.push(body);
    if (opts.postResponse) {
      route.fulfill(opts.postResponse);
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, whatsappNumber: body.whatsappNumber || null }) });
  });
  return calls;
}

async function openSettings(page) {
  await page.click('#account-btn');
  await page.waitForSelector('#sheet-account-overlay.open');
}

test('profile.html Settings: the Morning reminder section starts empty for an account with no saved number', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockSaveWhatsappNumber(page, { existingNumber: null });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    await page.waitForFunction(function () {
      var input = document.getElementById('whatsapp-number-input');
      return input && document.activeElement !== input; // just wait a tick for the prefill fetch to settle
    }).catch(function () {}); // best-effort settle wait, assertion below is the real check
    await page.waitForTimeout(50);

    assert.equal(await page.locator('#whatsapp-number-input').inputValue(), '');
    assert.equal(await page.locator('#whatsapp-success').isVisible(), false);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: prefills the field from the server when a number is already saved', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockSaveWhatsappNumber(page, { existingNumber: '+15559998888' });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    await page.waitForFunction(function () {
      var input = document.getElementById('whatsapp-number-input');
      return input && input.value === '+15559998888';
    });
    assert.equal(await page.locator('#whatsapp-number-input').inputValue(), '+15559998888');
  } finally {
    await page.close();
  }
});

test('profile.html Settings: saving a number posts it to save-whatsapp-number.js and shows the success notice', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockSaveWhatsappNumber(page, { existingNumber: null });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    await page.fill('#whatsapp-number-input', '+1 (555) 222-3333');
    await page.click('#whatsapp-save-btn');

    await page.waitForSelector('#whatsapp-success', { state: 'visible' });
    assert.equal(await page.locator('#whatsapp-success-text').textContent(), 'Saved.');
    assert.equal(await page.locator('#whatsapp-error').textContent(), '');

    assert.equal(calls.posts.length, 1);
    assert.equal(calls.posts[0].username, 'tester');
    assert.equal(calls.posts[0].whatsappNumber, '+1 (555) 222-3333');
  } finally {
    await page.close();
  }
});

test('profile.html Settings: an invalid number surfaces the server\'s E4 as a friendly error, no success notice shown', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockSaveWhatsappNumber(page, {
      existingNumber: null,
      postResponse: { status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E4: invalid_number' }) }
    });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    await page.fill('#whatsapp-number-input', 'not a real number');
    await page.click('#whatsapp-save-btn');

    await page.waitForFunction(function () {
      return document.getElementById('whatsapp-error').textContent.length > 0;
    });
    assert.match(await page.locator('#whatsapp-error').textContent(), /valid number/i);
    assert.equal(await page.locator('#whatsapp-success').isVisible(), false);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: clearing the field and saving opts back out ("Turned off.")', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockSaveWhatsappNumber(page, { existingNumber: '+15551234567' });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    await page.waitForFunction(function () {
      var input = document.getElementById('whatsapp-number-input');
      return input && input.value === '+15551234567';
    });
    await page.fill('#whatsapp-number-input', '');
    await page.click('#whatsapp-save-btn');

    await page.waitForSelector('#whatsapp-success', { state: 'visible' });
    assert.equal(await page.locator('#whatsapp-success-text').textContent(), 'Turned off.');
    assert.equal(calls.posts[calls.posts.length - 1].whatsappNumber, '');
  } finally {
    await page.close();
  }
});

test('profile.html Settings: reopening Settings clears any previous error/success state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockSaveWhatsappNumber(page, { existingNumber: null });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettings(page);

    await page.fill('#whatsapp-number-input', '+15551234567');
    await page.click('#whatsapp-save-btn');
    await page.waitForSelector('#whatsapp-success', { state: 'visible' });

    await page.click('#account-cancel');
    await page.waitForSelector('#sheet-account-overlay:not(.open)');
    await openSettings(page);

    assert.equal(await page.locator('#whatsapp-success').isVisible(), false);
    assert.equal(await page.locator('#whatsapp-error').textContent(), '');
  } finally {
    await page.close();
  }
});
