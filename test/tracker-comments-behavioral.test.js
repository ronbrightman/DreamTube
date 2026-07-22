// test/tracker-comments-behavioral.test.js
//
// Real browser-driven coverage for tracker.html's comment-textarea/render()
// interaction. This file has grown across three review-caught variants of
// the same underlying bug class (optimistic mutate + full render() + a
// catch-revert-to-a-captured-previous-value, per item id):
//
//   1. handleDoneChange, handlePriorityChange, and handleCommentSave all
//      rebuild every item's HTML from scratch via render() ->
//      sectionHTML() -> itemHTML(), and itemHTML() used to always seed each
//      textarea from item.comment (the last *saved* value) -- so any
//      unrelated action anywhere on the page (checking a done box, clicking
//      a priority button, saving a *different* item's comment) silently
//      wiped whatever unsaved text was sitting in someone else's open
//      comment box. Fixed by snapshotting the live DOM value of every open
//      comment textarea into an in-memory unsavedComments map immediately
//      before every render() call, and having itemHTML() prefer that
//      snapshot over item.comment when one exists.
//   2. The failure-revert (.catch) branch of handleCommentSave excluded its
//      own id from re-capture but never explicitly deleted a stale
//      unsavedComments[id] entry an unrelated interleaved render could have
//      written mid-flight -- fixed by deleting it explicitly, mirroring the
//      optimistic-save branch.
//   3. handleCommentSave (and, with the identical unguarded shape,
//      handleDoneChange/handlePriorityChange) had no per-id in-flight guard
//      at all: double-submitting the SAME item id (edit, save, edit
//      further, save again before the first request resolves) could have
//      the OLDER request's failure-revert apply after the NEWER request's
//      success already landed, silently discarding the successfully-saved
//      newer value. Fixed with a per-id monotonic request-sequence counter
//      per handler (commentSaveSeq/doneChangeSeq/priorityChangeSeq): each
//      catch only reverts if it's still the most recently-started request
//      for that id. The same-item-overlapping-request race test below only
//      ever covered handleCommentSave; the fourth review pass flagged that
//      the sequence-guard fix was extended to handleDoneChange/
//      handlePriorityChange by code-shape analogy with no equivalent test
//      for either -- the two "overlapping same-item toggle" tests below
//      close that gap.
//   4. Even with the seqMap guard in place, a further chained-failure case
//      survived: if TWO overlapping same-id requests both FAIL (not just
//      "older fails after newer already succeeded", the only case #3 above
//      tested), the surviving (later-started) request's revert used to fall
//      back to its own captured "previous" value -- which is only ever the
//      OTHER in-flight request's optimistic, never-confirmed edit, not
//      anything the server actually stored. Fixed by reverting to a
//      per-id, per-field SERVER-CONFIRMED value
//      (commentConfirmed/doneConfirmed/priorityConfirmed, updated only on
//      an actual successful postUpdate) instead of "previous". The
//      "chained double-failure" test below covers this.
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

test('a failed comment save on item A reverts correctly even when an unrelated render (item B\'s done-toggle) interleaves while A\'s save is still in flight (regression: stale unsavedComments[id] surviving the failure-revert)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var resolveARequestSeen = null;
    var aRequestSeen = new Promise(function (resolve) { resolveARequestSeen = resolve; });

    // Item A's update is held open (simulating an in-flight request) long
    // enough for the test to trigger an unrelated render via item B, then
    // resolves as a failure -- this is the exact window in which the bug's
    // interleaved captureDrafts() call used to write a stale entry into
    // unsavedComments['task-a'] that the revert never explicitly cleared.
    // Item B's own update resolves immediately and successfully; it's only
    // there to drive the unrelated render(), not to fail itself.
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'task-a') {
        resolveARequestSeen();
        setTimeout(function () {
          route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
        }, 200);
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
      }
    });

    await openItem(page, 'task-a');
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', 'A save that will fail while B interleaves');
    await page.click('.tracker-item[data-id="task-a"] .tracker-comment-save');

    // Wait until A's save request has actually gone out (still pending),
    // then fire an unrelated render by toggling B's done checkbox -- B's
    // own handleDoneChange calls captureDrafts() (no excludeId), which
    // snapshots A's still-open, just-rejected-but-not-yet-reverted textarea
    // value into unsavedComments['task-a'] before A's revert ever runs.
    await aRequestSeen;
    await page.click('.tracker-item[data-id="task-b"] .tracker-check');
    await page.waitForTimeout(50);

    // Now let A's save actually fail and revert.
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Couldn.t save/.test(t.textContent);
    }, null, { timeout: 5000 });

    var aValue = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValue, 'saved comment A', "after B's interleaved render, A's failed save must still show the correctly-reverted item.comment, not the stale draft B's render captured mid-flight");

    // Sanity check B's unrelated action actually took effect.
    var bChecked = await page.$eval('.tracker-item[data-id="task-b"] .tracker-check', function (el) { return el.checked; });
    assert.equal(bChecked, true);
  } finally {
    await context.close();
  }
});

