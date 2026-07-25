// test/tracker-needs-input-behavioral.test.js
//
// Real browser-driven coverage for tracker.html's "Needs your input" badge
// — Ron's own ask (tracker item for-product-tracker-page-clearly-mark-it-
// vvmq9e): "add a clear visual marker/badge on items that require founder
// feedback/input (e.g. items with an unanswered claude question, [auto]
// items awaiting review, anything tagged needs-founder)."
//
// Derived signal, no new tracker-store.js field: an OPEN (not done) item
// whose most recent comment (comments[comments.length-1]) was authored by
// 'claude' — Claude left the last word and nothing from 'ron' has followed
// it yet. See itemHTML's needsInputBadge in tracker.html.
//
// Distinct from the existing .tracker-needs-review-badge ("Needs review"),
// which is done-only ("built, founder hasn't looked at it yet") — this
// badge is open-only ("still open, and the ball is in the founder's
// court"). The two are visually distinguishable (red vs. blue accent — see
// css/styles.css) and can never both apply to the same item at once, since
// one requires item.done and the other requires !item.done.
//
// IMPORTANT constraint this file exists to verify alongside the badge
// itself: adding this purely-visual marker must NOT change sortItems()'s
// existing priority-only sort order (Ron's own explicit requirement) — see
// the last test below.
//
// Same Playwright-via-node:test + static-file-server convention as
// test/tracker-reviewed-behavioral.test.js (see that file's own header
// comment for the fuller reasoning).

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

function comment(author, text) {
  return { id: 'c-' + author + '-' + Math.random().toString(36).slice(2, 8), author: author, text: text, timestamp: '2026-07-20T00:00:00.000Z' };
}

// item-open-claude-last: open, last comment from 'claude' -- the exact
// "unanswered Claude question" case the badge exists to surface.
// item-open-ron-last: open, Claude asked, Ron already replied (Ron's
// comment is the most recent) -- must NOT show the badge.
// item-open-no-comments: open, no comments at all -- must NOT show the
// badge (nothing to check).
// item-done-claude-last: DONE, last comment from 'claude' -- must NOT show
// THIS badge (that's needsReviewBadge's job, unrelated signal).
var ITEM_OPEN_CLAUDE_LAST = {
  id: 'item-open-claude-last', category: 'task', title: 'Open, Claude asked something', detail: 'Detail A.', priority: 'low',
  done: false, comments: [comment('claude', 'Which payment provider should we use?')],
  createdAt: null, doneAt: null, startedAt: null, reviewedAt: null
};
var ITEM_OPEN_RON_LAST = {
  id: 'item-open-ron-last', category: 'task', title: 'Open, Ron already replied', detail: 'Detail B.', priority: 'high',
  done: false, comments: [comment('claude', 'Which payment provider?'), comment('ron', 'Use Dodo.')],
  createdAt: null, doneAt: null, startedAt: null, reviewedAt: null
};
var ITEM_OPEN_NO_COMMENTS = {
  id: 'item-open-no-comments', category: 'task', title: 'Open, no comments yet', detail: 'Detail C.', priority: 'medium',
  done: false, comments: [], createdAt: null, doneAt: null, startedAt: null, reviewedAt: null
};
var ITEM_DONE_CLAUDE_LAST = {
  id: 'item-done-claude-last', category: 'task', title: 'Done, Claude left last comment', detail: 'Detail D.', priority: 'medium',
  done: true, comments: [comment('claude', 'Shipped, marking done.')],
  createdAt: null, doneAt: '2026-07-19T00:00:00.000Z', startedAt: null, reviewedAt: null
};

/** Seeds a logged-in owner session and mocks the tracker endpoints, same pattern as tracker-reviewed-behavioral.test.js's setUpTrackerPage. */
async function setUpTrackerPage(page, seedItems) {
  seedItems = seedItems || [ITEM_OPEN_CLAUDE_LAST, ITEM_OPEN_RON_LAST, ITEM_OPEN_NO_COMMENTS, ITEM_DONE_CLAUDE_LAST];

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

  await page.goto(baseUrl + '/tracker.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tracker-item', { timeout: 5000 });
}

/** Opens the combined Done <details> so its contents become interactable, same technique as tracker-reviewed-behavioral.test.js's openDoneSection. */
async function openDoneSection(page) {
  await page.$eval('#tracker-done-details', function (el) { el.open = true; });
}

test('an open item whose most recent comment is from claude shows the "Needs your input" badge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var badge = await page.$('.tracker-item[data-id="item-open-claude-last"] .tracker-needs-input-badge');
    assert.ok(badge, 'an open item whose last comment is from claude must show the Needs your input badge');
    var badgeText = await page.$eval('.tracker-item[data-id="item-open-claude-last"] .tracker-needs-input-badge', function (el) { return el.textContent; });
    assert.match(badgeText, /needs your input/i);
  } finally {
    await context.close();
  }
});

test('an open item whose most recent comment is from ron (claude asked, ron already replied) does NOT show the badge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var badge = await page.$('.tracker-item[data-id="item-open-ron-last"] .tracker-needs-input-badge');
    assert.equal(badge, null, 'once ron has the last word, the badge must not show even though claude commented earlier');
  } finally {
    await context.close();
  }
});

