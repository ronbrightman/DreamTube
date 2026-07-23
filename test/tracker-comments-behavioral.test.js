// test/tracker-comments-behavioral.test.js
//
// Real browser-driven coverage for tracker.html's async, per-item controls:
// the two comment compose areas ("Your comment"/"Claude's comment"), the
// done button, the priority buttons, the one-way start button, the single
// combined Done section, and the add-item form — specifically the
// render()-triggered draft-preservation and per-id request-sequencing bug
// class this page has hit repeatedly (see git history: six review rounds
// on the earlier comment-field design, plus a seventh gap found in
// handleAddSubmit once it was merged alongside that work).
//
// SCHEMA CHANGE this file was rewritten for: the single overwritable
// `comment: string` field became an append-only `comments: [{ id, author,
// text, timestamp }]` list (see tracker-store.js's own SCHEMA CHANGE
// comment for the full reasoning). That removed an entire prior bug
// class this file used to cover in detail — "does a failed/overlapping
// comment SAVE correctly revert to a server-confirmed value instead of a
// stale in-flight one" — because appending a new, uniquely-id'd entry can
// never silently clobber another append the way overwriting one shared
// field could; there's nothing to revert client-side (a failed save
// simply never appends anything, and leaves the compose box exactly as
// typed). What this file keeps/still needs to cover for comments is
// narrower: the compose boxes' DRAFT text still needs the exact same
// cross-item/cross-render preservation as every other free-text input on
// this page, and a save that succeeds needs to give real visible
// feedback (this was Ron's own bug report: "I click Save and nothing
// happens").
//
// The done/priority overlapping-same-id-request sequencing bug class is
// UNCHANGED by that schema work and still fully applies — those tests are
// kept (adapted only for the done control's new button markup, see
// below), plus a new equivalent set for the start button, which is new
// async per-item UI built the same way (optimistic mutate -> render() ->
// postUpdate().catch(revert), with the same seqMap/Confirmed-map
// discipline) and needs the same coverage per this repo's own build
// instructions for any new async control on this page.
//
// The done control itself changed from a bare `<input type="checkbox"
// class="tracker-check">` to a labeled `<button class="tracker-done-btn">`
// (Ron's own feedback: "Maybe mark the button more clearly as a Done
// button") — tests that used to read `.checked` now read the `is-done`
// class / `aria-pressed` attribute instead, and still use `$eval(...).
// click()` rather than `page.click()` once an item is done and has moved
// into the (possibly still-collapsed) combined Done section, exactly like
// the original tests already had to for the old checkbox once it moved
// into a collapsed per-category Done section.
//
// Same Playwright-via-node:test convention as test/ui-behavioral.test.js
// (see that file's own header comment for why); see also CLAUDE.md's "No
// test framework is wired in..." section.

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

var ITEM_A = {
  id: 'task-a', category: 'task', title: 'Item A', detail: 'Detail A', priority: 'medium', done: false,
  comments: [{ id: 'c-existing-1', author: 'ron', text: 'an existing saved comment', timestamp: '2026-01-01T00:00:00.000Z' }],
  createdAt: '2026-01-01T00:00:00.000Z', doneAt: null, startedAt: null
};
var ITEM_B = {
  id: 'task-b', category: 'task', title: 'Item B', detail: 'Detail B', priority: 'medium', done: false,
  comments: [], createdAt: null, doneAt: null, startedAt: null
};
var DEFAULT_SEED = [ITEM_A, ITEM_B];

/**
 * A realistic stand-in for update-tracker-item.js's own success response:
 * merges whatever the request patched into the matching seed item (by id),
 * deriving doneAt/startedAt/comments the same way tracker-store.js's real
 * updateItem() does. Used as the default mocked update-tracker-item
 * behavior for tests that aren't specifically about injecting a
 * failure/delay — without this, a lazy `{ item: {} }` stand-in (the old
 * file's default, back when handlers ignored the resolved value entirely)
 * would make THIS page's handlers, which now read `data.item.doneAt` /
 * `data.item.startedAt` / `data.item.comments` off a successful response,
 * silently adopt `undefined` for those fields.
 */
