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
//   1. BATCHING: render/append only ~10 dreams' worth of DOM at a time,
//      via a sentinel element observed by a second IntersectionObserver
//      (scrollObserver) -- the same primitive videoObserver already uses
//      for playback gating.
//   2. VIRTUALIZATION: appending a batch does NOT mean fully rendering all
//      of it. Every dream beyond the very first gets a cheap placeholder
//      DOM slot (slotHTML/.feed-slot) at first; a THIRD observer
//      (presenceObserver) swaps a placeholder for the real, fully
//      hydrated card (hydrateSlot, built from the already-fetched
//      in-memory dream data, never re-fetched) once it's actually near
//      the viewport, and swaps a hydrated card back down to a placeholder
//      (dehydrateSlot) once it scrolls far enough away. This is the part
//      that keeps total DOM weight (not just video `src`) flat -- an
//      earlier version of this fix only released each off-screen card's
//      video `src` while its whole DOM subtree stayed in place forever,
//      so total .feed-card nodes still grew unboundedly with scroll
//      depth. Caught in review before merge; this file's
//      "upper bound on total .feed-card count" test below is the
//      regression test for exactly that finding.
//   3. preload="none" for every card except the very first (index 0) --
//      this is a one-card-per-screen scroll-snap feed, so "beyond the
//      first viewport" just means "index > 0". Combined with (2), a
//      card's `src` is now only ever set at all once it's already about
//      to be (or already is) near the viewport -- there's no longer a
//      window where a real `src` sits on an unseen card relying solely on
//      preload=none to stop it from loading (a real, if brief, risk
//      flagged in review of an earlier version of this fix).
//
// (home.html was checked too -- it's retired and unreferenced (see
// README.md and its own in-file comment: "home.html is retired... and no
// longer the surface a resumed generation completes on"), nothing live
// links to it, so it does not get this same fix; nothing would ever
// exercise it. Confirmed independently by review -- explicitly out of
// scope for this change.)
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
// A generous but real bound on simultaneously hydrated (real .feed-card,
// not .feed-slot placeholder) cards -- current design keeps roughly the
// current card plus a couple of neighbors hydrated (see explore.html's
// presenceObserver rootMargin comment), nowhere close to the total feed
// size on a long scroll.
var HYDRATED_BOUND = 6;

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

/** Real, fully hydrated cards -- excludes lightweight .feed-slot placeholders. */
async function countHydratedCards(page) {
  return page.$$eval('.feed-card', function (els) { return els.length; });
}

/** Every dream that has a DOM presence at all, hydrated or not -- this is what should reach the full feed size as the user scrolls, NOT countHydratedCards(). */
async function countAllSlots(page) {
  return page.$$eval('.feed-card, .feed-slot', function (els) { return els.length; });
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

test('explore.html: initial render only puts the first batch (~10 slots) in the DOM at all, not the whole feed, regardless of total feed size', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card, .feed-slot', { timeout: 5000 });
    await page.waitForTimeout(200);

    assert.equal(await countAllSlots(page), BATCH_SIZE, 'a 200-dream feed should only give the first batch (' + BATCH_SIZE + ' dreams) any DOM presence up front, not all 200');

    var hydrated = await countHydratedCards(page);
    assert.ok(hydrated >= 1 && hydrated < BATCH_SIZE, 'only the near-top few of the first batch should be fully hydrated cards, the rest should still be lightweight placeholders (got ' + hydrated + ' hydrated out of ' + BATCH_SIZE + ')');

    var sentinelExists = await page.$('.feed-load-sentinel');
    assert.ok(sentinelExists, 'a scroll sentinel should exist since more dreams remain unrendered');
  } finally {
    await context.close();
  }
});

test('explore.html: a feed smaller than one batch gets a DOM slot for every dream, with no sentinel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 4);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card, .feed-slot', { timeout: 5000 });
    await page.waitForTimeout(200);

    assert.equal(await countAllSlots(page), 4, 'a 4-dream feed (under one batch) should give all 4 dreams a DOM slot');
    assert.ok((await page.$('.feed-load-sentinel')) === null, 'no sentinel should exist once every dream already has a slot');
  } finally {
    await context.close();
  }
});

test('explore.html: preload is "metadata" only on the very first card, "none" on every other hydrated card', async function (t) {
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
    assert.ok(preloads.length >= 1, 'at least the first card should be hydrated with a real video');
    assert.equal(preloads[0], 'metadata', 'the first (currently in-viewport) card should keep preload=metadata');
    for (var i = 1; i < preloads.length; i++) {
      assert.equal(preloads[i], 'none', 'hydrated card index ' + i + ' is beyond the first viewport and must be preload=none');
    }
  } finally {
    await context.close();
  }
});

test('explore.html: scrolling near the end lazy-appends further batches until every dream has a DOM slot, then the sentinel is removed', async function (t) {
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
    await page.waitForSelector('.feed-card, .feed-slot', { timeout: 5000 });
    await page.waitForTimeout(200);
    assert.equal(await countAllSlots(page), BATCH_SIZE, 'sanity check: starts with just the first batch');

    // Repeatedly scroll to the current bottom of the feed -- each jump
    // should intersect the sentinel and trigger appendNextBatch(), moving
    // the sentinel further down each time, until all 25 dreams have a
    // slot and the sentinel removes itself.
    var reachedFull = false;
    for (var i = 0; i < 10 && !reachedFull; i++) {
      await scrollFeedToBottom(page);
      await page.waitForTimeout(200);
      var count = await countAllSlots(page);
      if (count === 25) reachedFull = true;
    }

    assert.equal(await countAllSlots(page), 25, 'repeated scroll-to-bottom should eventually lazy-append a slot for every remaining dream');
    assert.ok((await page.$('.feed-load-sentinel')) === null, 'the sentinel should be removed once the whole feed has a slot');
  } finally {
    await context.close();
  }
});

