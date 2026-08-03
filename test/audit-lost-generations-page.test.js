// test/audit-lost-generations-page.test.js
//
// Real browser coverage for audit-x7q4.html (the owner-only one-tap runner
// for admin-diagnose-lost-generations.js, tracker item
// for-product-p0-data-loss-founder-repro-0-6bzvv1). The diagnostic
// ENDPOINT's own hasDream/lostJobs logic is covered at the handler level
// (test/admin-diagnose-lost-generations.test.js) — this file proves the
// PAGE renders that response correctly, specifically regression-pinning
// the bug fixed in this same change: the page used to dump the sweep's
// full-window `details` array (both hasDream:true AND hasDream:false rows)
// into a single pane labeled just "Details", directly under the "Lost
// jobs" stat — which reads exactly like a list of lost jobs and produced
// this tracker item's own reported anomaly ("a hasDream:true row appearing
// in the lost list"). Playwright resolution/skip convention and static-
// server pattern mirror test/postpack-page.test.js closely.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };

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

// Mirrors the exact `details` row shape admin-diagnose-lost-generations.js's
// runSweepMode produces (see that file) -- a mix of lost, found, and
// unresolved rows, plus both mediaTypes among the lost ones, so a single
// mocked sweep response exercises every bucket the page must separate.
var SWEEP_RESPONSE = {
  ok: true, mode: 'sweep', sinceTimestamp: Date.now() - 86400000,
  jobsInWindow: 5, lostJobs: 3, accountsAffected: 2, accountsUnresolved: 1,
  scannedJobOwnerKeys: 5, totalJobOwnerKeys: 5, nextCursor: null, done: true,
  details: [
    { operationName: 'op-lost-video', email: 'a@example.com', username: 'alice', createdAt: Date.now(), mediaType: 'video', accountResolved: true, hasDream: false, dreamId: null },
    { operationName: 'op-lost-image', email: 'a@example.com', username: 'alice', createdAt: Date.now(), mediaType: 'image', accountResolved: true, hasDream: false, dreamId: null },
    { operationName: 'op-lost-video-2', email: 'b@example.com', username: 'bob', createdAt: Date.now(), mediaType: 'video', accountResolved: true, hasDream: false, dreamId: null },
    { operationName: 'op-found', email: 'b@example.com', username: 'bob', createdAt: Date.now(), mediaType: 'video', accountResolved: true, hasDream: true, dreamId: 'dream-1' },
    { operationName: 'op-orphaned', email: 'deleted@example.com', createdAt: Date.now(), mediaType: 'video', accountResolved: false, hasDream: null }
  ]
};

function mockSweepEndpoint(page, response) {
  return page.route('**/.netlify/functions/admin-diagnose-lost-generations', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

test('a hasDream:true row is never shown in the lost-jobs pane, and the lost/found/unresolved counts add up correctly (regression pin for the reported hasDream:true-yet-listed-as-lost anomaly)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockSweepEndpoint(page, SWEEP_RESPONSE);
  await safeGoto(page, baseUrl + '/audit-x7q4.html');

  await page.fill('#pw', 'realownerpassword');
  await page.click('#run');
  await page.waitForSelector('#out.show', { timeout: 5000 });

  var lostText = await page.locator('#details-lost').textContent();
  var lostJson = JSON.parse(lostText);
  assert.equal(lostJson.length, 3, 'exactly the 3 hasDream:false, account-resolved rows');
  assert.ok(lostJson.every(function (r) { return r.hasDream === false; }), 'no hasDream:true row may ever appear in the lost-jobs pane');

  var foundText = await page.locator('#details-found').textContent();
  var foundJson = JSON.parse(foundText);
  assert.equal(foundJson.length, 1);
  assert.equal(foundJson[0].operationName, 'op-found');
  assert.equal(foundJson[0].hasDream, true, 'the found bucket is exactly where a hasDream:true row belongs, clearly separated and labeled "NOT part of the lost count"');

  var unresolvedText = await page.locator('#details-unresolved').textContent();
  var unresolvedJson = JSON.parse(unresolvedText);
  assert.equal(unresolvedJson.length, 1);
  assert.equal(unresolvedJson[0].operationName, 'op-orphaned');

  var lostStat = await page.locator('#lost').textContent();
  assert.equal(lostStat.trim(), '3');
  var lostVideo = await page.locator('#lost-video').textContent();
  assert.equal(lostVideo.trim(), '2');
  var lostImage = await page.locator('#lost-image').textContent();
  assert.equal(lostImage.trim(), '1');

  await page.close();
});

test('an empty lost bucket renders "(none)" rather than an empty string, and the verdict shows the all-clear message', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockSweepEndpoint(page, {
    ok: true, mode: 'sweep', sinceTimestamp: Date.now() - 86400000,
    jobsInWindow: 1, lostJobs: 0, accountsAffected: 0, accountsUnresolved: 0,
    scannedJobOwnerKeys: 1, totalJobOwnerKeys: 1, nextCursor: null, done: true,
    details: [{ operationName: 'op-ok', email: 'a@example.com', username: 'alice', createdAt: Date.now(), mediaType: 'video', accountResolved: true, hasDream: true, dreamId: 'dream-1' }]
  });
  await safeGoto(page, baseUrl + '/audit-x7q4.html');

  await page.fill('#pw', 'realownerpassword');
  await page.click('#run');
  await page.waitForSelector('#out.show', { timeout: 5000 });

  var lostText = await page.locator('#details-lost').textContent();
  assert.equal(lostText.trim(), '(none)');
  var verdict = await page.locator('#verdict').textContent();
  assert.match(verdict, /No user has a lost dream/);
  await page.close();
});

test('a wrong password (E5 from the real endpoint) shows an inline error and never reveals the results panel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await page.route('**/.netlify/functions/admin-diagnose-lost-generations', function (route) {
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) });
  });
  await safeGoto(page, baseUrl + '/audit-x7q4.html');

  await page.fill('#pw', 'wrongpassword');
  await page.click('#run');
  await page.waitForSelector('#err:not(:empty)', { timeout: 5000 });
  var outVisible = await page.isVisible('#out.show');
  assert.equal(outVisible, false);
  await page.close();
});
