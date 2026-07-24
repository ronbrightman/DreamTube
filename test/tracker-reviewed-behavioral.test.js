// test/tracker-reviewed-behavioral.test.js
//
// Real browser-driven coverage for tracker.html's "Reviewed" marker — the
// founder-clickable one-way signal added alongside the existing "Start
// working on this" button (see netlify/functions/lib/tracker-store.js's
// updateItem for the reviewedAt schema, and update-tracker-item.js's own
// doc comment for why `reviewed` is modeled exactly like `started`: a
// one-way signal, no un-review control).
//
// Same Playwright-via-node:test + static-file-server convention as
// test/tracker-comments-behavioral.test.js (see that file's own header
// comment for the fuller reasoning) — this is a separate file rather than
// folded into that one so this feature's own coverage (the Reviewed
// button's reveal/reveal-only-when-done gating, its revert-on-failure
// behavior, and the Needs-review sub-section/digest it powers) has one
// clear home, mirroring how tracker-behavioral.test.js already exists
// as its own focused file alongside the broader comments-behavioral file.

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

// item-done-unreviewed: already done, never reviewed -- the exact "agent
// marked it done, founder hasn't looked yet" state this feature exists to
// surface. item-done-reviewed: done AND already reviewed, so it should
// show up in the plain "Reviewed" group with no badge/button.
// item-open: not done at all, so no Reviewed control should ever show on
// it, mirroring startControl's own not-done gating.
var ITEM_DONE_UNREVIEWED = {
  id: 'item-done-unreviewed', category: 'task', title: 'Done, not yet reviewed', detail: 'Detail A.', priority: 'medium',
  done: true, comments: [], createdAt: null, doneAt: '2026-03-01T00:00:00.000Z', startedAt: null, reviewedAt: null
};
var ITEM_DONE_REVIEWED = {
  id: 'item-done-reviewed', category: 'task', title: 'Done and already reviewed', detail: 'Detail B.', priority: 'medium',
  done: true, comments: [], createdAt: null, doneAt: '2026-02-01T00:00:00.000Z', startedAt: null, reviewedAt: '2026-02-02T00:00:00.000Z'
};
var ITEM_OPEN = {
  id: 'item-open', category: 'task', title: 'Not done yet', detail: 'Detail C.', priority: 'medium',
  done: false, comments: [], createdAt: null, doneAt: null, startedAt: null, reviewedAt: null
};

/** Seeds a logged-in owner session and mocks the tracker endpoints, same pattern as tracker-comments-behavioral.test.js's setUpTrackerPage. */
async function setUpTrackerPage(page, updateBehavior, seedItems) {
  seedItems = seedItems || [ITEM_DONE_UNREVIEWED, ITEM_DONE_REVIEWED, ITEM_OPEN];
  updateBehavior = updateBehavior || function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    var base = seedItems.filter(function (i) { return i.id === body.id; })[0] || {};
    var next = Object.assign({}, base);
    if (body.reviewed === true && !base.reviewedAt) next.reviewedAt = new Date().toISOString();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: next }) });
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: seedItems.map(function (i) { return Object.assign({}, i); }) }) });
  });
  await page.route('**/.netlify/functions/update-tracker-item', updateBehavior);

  await page.goto(baseUrl + '/tracker.html', { waitUntil: 'domcontentloaded' });
  // Open items render straight away; done items live in the (collapsed by
  // default) combined Done section, so wait on the open item as the
  // "page actually loaded" signal.
  await page.waitForSelector('.tracker-item[data-id="item-open"]', { timeout: 5000 });
}

/** Opens the combined Done <details> so its contents (done items, including their Reviewed controls) become interactable — mirrors tracker-comments-behavioral.test.js's own handling of this collapsed-by-default section. */
async function openDoneSection(page) {
  await page.$eval('#tracker-done-details', function (el) { el.open = true; });
}

/** Opens one item's own <details> (collapsed by default, independent of the outer Done section above) so controls inside its collapsible body — comment compose boxes, the Reviewed button's row — are actually visible/interactable, same technique as tracker-comments-behavioral.test.js's openItem. */
async function openItem(page, id) {
  await page.$eval('.tracker-item[data-id="' + id + '"]', function (el) { el.open = true; });
}

test('a not-done item never shows a Reviewed control, even inside the Done section markup path', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var openItemReviewBtn = await page.$('.tracker-item[data-id="item-open"] .tracker-review-btn');
    assert.equal(openItemReviewBtn, null, 'a not-yet-done item must never show a Reviewed control');
  } finally {
    await context.close();
  }
});

