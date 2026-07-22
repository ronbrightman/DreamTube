// test/tracker-comments-behavioral.test.js
//
// Real browser-driven coverage for tracker.html's comment-textarea/render()
// interaction. Regression test for a bug review caught: handleDoneChange,
// handlePriorityChange, and handleCommentSave all rebuild every item's HTML
// from scratch via render() -> sectionHTML() -> itemHTML(), and itemHTML()
// used to always seed each textarea from item.comment (the last *saved*
// value) -- so any unrelated action anywhere on the page (checking a done
// box, clicking a priority button, saving a *different* item's comment)
// silently wiped whatever unsaved text was sitting in someone else's open
// comment box, with zero warning. Fixed by snapshotting the live DOM value
// of every open comment textarea into an in-memory unsavedComments map
// immediately before every render() call, and having itemHTML() prefer that
// snapshot over item.comment when one exists.
//
// This is the first browser-level coverage tracker.html has ever had --
// test/tracker.test.js only covers the server side (get-tracker-items.js /
// update-tracker-item.js). Same Playwright-via-node:test convention as
// test/ui-behavioral.test.js (see that file's own header comment for why);
// see also CLAUDE.md's "No test framework is wired in..." section.

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

var ITEM_A = { id: 'task-a', category: 'task', title: 'Item A', detail: 'Detail A', priority: 'medium', done: false, comment: 'saved comment A' };
var ITEM_B = { id: 'task-b', category: 'task', title: 'Item B', detail: 'Detail B', priority: 'medium', done: false, comment: '' };

/**
 * Seeds a logged-in owner session (js/store.js localStorage state) and
 * mocks the three tracker endpoints tracker.html calls: admin-paywall-toggle
 * (owner check), get-tracker-items (seed data), update-tracker-item (the
 * actual write -- controllable per-test via updateBehavior).
 */
async function setUpTrackerPage(page, updateBehavior) {
  updateBehavior = updateBehavior || function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
  };

  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@owner', username: 'owner' };
    if (!state.accounts) state.accounts = {};
    state.accounts.owner = { password: 'testpass1', email: 'owner@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });

  await page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isOwner: true }) });
  });
  await page.route('**/.netlify/functions/get-tracker-items', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [ITEM_A, ITEM_B].map(function (i) { return Object.assign({}, i); }) }) });
  });
  await page.route('**/.netlify/functions/update-tracker-item', updateBehavior);

  await page.goto(baseUrl + '/tracker.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tracker-item[data-id="task-a"]', { timeout: 5000 });
}

/** Opens an item's <details> by clicking its title (avoids the checkbox/priority buttons, which stopPropagation their own clicks). */
async function openItem(page, id) {
  await page.click('.tracker-item[data-id="' + id + '"] .tracker-item-title');
  await page.waitForFunction(function (id) {
    var el = document.querySelector('.tracker-item[data-id="' + id + '"]');
    return el && el.open;
  }, id, { timeout: 5000 });
}

test('typing an unsaved draft in item A survives a done-change on a DIFFERENT item B (the reported cross-item data-loss bug)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    await openItem(page, 'task-a');
    var draft = 'unsaved note about A, never clicked save';
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', draft);

    // Trigger a done-change on the OTHER item (B) -- this is exactly the
    // render() path that used to wipe A's draft.
    await page.click('.tracker-item[data-id="task-b"] .tracker-check');

    // Give the optimistic render() (synchronous, but let a tick pass to be
    // safe) a moment, then confirm A's draft is untouched and A is still open.
    await page.waitForTimeout(50);
    var aStillOpen = await page.$eval('.tracker-item[data-id="task-a"]', function (el) { return el.open; });
    assert.equal(aStillOpen, true, "item A's <details> should still be open after B's done-change re-render");
    var aValue = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValue, draft, "item A's unsaved draft must survive a done-change triggered on a different item");

    // B's own done-change actually took effect (sanity check this wasn't a no-op).
    var bChecked = await page.$eval('.tracker-item[data-id="task-b"] .tracker-check', function (el) { return el.checked; });
    assert.equal(bChecked, true);
  } finally {
    await context.close();
  }
});

test('typing an unsaved draft in item A survives a priority-change on item A itself', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    await openItem(page, 'task-a');
    var draft = 'unsaved note, then I change my own priority';
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', draft);

    await page.click('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="high"]');
    await page.waitForTimeout(50);

    var aValue = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValue, draft, "item A's own unsaved draft must survive a priority-change on itself");
    var aPriorityActive = await page.$eval('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="high"]', function (el) { return el.classList.contains('active'); });
    assert.equal(aPriorityActive, true, 'the priority change itself should still have taken effect');
  } finally {
    await context.close();
  }
});

test('saving a comment successfully is not treated as a still-unsaved draft on the next render (no regression from the draft-preservation fix)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    await openItem(page, 'task-a');
    var saved = 'a genuinely saved comment';
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', saved);
    await page.click('.tracker-item[data-id="task-a"] .tracker-comment-save');
    await page.waitForTimeout(100);

    var aValue = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValue, saved, 'the saved comment should still show after its own re-render');

    // Now trigger an unrelated render() via item B -- the saved comment must
    // still be there (this is the scenario a naive always-treat-as-draft fix
    // would break: a stale draft snapshot overriding the real saved value).
    await page.click('.tracker-item[data-id="task-b"] .tracker-check');
    await page.waitForTimeout(50);
    var aValueAfter = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValueAfter, saved, 'a genuinely saved comment must survive an unrelated re-render too, unchanged');
  } finally {
    await context.close();
  }
});

test('a failed comment save still reverts to the previous value and toasts an error (already-correct behavior, unaffected by the draft-preservation fix)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page, function (route) { route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }); });

    await openItem(page, 'task-a');
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', 'this save is going to fail');
    await page.click('.tracker-item[data-id="task-a"] .tracker-comment-save');

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Couldn.t save/.test(t.textContent);
    }, null, { timeout: 5000 });

    var aValue = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValue, 'saved comment A', "a failed save must revert the textarea to the item's previous saved value, not keep the rejected edit");
  } finally {
    await context.close();
  }
});
