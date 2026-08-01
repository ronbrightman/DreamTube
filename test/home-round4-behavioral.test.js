// test/home-round4-behavioral.test.js
//
// Behavioral coverage for "Home round 4" (tracker item for-product-build-
// ship-founder-approved--9ta1j0, founder-approved home-mock5-x7q4.html) —
// the five NEW sub-features this build adds to home.html on top of the
// already-shipped Night Shelf (test/home-behavioral.test.js) and the
// already-shipped embedded dream's-room card (test/home-day0-dream-card-
// behavioral.test.js):
//   1. Tip of the day — per-account unseen-first tip rotation
//   2. Get inspired — a public-dream carousel from the shared feed
//   3. Consider publishing a dream — the account's own unpublished dreams
//   4. Make it yours — the install/copy-link/bookmark accordion + the
//      verified-install +100 claim (its browser-detection/copy REUSE of
//      js/install-nudge.js already has dedicated coverage in
//      test/a2hs-install-nudge-journey-behavioral.test.js and
//      test/install-first-door-behavioral.test.js, both updated by this
//      same build to target the new card instead of the old #install-qrow
//      — this file covers what's genuinely NEW: the accordion mechanics,
//      the copy-link/bookmark rows, and the full claim round trip)
//   6. Dock rebalance — Home tab prominent + glowing, "+" a quiet 40px ring
//   7. The logged hero shows the dream itself + the multi-dream chip
// (5, TOKEN ICON A, has its own dedicated section below on top of test/
// profile-night-restyle-behavioral.test.js's topbar-chip assertion — since
// js/purchase-sheet.js's mountBalanceChip is the SAME renderer home.html
// now also mounts, that page's coverage already proves the shared piece;
// this file adds the home.html-specific surfaces (ritual module, MKY
// reward line) that page doesn't have.
// 8, the single-pulse rule, is already covered by test/home-behavioral.
// test.js's existing pulse assertions; this file only adds the "the new
// sections never pulse" regression check.)
//
// Follows test/home-day0-dream-card-behavioral.test.js's/test/home-
// behavioral.test.js's established Playwright/node:test conventions
// (seedHomeUser-shaped helpers, mockTokenStatus, blockThirdParty) rather
// than inventing a new one.

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

function newMobileContext(extraOpts) {
  return browser.newContext(Object.assign({ viewport: MOBILE_VIEWPORT }, extraOpts || {}));
}

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
  });
}

/** Mocks GET get-feed.js -- defaults to empty (Get Inspired hidden) unless `feed` is passed. */
function mockFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
  });
}

function makeFeedDream(id, extra) {
  return Object.assign({
    id: id,
    ownerHandle: '@stranger_' + id,
    caption: 'a dream about ' + id,
    storyText: 'a dream about ' + id,
    style: 'Cinematic',
    likes: 12,
    isPublished: true,
    createdAt: Date.now() - 100000,
    videoUrl: null,
    imageUrl: null
  }, extra || {});
}

/** Seeds a logged-in account directly into localStorage and navigates to home.html -- same shape as test/home-behavioral.test.js's own seedHomeUser. */
async function seedHomeUser(page, opts) {
  opts = opts || {};
  var username = opts.username || 'tester';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {
      user: { handle: '@' + args.username, username: args.username },
      accounts: {},
      draft: {},
      dreams: args.dreams || []
    };
    state.accounts[args.username] = Object.assign({ password: 'testpass1', email: args.username + '@example.com', noRecallDates: args.noRecallDates || [] }, args.accountExtra || {});
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreams: opts.dreams, noRecallDates: opts.noRecallDates, accountExtra: opts.accountExtra });
  if (opts.skipNav) return;
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

function makeDream(id, extra) {
  return Object.assign({
    id: id,
    ownerHandle: '@tester',
    caption: 'A dream about ' + id,
    storyText: 'A dream about ' + id,
    style: 'Cinematic',
    videoUrl: 'https://example.com/' + id + '.mp4',
    isPublished: false,
    likes: 0,
    createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000
  }, extra || {});
}

// ============================================================================
// 1. TIP OF THE DAY
// ============================================================================

