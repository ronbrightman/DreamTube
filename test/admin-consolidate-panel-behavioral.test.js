// test/admin-consolidate-panel-behavioral.test.js
//
// Real browser-driven coverage for the "Consolidate founder accounts" panel
// added to admin.html (tracker.html's
// for-product-rename-dry-run-refused-u-ron-rd0sm9 item's own ask for a real
// page, per the founder's standing rule from
// for-product-owner-ui-for-the-account-ren-baguw7: any founder-facing
// action ships with a UI/link, never a curl command). This panel is a thin
// client for the already-reviewed netlify/functions/admin-consolidate-
// accounts.js — see that file's own header comment for the full
// request/response shape this test mocks against.
//
// Follows test/admin-rename-panel-behavioral.test.js's conventions exactly
// (same static server, same owner-gate mock, same page-route mocking
// approach) — this file checks the same class of client-side guardrails for
// the new panel:
//   1. the dry-run toggle defaults on, the skip-sanity-checks toggle
//      defaults off
//   2. a dry-run result renders (from a mocked response) before any
//      real-run action is possible
//   3. the real (non-dry-run) call only fires once the toggle has been
//      explicitly turned off, a dry run has actually completed first, AND
//      the confirm() dialog is accepted
//   4. editing the password after a completed dry run invalidates it (same
//      review finding the rename panel's own test file already covers for
//      its sibling panel)
//   5. the skip-sanity-checks toggle's state is actually included in what
//      gets submitted
//   6. an error response (e.g. a snapshot mismatch) is shown, never
//      rendered as a success

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

/** Same seeding approach as test/admin-rename-panel-behavioral.test.js's own seedOwnerAt — see that file's doc comment for why login.html must be loaded first. */
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

function mockOwnerGate(page) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    if (route.request().method() !== 'GET') { route.fallback(); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isOwner: true, enabled: false, source: 'env' }) });
  });
}

/** Mocks admin-consolidate-accounts.js's POST, recording every call's parsed body and responding with `responses` in order (last one repeats once exhausted). */
function mockConsolidateEndpoint(page, responses) {
  var calls = [];
  page.route('**/.netlify/functions/admin-consolidate-accounts', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    calls.push(body);
    var resp = responses[Math.min(calls.length - 1, responses.length - 1)];
    route.fulfill({ status: resp.status || 200, contentType: 'application/json', body: JSON.stringify(resp.body) });
  });
  return calls;
}

var DRY_RUN_RESPONSE = {
  status: 200,
  body: {
    ok: true, dryRun: true, status: 'consolidated',
    account: { username: 'ronbrightman', email: 'ronbrightman@gmail.com' },
    tokens: { ownerEmailBalanceBefore: 1860, oldEmailBalanceBefore: 200, newOwnerEmailBalance: 2060, oldEmailDrainedToZero: true },
    feed: { updatedCount: 2, dreamIds: ['dqocagbs', 'dm6bujus'] },
    tombstoned: { probeAccountDeleted: true, oldEmailIndexDeleted: true }
  }
};
var REAL_RUN_RESPONSE = {
  status: 200,
  body: {
    ok: true, dryRun: false, status: 'consolidated',
    account: { username: 'ronbrightman', email: 'ronbrightman@gmail.com' },
    tokens: { ownerEmailBalanceBefore: 1860, oldEmailBalanceBefore: 200, newOwnerEmailBalance: 2060, oldEmailDrainedToZero: true },
    feed: { updatedCount: 2, dreamIds: ['dqocagbs', 'dm6bujus'] },
    tombstoned: { probeAccountDeleted: true, oldEmailIndexDeleted: true }
  }
};

