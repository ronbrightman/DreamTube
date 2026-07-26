// test/feed-windowing-behavioral.test.js
//
// Regression coverage for tracker.html's
// feed-pages-explore-html-home-html-render-6t7udd (founder-approved
// 2026-07-27): explore.html used to do `dreams.map(cardHTML).join('')`,
// rendering EVERY fetched dream as a <video preload=metadata> element
// immediately on page load, unbounded by feed size. Not currently causing
// crashes (playback was already correctly gated to the single in-view
// card via IntersectionObserver, no autoplay attribute -- see
// test/first-video-created-explore-resume-behavioral.test.js's file
// header for that unrelated, already-fixed bug class), but as the
// published-dream library grows this becomes an unbounded number of
// simultaneous metadata fetches on page load -- a scaling risk on
// memory-constrained mobile webviews, especially now that FB/IG ad
// traffic funnels visitors here (see
// for-product-check-app-for-the-same-mobil-5ng2cg's marketing-funnel
// precedent for exactly this class of bug).
//
// The fix, all in explore.html:
//   1. Render only the first ~10 dreams up front; lazy-append the next
//      ~10 as the user scrolls near the end, via a sentinel element
//      observed by a second IntersectionObserver (scrollObserver) -- the
//      same primitive videoObserver already uses for playback gating.
//   2. preload="none" (not "metadata") for every card beyond the very
//      first one -- this is a one-card-per-screen scroll-snap feed, so
//      "beyond the first viewport" just means "index > 0".
//   3. A third observer (memoryObserver) releases a scrolled-far-off-
//      screen card's video `src` (and calls .load()) so a long scroll
//      doesn't keep every visited video's underlying media resource alive
//      at once, restoring `src` (from `data-src`) if the user scrolls
//      back to it.
//
// (home.html was checked too -- it's retired and unreferenced (see
// README.md and its own in-file comment: "home.html is retired... and no
// longer the surface a resumed generation completes on"), nothing live
// links to it, so it does not get this same fix; nothing would ever
// exercise it.)
//
// Follows test/first-video-created-explore-resume-behavioral.test.js's
// and test/ui-behavioral.test.js's conventions: staticServer + Playwright
// Chromium, page.route() to intercept get-feed instead of a real network
// call, and (per test/ui-behavioral.test.js's own precedent, e.g. its
// 375px/320px topbar tests) an explicit mobile viewport for the smoke-test
// AGENT_POLICY.md's standing rule calls for -- 390x844 here, a common FB/
// IG in-app-webview phone size.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };
var BATCH_SIZE = 10; // must match explore.html's own BATCH_SIZE

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel's real CDN script) -- see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Builds `count` synthetic published dreams, matching get-feed.js's real response shape (see js/store.js's getSharedFeed). Distinct fake videoUrls so a per-card src is trivially identifiable in assertions. */
function makeSyntheticFeed(count) {
  var feed = [];
  for (var i = 0; i < count; i++) {
    feed.push({
      id: 'synthetic-dream-' + i,
      caption: 'Synthetic dream #' + i,
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-feed-video-' + i + '.mp4',
      ownerHandle: '@synthuser' + i,
      likes: i,
      likedByMe: false,
      dur: '0:08'
    });
  }
  return feed;
}

/** Intercepts get-feed.js with a synthetic feed of the given size, no real network/Blobs call. */
function mockFeed(page, count, dreamOfDayId) {
  var feed = makeSyntheticFeed(count);
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: dreamOfDayId || null }) });
  }).then(function () { return feed; });
}

async function countFeedCards(page) {
  return page.$$eval('.feed-card', function (els) { return els.length; });
}

async function countHydratedVideos(page) {
  return page.$$eval('.feed-video', function (els) {
    return els.filter(function (v) { return !!v.getAttribute('src'); }).length;
  });
}

async function scrollFeedToBottom(page) {
  await page.evaluate(function () {
    var root = document.getElementById('feed-scroll');
    root.scrollTop = root.scrollHeight;
  });
}

async function scrollFeedToTop(page) {
  await page.evaluate(function () {
    document.getElementById('feed-scroll').scrollTop = 0;
  });
}

test('explore.html: initial render only holds the first batch (~10 cards), not the whole feed, regardless of total feed size', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    // Give any (incorrect) eager full-render a moment to have happened if
    // the fix regressed -- the assertion below would still catch it, this
    // just avoids a false pass from checking before the DOM settles.
    await page.waitForTimeout(200);

    var cardCount = await countFeedCards(page);
    assert.equal(cardCount, BATCH_SIZE, 'a 200-dream feed should only render the first batch (' + BATCH_SIZE + ' cards) up front, not all 200');

    var sentinelExists = await page.$('.feed-load-sentinel');
    assert.ok(sentinelExists, 'a scroll sentinel should exist since more dreams remain unrendered');
  } finally {
    await context.close();
  }
});

test('explore.html: a feed smaller than one batch renders in full, with no sentinel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 4);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);

    assert.equal(await countFeedCards(page), 4, 'a 4-dream feed (under one batch) should render all 4 cards');
    assert.equal(await page.$('.feed-load-sentinel'), null, 'no sentinel should exist once every dream is already rendered');
  } finally {
    await context.close();
  }
});

test('explore.html: preload is "metadata" only on the very first card, "none" on every other card in the initial batch', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);

    var preloads = await page.$$eval('.feed-video', function (els) { return els.map(function (v) { return v.getAttribute('preload'); }); });
    assert.equal(preloads.length, BATCH_SIZE);
    assert.equal(preloads[0], 'metadata', 'the first (currently in-viewport) card should keep preload=metadata');
    for (var i = 1; i < preloads.length; i++) {
      assert.equal(preloads[i], 'none', 'card index ' + i + ' is beyond the first viewport and must be preload=none');
    }
  } finally {
    await context.close();
  }
});