test('home.html: Tip of the day shows the first (unseen-first) tip on a brand-new account, and tapping advances through each tip exactly once before the cycle restarts', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'tiptester1', dreams: [] });
    await page.waitForSelector('#tipsect', { state: 'visible', timeout: 5000 });

    var seenTexts = [];
    for (var i = 0; i < 10; i++) {
      seenTexts.push((await page.locator('#tip-text').textContent()).trim());
      await page.click('#tipcard');
      await page.waitForTimeout(250); // the .18s fade transition
    }
    // Every one of the 10 approved tips must have been shown, each exactly
    // once, before any repeats (unseen-first rotation).
    assert.equal(new Set(seenTexts).size, 10, 'expected 10 distinct tips shown before any repeat, got: ' + JSON.stringify(seenTexts));

    // The 11th tap (cycle restart) must land back on the very first tip.
    var eleventh = (await page.locator('#tip-text').textContent()).trim();
    assert.equal(eleventh, seenTexts[0], 'the cycle must restart at the first tip once all 10 have been seen');
  } finally {
    await context.close();
  }
});

test('home.html: the tip rotation is per-account and account-scoped in localStorage, not device-level or unscoped (recurring-pattern-new-features-re-introd-dhfty9)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'scopedtipuser', dreams: [] });
    await page.waitForSelector('#tipsect', { state: 'visible', timeout: 5000 });

    // Advance this account's rotation a few times.
    await page.click('#tipcard'); await page.waitForTimeout(250);
    await page.click('#tipcard'); await page.waitForTimeout(250);
    var advancedTip = (await page.locator('#tip-text').textContent()).trim();

    // The seen-set/current-tip must live on THIS account's own record, not
    // a bare unscoped localStorage key -- verified directly against
    // js/store.js's own state shape.
    var scoped = await page.evaluate(function () {
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      var account = raw.accounts['scopedtipuser'];
      return { hasTipsSeenIds: Array.isArray(account.tipsSeenIds), hasCurrentId: typeof account.tipCurrentId === 'string' };
    });
    assert.equal(scoped.hasTipsSeenIds, true, 'the seen-set must live on state.accounts[username], the established per-account pattern');
    assert.equal(scoped.hasCurrentId, true);

    // A DIFFERENT account on the same browser starts its own fresh rotation
    // (the first tip again), not wherever the first account's rotation left off.
    await seedHomeUser(page, { username: 'anotherscopedtipuser', dreams: [] });
    await page.waitForSelector('#tipsect', { state: 'visible', timeout: 5000 });
    var freshAccountTip = (await page.locator('#tip-text').textContent()).trim();
    assert.notEqual(freshAccountTip, advancedTip, 'a different account must not inherit the first account\'s rotation position');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. GET INSPIRED
// ============================================================================

test('home.html: Get inspired renders up to 6 public dreams from the shared feed, excludes the signed-in account\'s OWN dreams, and tapping a tile opens it in Explore', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var feed = [];
    for (var i = 1; i <= 8; i++) feed.push(makeFeedDream('pub' + i));
    // One of the feed entries belongs to the signed-in account itself --
    // getSharedFeed() marks this via `mine`, computed against the CURRENT
    // user's handle (js/store.js's own doc comment) -- must never appear
    // in Get Inspired (that's what My dreams / Consider publishing are for).
    feed.push(makeFeedDream('myownpublished', { ownerHandle: '@insptester', mine: true }));
    await mockFeed(page, feed);
    await seedHomeUser(page, { username: 'insptester', dreams: [] });

    await page.waitForSelector('#inspired', { state: 'visible', timeout: 5000 });
    var count = await page.locator('#inspired-row .insp-tile').count();
    assert.equal(count, 6, 'expected the carousel capped at ~6 tiles');

    var firstTileId = await page.locator('#inspired-row .insp-tile').first().getAttribute('data-dream-id');
    assert.notEqual(firstTileId, 'myownpublished', 'the signed-in account\'s own dream must never appear in Get Inspired');

    await Promise.all([
      page.waitForURL(/explore\.html\?id=/, { timeout: 5000, waitUntil: 'domcontentloaded' }),
      page.locator('#inspired-row .insp-tile').first().click()
    ]);
  } finally {
    await context.close();
  }
});

