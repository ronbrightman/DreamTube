// test/support-feedback-behavioral.test.js
//
// Real browser-driven coverage for the Settings redesign + new support/
// feedback compose flow (tracker.html's support-and-feedback-atms4a item):
// the redesigned #sheet-account-overlay ("Settings") groups its controls
// into labeled sections, and its new feedback CTA / "Contact support" row
// both open the SAME compose panel (#support-compose), submitting to
// netlify/functions/submit-support-message.js with real account context
// (username, email, video count, days since signup) and a `type` of
// "feedback" or "support" depending on which entry point was tapped.
//
// Follows test/profile-me-character-behavioral.test.js's conventions:
// node:test + real Chromium via Playwright, state seeded directly into
// localStorage, every page.goto wrapped against this sandbox's known
// intermittent third-party-host network stalls, and the real
// submit-support-message.js network call intercepted via page.route()
// (no local Netlify Functions runtime is available to these tests — see
// test/helpers/static-server.js's own doc comment).

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

/** Mocks the real admin-paywall-toggle GET the page fires on load to decide whether to show owner tools — always answers isOwner:false so tests never depend on OWNER_EMAIL config, unless overridden. */
function mockOwnerCheck(page, isOwner) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, source: 'env-default', isOwner: !!isOwner }) });
  });
}

/** Mocks the real get-token-status GET (or whatever route DreamStore.getTokenStatus hits) so the token chip doesn't hang on a real network call. */
function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 200, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 100 }) });
  });
}

/** Intercepts submit-support-message.js — captures every request body and lets the test control success/failure. */
function mockSubmitSupport(page, opts) {
  opts = opts || {};
  var calls = [];
  return {
    calls: calls,
    install: function () {
      return page.route('**/.netlify/functions/submit-support-message', function (route) {
        var req = route.request();
        calls.push(JSON.parse(req.postData() || '{}'));
        if (opts.fail) {
          route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'E6: message_required' }) });
          return;
        }
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      });
    }
  };
}