test("an older comment-save request for item A that fails AFTER a newer request for the SAME item has already succeeded must not revert past the newer value (regression: same-item overlapping-request race, review's third finding on this bug class)", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var taskASaveCount = 0;
    var resolveOlderRequestSeen = null;
    var olderRequestSeen = new Promise(function (resolve) { resolveOlderRequestSeen = resolve; });

    // The OLDER request (comment = "X, first edit") is held open long enough
    // for the test to fire a NEWER request (comment = "Y, second edit") on
    // the exact SAME item id, let that newer one resolve successfully, and
    // only THEN let the older one fail -- this is exactly the ordering
    // review's third finding on this bug class described: an older, slower
    // save's failure landing after a newer save's success has already
    // landed, with nothing in the naive implementation to stop the older
    // one's revert from clobbering the newer one's already-persisted value.
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'task-a') {
        taskASaveCount++;
        if (taskASaveCount === 1) {
          resolveOlderRequestSeen();
          setTimeout(function () {
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
          }, 300);
        } else {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
      }
    });

    await openItem(page, 'task-a');
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', 'X, first edit');
    await page.click('.tracker-item[data-id="task-a"] .tracker-comment-save');

    // Wait until the older request has actually gone out (still pending),
    // then edit further and save again -- the newer request for the SAME id.
    // The optimistic update from the first save has already re-rendered the
    // textarea to show "X, first edit" at this point.
    await olderRequestSeen;
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', 'Y, second edit');
    await page.click('.tracker-item[data-id="task-a"] .tracker-comment-save');

    // Give the newer (immediate) request time to resolve and land before the
    // older, 300ms-delayed one fails.
    await page.waitForTimeout(100);
    var aValueMidway = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValueMidway, 'Y, second edit', 'the newer save should already be showing, well before the older one has even failed yet');

    // Now let the older request's delayed failure actually land.
    await page.waitForTimeout(350);

    var aValueFinal = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValueFinal, 'Y, second edit', "the older request's failure-revert must not overwrite the newer request's already-landed success");

    // No error toast should fire either: the newer request succeeded, and
    // per the fix, the older one's now-stale failure is suppressed entirely
    // for this same-id race (its .catch bails out before showing anything).
    var toastShown = await page.$eval('#toast', function (el) { return el.classList.contains('show'); });
    assert.equal(toastShown, false, "the suppressed older-request revert must not surface a \"couldn't save\" toast either");
  } finally {
    await context.close();
  }
});

test("an older done-toggle request for item A that fails AFTER a newer done-toggle request for the SAME item has already succeeded must not revert past the newer state (regression: the seqMap fix was extended to handleDoneChange 'since it had the same unguarded shape' but had no equivalent test until now)", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var taskADoneCount = 0;
    var resolveOlderRequestSeen = null;
    var olderRequestSeen = new Promise(function (resolve) { resolveOlderRequestSeen = resolve; });

    // The OLDER done-toggle request (from the first click, done: true) is
    // held open long enough for the test to fire a NEWER done-toggle
    // request (from a second click, done: false) on the exact SAME item id,
    // let that newer one resolve successfully, and only THEN let the older
    // one fail -- identical ordering to the handleCommentSave race test
    // above, applied to handleDoneChange.
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
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
      }
    });

    // Item A starts not-done. First click checks it (done: true, the older,
    // slow-to-fail request). Uses el.click() via $eval rather than
    // page.click(), because as soon as an item becomes done it moves into
    // the collapsed "Done (N)" <details> section (closed by default) --
    // Playwright's normal click() waits for the target to be visible, which
    // it deliberately no longer is once checked, and a force:true click
    // still computes real screen coordinates from a display:none (zero-size)
    // box and hits nothing. Calling the DOM .click() method directly fires
    // the same native click+change behavior regardless of visibility.
    await page.$eval('.tracker-item[data-id="task-a"] .tracker-check', function (el) { el.click(); });

    // Wait until the older request has actually gone out, then click again
    // (unchecking it, done: false) -- the newer request for the SAME id.
    await olderRequestSeen;
    await page.$eval('.tracker-item[data-id="task-a"] .tracker-check', function (el) { el.click(); });

    // Give the newer (immediate) request time to resolve and land before
    // the older, 300ms-delayed one fails.
    await page.waitForTimeout(100);
    var checkedMidway = await page.$eval('.tracker-item[data-id="task-a"] .tracker-check', function (el) { return el.checked; });
    assert.equal(checkedMidway, false, 'the newer (unchecked) state should already be showing, well before the older request has even failed yet');

    // Now let the older request's delayed failure actually land.
    await page.waitForTimeout(350);

    var checkedFinal = await page.$eval('.tracker-item[data-id="task-a"] .tracker-check', function (el) { return el.checked; });
    assert.equal(checkedFinal, false, "the older request's failure-revert must not overwrite the newer request's already-landed success");

    var toastShown = await page.$eval('#toast', function (el) { return el.classList.contains('show'); });
    assert.equal(toastShown, false, "the suppressed older-request revert must not surface a \"couldn't save\" toast either");
  } finally {
    await context.close();
  }
});