test('an open item with no comments at all does NOT show the badge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var badge = await page.$('.tracker-item[data-id="item-open-no-comments"] .tracker-needs-input-badge');
    assert.equal(badge, null, 'an item with no comments has nothing to check, so it must never show the badge');
  } finally {
    await context.close();
  }
});

test('a done item never shows the "Needs your input" badge, regardless of its last comment\'s author', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);
    await openDoneSection(page);

    var input = await page.$('.tracker-item[data-id="item-done-claude-last"] .tracker-needs-input-badge');
    assert.equal(input, null, 'a done item must never show the open-only Needs your input badge, even with claude as the last commenter');
    // That done item DOES still get the unrelated needsReviewBadge, since
    // it's done and unreviewed -- confirms the two badges are governed by
    // separate, non-overlapping conditions rather than one accidentally
    // suppressing the other.
    var reviewBadge = await page.$('.tracker-item[data-id="item-done-claude-last"] .tracker-needs-review-badge');
    assert.ok(reviewBadge, 'the done item should still show the unrelated Needs review badge (done + unreviewed)');
  } finally {
    await context.close();
  }
});

test('adding the "Needs your input" badge does not change the priority-sorted render order of open items', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Mix of badge / no-badge items across all three priorities, seeded in
    // a deliberately scrambled order so a real "still sorted by priority
    // alone" assertion actually proves something. sortItems() is a stable
    // sort keyed ONLY on priority (High -> Medium -> Low) — see
    // tracker.html's own sortItems() doc comment — so within each priority
    // tier, items must keep exactly their relative SEED order regardless
    // of which ones happen to carry the new badge; badge presence must
    // never itself act as a secondary sort key.
    var HIGH_NO_BADGE = { id: 'sort-high-no-badge', category: 'task', title: 'High, no badge', detail: 'd', priority: 'high', done: false, comments: [], createdAt: null, doneAt: null, startedAt: null, reviewedAt: null };
    var HIGH_WITH_BADGE = { id: 'sort-high-with-badge', category: 'task', title: 'High, with badge', detail: 'd', priority: 'high', done: false, comments: [comment('claude', 'q')], createdAt: null, doneAt: null, startedAt: null, reviewedAt: null };
    var MEDIUM_NO_BADGE = { id: 'sort-medium-no-badge', category: 'task', title: 'Medium, no badge', detail: 'd', priority: 'medium', done: false, comments: [], createdAt: null, doneAt: null, startedAt: null, reviewedAt: null };
    var MEDIUM_WITH_BADGE = { id: 'sort-medium-with-badge', category: 'task', title: 'Medium, with badge', detail: 'd', priority: 'medium', done: false, comments: [comment('claude', 'q')], createdAt: null, doneAt: null, startedAt: null, reviewedAt: null };
    var LOW_NO_BADGE = { id: 'sort-low-no-badge', category: 'task', title: 'Low, no badge', detail: 'd', priority: 'low', done: false, comments: [], createdAt: null, doneAt: null, startedAt: null, reviewedAt: null };
    var LOW_WITH_BADGE = { id: 'sort-low-with-badge', category: 'task', title: 'Low, with badge', detail: 'd', priority: 'low', done: false, comments: [comment('claude', 'q')], createdAt: null, doneAt: null, startedAt: null, reviewedAt: null };

    // Scrambled seed order -- deliberately not already priority-sorted,
    // and deliberately interleaves badge/no-badge within each priority
    // tier (with-badge before no-badge in High/Low, no-badge before
    // with-badge in Medium) so the expected output below can't be
    // satisfied by accident if badge presence ever leaked into the sort.
    var seed = [LOW_WITH_BADGE, HIGH_WITH_BADGE, MEDIUM_NO_BADGE, LOW_NO_BADGE, HIGH_NO_BADGE, MEDIUM_WITH_BADGE];
    await setUpTrackerPage(page, seed);

    var renderedIds = await page.$$eval('#tracker-tasks .tracker-item', function (els) {
      return els.map(function (el) { return el.dataset.id; });
    });
    // Expected = seed order, grouped by priority (High -> Medium -> Low),
    // preserving each item's original relative position within its own
    // tier -- exactly what a stable, priority-only sort produces, and
    // exactly what sortItems() must keep producing with the badge in play.
    assert.deepEqual(renderedIds, [
      'sort-high-with-badge', 'sort-high-no-badge',
      'sort-medium-no-badge', 'sort-medium-with-badge',
      'sort-low-with-badge', 'sort-low-no-badge'
    ], 'render order must still be governed purely by priority (High -> Medium -> Low, stable), unaffected by which items show the new badge');

    // And confirm the badge itself actually rendered on exactly the three
    // "with badge" items, sanity-checking the order assertion above isn't
    // vacuously true because the badge never showed at all.
    var badgedIds = await page.$$eval('#tracker-tasks .tracker-needs-input-badge', function (els) {
      return els.map(function (el) { return el.closest('.tracker-item').dataset.id; });
    });
    assert.deepEqual(badgedIds.sort(), ['sort-high-with-badge', 'sort-low-with-badge', 'sort-medium-with-badge'].sort());
  } finally {
    await context.close();
  }
});