/** Seeds a logged-in "tester" account with a known createdAt and some existing dreams, so videoCount/daysSinceSignup are real, checkable numbers. */
async function seedUser(page, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (opts) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = {
      password: 'testpass1',
      email: 'tester@example.com',
      createdAt: opts.createdAt !== undefined ? opts.createdAt : (Date.now() - 3 * 86400000)
    };
    state.dreams = opts.dreams || [];
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

// IDs deliberately avoid js/store.js's LEGACY_MOCK_ID pattern (/^d[0-5]$/,
// the old pre-fal.ai mock-seed-dream ids "d0".."d5") — migrateLegacyState()
// silently strips any dream whose id matches that on every load, which a
// plain "d1"/"d2"/"d3" fixture collides with.
function threeFakeDreams() {
  return [
    { id: 'dream-one', ownerHandle: '@tester', caption: 'one', isPublished: false, videoUrl: 'x' },
    { id: 'dream-two', ownerHandle: '@tester', caption: 'two', isPublished: true, videoUrl: 'x' },
    { id: 'dream-three', ownerHandle: '@tester', caption: 'three', isPublished: false, videoUrl: 'x' }
  ];
}

test('profile.html Settings: redesigned sheet groups controls into labeled sections, including the new Support & feedback section', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page, false);
  await mockTokenStatus(page);
  try {
    await seedUser(page, { dreams: threeFakeDreams() });
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    assert.equal(await page.locator('#sheet-account-overlay .sheet-title').textContent(), 'Settings');
    var sectionLabels = await page.locator('#sheet-account-overlay .section-label').allTextContents();
    assert.ok(sectionLabels.indexOf('Account') !== -1, JSON.stringify(sectionLabels));
    assert.ok(sectionLabels.indexOf('Your data') !== -1, JSON.stringify(sectionLabels));
    assert.ok(sectionLabels.indexOf('Tokens') !== -1, JSON.stringify(sectionLabels));
    assert.ok(sectionLabels.indexOf('Support & feedback') !== -1, JSON.stringify(sectionLabels));
    // Owner tools stays hidden for a non-owner account.
    assert.equal(await page.locator('#owner-topup-block').isVisible(), false);

    assert.equal(await page.locator('#feedback-cta-btn .feedback-cta-title').textContent(), 'Help us improve');
    assert.equal(await page.locator('#support-row .settings-row-title').textContent(), 'Contact support');
    // Compose panel starts collapsed.
    assert.equal(await page.locator('#support-compose').isVisible(), false);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: the feedback CTA and the support row open the SAME panel, tagged with the right type and real account context', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page, false);
  await mockTokenStatus(page);
  var mock = mockSubmitSupport(page);
  await mock.install();
  try {
    var createdAt = Date.now() - 5 * 86400000; // exactly 5 days ago
    await seedUser(page, { createdAt: createdAt, dreams: threeFakeDreams() });
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    // ----- Feedback entry point -----
    await page.click('#feedback-cta-btn');
    await page.waitForSelector('#support-compose', { state: 'visible' });
    var feedbackPlaceholder = await page.locator('#support-message-input').getAttribute('placeholder');
    assert.match(feedbackPlaceholder, /love to see/i);

    await page.fill('#support-message-input', 'Really enjoying the cartoon style!');
    await page.click('#support-send-btn');
    await page.waitForSelector('#support-success', { state: 'visible' });

    assert.equal(mock.calls.length, 1);
    var feedbackCall = mock.calls[0];
    assert.equal(feedbackCall.type, 'feedback');
    assert.equal(feedbackCall.username, 'tester');
    assert.equal(feedbackCall.email, 'tester@example.com');
    assert.equal(feedbackCall.message, 'Really enjoying the cartoon style!');
    assert.equal(feedbackCall.videoCount, 3);
    assert.equal(feedbackCall.daysSinceSignup, 5);

    // Reopen the sheet fresh (closing collapses/reset the panel) then use the support entry point.
    await page.click('#account-cancel');
    await page.waitForSelector('#sheet-account-overlay:not(.open)');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');
    assert.equal(await page.locator('#support-compose').isVisible(), false, 'compose panel must not carry over open across a reopen');

    await page.click('#support-row');
    await page.waitForSelector('#support-compose', { state: 'visible' });
    var supportPlaceholder = await page.locator('#support-message-input').getAttribute('placeholder');
    assert.match(supportPlaceholder, /describe what's happening/i);

    await page.fill('#support-message-input', 'My last video failed to generate.');
    await page.click('#support-send-btn');
    await page.waitForSelector('#support-success', { state: 'visible' });

    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].type, 'support');
    assert.equal(mock.calls[1].message, 'My last video failed to generate.');
  } finally {
    await page.close();
  }
});

test('profile.html Settings: an empty message is rejected inline with no network call; a failed send shows an inline error, not a silent failure', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page, false);
  await mockTokenStatus(page);
  var mock = mockSubmitSupport(page, { fail: true });
  await mock.install();
  try {
    await seedUser(page, { dreams: [] });
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    await page.click('#support-row');
    await page.waitForSelector('#support-compose', { state: 'visible' });
    await page.click('#support-send-btn');
    assert.equal(mock.calls.length, 0, 'an empty message must never reach the network');
    assert.notEqual(await page.locator('#support-error').textContent(), '');

    await page.fill('#support-message-input', 'a real message this time');
    await page.click('#support-send-btn');
    await page.waitForFunction(function () {
      var el = document.getElementById('support-error');
      return el && el.textContent && el.textContent.length > 0;
    });
    assert.equal(mock.calls.length, 1);
    assert.equal(await page.locator('#support-success').isVisible(), false);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: a legacy account with no recorded signup timestamp reports daysSinceSignup as null, not a fabricated number', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page, false);
  await mockTokenStatus(page);
  var mock = mockSubmitSupport(page);
  await mock.install();
  try {
    await seedUser(page, { createdAt: null, dreams: [] });
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');
    await page.click('#support-row');
    await page.waitForSelector('#support-compose', { state: 'visible' });
    await page.fill('#support-message-input', 'hello');
    await page.click('#support-send-btn');
    await page.waitForSelector('#support-success', { state: 'visible' });

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].daysSinceSignup, null);
    assert.equal(mock.calls[0].videoCount, 0);
  } finally {
    await page.close();
  }
});
