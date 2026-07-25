// test/tracker-waiting-for-behavioral.test.js
//
// Real browser-driven coverage for tracker.html's "Waiting for" badge —
// Ron's own ask (tracker item
// for-product-tracker-add-a-visible-waitin-9zdkb8): "at-a-glance
// visibility of who each item is blocked on (he noticed items not being
// continuously worked + could not tell who owes what)." Values: Product |
// Growth | Ron | none, rendered as "Waiting Product"/"Waiting Growth"/
// "Waiting Ron" (none renders no badge at all).
//
// SUPERSEDES the earlier, narrower "Needs your input" badge (tracker item
// for-product-tracker-page-clearly-mark-it-vvmq9e, shipped in commit
// 78a9375) — this file replaces test/tracker-needs-input-behavioral.test.js.
// That badge only ever covered "open item, last comment from claude" ->
// waiting on Ron; this generalizes to Product/Growth/Ron via a real
// item.waitingFor field (see tracker-store.js), while preserving the old
// last-comment-from-claude condition as a DISPLAY-ONLY fallback for the
// ~35 pre-existing items that predate the field entirely (see
// tracker.html's itemHTML/waitingForBadge for the full derivation order).
//
// Distinct from the existing .tracker-needs-review-badge ("Needs review"),
// which is done-only ("built, founder hasn't looked at it yet") — this
// badge is open-only ("still open, and someone owes something"). The two
// can never both apply to the same item at once, since one requires
// item.done and the other requires !item.done.
//
// IMPORTANT constraint this file exists to verify alongside the badge
// itself: adding this purely-visual marker must NOT change sortItems()'s
// existing priority-only sort order (Ron's own explicit, emphatic
// requirement) — see the last test below.
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

function baseItem(overrides) {
  return Object.assign({
    category: 'task', detail: 'Detail.', priority: 'medium',
    done: false, comments: [], waitingFor: 'none',
    createdAt: null, doneAt: null, startedAt: null, reviewedAt: null
  }, overrides);
}

// (a) explicit waitingFor:'product' wins regardless of title/comments.
var ITEM_EXPLICIT_PRODUCT = baseItem({
  id: 'item-explicit-product', title: 'Explicit product, no tag, no comments', waitingFor: 'product'
});
// (b) waitingFor:'none' + '[for product]' in title -> falls back to product.
var ITEM_TAG_PRODUCT = baseItem({
  id: 'item-tag-product', title: '[for product] Some tagged item', waitingFor: 'none'
});
// (c) waitingFor:'none' + '[for growth]' in title -> falls back to growth.
var ITEM_TAG_GROWTH = baseItem({
  id: 'item-tag-growth', title: '[for growth] Some other tagged item', waitingFor: 'none'
});
// (d) open, waitingFor:'none', no title tag, last comment from claude ->
// falls back to 'ron' (preserves the old badge's exact condition).
var ITEM_FALLBACK_RON = baseItem({
  id: 'item-fallback-ron', title: 'Open, Claude asked something', waitingFor: 'none',
  comments: [comment('claude', 'Which payment provider should we use?')]
});
// (e) waitingFor:'none', no tag, no claude-last-comment signal -> no badge.
var ITEM_NO_SIGNAL = baseItem({
  id: 'item-no-signal', title: 'Nothing waiting here', waitingFor: 'none'
});
// waitingFor:'none', ron already replied last -> no badge (claude did not
// leave the last word).
var ITEM_RON_REPLIED = baseItem({
  id: 'item-ron-replied', title: 'Open, Ron already replied', waitingFor: 'none',
  comments: [comment('claude', 'Which payment provider?'), comment('ron', 'Use Dodo.')]
});
// (f) a DONE item never shows the badge, even with an explicit non-'none'
// value and even with a matching title tag / claude-last-comment.
var ITEM_DONE_EXPLICIT = baseItem({
  id: 'item-done-explicit', title: 'Done, explicitly waiting on growth', waitingFor: 'growth',
  done: true, doneAt: '2026-07-19T00:00:00.000Z'
});
var ITEM_DONE_TAG = baseItem({
  id: 'item-done-tag', title: '[for product] Done item with the tag', waitingFor: 'none',
  done: true, doneAt: '2026-07-19T00:00:00.000Z'
});
var ITEM_DONE_CLAUDE_LAST = baseItem({
  id: 'item-done-claude-last', title: 'Done, Claude left last comment', waitingFor: 'none',
  done: true, doneAt: '2026-07-19T00:00:00.000Z', comments: [comment('claude', 'Shipped, marking done.')]
});