function makeDefaultUpdateBehavior(seedItems) {
  var byId = {};
  seedItems.forEach(function (i) { byId[i.id] = i; });
  return function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    var base = byId[body.id] || {};
    var next = Object.assign({}, base);
    if (Object.prototype.hasOwnProperty.call(body, 'priority')) next.priority = body.priority;
    if (Object.prototype.hasOwnProperty.call(body, 'done')) {
      next.done = body.done;
      next.doneAt = body.done ? (base.done ? base.doneAt : new Date().toISOString()) : null;
    }
    if (body.started === true && !base.startedAt) {
      next.startedAt = new Date().toISOString();
    }
    if (Object.prototype.hasOwnProperty.call(body, 'comment')) {
      next.comments = (base.comments || []).concat([{
        id: 'c-' + Math.random().toString(36).slice(2, 8),
        author: body.commentAuthor,
        text: body.comment,
        timestamp: new Date().toISOString()
      }]);
    }
    byId[body.id] = next; // so a later request in the same test sees this one's effect
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: next }) });
  };
}

/**
 * Seeds a logged-in owner session (js/store.js localStorage state) and
 * mocks the three tracker endpoints tracker.html calls: admin-paywall-toggle
 * (owner check), get-tracker-items (seed data), update-tracker-item (the
 * actual write -- controllable per-test via updateBehavior).
 */
async function setUpTrackerPage(page, updateBehavior, seedItems) {
  seedItems = seedItems || DEFAULT_SEED;
  updateBehavior = updateBehavior || makeDefaultUpdateBehavior(seedItems);

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: seedItems.map(function (i) { return Object.assign({}, i); }) }) });
  });
  await page.route('**/.netlify/functions/update-tracker-item', updateBehavior);

  await page.goto(baseUrl + '/tracker.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tracker-item[data-id="' + seedItems[0].id + '"]', { timeout: 5000 });
}

/** Opens an item's <details> by clicking its title (avoids the done/priority buttons, which stopPropagation their own clicks). */
async function openItem(page, id) {
  await page.click('.tracker-item[data-id="' + id + '"] .tracker-item-title');
  await page.waitForFunction(function (id) {
    var el = document.querySelector('.tracker-item[data-id="' + id + '"]');
    return el && el.open;
  }, id, { timeout: 5000 });
}

function commentInputSelector(id, author) {
  return '.tracker-item[data-id="' + id + '"] .tracker-comment-compose[data-author="' + author + '"] .tracker-comment-input';
}
function commentSaveSelector(id, author) {
  return '.tracker-item[data-id="' + id + '"] .tracker-comment-compose[data-author="' + author + '"] .tracker-comment-save';
}

// ===== Draft preservation across unrelated renders =====

test('typing an unsaved draft in item A\'s "Your comment" box survives a done-change on a DIFFERENT item B', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    await openItem(page, 'task-a');
    var draft = 'unsaved note about A, never clicked save';
    await page.fill(commentInputSelector('task-a', 'ron'), draft);

    // Trigger a done-change on the OTHER item (B) -- this is exactly the
    // render() path that used to wipe A's draft under the old single-
    // comment-field design, and the same risk applies to the new compose
    // boxes if captureDrafts() were ever dropped from handleDoneChange.
    await page.click('.tracker-item[data-id="task-b"] .tracker-done-btn');

    await page.waitForTimeout(50);
    var aStillOpen = await page.$eval('.tracker-item[data-id="task-a"]', function (el) { return el.open; });
    assert.equal(aStillOpen, true, "item A's <details> should still be open after B's done-change re-render");
    var aValue = await page.$eval(commentInputSelector('task-a', 'ron'), function (el) { return el.value; });
    assert.equal(aValue, draft, "item A's unsaved draft must survive a done-change triggered on a different item");

    // B's own done-change actually took effect (sanity check this wasn't a no-op).
    var bIsDone = await page.$eval('.tracker-item[data-id="task-b"] .tracker-done-btn', function (el) { return el.classList.contains('is-done'); });
    assert.equal(bIsDone, true);
  } finally {
    await context.close();
  }
});