test('explore.html: scrolling near the end lazy-appends further batches until the whole feed has rendered, then the sentinel is removed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Small-ish total (25) so this test can deterministically drive it to
    // full exhaustion (sentinel gone) in a bounded number of scroll steps,
    // while still being more than one batch (proves real lazy-append, not
    // just the "fits in one batch" case above).
    await mockFeed(page, 25);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);
    assert.equal(await countFeedCards(page), BATCH_SIZE, 'sanity check: starts with just the first batch');

    // Repeatedly scroll to the current bottom of the feed -- each jump
    // should intersect the sentinel and trigger appendNextBatch(), moving
    // the sentinel further down each time, until all 25 dreams have been
    // appended and the sentinel removes itself.
    var reachedFull = false;
    for (var i = 0; i < 10 && !reachedFull; i++) {
      await scrollFeedToBottom(page);
      await page.waitForTimeout(200);
      var count = await countFeedCards(page);
      if (count === 25) reachedFull = true;
    }

    assert.equal(await countFeedCards(page), 25, 'repeated scroll-to-bottom should eventually lazy-append every remaining dream');
    assert.equal(await page.$('.feed-load-sentinel'), null, 'the sentinel should be removed once the whole feed has been rendered');
  } finally {
    await context.close();
  }
});

test('explore.html: DOM only ever holds a bounded number of fully-hydrated (src-carrying) video elements at once, even on a long (200-dream) feed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);

    // A generous but real bound -- current design keeps roughly the
    // current card plus its immediate neighbors hydrated (see
    // explore.html's memoryObserver comment), nowhere close to all 200.
    var HYDRATED_BOUND = 6;

    var initialHydrated = await countHydratedVideos(page);
    assert.ok(initialHydrated > 0, 'at least the first card should be hydrated on load');
    assert.ok(initialHydrated <= HYDRATED_BOUND, 'expected only a small, bounded number of hydrated videos on initial load, got ' + initialHydrated + ' out of 200 total dreams');

    // Scroll deep into the feed repeatedly -- this both lazy-appends many
    // more cards (DOM card count grows well past the first batch) AND
    // should keep releasing src from cards that scroll far behind, so the
    // hydrated count must stay bounded throughout, not accumulate with
    // total rendered cards.
    for (var i = 0; i < 8; i++) {
      await scrollFeedToBottom(page);
      await page.waitForTimeout(200);
      var hydrated = await countHydratedVideos(page);
      assert.ok(hydrated <= HYDRATED_BOUND, 'hydrated video count should stay bounded while scrolling through a long feed, got ' + hydrated + ' at scroll step ' + i);
    }

    var cardsAfterScrolling = await countFeedCards(page);
    assert.ok(cardsAfterScrolling > BATCH_SIZE, 'sanity check: scrolling should have appended well beyond the first batch (got ' + cardsAfterScrolling + ' cards)');
  } finally {
    await context.close();
  }
});

test('explore.html: a released (scrolled-far-past) card\'s video src is restored once the user scrolls back to it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);

    var firstCardHasSrc = await page.$eval('.feed-card[data-id="synthetic-dream-0"] .feed-video', function (v) { return !!v.getAttribute('src'); });
    assert.equal(firstCardHasSrc, true, 'sanity check: the first card should start hydrated');

    // Scroll far enough away that the first card is well outside
    // memoryObserver's kept window, appending several more batches along
    // the way.
    for (var i = 0; i < 6; i++) {
      await scrollFeedToBottom(page);
      await page.waitForTimeout(200);
    }
    var firstCardSrcAfterScrollAway = await page.$eval('.feed-card[data-id="synthetic-dream-0"] .feed-video', function (v) { return v.getAttribute('src'); });
    assert.equal(firstCardSrcAfterScrollAway, null, 'the first card\'s video src should have been released once scrolled far past');
    var firstCardDataSrcAfterScrollAway = await page.$eval('.feed-card[data-id="synthetic-dream-0"] .feed-video', function (v) { return v.getAttribute('data-src'); });
    assert.equal(firstCardDataSrcAfterScrollAway, 'https://example.com/fake-feed-video-0.mp4', 'data-src should still carry the real URL even after src is released');

    // Scroll back to the very top -- the first card's src should be
    // restored from data-src.
    await scrollFeedToTop(page);
    await page.waitForTimeout(300);
    var firstCardSrcAfterScrollBack = await page.$eval('.feed-card[data-id="synthetic-dream-0"] .feed-video', function (v) { return v.getAttribute('src'); });
    assert.equal(firstCardSrcAfterScrollBack, 'https://example.com/fake-feed-video-0.mp4', 'scrolling back to the first card should restore its video src');
  } finally {
    await context.close();
  }
});

test('explore.html: a shared-dream deep link (?id=) still lands on the target dream first, even deep in a long feed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // The deep-linked dream ('synthetic-dream-150') is deep in the feed --
    // far beyond the first batch -- so this only passes if explore.html
    // moves it to the front before rendering (windowing would otherwise
    // never render it at all without a lot of scrolling).
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html?id=synthetic-dream-150', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);

    var firstCardId = await page.$eval('.feed-card', function (el) { return el.dataset.id; });
    assert.equal(firstCardId, 'synthetic-dream-150', 'the deep-linked dream should be the first (and only immediately visible) card');
  } finally {
    await context.close();
  }
});