/** Seeds a logged-in owner session and mocks the tracker endpoints, same pattern as tracker-reviewed-behavioral.test.js's setUpTrackerPage. */
async function setUpTrackerPage(page, seedItems) {
  seedItems = seedItems || [
    ITEM_EXPLICIT_PRODUCT, ITEM_TAG_PRODUCT, ITEM_TAG_GROWTH, ITEM_FALLBACK_RON,
    ITEM_NO_SIGNAL, ITEM_RON_REPLIED, ITEM_DONE_EXPLICIT, ITEM_DONE_TAG, ITEM_DONE_CLAUDE_LAST
  ];

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

async function badgeTextFor(page, id) {
  var el = await page.$('.tracker-item[data-id="' + id + '"] .tracker-waiting-badge');
  if (!el) return null;
  return page.evaluate(function (node) { return node.textContent; }, el);
}

test('(a) an item with an explicit waitingFor:"product" shows "Waiting Product", regardless of title/comments', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var text = await badgeTextFor(page, 'item-explicit-product');
    assert.ok(text, 'explicit waitingFor:"product" must show a badge');
    assert.match(text, /waiting product/i);
  } finally {
    await context.close();
  }
});

test('(b) an item with waitingFor:"none" and "[for product]" in its title falls back to "Waiting Product"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var text = await badgeTextFor(page, 'item-tag-product');
    assert.ok(text, 'a [for product]-tagged item with waitingFor:"none" must fall back to a badge');
    assert.match(text, /waiting product/i);
  } finally {
    await context.close();
  }
});

test('(c) an item with waitingFor:"none" and "[for growth]" in its title falls back to "Waiting Growth"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var text = await badgeTextFor(page, 'item-tag-growth');
    assert.ok(text, 'a [for growth]-tagged item with waitingFor:"none" must fall back to a badge');
    assert.match(text, /waiting growth/i);
  } finally {
    await context.close();
  }
});

test('(d) an open item with waitingFor:"none", no title tag, and last comment from claude falls back to "Waiting Ron" (preserves the old badge\'s behavior)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var text = await badgeTextFor(page, 'item-fallback-ron');
    assert.ok(text, 'the claude-left-last-word fallback must still show a badge');
    assert.match(text, /waiting ron/i);

    var ronRepliedText = await badgeTextFor(page, 'item-ron-replied');
    assert.equal(ronRepliedText, null, 'once ron has the last word, the fallback must not fire even though claude commented earlier');
  } finally {
    await context.close();
  }
});

test('(e) an item with waitingFor:"none" and none of the fallback signals shows no badge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);

    var text = await badgeTextFor(page, 'item-no-signal');
    assert.equal(text, null, 'no title tag, no claude-last comment -- nothing to show');
  } finally {
    await context.close();
  }
});

test('(f) a done item never shows the Waiting badge, even with an explicit non-"none" value or a matching fallback signal', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await setUpTrackerPage(page);
    await openDoneSection(page);

    assert.equal(await badgeTextFor(page, 'item-done-explicit'), null, 'a done item with an explicit waitingFor must not show the badge -- nothing is still "waited on" once done');
    assert.equal(await badgeTextFor(page, 'item-done-tag'), null, 'a done item with a [for product] title tag must not show the fallback badge either');
    assert.equal(await badgeTextFor(page, 'item-done-claude-last'), null, 'a done item whose last comment is from claude must not show the ron-fallback badge');

    // The done items DO still get the unrelated needsReviewBadge, since
    // they're done and unreviewed -- confirms the two badges are governed
    // by separate, non-overlapping conditions rather than one accidentally
    // suppressing the other.
    var reviewBadge = await page.$('.tracker-item[data-id="item-done-explicit"] .tracker-needs-review-badge');
    assert.ok(reviewBadge, 'the done item should still show the unrelated Needs review badge (done + unreviewed)');
  } finally {
    await context.close();
  }
});

test('adding the "Waiting for" badge does not change the priority-sorted render order of open items', async function (t) {
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
    var HIGH_NO_BADGE = baseItem({ id: 'sort-high-no-badge', title: 'High, no badge', priority: 'high' });
    var HIGH_WITH_BADGE = baseItem({ id: 'sort-high-with-badge', title: 'High, with badge', priority: 'high', waitingFor: 'product' });
    var MEDIUM_NO_BADGE = baseItem({ id: 'sort-medium-no-badge', title: 'Medium, no badge', priority: 'medium' });
    var MEDIUM_WITH_BADGE = baseItem({ id: 'sort-medium-with-badge', title: 'Medium, with badge', priority: 'medium', waitingFor: 'growth' });
    var LOW_NO_BADGE = baseItem({ id: 'sort-low-no-badge', title: 'Low, no badge', priority: 'low' });
    var LOW_WITH_BADGE = baseItem({ id: 'sort-low-with-badge', title: 'Low, with badge', priority: 'low', waitingFor: 'ron' });

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
    var badgedIds = await page.$$eval('#tracker-tasks .tracker-waiting-badge', function (els) {
      return els.map(function (el) { return el.closest('.tracker-item').dataset.id; });
    });
    assert.deepEqual(badgedIds.sort(), ['sort-high-with-badge', 'sort-low-with-badge', 'sort-medium-with-badge'].sort());
  } finally {
    await context.close();
  }
});