test('drafts in BOTH compose boxes ("Your comment" and "Claude\'s comment") on item A survive a start-change on item A itself', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    await openItem(page, 'task-a');
    var ronDraft = "Ron's unsaved note";
    var claudeDraft = "Claude's unsaved note";
    await page.fill(commentInputSelector('task-a', 'ron'), ronDraft);
    await page.fill(commentInputSelector('task-a', 'claude'), claudeDraft);

    await page.click('.tracker-item[data-id="task-a"] .tracker-start-btn');
    await page.waitForTimeout(50);

    var ronValue = await page.$eval(commentInputSelector('task-a', 'ron'), function (el) { return el.value; });
    var claudeValue = await page.$eval(commentInputSelector('task-a', 'claude'), function (el) { return el.value; });
    assert.equal(ronValue, ronDraft, "Ron's own unsaved draft must survive a start-change on the same item");
    assert.equal(claudeValue, claudeDraft, "Claude's own unsaved draft must survive a start-change on the same item");

    var metaText = await page.$eval('.tracker-item[data-id="task-a"] .tracker-item-meta', function (el) { return el.textContent; });
    assert.match(metaText, /Started/, 'the start-change itself should still have taken effect');
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
    await page.fill(commentInputSelector('task-a', 'ron'), draft);

    await page.click('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="high"]');
    await page.waitForTimeout(50);

    var aValue = await page.$eval(commentInputSelector('task-a', 'ron'), function (el) { return el.value; });
    assert.equal(aValue, draft, "item A's own unsaved draft must survive a priority-change on itself");
    var aPriorityActive = await page.$eval('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="high"]', function (el) { return el.classList.contains('active'); });
    assert.equal(aPriorityActive, true, 'the priority change itself should still have taken effect');
  } finally {
    await context.close();
  }
});

// ===== Comment save: visible feedback, append-only semantics =====
//
// Directly covers Ron's own bug report: "I see that in the comments
// section you wrote a comment for one of the items but the button - Save
// comment - still shows as if this was not saved and when I click Save
// nothing happens." The fix has three visible parts, all covered below:
// the button disables + shows "Saving…" the instant it's clicked, the new
// entry appears in the read-only comment list the moment the save
// actually lands, and a toast confirms it either way.

test('saving a comment shows immediate "Saving…" feedback, then appends the entry and shows a confirmation toast', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var resolveSave = null;
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      // Hold the response open until the test explicitly releases it, so
      // the "Saving…" intermediate state is actually observable.
      var releaseIt = new Promise(function (resolve) { resolveSave = resolve; });
      releaseIt.then(function () {
        route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ item: Object.assign({}, ITEM_A, { comments: ITEM_A.comments.concat([{ id: 'c-new-1', author: body.commentAuthor, text: body.comment, timestamp: '2026-02-01T00:00:00.000Z' }]) }) })
        });
      });
    });

    await openItem(page, 'task-a');
    await page.fill(commentInputSelector('task-a', 'ron'), 'a brand new note from Ron');
    await page.click(commentSaveSelector('task-a', 'ron'));

    // Immediate feedback: the button disables and relabels while the
    // request is still out -- this is the part that was previously
    // entirely missing.
    await page.waitForFunction(function (sel) {
      var el = document.querySelector(sel);
      return el && el.disabled && /Saving/.test(el.textContent);
    }, commentSaveSelector('task-a', 'ron'), { timeout: 5000 });

    resolveSave();

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Comment saved/.test(t.textContent);
    }, null, { timeout: 5000 });

    var entries = await page.$$eval('.tracker-item[data-id="task-a"] .tracker-comment-entry .tracker-comment-text', function (els) { return els.map(function (e) { return e.textContent; }); });
    assert.ok(entries.indexOf('a brand new note from Ron') !== -1, 'the newly saved comment must appear in the read-only comment list');
    assert.ok(entries.indexOf('an existing saved comment') !== -1, 'the pre-existing comment must still be there too -- this is an append, not a replace');

    var boxValue = await page.$eval(commentInputSelector('task-a', 'ron'), function (el) { return el.value; });
    assert.equal(boxValue, '', 'the compose box should clear itself once its own save actually lands');
  } finally {
    await context.close();
  }
});

