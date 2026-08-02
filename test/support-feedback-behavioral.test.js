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

/** Polls `conditionFn` (sync, Node-side) until it returns truthy or `timeoutMs` elapses -- condition-based waiting instead of a fixed sleep, since route interception is async relative to a page.click() call. Throws on timeout. */
async function waitFor(conditionFn, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 2000);
  while (Date.now() < deadline) {
    if (conditionFn()) return;
    await new Promise(function (r) { setTimeout(r, 20); });
  }
  if (!conditionFn()) throw new Error('waitFor: condition never became true within ' + timeoutMs + 'ms');
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 200, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100 }) });
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

/**
 * Intercepts submit-support-message.js WITHOUT resolving it immediately —
 * each call's route is held open until the test explicitly calls
 * releaseNext(), giving deterministic, condition-based control over exactly
 * when a request resolves relative to other UI actions (switching compose
 * type, cancelling, etc.) rather than racing an arbitrary setTimeout. Used
 * by the stale-async-response regression test below.
 */
function mockSubmitSupportControllable(page) {
  var calls = [];
  var pendingRoutes = [];
  return {
    calls: calls,
    install: function () {
      return page.route('**/.netlify/functions/submit-support-message', function (route) {
        calls.push(JSON.parse(route.request().postData() || '{}'));
        pendingRoutes.push(route);
      });
    },
    /** Resolves the oldest still-held request with a real ok:true response. */
    releaseNext: function () {
      var route = pendingRoutes.shift();
      if (!route) throw new Error('releaseNext() called with no pending submit-support-message request');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
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

test('profile.html Settings: a stale in-flight send from an ABANDONED compose session must not clobber a NEW session the user has already switched to and is actively typing into (review finding: async callback side effects must be scoped to the session that started them, same class as identitySheetToken/charSheetToken)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page, false);
  await mockTokenStatus(page);
  var mock = mockSubmitSupportControllable(page);
  await mock.install();
  try {
    await seedUser(page, { dreams: [] });
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    // 1. Start a Feedback submission -- the request is sent but deliberately
    //    held (not resolved yet) via mockSubmitSupportControllable.
    await page.click('#feedback-cta-btn');
    await page.waitForSelector('#support-compose', { state: 'visible' });
    await page.fill('#support-message-input', 'first feedback message, still in flight');
    await page.click('#support-send-btn');
    await waitFor(function () { return mock.calls.length === 1; });
    assert.equal(mock.calls[0].type, 'feedback');

    // 2. Before that request resolves, the user backs out of it entirely --
    //    Cancel, then opens the OTHER entry point (Support) and starts
    //    typing a brand-new, unrelated, unsent message.
    await page.click('#support-cancel-btn');
    await page.click('#support-row');
    await page.waitForSelector('#support-compose', { state: 'visible' });
    var newMessage = 'second message, actively being typed, must survive';
    await page.fill('#support-message-input', newMessage);

    // 3. ONLY NOW does the abandoned Feedback request resolve.
    await mock.releaseNext();
    // This assertion is inherently "prove nothing happened" -- there's no
    // DOM mutation to positively poll for on the discard path (that's the
    // whole point of the fix), so a short bounded wait is the honest way
    // to give the stale .then() chain (route.fulfill -> fetch resolves ->
    // res.json() -> .then()) real ticks to run before checking. The
    // fully-positive assertion for "the fix actually reset the button" and
    // "a real new send still works afterward" comes from step 4 below.
    await page.waitForTimeout(150);

    // The new session's typed-but-unsent message must be untouched --
    // the exact corruption the review flagged (a stale resolution wiping
    // the CURRENT session's input).
    assert.equal(await page.locator('#support-message-input').inputValue(), newMessage);
    // No success banner for a submission that is no longer the one on
    // screen -- discarded silently, same precedent as identitySheetToken's
    // own stale-save handling.
    assert.equal(await page.locator('#support-success').isVisible(), false);
    // The Send button must still be usable (not stuck disabled forever) --
    // the stale .then() still clears the button state even though it
    // discards the rest of its side effects.
    assert.equal(await page.locator('#support-send-btn').isDisabled(), false);

    // 4. The new (support) session can still be sent normally afterward.
    await page.click('#support-send-btn');
    // Same condition-based wait as step 1 -- the click's resulting fetch
    // reaching this test's page.route() interception is async relative to
    // page.click() resolving, so releaseNext() must not assume the second
    // request has already landed in pendingRoutes just because the click
    // happened. Without this wait, under enough scheduling delay (e.g. a
    // contended full-suite run) releaseNext() can run before the request
    // arrives and throw "no pending request" -- a race in this test's own
    // orchestration, not a product bug.
    await waitFor(function () { return mock.calls.length === 2; });
    await mock.releaseNext();
    await page.waitForSelector('#support-success', { state: 'visible' });
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].type, 'support');
    assert.equal(mock.calls[1].message, newMessage);
    assert.equal(await page.locator('#support-success-text').textContent(), "Thanks — we got your message and will follow up by email.");
  } finally {
    await page.close();
  }
});