test("an older priority-change request for item A that fails AFTER a newer priority-change request for the SAME item has already succeeded must not revert past the newer state (regression: the seqMap fix was extended to handlePriorityChange 'since it had the same unguarded shape' but had no equivalent test until now)", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var taskAPriorityCount = 0;
    var resolveOlderRequestSeen = null;
    var olderRequestSeen = new Promise(function (resolve) { resolveOlderRequestSeen = resolve; });

    // The OLDER priority-change request (from the first click, -> "high")
    // is held open long enough for the test to fire a NEWER priority-change
    // request (from a second click, -> "low") on the exact SAME item id,
    // let that newer one resolve successfully, and only THEN let the older
    // one fail -- identical ordering to the handleCommentSave race test
    // above, applied to handlePriorityChange.
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
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
      }
    });

    // Item A starts medium. First click sets it to high (the older,
    // slow-to-fail request).
    await page.click('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="high"]');

    // Wait until the older request has actually gone out, then click "low"
    // -- the newer request for the SAME id.
    await olderRequestSeen;
    await page.click('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="low"]');

    // Give the newer (immediate) request time to resolve and land before
    // the older, 300ms-delayed one fails.
    await page.waitForTimeout(100);
    var lowActiveMidway = await page.$eval('.tracker-item[data-id="task-a"] .tracker-pri-btn[data-priority="low"]', function (el) { return el.classList.contains('active'); });
    assert.equal(lowActiveMidway, true, 'the newer ("low") priority should already be showing, well before the older request has even failed yet');

    // Now let the older request's delayed failure actually land.
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

test("two overlapping comment-save requests for the SAME item that BOTH fail must revert to the server-confirmed value, not chain through an unconfirmed intermediate optimistic edit (regression: chained double-failure, review's fourth finding on this bug class)", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var taskASaveCount = 0;
    var resolveOlderRequestSeen = null;
    var olderRequestSeen = new Promise(function (resolve) { resolveOlderRequestSeen = resolve; });
    var resolveNewerRequestSeen = null;
    var newerRequestSeen = new Promise(function (resolve) { resolveNewerRequestSeen = resolve; });

    // BOTH the older request (comment = "X, first edit") and the newer
    // request (comment = "Y, second edit") for the SAME item eventually
    // FAIL -- the older after a longer delay, the newer (the current
    // sequence holder, so the one whose .catch actually runs the revert)
    // after a shorter one. A naive fix that reverts to a captured
    // "previous" in-memory value would land the newer request's revert on
    // "X, first edit" -- an edit the server never actually stored either,
    // since request A also failed -- instead of the true last-good
    // server-confirmed value ("saved comment A").
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'task-a') {
        taskASaveCount++;
        if (taskASaveCount === 1) {
          resolveOlderRequestSeen();
          setTimeout(function () {
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
          }, 300);
        } else {
          resolveNewerRequestSeen();
          setTimeout(function () {
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
          }, 100);
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: {} }) });
      }
    });

    await openItem(page, 'task-a');
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', 'X, first edit');
    await page.click('.tracker-item[data-id="task-a"] .tracker-comment-save');

    await olderRequestSeen;
    await page.fill('.tracker-item[data-id="task-a"] .tracker-comment-input', 'Y, second edit');
    await page.click('.tracker-item[data-id="task-a"] .tracker-comment-save');
    await newerRequestSeen;

    // Wait for the newer (sequence-holding) request's own failure to land
    // and run its revert.
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Couldn.t save/.test(t.textContent);
    }, null, { timeout: 5000 });

    var aValueAfterNewerFails = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValueAfterNewerFails, 'saved comment A', "the sequence-holding request's revert must land on the server-confirmed original value, not the older request's unconfirmed optimistic edit ('X, first edit')");

    // Now let the older request's own (later) failure land too -- the
    // seqMap guard must suppress it entirely; nothing should change further.
    await page.waitForTimeout(250);

    var aValueFinal = await page.$eval('.tracker-item[data-id="task-a"] .tracker-comment-input', function (el) { return el.value; });
    assert.equal(aValueFinal, 'saved comment A', "the older (now-stale) request's later failure must not change anything further");
  } finally {
    await context.close();
  }
});