test('a saved comment surviving an unrelated re-render does not resurrect as a stale draft in the now-empty compose box', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    await openItem(page, 'task-a');
    await page.fill(commentInputSelector('task-a', 'ron'), 'a genuinely saved comment');
    await page.click(commentSaveSelector('task-a', 'ron'));
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Comment saved/.test(t.textContent);
    }, null, { timeout: 5000 });

    var boxValue = await page.$eval(commentInputSelector('task-a', 'ron'), function (el) { return el.value; });
    assert.equal(boxValue, '', 'the box should be empty right after its own successful save');

    // Now trigger an unrelated render() via item B -- a naive
    // always-treat-as-draft implementation could make the now-cleared box
    // reappear with the old text (the exact regression class this page
    // has hit before, just inverted: previously an unrelated render wiped
    // a real draft; here it must not resurrect a stale one).
    await page.click('.tracker-item[data-id="task-b"] .tracker-done-btn');
    await page.waitForTimeout(50);
    var boxValueAfter = await page.$eval(commentInputSelector('task-a', 'ron'), function (el) { return el.value; });
    assert.equal(boxValueAfter, '', 'the cleared compose box must stay empty across an unrelated re-render, not resurrect the just-saved text as a stale draft');
  } finally {
    await context.close();
  }
});

test('a failed comment save leaves the typed text in the box untouched, appends nothing, and shows an error toast', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page, function (route) { route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }); });

    await openItem(page, 'task-a');
    await page.fill(commentInputSelector('task-a', 'ron'), 'this save is going to fail');
    await page.click(commentSaveSelector('task-a', 'ron'));

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Couldn.t save comment/.test(t.textContent);
    }, null, { timeout: 5000 });

    var boxValue = await page.$eval(commentInputSelector('task-a', 'ron'), function (el) { return el.value; });
    assert.equal(boxValue, 'this save is going to fail', "a failed save must leave the typed text exactly as the user left it -- there's nothing to revert to since nothing was ever optimistically appended");

    var entries = await page.$$eval('.tracker-item[data-id="task-a"] .tracker-comment-entry .tracker-comment-text', function (els) { return els.map(function (e) { return e.textContent; }); });
    assert.equal(entries.length, 1, 'a failed save must not append anything -- only the pre-existing seeded comment should be there');
    assert.equal(entries[0], 'an existing saved comment');
  } finally {
    await context.close();
  }
});

test('clicking Save twice in quick succession only fires one request (the in-flight guard prevents a duplicate submission)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var requestCount = 0;
    await setUpTrackerPage(page, function (route) {
      requestCount++;
      setTimeout(function () {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_A, { comments: ITEM_A.comments.concat([{ id: 'c-once', author: 'ron', text: 'only once', timestamp: '2026-02-01T00:00:00.000Z' }]) }) }) });
      }, 200);
    });

    await openItem(page, 'task-a');
    await page.fill(commentInputSelector('task-a', 'ron'), 'only once');
    await page.click(commentSaveSelector('task-a', 'ron'));
    // The button is disabled synchronously on the first click's render(),
    // so this second click lands on a disabled button and must not fire a
    // second POST.
    await page.click(commentSaveSelector('task-a', 'ron'), { force: true });

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Comment saved/.test(t.textContent);
    }, null, { timeout: 5000 });

    assert.equal(requestCount, 1, 'a double-click on Save must only ever result in one update-tracker-item request');
  } finally {
    await context.close();
  }
});

test('Ron\'s and Claude\'s comment areas on the same item save independently -- both entries persist without either clobbering the other', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    await openItem(page, 'task-b');
    await page.fill(commentInputSelector('task-b', 'ron'), "Ron's note");
    await page.click(commentSaveSelector('task-b', 'ron'));
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Comment saved/.test(t.textContent);
    }, null, { timeout: 5000 });

    await page.fill(commentInputSelector('task-b', 'claude'), "Claude's note");
    await page.click(commentSaveSelector('task-b', 'claude'));
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Comment saved/.test(t.textContent);
    }, null, { timeout: 5000 });

    var authors = await page.$$eval('.tracker-item[data-id="task-b"] .tracker-comment-author', function (els) { return els.map(function (e) { return e.textContent; }); });
    var texts = await page.$$eval('.tracker-item[data-id="task-b"] .tracker-comment-text', function (els) { return els.map(function (e) { return e.textContent; }); });
    assert.deepEqual(authors, ['Ron', 'Claude'], 'both authors\' entries must show, in the order they were saved');
    assert.deepEqual(texts, ["Ron's note", "Claude's note"], "neither author's comment overwrote the other's");
  } finally {
    await context.close();
  }
});

