// test/admin-rename-panel-behavioral.test.js
//
// Real browser-driven coverage for the "Account rename" panel added to
// admin.html (tracker.html's
// for-product-owner-ui-for-the-account-ren-baguw7 item, and its own
// standing rule that any founder-facing action ships with a UI/link, never
// a curl command). This panel is a thin client for the already-reviewed,
// already-merged netlify/functions/admin-rename-account.js — see that
// file's own header comment for the full request/response shape this test
// mocks against.
//
// Follows test/rename-migration-login-behavioral.test.js's and
// test/ui-behavioral.test.js's conventions: a plain static file server (no
// real Netlify Functions runtime), page.route() to mock the two functions
// admin.html calls (admin-paywall-toggle for the isOwner gate,
// admin-rename-account for the panel itself), blockThirdParty() for this
// sandbox's flaky outbound network, and safeGoto() to tolerate a transient
// nav failure.
//
// What this file checks, per the tracker item's own explicit ask:
//   1. the dry-run toggle defaults on
//   2. a dry-run result renders (from a mocked response) before any
//      real-run action is possible
//   3. the real (non-dry-run) call only fires once the toggle has been
//      explicitly turned off — AND only after a dry run has actually
//      completed first (this panel's own extra client-side guardrail,
//      since admin-rename-account.js can delete an account record).

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure — see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Seeds a logged-in owner-shaped account in localStorage, then navigates to admin.html. Follows test/ui-behavioral.test.js's seedLoggedInUserAt exactly: load login.html FIRST so js/store.js's own load()/seed() has already written a complete, valid state object (with `dreams`, etc.) to localStorage, then MERGE user/accounts into that existing object rather than replacing it outright. js/store.js's load() (line ~231) throws on any parsed state missing `dreams` and falls back to a fresh, logged-out seed — a wholesale localStorage.setItem() with just {user, accounts} silently loses the login instead of setting it, which is exactly the bug this comment is here to prevent regressing. */
async function seedOwnerAt(page, baseUrl) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@ronbrightman', username: 'ronbrightman' };
    if (!state.accounts) state.accounts = {};
    state.accounts.ronbrightman = { password: 'testpass1', email: 'ronbrightman@gmail.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
  await safeGoto(page, baseUrl + '/admin.html');
}

/** Mocks admin-paywall-toggle.js's GET so admin.html's own isOwner gate always passes — this panel is nested inside #admin-content, which only shows once that gate resolves true. */
function mockOwnerGate(page) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    if (route.request().method() !== 'GET') { route.fallback(); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isOwner: true, enabled: false, source: 'env' }) });
  });
}

/** Mocks admin-rename-account.js's POST, recording every call's parsed body and responding with `responses` in order (last one repeats once exhausted). Returns the `calls` array the test can assert against. */
function mockRenameEndpoint(page, responses) {
  var calls = [];
  page.route('**/.netlify/functions/admin-rename-account', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    calls.push(body);
    var resp = responses[Math.min(calls.length - 1, responses.length - 1)];
    route.fulfill({ status: resp.status || 200, contentType: 'application/json', body: JSON.stringify(resp.body) });
  });
  return calls;
}

var DRY_RUN_RENAMED_RESPONSE = {
  status: 200,
  body: { ok: true, dryRun: true, status: 'renamed', account: { username: 'ronbrightman', email: 'ronbrightman@gmail.com' }, feed: { updatedCount: 2, dreamIds: ['d1', 'd2'] } }
};
var REAL_RUN_RENAMED_RESPONSE = {
  status: 200,
  body: { ok: true, dryRun: false, status: 'renamed', account: { username: 'ronbrightman', email: 'ronbrightman@gmail.com' }, feed: { updatedCount: 2, dreamIds: ['d1', 'd2'] } }
};

test('admin.html: the account-rename panel\'s dry-run toggle defaults on', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-content', { state: 'visible' });

    var toggle = page.locator('#admin-rename-dryrun-toggle');
    assert.ok(await toggle.isVisible(), 'dry-run toggle must be visible once the owner gate passes');
    var classes = await toggle.getAttribute('class');
    assert.ok(classes.split(' ').indexOf('on') !== -1, 'dry-run toggle must default to the "on" state');
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.equal((await page.locator('#admin-rename-submit').textContent()).trim(), 'Preview (dry run)');
  } finally {
    await page.close();
  }
});

test('admin.html: a dry-run result renders from a mocked response before any real-run action is possible', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockRenameEndpoint(page, [DRY_RUN_RENAMED_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-rename-submit');

    // Toggle is still on (default) -- submitting must call the endpoint
    // with dryRun:true, never a real run.
    await page.fill('#admin-rename-password', 'realfounderpw1');
    await page.click('#admin-rename-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-rename-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });

    assert.equal(calls.length, 1, 'exactly one call so far');
    assert.equal(calls[0].dryRun, true, 'the only call made must have been a dry run');
    assert.equal(calls[0].usernameOrEmail, '__probe_throwaway_user__', 'the prefilled source field value must be what gets sent');

    var resultText = await page.locator('#admin-rename-result').textContent();
    assert.ok(resultText.indexOf('DRY RUN') !== -1, 'result must be clearly labeled as a dry run');
    assert.ok(resultText.indexOf('ronbrightman@gmail.com') !== -1, 'result must show the account the dry run resolved');
    assert.ok(resultText.indexOf('2') !== -1, 'result must show the feed update count');

    // No real (mutating) call has happened -- still just the one dry run.
    assert.equal(calls.length, 1);
  } finally {
    await page.close();
  }
});

test('admin.html: turning dry run off and submitting WITHOUT a completed dry run first is blocked client-side (no real call fires)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockRenameEndpoint(page, [REAL_RUN_RENAMED_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-rename-submit');

    // Auto-accept any confirm() dialog -- if this test is wrong and a real
    // call is somehow reachable, it must not be the confirm() step itself
    // silently blocking it.
    page.on('dialog', function (dialog) { dialog.accept(); });

    await page.click('#admin-rename-dryrun-row');
    assert.equal(await page.locator('#admin-rename-dryrun-toggle').getAttribute('aria-checked'), 'false', 'toggle must actually be off now');

    await page.fill('#admin-rename-password', 'realfounderpw1');
    await page.click('#admin-rename-submit');
    // Give any (incorrect) network call a moment to land before asserting
    // it didn't.
    await page.waitForTimeout(200);

    assert.equal(calls.length, 0, 'no call to admin-rename-account.js must fire until a dry run has completed first');
    var errorText = await page.locator('#admin-rename-error').textContent();
    assert.ok(errorText.toLowerCase().indexOf('dry run') !== -1, 'an explanatory error must be shown instead');
  } finally {
    await page.close();
  }
});