test('home.html: Get inspired is hidden entirely when the shared feed has nothing to show -- no empty-state placeholder', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'emptyfeedtester', dreams: [] });
    await page.waitForSelector('#tipsect', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#inspired').isVisible(), false, 'the whole section must be omitted, not shown empty');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3. CONSIDER PUBLISHING A DREAM
// ============================================================================

test('home.html: Consider publishing shows the account\'s own unpublished dreams and omits already-published ones; tapping a tile opens that dream\'s own room', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, {
      username: 'unpubtester',
      dreams: [
        makeDream('unpub-1', { ownerHandle: '@unpubtester', isPublished: false }),
        makeDream('pub-1', { ownerHandle: '@unpubtester', isPublished: true })
      ]
    });

    await page.waitForSelector('#unpub', { state: 'visible', timeout: 5000 });
    var ids = await page.locator('#unpub-row .insp-tile').evaluateAll(function (els) { return els.map(function (e) { return e.dataset.dreamId; }); });
    assert.deepEqual(ids, ['unpub-1'], 'only the unpublished dream must appear -- the already-published one is excluded');

    var badge = await page.locator('#unpub-row .insp-tile .pbadge').textContent();
    assert.match(badge, /Private/i);

    await Promise.all([
      page.waitForURL(/result\.html\?id=unpub-1/, { timeout: 5000, waitUntil: 'domcontentloaded' }),
      page.locator('#unpub-row .insp-tile').first().click()
    ]);
  } finally {
    await context.close();
  }
});

test('home.html: Consider publishing is omitted entirely when the account has nothing unpublished -- no empty-state placeholder', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'nounpubtester', dreams: [makeDream('all-published', { ownerHandle: '@nounpubtester', isPublished: true })] });
    await page.waitForSelector('#tipsect', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#unpub').isVisible(), false);
  } finally {
    await context.close();
  }
});

test('home.html: Consider publishing never duplicates whichever dream the embedded room card already owns', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    // Tonight's own dream is unpublished and already finished -- shouldShowRoomCard()
    // makes #day0-card own it; Consider publishing must not ALSO show it.
    var tonightDream = makeDream('tonight-unpub', { ownerHandle: '@noduptester', createdAt: Date.now(), isPublished: false });
    var olderUnpub = makeDream('older-unpub', { ownerHandle: '@noduptester', createdAt: Date.now() - 5 * 24 * 60 * 60 * 1000, isPublished: false });
    await seedHomeUser(page, { username: 'noduptester', dreams: [tonightDream, olderUnpub] });

    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('#unpub', { state: 'visible', timeout: 5000 });
    var ids = await page.locator('#unpub-row .insp-tile').evaluateAll(function (els) { return els.map(function (e) { return e.dataset.dreamId; }); });
    assert.deepEqual(ids, ['older-unpub'], 'the embedded card\'s own dream must never also appear in Consider publishing');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 4. MAKE IT YOURS — accordion mechanics + the claim round trip
// ============================================================================

test('home.html: Make-it-yours rows are a real accordion -- only one open at a time -- and the copy-link row copies the page URL and shows a confirmation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'accordiontester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    await page.click('#mky-install-row');
    assert.equal(await page.locator('#mky-item-install').evaluate(function (el) { return el.classList.contains('open'); }), true);

    await page.click('#mky-bookmark-row');
    assert.equal(await page.locator('#mky-item-install').evaluate(function (el) { return el.classList.contains('open'); }), false, 'opening a second row must close the first -- one open at a time');
    assert.equal(await page.locator('#mky-item-bookmark').evaluate(function (el) { return el.classList.contains('open'); }), true);
    var bookmarkText = await page.textContent('#mky-bookmark-exp');
    assert.match(bookmarkText, /Bookmark|Safari|Chrome|⌘D|Ctrl\+D/i, 'expected real bookmark instructions');

    await page.click('#mky-copy-row');
    assert.equal(await page.locator('#mky-item-bookmark').evaluate(function (el) { return el.classList.contains('open'); }), false);
    assert.equal(await page.locator('#mky-copied').isHidden(), false, 'expected the "Link copied" confirmation after opening the copy-link row');
    var clipboardText = await page.evaluate(function () { return navigator.clipboard.readText(); });
    assert.equal(clipboardText, page.url());
  } finally {
    await context.close();
  }
});