// ===== Start button: one-way "start working on this" signal =====

test('clicking "Start working on this" replaces the button with a Started timestamp, and a failed start reverts it back', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var startCount = 0;
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.started) {
        startCount++;
        if (startCount === 1) {
          route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
        } else {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_B, { startedAt: '2026-03-01T00:00:00.000Z' }) }) });
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_B) }) });
      }
    });

    await openItem(page, 'task-b');
    await page.click('.tracker-item[data-id="task-b"] .tracker-start-btn');

    // First attempt fails -- the button must come back (nothing persisted).
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Couldn.t start/.test(t.textContent);
    }, null, { timeout: 5000 });
    var startBtnBack = await page.$('.tracker-item[data-id="task-b"] .tracker-start-btn');
    assert.ok(startBtnBack, 'a failed start must revert -- the "Start working on this" button must reappear');

    // Second attempt succeeds.
    await page.click('.tracker-item[data-id="task-b"] .tracker-start-btn');
    await page.waitForFunction(function () {
      var el = document.querySelector('.tracker-item[data-id="task-b"] .tracker-item-meta');
      return el && /Started/.test(el.textContent);
    }, null, { timeout: 5000 });
    var startBtnGone = await page.$('.tracker-item[data-id="task-b"] .tracker-start-btn');
    assert.equal(startBtnGone, null, 'once started, the button must be gone -- there is no "un-start" control');
  } finally {
    await context.close();
  }
});

// A genuine SAME-id "older request succeeds after a newer same-id request
// has already succeeded, don't clobber Confirmed[id] with the stale
// value" race (the exact second variant done/priority get below) is NOT
// reachable for handleStartChange, unlike done/priority -- checked by
// hand rather than assumed. handleStartChange's very first line is `if
// (!item || item.startedAt) return;`, and the optimistic
// `item.startedAt = ...` write happens SYNCHRONOUSLY, before the network
// call is even issued and before control ever returns to the browser's
// event loop. So there is no window in which a second click (or a second
// direct call) can see `item.startedAt` still falsy while a first
// request for the same id is in flight -- every subsequent click before
// the first request resolves is a same-tick no-op, and once the first
// request resolves (success OR failure-then-revert), only ONE request
// can ever be in flight for a given id at a time. done/priority have no
// equivalent single-flight guard (an item can toggle done true/false, or
// priority high/medium/low, repeatedly, each toggle firing a fresh
// request regardless of what's already in flight), which is exactly what
// makes their two-request overlap reachable and worth testing. This is a
// real, deliberate difference in handleStartChange's design (a one-way
// signal only ever needs to fire once), not a coverage gap to fake a test
// around.
//
// The closest genuinely reachable, meaningful concurrency test for start
// is per-id isolation: two DIFFERENT items' start-clicks with requests
// racing each other (one slow, one fast) must not cross-contaminate one
// another's startChangeSeq/startedAtConfirmed state -- confirms the maps
// are correctly keyed per-id rather than accidentally shared.
test('starting two DIFFERENT items concurrently (one slow, one fast) does not cross-contaminate either item\'s started state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var resolveSlow = null;
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'task-a') {
        // Held open until after task-b's (fast) start has already landed.
        new Promise(function (resolve) { resolveSlow = resolve; }).then(function () {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_A, { startedAt: '2026-03-01T00:00:00.000Z' }) }) });
        });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_B, { startedAt: '2026-03-02T00:00:00.000Z' }) }) });
      }
    });

    // Both items' <details> start closed -- the start button lives in the
    // collapsible body, same as the comment compose areas, so each needs
    // opening first (same as every other test here that reaches into an
    // item's body).
    await openItem(page, 'task-a');
    await openItem(page, 'task-b');

    await page.click('.tracker-item[data-id="task-a"] .tracker-start-btn'); // slow, still pending
    await page.click('.tracker-item[data-id="task-b"] .tracker-start-btn'); // fast, resolves immediately

    await page.waitForFunction(function () {
      var el = document.querySelector('.tracker-item[data-id="task-b"] .tracker-item-meta');
      return el && /Started/.test(el.textContent);
    }, null, { timeout: 5000 });

    // task-a's request is still in flight -- its own optimistic Started
    // state must already be showing (set synchronously on click), and
    // must not have been affected by task-b's unrelated request landing.
    var aMetaMidway = await page.$eval('.tracker-item[data-id="task-a"] .tracker-item-meta', function (el) { return el.textContent; });
    assert.match(aMetaMidway, /Started/, "task-a's own optimistic started state must show while its request is still in flight, unaffected by task-b's already-landed request");

    resolveSlow();
    await page.waitForFunction(function () {
      var el = document.querySelector('.tracker-item[data-id="task-a"] .tracker-item-meta');
      return el && /Started/.test(el.textContent);
    }, null, { timeout: 5000 });

    var aStartBtnGone = await page.$('.tracker-item[data-id="task-a"] .tracker-start-btn');
    var bStartBtnGone = await page.$('.tracker-item[data-id="task-b"] .tracker-start-btn');
    assert.equal(aStartBtnGone, null, 'task-a must end up started once its own (slower) request lands');
    assert.equal(bStartBtnGone, null, 'task-b must stay started -- unaffected by task-a\'s later-landing request');
  } finally {
    await context.close();
  }
});