test('a done, unreviewed item shows a "Needs review" badge and a Mark Reviewed button; an already-reviewed done item shows neither', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);
    await openDoneSection(page);

    var unreviewedBadge = await page.$('.tracker-item[data-id="item-done-unreviewed"] .tracker-needs-review-badge');
    assert.ok(unreviewedBadge, 'a done-but-unreviewed item must show the Needs review badge');
    var unreviewedBtn = await page.$('.tracker-item[data-id="item-done-unreviewed"] .tracker-review-btn');
    assert.ok(unreviewedBtn, 'a done-but-unreviewed item must show the Mark Reviewed button');

    var reviewedBadge = await page.$('.tracker-item[data-id="item-done-reviewed"] .tracker-needs-review-badge');
    assert.equal(reviewedBadge, null, 'an already-reviewed item must not show the Needs review badge');
    var reviewedBtn = await page.$('.tracker-item[data-id="item-done-reviewed"] .tracker-review-btn');
    assert.equal(reviewedBtn, null, 'an already-reviewed item must not show the Mark Reviewed button any more');
  } finally {
    await context.close();
  }
});

test('the Done section summary shows an "N new" count and a one-line digest sentence while unreviewed items remain', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var summaryText = await page.$eval('.tracker-done-summary', function (el) { return el.textContent; });
    assert.match(summaryText, /Done \(2\)/, 'the summary must count BOTH done items (reviewed and unreviewed)');
    var countBadge = await page.$eval('.tracker-review-count-badge', function (el) { return el.textContent; });
    assert.match(countBadge, /1 new/, 'exactly one of the two done items is unreviewed');

    await openDoneSection(page);
    var digestText = await page.$eval('.tracker-review-digest', function (el) { return el.textContent; });
    assert.match(digestText, /1 item done since your last review/);

    var subheads = await page.$$eval('.tracker-done-subhead', function (els) { return els.map(function (e) { return e.textContent; }); });
    assert.deepEqual(subheads, ['Needs review (1)', 'Reviewed'], 'both sub-groups must be labeled once at least one item needs review');
  } finally {
    await context.close();
  }
});

test('with nothing left to review, the Done section shows no digest, no count badge, and no sub-headings', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Both done items already reviewed -- nothing new since "last review".
    var allReviewed = Object.assign({}, ITEM_DONE_UNREVIEWED, { reviewedAt: '2026-03-02T00:00:00.000Z' });
    await setUpTrackerPage(page, null, [allReviewed, ITEM_DONE_REVIEWED, ITEM_OPEN]);

    var summaryText = await page.$eval('.tracker-done-summary', function (el) { return el.textContent; });
    assert.match(summaryText, /Done \(2\)/);
    assert.doesNotMatch(summaryText, /new/, 'no "N new" badge once everything is reviewed');

    var countBadge = await page.$('.tracker-review-count-badge');
    assert.equal(countBadge, null);
    var digest = await page.$('.tracker-review-digest');
    assert.equal(digest, null);
    var subheads = await page.$$('.tracker-done-subhead');
    assert.equal(subheads.length, 0, 'no Needs review/Reviewed sub-headings once there is nothing to distinguish');
  } finally {
    await context.close();
  }
});

test('clicking Mark Reviewed replaces the button with a Reviewed timestamp, clears the badge, and updates the digest; a failed attempt reverts it back', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var reviewCount = 0;
    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.reviewed) {
        reviewCount++;
        if (reviewCount === 1) {
          route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
        } else {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_DONE_UNREVIEWED, { reviewedAt: '2026-03-05T00:00:00.000Z' }) }) });
        }
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, ITEM_DONE_UNREVIEWED) }) });
      }
    });
    await openDoneSection(page);

    await page.$eval('.tracker-item[data-id="item-done-unreviewed"] .tracker-review-btn', function (el) { el.click(); });

    // First attempt fails -- the button must come back (nothing persisted).
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t.classList.contains('show') && /Couldn.t mark reviewed/.test(t.textContent);
    }, null, { timeout: 5000 });
    var btnBackAfterFailure = await page.$('.tracker-item[data-id="item-done-unreviewed"] .tracker-review-btn');
    assert.ok(btnBackAfterFailure, 'a failed review-mark must revert -- the Mark Reviewed button must reappear');
    var badgeBackAfterFailure = await page.$('.tracker-item[data-id="item-done-unreviewed"] .tracker-needs-review-badge');
    assert.ok(badgeBackAfterFailure, 'the Needs review badge must also come back on failure');

    // Second attempt succeeds.
    await page.$eval('.tracker-item[data-id="item-done-unreviewed"] .tracker-review-btn', function (el) { el.click(); });
    await page.waitForFunction(function () {
      var el = document.querySelector('.tracker-item[data-id="item-done-unreviewed"] .tracker-item-meta');
      return el && /Reviewed/.test(el.textContent);
    }, null, { timeout: 5000 });

    var btnGone = await page.$('.tracker-item[data-id="item-done-unreviewed"] .tracker-review-btn');
    assert.equal(btnGone, null, 'once reviewed, the Mark Reviewed button must be gone -- there is no "un-review" control');
    var badgeGone = await page.$('.tracker-item[data-id="item-done-unreviewed"] .tracker-needs-review-badge');
    assert.equal(badgeGone, null, 'once reviewed, the Needs review badge must be gone too');

    // The digest/count badge must reflect the now-zero unreviewed count
    // without a page reload -- render() must have re-derived it from the
    // updated item, not left it stuck at the pre-click value.
    var countBadge = await page.$('.tracker-review-count-badge');
    assert.equal(countBadge, null, 'the "N new" count badge must disappear once the last unreviewed item is cleared');
  } finally {
    await context.close();
  }
});