test('home.html: the +100 claim button stays disabled until a verified install, then a successful claim credits tokens, shows the done-state, and the whole card is gone on the next visit', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Stateful balance -- the real flow re-fetches get-token-status.js
    // AFTER a successful claim (refreshTokenStatus(false)), so the mock
    // must reflect the real server-side credit the second time around,
    // not the same static pre-claim number both times.
    var currentBalance = 220;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: currentBalance, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
    });
    await mockFeed(page, []);
    var claimCalls = [];
    await page.route('**/.netlify/functions/claim-install-bonus', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      currentBalance = 320;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, balance: 320 }) });
    });
    // Simulate a standalone-display-mode launch BEFORE any page script runs
    // -- the exact same client-attested verified-install signal js/pwa.js
    // reads (PwaInstall.isStandalone()), same technique test/a2hs-install-
    // nudge-journey-behavioral.test.js's own forceStandalone uses.
    await page.addInitScript(function () {
      var real = window.matchMedia ? window.matchMedia.bind(window) : null;
      window.matchMedia = function (q) {
        if (String(q).indexOf('display-mode') !== -1) return { matches: true, media: q, addListener: function () {}, removeListener: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
        return real ? real(q) : { matches: false, media: q };
      };
    });
    await seedHomeUser(page, { username: 'claimflowtester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    assert.equal(await page.locator('#mky-claim').isDisabled(), false, 'standalone launch must have already verified the install and enabled the claim');
    assert.equal(await page.locator('#mky-install-check').isHidden(), false);

    await page.click('#mky-claim');
    await page.waitForTimeout(500);
    assert.equal(claimCalls.length, 1);
    assert.equal(claimCalls[0].email, 'claimflowtester@example.com');
    assert.equal(await page.locator('#mky-live').isHidden(), true, 'the live accordion state must be replaced by the done-state');
    assert.equal(await page.locator('#mky-done').isHidden(), false);
    var doneText = await page.textContent('#mky-done');
    assert.match(doneText, /claimed/i);

    // The ritual module's balance re-fetches and reflects the credited amount.
    await page.waitForFunction(function () {
      var el = document.getElementById('ritual-balance');
      return el && /320/.test(el.textContent);
    }, null, { timeout: 5000 });

    // Reload -- the whole card is gone, per the mock's own "won't be here next visit".
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav-icon', { timeout: 5000 });
    assert.equal(await page.locator('#mky').isVisible(), false);
  } finally {
    await context.close();
  }
});

test('claim-install-bonus.js: a repeat claim for the same account reports granted:false and never double-credits (server-side once-per-account marker)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    var callCount = 0;
    await page.route('**/.netlify/functions/claim-install-bonus', function (route) {
      callCount++;
      // Real endpoint behavior: granted only the first time, false after.
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: callCount === 1, balance: 320 }) });
    });
    await page.addInitScript(function () {
      var real = window.matchMedia ? window.matchMedia.bind(window) : null;
      window.matchMedia = function (q) {
        if (String(q).indexOf('display-mode') !== -1) return { matches: true, media: q };
        return real ? real(q) : { matches: false, media: q };
      };
    });
    await seedHomeUser(page, { username: 'doubleclaimtester', dreams: [] });
    await page.waitForSelector('#mky-claim:not([disabled])', { state: 'visible', timeout: 5000 });

    var result = await page.evaluate(function () { return DreamStore.claimInstallBonus(); });
    assert.equal(result.granted, true);
    var second = await page.evaluate(function () { return DreamStore.claimInstallBonus(); });
    assert.equal(second.granted, false, 'a second claim for the same account must report granted:false, never a second credit');
    assert.equal(callCount, 2);
  } finally {
    await context.close();
  }
});

// ============================================================================
// 6. DOCK REBALANCE
// ============================================================================

test('home.html: the shared night dock renders the Home tab prominent + glowing and the "+" as a quiet 40px ring, via the ONE shared js/bottom-nav.js renderer', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'dockrebalancetester', dreams: [] });
    await page.waitForSelector('.night-dock', { timeout: 5000 });

    var homeBox = await page.locator('#nav-home').boundingBox();
    var createBox = await page.locator('.night-dock-create').boundingBox();
    assert.ok(Math.abs(homeBox.width - 72) < 1.5, 'the Home tab must be the wider, prominent 72px treatment, got ' + homeBox.width);
    assert.ok(Math.abs(createBox.width - 40) < 1.5 && Math.abs(createBox.height - 40) < 1.5, 'the create button must be the quiet 40px ring, got ' + createBox.width + 'x' + createBox.height);

    var homeIconGlow = await page.locator('#nav-home .nav-icon').evaluate(function (el) { return getComputedStyle(el).filter; });
    assert.notEqual(homeIconGlow, 'none', 'the Home tab icon must carry the soft glow drop-shadow');

    // A page where Home is NOT the active tab still gets the prominent
    // treatment -- the whole point is enticing a visitor back to Home from
    // wherever else they are (explore.html/profile.html/result.html), same
    // shared renderer.
  } finally {
    await context.close();
  }
});