// ===== Overlapping same-id request races: done-toggle, priority-change =====
//
// Unchanged bug class from before the comment schema change -- the
// seqMap/Confirmed-map guard is identical for done/priority, only the
// done control's markup changed (button instead of checkbox).

test("an older done-toggle request for item A that fails AFTER a newer done-toggle request for the SAME item has already succeeded must not revert past the newer state", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var taskADoneCount = 0;
    var resolveOlderRequestSeen = null;
    var olderRequestSeen = new Promise(function (resolve) { resolveOlderRequestSeen = resolve; });

    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'task-a') {
        taskADoneCount++;
        if (taskADoneCount === 1) {
          resolveOlderRequestSeen();
          setTimeout(function () {
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
          }, 300);
        } else {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_A, { done: false, doneAt: null }) }) });
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_B) }) });
      }
    });

    // Item A starts not-done. First click marks it done (the older, slow-
    // to-fail request). Uses $eval(...).click() rather than page.click(),
    // because once done it moves into the (collapsed-by-default) combined
    // Done section -- Playwright's normal click() waits for visibility,
    // which a collapsed <details> deliberately doesn't have; calling the
    // native .click() method directly bypasses that.
    await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { el.click(); });

    await olderRequestSeen;
    // Second click marks it not-done again -- the newer request for the SAME id.
    await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { el.click(); });

    await page.waitForTimeout(100);
    var isDoneMidway = await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { return el.classList.contains('is-done'); });
    assert.equal(isDoneMidway, false, 'the newer (not-done) state should already be showing, well before the older request has even failed yet');

    await page.waitForTimeout(350);

    var isDoneFinal = await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { return el.classList.contains('is-done'); });
    assert.equal(isDoneFinal, false, "the older request's failure-revert must not overwrite the newer request's already-landed success");

    var toastShown = await page.$eval('#toast', function (el) { return el.classList.contains('show'); });
    assert.equal(toastShown, false, "the suppressed older-request revert must not surface a \"couldn't save\" toast either");
  } finally {
    await context.close();
  }
});

test("an older priority-change request for item A that fails AFTER a newer priority-change request for the SAME item has already succeeded must not revert past the newer state", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var taskAPriorityCount = 0;
    var resolveOlderRequestSeen = null;
    var olderRequestSeen = new Promise(function (resolve) { resolveOlderRequestSeen = resolve; });

    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'task-a') {
        taskAPriorityCount++;
        if (taskAPriorityCount === 1) {
          resolveOlderRequestSeen();
          setTimeout(function () {
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
          }, 300);
        } else {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_A) }) });
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_B) }) });
      }
    });

    await page.click('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="high"]');

    await olderRequestSeen;
    await page.click('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="low"]');

    await page.waitForTimeout(100);
    var lowActiveMidway = await page.$eval('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="low"]', function (el) { return el.classList.contains('active'); });
    assert.equal(lowActiveMidway, true, 'the newer ("low") priority should already be showing, well before the older request has even failed yet');

    await page.waitForTimeout(350);

    var lowActiveFinal = await page.$eval('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="low"]', function (el) { return el.classList.contains('active'); });
    assert.equal(lowActiveFinal, true, "the older request's failure-revert must not overwrite the newer request's already-landed success");
    var highActiveFinal = await page.$eval('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="high"]', function (el) { return el.classList.contains('active'); });
    assert.equal(highActiveFinal, false, 'the stale older request must not resurrect the intermediate "high" state either');

    var toastShown = await page.$eval('#toast', function (el) { return el.classList.contains('show'); });
    assert.equal(toastShown, false, "the suppressed older-request revert must not surface a \"couldn't save\" toast either");
  } finally {
    await context.close();
  }
});