test('explore.html: total .feed-card (fully hydrated) count stays bounded even after scrolling deep into a 200-dream feed -- BLOCKING acceptance criterion', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);

    var initialHydrated = await countHydratedCards(page);
    assert.ok(initialHydrated >= 1, 'at least the first card should be hydrated on load');
    assert.ok(initialHydrated <= HYDRATED_BOUND, 'expected only a small, bounded number of hydrated .feed-card elements on initial load, got ' + initialHydrated + ' out of 200 total dreams');

    // Scroll deep into the feed repeatedly -- this lazy-appends many more
    // slots (total DOM slot count grows well past the first batch, as
    // expected -- see the "all slots" sanity check below), but the
    // HYDRATED .feed-card count specifically must stay bounded throughout,
    // never accumulating with how far the user has scrolled. This is the
    // literal regression test for review's blocking finding on the
    // previous version of this fix, which only released a scrolled-past
    // card's video `src` while leaving its full DOM subtree (info panel,
    // like/share buttons, icons) in the document forever -- total
    // .feed-card nodes grew linearly with scroll depth even though
    // hydrated *video src* count alone looked bounded.
    for (var i = 0; i < 10; i++) {
      await scrollFeedToBottom(page);
      await page.waitForTimeout(200);
      var hydrated = await countHydratedCards(page);
      assert.ok(hydrated <= HYDRATED_BOUND, 'total .feed-card count should stay bounded while scrolling through a long feed, got ' + hydrated + ' at scroll step ' + i);
    }

    var allSlotsAfterScrolling = await countAllSlots(page);
    assert.ok(allSlotsAfterScrolling > BATCH_SIZE, 'sanity check: scrolling should have appended well beyond the first batch of DOM slots (got ' + allSlotsAfterScrolling + ')');
    assert.ok(allSlotsAfterScrolling < 200, 'sanity check: this scroll depth should not have reached the very end of a 200-dream feed yet (got ' + allSlotsAfterScrolling + ')');
  } finally {
    await context.close();
  }
});

test('explore.html: a scrolled-far-past card is fully de-rendered (not just src-cleared) and comes back as a real hydrated card once the user scrolls back to it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);

    var firstCardIsHydrated = await page.$eval('[data-id="synthetic-dream-0"]', function (el) { return el.classList.contains('feed-card'); });
    assert.equal(firstCardIsHydrated, true, 'sanity check: the first card should start out fully hydrated');
    var firstCardHasVideo = await page.$eval('[data-id="synthetic-dream-0"]', function (el) { return !!el.querySelector('.feed-video'); });
    assert.equal(firstCardHasVideo, true, 'sanity check: the hydrated first card should have a real video element');

    // Scroll far enough away that the first card is well outside
    // presenceObserver's kept window, appending several more batches along
    // the way.
    for (var i = 0; i < 6; i++) {
      await scrollFeedToBottom(page);
      await page.waitForTimeout(200);
    }

    var firstCardEl = await page.$('[data-id="synthetic-dream-0"]');
    assert.ok(firstCardEl, 'the dream should still have SOME DOM presence (a placeholder slot), just not a hydrated card');
    var isNowSlot = await page.$eval('[data-id="synthetic-dream-0"]', function (el) { return el.classList.contains('feed-slot') && !el.classList.contains('feed-card'); });
    assert.equal(isNowSlot, true, 'the first card should have been fully de-rendered to a lightweight placeholder once scrolled far past, not just had its video src cleared');
    var hasVideoWhileDehydrated = await page.$eval('[data-id="synthetic-dream-0"]', function (el) { return !!el.querySelector('.feed-video'); });
    assert.equal(hasVideoWhileDehydrated, false, 'a de-rendered card must have no video element (or any other subtree) left in the DOM at all');

    // Scroll back to the very top -- the first card should be re-hydrated
    // into a real card again, built fresh from the still-in-memory dream
    // data (never re-fetched over the network -- get-feed.js is only
    // mocked/hit once for this whole test).
    await scrollFeedToTop(page);
    await page.waitForTimeout(300);
    var isRehydrated = await page.$eval('[data-id="synthetic-dream-0"]', function (el) { return el.classList.contains('feed-card'); });
    assert.equal(isRehydrated, true, 'scrolling back to the first card should re-hydrate it into a real card');
    var restoredSrc = await page.$eval('[data-id="synthetic-dream-0"] .feed-video', function (v) { return v.getAttribute('src'); });
    assert.equal(restoredSrc, 'https://example.com/fake-feed-video-0.mp4', 'the re-hydrated card\'s video should carry the correct (in-memory, not re-fetched) URL');
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
    // moves it to the front before rendering (windowing/virtualization
    // would otherwise never render it at all without a lot of scrolling).
    await mockFeed(page, 200);

    await page.goto(baseUrl + '/explore.html?id=synthetic-dream-150', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(200);

    var firstCardId = await page.$eval('.feed-card', function (el) { return el.dataset.id; });
    assert.equal(firstCardId, 'synthetic-dream-150', 'the deep-linked dream should be the first (and immediately hydrated) card');
  } finally {
    await context.close();
  }
});