test('explore.html and profile.html also render the Home tab prominent via the same shared dock renderer (no per-page drift)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'crosspagedocktester', dreams: [], skipNav: true });

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.night-dock', { timeout: 5000 });
    var exploreHomeBox = await page.locator('#nav-home').boundingBox();
    assert.ok(Math.abs(exploreHomeBox.width - 72) < 1.5, 'explore.html must show the same prominent Home tab, got ' + exploreHomeBox.width);
    var exploreCreateBox = await page.locator('.night-dock-create').boundingBox();
    assert.ok(Math.abs(exploreCreateBox.width - 40) < 1.5, 'explore.html must show the same quiet 40px + ring');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 7. LOGGED HERO SHOWS THE DREAM + THE MULTI-DREAM CHIP
// ============================================================================

test('home.html: the "2 dreams tonight" chip shows on the embedded room card once a second same-day dream exists, and stays hidden for a single dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);

    // Single dream tonight -- chip hidden.
    await seedHomeUser(page, { username: 'onedreamtester', dreams: [makeDream('only-tonight', { ownerHandle: '@onedreamtester', createdAt: Date.now() })] });
    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    assert.equal(await page.locator('#d0-chip').isHidden(), true);

    // Two dreams tonight -- chip shows, on the newest (the embedded card
    // already always shows the newest per shouldShowRoomCard/renderDay0Card).
    var older = makeDream('today-older', { ownerHandle: '@twodreamstester', createdAt: Date.now() - 3600000 });
    var newer = makeDream('today-newer', { ownerHandle: '@twodreamstester', createdAt: Date.now() - 1000 });
    await seedHomeUser(page, { username: 'twodreamstester', dreams: [newer, older] });
    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    assert.equal(await page.locator('#d0-chip').isHidden(), false);
    assert.match(await page.locator('#d0-chip').textContent(), /2 dreams tonight/);

    // The OTHER same-day dream still appears in My dreams, never duplicated.
    await page.waitForSelector('#dreams', { state: 'visible', timeout: 5000 });
    var rowHrefs = await page.locator('#dreams-row a.dream-row-tile').evaluateAll(function (els) { return els.map(function (e) { return e.getAttribute('href'); }); });
    assert.deepEqual(rowHrefs, ['result.html?id=today-older']);
  } finally {
    await context.close();
  }
});

// ============================================================================
// 8. STATES/PULSE RULE — the new sections never pulse
// ============================================================================

test('home.html: none of the four new round-4 sections ever carry the .pulse class -- the single pulse stays on the Tonight/Chamber pill only', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var feed = [makeFeedDream('pulsecheckfeed1')];
    await mockFeed(page, feed);
    await seedHomeUser(page, { username: 'pulsechecktester', dreams: [makeDream('pulsecheckunpub', { ownerHandle: '@pulsechecktester', isPublished: false })] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    var pulsingCount = await page.locator('#tipcard.pulse, #inspired .pulse, #unpub .pulse, #mky .pulse, #mky-claim.pulse, .ritual-claim.pulse').count();
    assert.equal(pulsingCount, 0, 'none of the four new round-4 sections may ever carry the .pulse class');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 5. TOKEN ICON A — home.html-specific surfaces (the shared topbar-chip
// piece is already proven by test/profile-night-restyle-behavioral.
// test.js, since it's the SAME js/purchase-sheet.js renderer)
// ============================================================================

test('home.html: TOKEN ICON A (the shared coin+play SVG) renders in the topbar chip, the ritual module\'s balance line, and the Make-it-yours reward line -- never the old "✦" text glyph', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 340, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'tokeniconhometester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    await page.waitForFunction(function () {
      var el = document.getElementById('ritual-balance');
      return el && /340/.test(el.textContent);
    }, null, { timeout: 5000 });

    assert.equal(await page.locator('#home-tok-chip-slot .token-chip-star svg').count(), 1, 'expected the real inline token-icon SVG in the topbar chip');
    assert.equal(await page.locator('#ritual-balance .tok-ico svg').count(), 1, 'expected the real inline token-icon SVG in the ritual module\'s balance line');
    assert.equal(await page.locator('.mky-reward .tok-ico svg').count(), 1, 'expected the real inline token-icon SVG in the Make-it-yours reward line');

    var bodyText = await page.locator('#app').innerText();
    assert.doesNotMatch(bodyText, /✦/, 'the old tilted-square glyph must be gone everywhere on this page');
  } finally {
    await context.close();
  }
});