test("an older done-toggle request for item A that SUCCEEDS after a newer done-toggle request for the SAME item has already succeeded must not clobber doneConfirmed with the stale older value", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var taskADoneCount = 0;
    var resolveOlderRequestSeen = null;
    var olderRequestSeen = new Promise(function (resolve) { resolveOlderRequestSeen = resolve; });

    // Request 1 (older, done: true) succeeds only after a long delay.
    // Request 2 (newer, done: false) fires while request 1 is still in
    // flight and succeeds immediately. A THIRD request (done: true) fires
    // only once both of the above have resolved, and is made to FAIL --
    // its revert is the only way to observe which value doneConfirmed[id]
    // actually holds, since a successful .then never itself calls render().
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'task-a') {
        taskADoneCount++;
        if (taskADoneCount === 1) {
          resolveOlderRequestSeen();
          setTimeout(function () {
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_A, { done: true, doneAt: '2026-02-01T00:00:00.000Z' }) }) });
          }, 300);
        } else if (taskADoneCount === 2) {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_A, { done: false, doneAt: null }) }) });
        } else {
          route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_B) }) });
      }
    });

    await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { el.click(); });

    await olderRequestSeen;
    await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { el.click(); });

    await page.waitForTimeout(100);
    await page.waitForTimeout(350);

    // Re-click a third time (done: true) -- this request FAILS, and its
    // catch reverts to doneConfirmed[id]. Correct: reverts to not-done
    // (the newer request's confirmed value). Buggy: reverts to done (the
    // older request's stale, later-landing success).
    await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { el.click(); });

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Couldn.t save/.test(t.textContent);
    }, null, { timeout: 5000 });

    var isDoneFinal = await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { return el.classList.contains('is-done'); });
    assert.equal(isDoneFinal, false, "the third request's failure-revert must land on the newer request's confirmed value (not done), not the older request's stale later-landing success (done)");
  } finally {
    await context.close();
  }
});

// ===== ONE combined Done section, spanning Tasks + Ideas =====

test('marking a task and an idea both done puts them in ONE combined Done section, collapsed by default, with category badges', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var IDEA = { id: 'idea-c', category: 'idea', title: 'Item C (idea)', detail: 'Detail C', priority: 'medium', done: false, comments: [], createdAt: null, doneAt: null, startedAt: null };
    var seed = [ITEM_A, ITEM_B, IDEA];
    await setUpTrackerPage(page, makeDefaultUpdateBehavior(seed), seed);

    var doneSectionInitial = await page.$('#tracker-done-details');
    assert.equal(doneSectionInitial, null, 'with nothing done yet, the combined Done section must not render at all');

    await page.$eval('.tracker-item[data-id="task-a"] .tracker-done-btn', function (el) { el.click(); });
    await page.waitForSelector('#tracker-done-details', { timeout: 5000 });

    var openBeforeExpand = await page.$eval('#tracker-done-details', function (el) { return el.open; });
    assert.equal(openBeforeExpand, false, 'the combined Done section must start collapsed, even once it has content');

    await page.$eval('.tracker-item[data-id="idea-c"] .tracker-done-btn', function (el) { el.click(); });
    await page.waitForFunction(function () {
      var el = document.querySelector('.tracker-done-summary');
      return el && /Done \(2\)/.test(el.textContent);
    }, null, { timeout: 5000 });

    // Exactly one combined Done section for the whole page, not one per
    // category.
    var doneDetailsCount = await page.$$eval('.tracker-done-details', function (els) { return els.length; });
    assert.equal(doneDetailsCount, 1, 'there must be exactly ONE Done section spanning both categories, not a separate one per category');

    await page.click('.tracker-done-summary');
    await page.waitForFunction(function () {
      var el = document.querySelector('#tracker-done-details');
      return el && el.open;
    }, null, { timeout: 5000 });

    var idsInDone = await page.$$eval('.tracker-done-list .tracker-item', function (els) { return els.map(function (e) { return e.dataset.id; }); });
    assert.deepEqual(idsInDone.sort(), ['idea-c', 'task-a'], 'both the done task and the done idea must be inside the same combined list');

    var badges = await page.$$eval('.tracker-done-list .tracker-category-badge', function (els) { return els.map(function (e) { return e.textContent; }); });
    assert.deepEqual(badges.sort(), ['Idea', 'Task'], 'each item in the combined section must show which category it came from');
  } finally {
    await context.close();
  }
});