test('admin.html: the consolidate panel\'s dry-run toggle defaults on, and the skip-sanity-checks toggle defaults off', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-content', { state: 'visible' });

    var dryRunToggle = page.locator('#admin-consolidate-dryrun-toggle');
    assert.ok((await dryRunToggle.getAttribute('class')).split(' ').indexOf('on') !== -1, 'dry-run toggle must default to on');
    assert.equal(await dryRunToggle.getAttribute('aria-checked'), 'true');
    assert.equal((await page.locator('#admin-consolidate-submit').textContent()).trim(), 'Preview (dry run)');

    var skipToggle = page.locator('#admin-consolidate-skip-toggle');
    assert.ok((await skipToggle.getAttribute('class')).split(' ').indexOf('on') === -1, 'skip-sanity-checks toggle must default to off');
    assert.equal(await skipToggle.getAttribute('aria-checked'), 'false');
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
    var calls = mockConsolidateEndpoint(page, [DRY_RUN_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-consolidate-submit');

    await page.fill('#admin-consolidate-password', 'realfounderpw1');
    await page.click('#admin-consolidate-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-consolidate-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].dryRun, true);
    assert.equal(calls[0].usernameOrEmail, '__probe_throwaway_user__', 'the prefilled source field value must be what gets sent');
    assert.equal(calls[0].skipSnapshotSanityChecks, false, 'must default to false');

    var resultText = await page.locator('#admin-consolidate-result').textContent();
    assert.ok(resultText.indexOf('DRY RUN') !== -1);
    assert.ok(resultText.indexOf('ronbrightman@gmail.com') !== -1);
    assert.ok(resultText.indexOf('2060') !== -1, 'result must show the resulting token balance');
    assert.ok(resultText.indexOf('dqocagbs') !== -1, 'result must show which dreams were retagged');

    assert.equal(calls.length, 1, 'still no real call has fired');
  } finally {
    await page.close();
  }
});

test('admin.html: turning the skip-sanity-checks toggle on is reflected in the submitted request body', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockConsolidateEndpoint(page, [DRY_RUN_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-consolidate-submit');

    await page.click('#admin-consolidate-skip-row');
    assert.equal(await page.locator('#admin-consolidate-skip-toggle').getAttribute('aria-checked'), 'true');

    await page.fill('#admin-consolidate-password', 'realfounderpw1');
    await page.click('#admin-consolidate-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-consolidate-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].skipSnapshotSanityChecks, true);
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
    var calls = mockConsolidateEndpoint(page, [REAL_RUN_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-consolidate-submit');

    page.on('dialog', function (dialog) { dialog.accept(); });

    await page.click('#admin-consolidate-dryrun-row');
    assert.equal(await page.locator('#admin-consolidate-dryrun-toggle').getAttribute('aria-checked'), 'false');

    await page.fill('#admin-consolidate-password', 'realfounderpw1');
    await page.click('#admin-consolidate-submit');
    await page.waitForTimeout(200);

    assert.equal(calls.length, 0, 'no call must fire until a dry run has completed first');
    var errorText = await page.locator('#admin-consolidate-error').textContent();
    assert.ok(errorText.toLowerCase().indexOf('dry run') !== -1);
  } finally {
    await page.close();
  }
});

test('admin.html: the real (non-dry-run) call only fires once the toggle is off, a dry run completed, and confirm() is accepted', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockConsolidateEndpoint(page, [DRY_RUN_RESPONSE, REAL_RUN_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-consolidate-submit');

    var dialogMessages = [];
    page.on('dialog', function (dialog) { dialogMessages.push(dialog.message()); dialog.accept(); });

    await page.fill('#admin-consolidate-password', 'realfounderpw1');

    await page.click('#admin-consolidate-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-consolidate-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dryRun, true);

    await page.click('#admin-consolidate-dryrun-row');
    assert.equal(await page.locator('#admin-consolidate-dryrun-toggle').getAttribute('aria-checked'), 'false');
    assert.equal((await page.locator('#admin-consolidate-submit').textContent()).trim(), 'Consolidate for real');

    await page.click('#admin-consolidate-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-consolidate-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') === -1 && el.textContent.indexOf('Consolidated') !== -1;
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].dryRun, false);
    assert.equal(dialogMessages.length, 1, 'the real run must be gated behind an explicit confirm() dialog');
  } finally {
    await page.close();
  }
});

test('admin.html: editing the password AFTER a completed dry run invalidates it -- the real run stays blocked until a fresh dry run covers the new password', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockConsolidateEndpoint(page, [DRY_RUN_RESPONSE, DRY_RUN_RESPONSE, REAL_RUN_RESPONSE]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-consolidate-submit');

    page.on('dialog', function (dialog) { dialog.accept(); });

    await page.fill('#admin-consolidate-password', 'passwordA');
    await page.click('#admin-consolidate-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-consolidate-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });
    assert.equal(calls.length, 1);

    await page.fill('#admin-consolidate-password', 'passwordB');
    await page.click('#admin-consolidate-dryrun-row');
    await page.click('#admin-consolidate-submit');
    await page.waitForTimeout(200);
    assert.equal(calls.length, 1, 'no real call must fire -- the prior dry run no longer covers the edited password');

    await page.click('#admin-consolidate-dryrun-row');
    await page.click('#admin-consolidate-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-consolidate-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') !== -1;
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].password, 'passwordB');

    await page.click('#admin-consolidate-dryrun-row');
    await page.click('#admin-consolidate-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-consolidate-result');
      return el && el.textContent && el.textContent.indexOf('DRY RUN') === -1 && el.textContent.indexOf('Consolidated') !== -1;
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].dryRun, false);
    assert.equal(calls[2].password, 'passwordB');
  } finally {
    await page.close();
  }
});

test('admin.html: an error response (e.g. snapshot mismatch) is shown with its details, and never rendered as a success result', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockOwnerGate(page);
    var calls = mockConsolidateEndpoint(page, [{
      status: 409,
      body: { ok: false, error: 'E10: snapshot_mismatch', details: [{ field: 'probeTokenBalance', expected: 1860, actual: 999 }] }
    }]);
    await seedOwnerAt(page, baseUrl);
    await page.waitForSelector('#admin-consolidate-submit');

    await page.fill('#admin-consolidate-password', 'realfounderpw1');
    await page.click('#admin-consolidate-submit');
    await page.waitForFunction(function () {
      var el = document.getElementById('admin-consolidate-error');
      return el && el.textContent && el.textContent.length > 0;
    });

    assert.equal(calls.length, 1);
    var errorText = await page.locator('#admin-consolidate-error').textContent();
    assert.ok(errorText.toLowerCase().indexOf('mismatch') !== -1 || errorText.toLowerCase().indexOf("don't match") !== -1);
    assert.ok(errorText.indexOf('probeTokenBalance') !== -1, 'the mismatch details must be shown, not just the bare error code');
    var resultVisible = await page.locator('#admin-consolidate-result').isVisible();
    assert.equal(resultVisible, false, 'the result box must not show a success-shaped render for an error response');
  } finally {
    await page.close();
  }
});