test('admin.html: the real (non-dry-run) call only fires once the toggle is explicitly turned off, and only after a dry run has completed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockRenameEndpoint(page, [DRY_RUN_RENAMED_RESPONSE, REAL_RUN_RENAMED_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-rename-submit');

    var dialogMessages = [];
    page.on('dialog', function (dialog) { dialogMessages.push(dialog.message()); dialog.accept(); });

    await page.fill('#admin-rename-password', 'realfounderpw1');

    // 1) Dry run first (toggle still on by default).
    await page.click('#admin-rename-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-rename-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dryRun, true);

    // 2) Flip the toggle off explicitly.
    await page.click('#admin-rename-dryrun-row');
    assert.equal(await page.locator('#admin-rename-dryrun-toggle').getAttribute('aria-checked'), 'false');
    assert.equal((await page.locator('#admin-rename-submit').textContent()).trim(), 'Rename for real');

    // 3) Submit again -- now, and only now, the real call must fire.
    await page.click('#admin-rename-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-rename-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') === -1 && el.textContent.indexOf('Renamed') !== -1;
    });

    assert.equal(calls.length, 2, 'the real call must have fired this time');
    assert.equal(calls[1].dryRun, false, 'the second call must be a real (non-dry-run) run');
    assert.equal(dialogMessages.length, 1, 'the real run must be gated behind an explicit confirm() dialog');

    var resultText = await page.locator('#admin-rename-result').textContent();
    assert.ok(resultText.indexOf('DRY RUN') === -1, 'a completed real run must not still be labeled as a dry run');
  } finally {
    await page.close();
  }
});

test('admin.html: editing the password AFTER a completed dry run invalidates it -- the real run stays blocked until a fresh dry run covers the new password (review finding)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockRenameEndpoint(page, [DRY_RUN_RENAMED_RESPONSE, DRY_RUN_RENAMED_RESPONSE, REAL_RUN_RENAMED_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-rename-submit');

    page.on('dialog', function (dialog) { dialog.accept(); });

    // 1) Dry run against password A.
    await page.fill('#admin-rename-password', 'passwordA');
    await page.click('#admin-rename-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-rename-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });
    assert.equal(calls.length, 1);

    // 2) Edit the password to B WITHOUT re-running the dry run, then flip
    // dry-run off and try to submit for real.
    await page.fill('#admin-rename-password', 'passwordB');
    await page.click('#admin-rename-dryrun-row');
    assert.equal(await page.locator('#admin-rename-dryrun-toggle').getAttribute('aria-checked'), 'false');
    await page.click('#admin-rename-submit');
    await page.waitForTimeout(200);

    // The stale dry run (against password A) must not authorize a real run
    // against password B -- must be blocked exactly like never having run
    // a dry run at all.
    assert.equal(calls.length, 1, 'no real call must fire -- the prior dry run no longer covers the edited password');
    var errorText = await page.locator('#admin-rename-error').textContent();
    assert.ok(errorText.toLowerCase().indexOf('dry run') !== -1, 'an explanatory error must be shown instead');

    // 3) A fresh dry run against B, THEN the real run, must work normally.
    await page.click('#admin-rename-dryrun-row');
    assert.equal(await page.locator('#admin-rename-dryrun-toggle').getAttribute('aria-checked'), 'true');
    await page.click('#admin-rename-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-rename-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].password, 'passwordB');

    await page.click('#admin-rename-dryrun-row');
    await page.click('#admin-rename-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-rename-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') === -1 && el.textContent.indexOf('Renamed') !== -1;
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].dryRun, false);
    assert.equal(calls[2].password, 'passwordB');
  } finally {
    await page.close();
  }
});

test('admin.html: an error response (e.g. wrong password) is shown and never rendered as a success result', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockRenameEndpoint(page, [{ status: 403, body: { ok: false, error: 'E5: forbidden' } }]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-rename-submit');

    await page.fill('#admin-rename-password', 'wrong-password');
    await page.click('#admin-rename-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-rename-error');
      return el && el.textContent && el.textContent.length > 0;
    });

    assert.equal(calls.length, 1);
    var errorText = await page.locator('#admin-rename-error').textContent();
    assert.ok(errorText.length > 0, 'an error message must be shown');
    var resultVisible = await page.locator('#admin-rename-result').isVisible();
    assert.equal(resultVisible, false, 'the result box must not show a success-shaped render for an error response');
  } finally {
    await page.close();
  }
});