// ===== handleAddSubmit gaps (draft preservation + Confirmed-map seeding) =====

test("typing an unsaved draft in item A survives successfully adding a new item via the add-item form", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var CREATED = { id: 'task-new-1', category: 'task', title: 'Brand new item', detail: 'New detail.', priority: 'medium', done: false, comments: [], createdAt: '2026-04-01T00:00:00.000Z', doneAt: null, startedAt: null };
    await page.route('**/.netlify/functions/add-tracker-item', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: CREATED }) });
    });

    await openItem(page, 'task-a');
    var draft = 'unsaved note about A, never clicked save';
    await page.fill(commentInputSelector('task-a', 'ron'), draft);

    await page.fill('#tracker-add-title', 'Brand new item');
    await page.fill('#tracker-add-detail', 'New detail.');
    await page.click('#tracker-add-submit');

    await page.waitForSelector('.tracker-item[data-id="task-new-1"]', { timeout: 5000 });

    var aStillOpen = await page.$eval('.tracker-item[data-id="task-a"]', function (el) { return el.open; });
    assert.equal(aStillOpen, true, "item A's <details> should still be open after the new item's render()");
    var aValue = await page.$eval(commentInputSelector('task-a', 'ron'), function (el) { return el.value; });
    assert.equal(aValue, draft, "item A's unsaved draft must survive a successful add-item render(), same as done/priority/start/delete already do");
  } finally {
    await context.close();
  }
});

test("changing priority on a brand-new item immediately after adding it, and having that request FAIL, reverts to the item's actual just-created priority ('medium') instead of undefined", async function (t) {
  // Uses priority rather than done for this assertion: item.priority === p
  // is false (no button active) for undefined, and true for exactly one
  // button when correctly seeded, so this is the version of the test that
  // can actually fail if handleAddSubmit's Confirmed-map seeding is missing.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var CREATED = { id: 'task-new-2', category: 'task', title: 'Another new item', detail: 'Another detail.', priority: 'medium', done: false, comments: [], createdAt: '2026-04-01T00:00:00.000Z', doneAt: null, startedAt: null };
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'task-new-2') {
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_A) }) });
      }
    });
    await page.route('**/.netlify/functions/add-tracker-item', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: CREATED }) });
    });

    await page.fill('#tracker-add-title', 'Another new item');
    await page.fill('#tracker-add-detail', 'Another detail.');
    await page.click('#tracker-add-submit');
    await page.waitForSelector('.tracker-item[data-id="task-new-2"]', { timeout: 5000 });

    await page.click('.tracker-item[data-id="task-new-2"] .tracker-pri-btn[data-priority="high"]');

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Couldn.t save/.test(t.textContent);
    }, null, { timeout: 5000 });

    var mediumActive = await page.$eval('.tracker-item[data-id="task-new-2"] .tracker-pri-btn[data-priority="medium"]', function (el) { return el.classList.contains('active'); });
    assert.equal(mediumActive, true, "reverting a failed priority-change on a brand-new item must land on its real seeded value ('medium'), not undefined");
    var highActive = await page.$eval('.tracker-item[data-id="task-new-2"] .tracker-pri-btn[data-priority="high"]', function (el) { return el.classList.contains('active'); });
    assert.equal(highActive, false, "the rejected optimistic priority must not remain active after the revert");
  } finally {
    await context.close();
  }
});
