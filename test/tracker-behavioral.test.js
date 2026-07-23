// test/tracker-behavioral.test.js
//
// Real browser-driven regression coverage for tracker.html's handleDelete()
// fix: reverting a failed delete by item id/reference instead of an array
// index captured before the async round-trip (see
// netlify/functions/lib/tracker-store.js's addItem/deleteItem retry-loop
// fix and tracker.html's handleDelete for the fuller writeup — flagged in
// review of the add/delete-endpoints branch). Follows the same
// node:test + Playwright + static-file-server convention as
// test/ui-behavioral.test.js (this repo has no other browser-test
// convention — see that file's own header comment) and the same
// skip-if-unavailable guard, since Playwright/Chromium aren't guaranteed
// to be resolvable in every environment this suite runs in.
//
// The scenario under test is exactly the one review flagged as
// non-blocking-but-worth-fixing: item A's delete request is still in
// flight when a DIFFERENT item (B)'s delete completes first, changing
// `items`' shape out from under any index A's revert might have
// captured. With the old index-based revert, A's failure-triggered
// splice(idx, 0, removed) used a position computed before B was ever
// removed — reverting by id (this test's assertion) instead confirms A
// comes back and B stays gone regardless of that interleaving, with no
// duplication or loss either way.

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

var OWNER_EMAIL = 'owner@example.com';

var SEED_ITEMS = [
  { id: 'item-a', category: 'task', title: 'Item A', detail: 'Detail A.', priority: 'medium', done: false, comments: [], createdAt: null, doneAt: null, startedAt: null },
  { id: 'item-b', category: 'task', title: 'Item B', detail: 'Detail B.', priority: 'medium', done: false, comments: [], createdAt: null, doneAt: null, startedAt: null },
  { id: 'item-c', category: 'task', title: 'Item C', detail: 'Detail C.', priority: 'medium', done: false, comments: [], createdAt: null, doneAt: null, startedAt: null }
];

/** Seeds a logged-in owner account directly into js/store.js's localStorage state, then navigates to tracker.html — shortest path to a real, authenticated tracker.html render, same technique as ui-behavioral.test.js's seedResultPage. */
async function seedOwnerAndGoToTracker(page) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (email) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@owner', username: 'owner' };
    if (!state.accounts) state.accounts = {};
    state.accounts.owner = { password: 'ownerpass1', email: email };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, OWNER_EMAIL);

  await page.route('**/.netlify/functions/admin-paywall-toggle**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isOwner: true }) });
  });
  await page.route('**/.netlify/functions/get-tracker-items', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: SEED_ITEMS }) });
  });

  await page.goto(baseUrl + '/tracker.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tracker-content[style*="display: block"]', { timeout: 5000 });
}

test('a failed delete reverts by id, not a stale array index, even when a different item finishes deleting first', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    page.on('dialog', function (dialog) { dialog.accept(); });
    await seedOwnerAndGoToTracker(page);

    var releaseA = null;
    var aRequested = false;
    await page.route('**/.netlify/functions/delete-tracker-item', async function (route) {
      var body = JSON.parse(route.request().postData());
      if (body.id === 'item-a') {
        aRequested = true;
        // Held open until item B's delete has already resolved below —
        // this is what puts A's revert in flight *after* the array shape
        // has changed out from under any index captured earlier.
        await new Promise(function (resolve) { releaseA = resolve; });
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E: simulated_failure' }) });
      } else if (body.id === 'item-b') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: true, id: 'item-b' }) });
      } else {
        route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'E6: item_not_found' }) });
      }
    });

    // Start deleting A first (its request will hang until released below).
    await page.click('[data-id="item-a"] .tracker-delete-btn');
    await page.waitForFunction(function () {
      return document.querySelectorAll('[data-id="item-a"]').length === 0;
    }, { timeout: 5000 });

    await page.waitForFunction(function () { return true; });
    assert.ok(aRequested, 'delete-tracker-item must have been called for item A before B is deleted');

    // While A's delete is still in flight, delete B — this resolves
    // immediately and changes `items`' shape before A's own revert runs.
    await page.click('[data-id="item-b"] .tracker-delete-btn');
    await page.waitForFunction(function () {
      return document.querySelectorAll('[data-id="item-b"]').length === 0;
    }, { timeout: 5000 });

    // Now let A's (already in-flight) request fail, triggering its revert.
    releaseA();
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, { timeout: 5000 });

    // A must be back (reverted), B must stay gone (its own delete really
    // succeeded), and C must be entirely untouched — no duplication, no
    // loss, regardless of the interleaving above.
    await page.waitForSelector('[data-id="item-a"]', { timeout: 5000 });
    var idsAfter = await page.$$eval('.tracker-item', function (els) {
      return els.map(function (el) { return el.dataset.id; });
    });
    assert.deepEqual(idsAfter.sort(), ['item-a', 'item-c'], 'A must be reverted back in, B must stay deleted, C must be untouched, with no duplicates');
  } finally {
    await context.close();
  }
});