test('reviewing two DIFFERENT items concurrently (one slow, one fast) does not cross-contaminate either item\'s reviewed state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var SLOW_ITEM = Object.assign({}, ITEM_DONE_UNREVIEWED, { id: 'item-slow', title: 'Slow item' });
    var FAST_ITEM = Object.assign({}, ITEM_DONE_UNREVIEWED, { id: 'item-fast', title: 'Fast item' });
    var resolveSlow = null;

    await setUpTrackerPage(page, function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.id === 'item-slow') {
        new Promise(function (resolve) { resolveSlow = resolve; }).then(function () {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, SLOW_ITEM, { reviewedAt: '2026-04-01T00:00:00.000Z' }) }) });
        });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: Object.assign({}, FAST_ITEM, { reviewedAt: '2026-04-02T00:00:00.000Z' }) }) });
      }
    }, [SLOW_ITEM, FAST_ITEM, ITEM_OPEN]);
    await openDoneSection(page);

    await page.$eval('.tracker-item[data-id="item-slow"] .tracker-review-btn', function (el) { el.click(); }); // slow, still pending
    await page.$eval('.tracker-item[data-id="item-fast"] .tracker-review-btn', function (el) { el.click(); }); // fast, resolves immediately

    await page.waitForFunction(function () {
      var el = document.querySelector('.tracker-item[data-id="item-fast"] .tracker-item-meta');
      return el && /Reviewed/.test(el.textContent);
    }, null, { timeout: 5000 });

    // item-slow's request is still in flight -- its own optimistic
    // Reviewed state must already be showing (set synchronously on
    // click), unaffected by item-fast's unrelated already-landed request.
    var slowMetaMidway = await page.$eval('.tracker-item[data-id="item-slow"] .tracker-item-meta', function (el) { return el.textContent; });
    assert.match(slowMetaMidway, /Reviewed/, "item-slow's own optimistic reviewed state must show while its request is still in flight");

    resolveSlow();
    await page.waitForFunction(function () {
      var el = document.querySelector('.tracker-item[data-id="item-slow"] .tracker-item-meta');
      return el && /Reviewed/.test(el.textContent);
    }, null, { timeout: 5000 });

    var slowBtnGone = await page.$('.tracker-item[data-id="item-slow"] .tracker-review-btn');
    var fastBtnGone = await page.$('.tracker-item[data-id="item-fast"] .tracker-review-btn');
    assert.equal(slowBtnGone, null, 'item-slow must end up reviewed once its own (slower) request lands');
    assert.equal(fastBtnGone, null, 'item-fast must stay reviewed -- unaffected by item-slow\'s later-landing request');
  } finally {
    await context.close();
  }
});

test('typing an unsaved comment draft on a done item survives clicking Mark Reviewed on that same item', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);
    await openDoneSection(page);
    await openItem(page, 'item-done-unreviewed');

    var draftSelector = '.tracker-item[data-id="item-done-unreviewed"] .tracker-comment-compose[data-author="ron"] .tracker-comment-input';
    var draft = 'unsaved note, then I mark this reviewed';
    await page.fill(draftSelector, draft);

    await page.$eval('.tracker-item[data-id="item-done-unreviewed"] .tracker-review-btn', function (el) { el.click(); });
    await page.waitForFunction(function () {
      var el = document.querySelector('.tracker-item[data-id="item-done-unreviewed"] .tracker-item-meta');
      return el && /Reviewed/.test(el.textContent);
    }, null, { timeout: 5000 });

    var draftValue = await page.$eval(draftSelector, function (el) { return el.value; });
    assert.equal(draftValue, draft, 'an unsaved comment draft on the same item must survive its own Mark Reviewed click, same captureDrafts()-before-render() discipline as every other control on this page');
  } finally {
    await context.close();
  }
});
