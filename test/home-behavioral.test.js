// test/home-behavioral.test.js
//
// Behavioral coverage for home.html — the new logged-in landing page
// (tracker item for-product-build-homepage-wave-1-the-ri-xr8mir,
// founder-approved 2026-07-29). Follows this repo's established
// Playwright/node:test convention (test/ui-behavioral.test.js's
// seedLoggedInUserAt/mockTokenStatus shape, test/interp-analytics-
// behavioral.test.js's readPostHogCalls/captures shape) rather than
// inventing a new one.
//
// Deliberately seeds every dream's createdAt as "now" (or "now minus a
// few ms/hours", same calendar day) rather than reaching for a specific
// day-of-week — home.html's "This Week" window is Monday-anchored (see
// js/store.js's startOfWeekMs), and "today" is by definition always
// inside the current week regardless of which real day the test suite
// happens to run on, so same-day timestamps sidestep week-boundary
// flakiness entirely. The one "yesterday" case (silent streak freeze) is
// a plain 24h-back offset, independent of week alignment.

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

/** Intercepts get-token-status.js's underlying fetch, same convention as test/ui-behavioral.test.js's own helper. */
function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

/**
 * Seeds js/store.js's localStorage state with a logged-in account, an
 * optional set of dreams and noRecallDates, then navigates to home.html.
 * dreams/noRecallDates left undefined seeds a genuinely brand-new (D1)
 * account with nothing logged yet.
 */
async function seedHomeUser(page, opts) {
  opts = opts || {};
  var username = opts.username || 'tester';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {};
    // freshState clears any state a PRIOR seedHomeUser call on this same
    // page/context already wrote -- otherwise this (like every real
    // DreamStore write) only ever APPENDS to state.dreams, and a second
    // seed reusing the same dream ids would double-count them.
    if (!args.freshState) {
      var raw = localStorage.getItem('dreamtube_state_v1');
      state = raw ? JSON.parse(raw) : {};
    }
    state.user = { handle: '@' + args.username, username: args.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[args.username] = {
      password: 'testpass1',
      email: args.username + '@example.com',
      noRecallDates: args.noRecallDates || []
    };
    if (!state.dreams) state.dreams = [];
    // js/store.js's load() unconditionally reads parsed.draft.characterIds
    // -- a state object missing `draft` entirely (only possible here, with
    // freshState, since every real write always goes through this file's
    // own seed()) throws and falls into load()'s catch-all, which resets
    // EVERYTHING including state.user. Real state always has this key;
    // keep this stub the same shape.
    if (!state.draft) state.draft = {};
    (args.dreams || []).forEach(function (d) { state.dreams.push(d); });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreams: opts.dreams, noRecallDates: opts.noRecallDates, freshState: !!opts.freshState });
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
    createdAt: Date.now()
  }, extra || {});
}

function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}
function captures(phCalls, eventName) {
  return phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === eventName; });
}

test('home.html redirects to login.html when not authenticated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/login\.html/, { timeout: 5000, waitUntil: 'domcontentloaded' });
  } finally {
    await context.close();
  }
});

test('home.html: a brand-new (D1) account sees the D1 next-step strip, real entry buttons, and neutral "start your streak" copy -- never a punitive missed-day message anywhere on the page', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: true, nextClaimAt: 0, dailyClaimAmount: 100, streak: 0 });
    await seedHomeUser(page, {});

    await page.waitForSelector('#next-strip', { timeout: 5000 });
    var stripText = await page.locator('#next-strip').textContent();
    assert.match(stripText, /new here/i);

    assert.equal(await page.locator('#today-entrybtns').isVisible(), true);
    assert.equal(await page.locator('#btn-write').isVisible(), true);
    assert.equal(await page.locator('#btn-speak').isVisible(), true);
    assert.equal(await page.locator('#btn-norecall').isVisible(), true);

    var streakLabel = await page.locator('#streak-label').textContent();
    assert.match(streakLabel, /start your dream capture streak/i);

    var bodyText = await page.locator('#app').textContent();
    assert.doesNotMatch(bodyText, /broke|lost your streak|reset to zero/i, 'the page must never show a punitive missed-day message -- silent freeze means silent');
  } finally {
    await context.close();
  }
});

test('home.html: an account with only a LEGACY dream (no createdAt field) is never shown the brand-new-user "New here?" hint -- getDreamLogStatus\'s hasEverLogged must not require createdAt (tracker item for-product-home-screen-spec-drift-from--575djz, fix 4)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 300, claimable: true, nextClaimAt: 0, dailyClaimAmount: 20, streak: 4 });
    // makeDream's createdAt:undefined is dropped entirely by JSON.stringify
    // in seedHomeUser -- same shape as a real dream saved before the
    // createdAt field existed (see finalizeDream's own doc comment).
    await seedHomeUser(page, { dreams: [makeDream('legacy-1', { createdAt: undefined })] });

    await page.waitForSelector('#next-strip', { timeout: 5000 });
    var stripText = await page.locator('#next-strip').textContent();
    assert.doesNotMatch(stripText, /new here/i, 'an account with a real (if undated) logged dream must never see the D1 brand-new-user hint');
    assert.match(stripText, /more this week/i, 'a returning-user strip shape should show instead -- the legacy dream just cannot be date-bucketed into this week\'s count');
  } finally {
    await context.close();
  }
});

test('home.html: tapping "No recall" logs today without any token/claim call, flips the Today card to the logged state, and updates the next-step strip', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 3 });
    var claimCalled = false;
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      claimCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: false, nextClaimAt: 0 }) });
    });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#btn-norecall', { timeout: 5000 });
    await page.click('#btn-norecall');

    await page.waitForSelector('#today-logged-row', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#today-entrybtns').isVisible(), false, 'entry buttons should hide once today is logged');
    var loggedRowText = await page.locator('#today-logged-row').textContent();
    assert.match(loggedRowText, /no recall.*counts too/i);

    var stripText = await page.locator('#next-strip').textContent();
    assert.match(stripText, /more this week/i, 'a returning-shape strip (not the D1 one) should show once something has been logged');

    assert.equal(claimCalled, false, 'logging "no recall" must never call the token-claim endpoint -- it grants nothing');

    // Persists across a reload (real store.js write, not just in-memory JS state).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#today-logged-row', { state: 'visible', timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('home.html: This Week card stays in the exact same grid slot across locked -> earned states (founder amendment: cards never change position)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });

    // Locked state: 1 of 3.
    await seedHomeUser(page, { dreams: [makeDream('wk-1')] });
    await page.waitForSelector('#card-week', { timeout: 5000 });
    var cardIds = await page.locator('#home-grid > *').evaluateAll(function (els) { return els.map(function (e) { return e.id; }); });
    var lockedIndex = cardIds.indexOf('card-week');
    assert.ok(lockedIndex !== -1, 'card-week must be present');
    assert.equal(await page.locator('#card-week').getAttribute('class'), 'hcard span2', 'locked state should not yet carry the week-earned class');
    var lockedText = await page.locator('#week-body').textContent();
    assert.match(lockedText, /1 of 3/);

    // Earned state: 3 of 3, same account, more dreams -- freshState avoids
    // double-counting the 'wk-1' dream seeded above into a 4th entry.
    await seedHomeUser(page, { dreams: [makeDream('wk-1'), makeDream('wk-2'), makeDream('wk-3')], freshState: true });
    await page.waitForSelector('#card-week', { timeout: 5000 });
    var cardIdsAfter = await page.locator('#home-grid > *').evaluateAll(function (els) { return els.map(function (e) { return e.id; }); });
    var earnedIndex = cardIdsAfter.indexOf('card-week');
    assert.equal(earnedIndex, lockedIndex, 'card-week must occupy the exact same index in the grid in both states');
    assert.equal(cardIdsAfter.length, cardIds.length, 'the total number of top-level cards must not change between states');
    var earnedClass = await page.locator('#card-week').getAttribute('class');
    assert.match(earnedClass, /week-earned/);
    var earnedText = await page.locator('#week-body').textContent();
    assert.match(earnedText, /3 dreams this week/i);
    assert.match(earnedText, /cinematic/i, 'the earned summary should reflect the REAL seeded style, not fabricated text');
  } finally {
    await context.close();
  }
});

test('home.html: My Dreams gallery renders real thumbnails linking to result.html and an "All my dreams" link to profile.html; shows an empty state with none', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [makeDream('md-1'), makeDream('md-2')] });

    await page.waitForSelector('#mydreams-thumbs a.thumb', { timeout: 5000 });
    var hrefs = await page.locator('#mydreams-thumbs a.thumb').evaluateAll(function (els) { return els.map(function (e) { return e.getAttribute('href'); }); });
    assert.equal(hrefs.length, 2);
    hrefs.forEach(function (h) { assert.match(h, /^result\.html\?id=md-/); });
    var allLinkHref = await page.locator('#card-mydreams .alllink').getAttribute('href');
    assert.equal(allLinkHref, 'profile.html');

    // Empty case, fresh account.
    await seedHomeUser(page, { username: 'emptytester', dreams: [] });
    await page.waitForSelector('#mydreams-empty', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#mydreams-thumbs').isVisible(), false);
  } finally {
    await context.close();
  }
});

// Regression coverage for the My Dreams carousel blank/black video-tile bug
// (tracker item for-product-home-screen-spec-drift-from--575djz, fix 5).
// Follows test/processing-preview-video-blank-tile-fallback-behavioral.
// test.js's pattern of stalling the video's own network request (so no
// loadeddata/playing/error can ever fire -- the exact real-world shape of
// a slow network or blocked autoplay) rather than just asserting on
// markup, but adapted to what home.html's fix actually IS: unlike
// processing.html, home.html has no load-timeout fallback (out of scope
// for this round -- see the tracker item's review notes) -- its fix is
// preload="metadata" (never fetches zero bytes, unlike the old
// preload="none") plus thumbVideoObserver actually calling play() once a
// thumb scrolls into view. So this asserts the mechanism of the fix
// directly: the attribute regression class (preload="none" reintroduced)
// and the behavioral regression class (no observer/no play() call ever
// wired up) would each independently be caught here.
function stallHomeThumbVideoRequest(page) {
  return page.route('**/mock-home-thumb-video.mp4', function () { /* deliberately never fulfilled -- stalled network, matching the real bug's shape */ });
}

test('home.html: My Dreams carousel video thumb uses preload="metadata" (never "none") and its IntersectionObserver actually calls play() once the thumb is visible -- regression coverage for the blank/black tile bug', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stallHomeThumbVideoRequest(page);
    // Installed before any page script runs (Playwright guarantee for
    // addInitScript), so this wraps HTMLMediaElement.prototype.play before
    // home.html's own thumbVideoObserver ever gets a chance to call it --
    // records real invocations rather than inferring them from a decoded
    // frame that a stalled request can never produce.
    await page.addInitScript(function () {
      window.__thumbPlayCalls = 0;
      var origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this.classList && this.classList.contains('thumb-video')) window.__thumbPlayCalls++;
        return origPlay.apply(this, arguments);
      };
    });
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [makeDream('vid-1', { videoUrl: baseUrl + '/mock-home-thumb-video.mp4' })] });

    await page.waitForSelector('#mydreams-thumbs video.thumb-video', { timeout: 5000 });

    // Attribute regression guard: the original bug was preload="none",
    // which never fetches enough to decode a frame at all.
    var preload = await page.locator('#mydreams-thumbs video.thumb-video').getAttribute('preload');
    assert.equal(preload, 'metadata', 'must never regress back to preload="none" -- that alone caused the blank/black tile');

    // Behavioral regression guard: force the intersection (scrolled fully
    // into view) and confirm the observer's callback really did invoke
    // play() on this exact element -- the request is still stalled at this
    // point, so this would NOT pass merely because the video happened to
    // have decoded a frame on its own.
    await page.locator('#mydreams-thumbs video.thumb-video').scrollIntoViewIfNeeded();
    await page.waitForFunction(function () { return window.__thumbPlayCalls > 0; }, null, { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('home.html: Chamber card\'s fallback href points at result.html for a completed dream (no ?openInterp=1 -- that mechanism is gone), and at create.html when there is nothing to interpret yet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });

    await seedHomeUser(page, { dreams: [makeDream('ch-1')] });
    await page.waitForSelector('#card-chamber', { timeout: 5000 });
    var href = await page.locator('#card-chamber').getAttribute('href');
    assert.equal(href, 'result.html?id=ch-1');

    await seedHomeUser(page, { username: 'nodreamsyet', dreams: [] });
    await page.waitForSelector('#card-chamber', { timeout: 5000 });
    var href2 = await page.locator('#card-chamber').getAttribute('href');
    assert.equal(href2, 'create.html');
  } finally {
    await context.close();
  }
});

test('home.html: Chamber card, with a completed dream, opens InterpretExperience directly ON THIS PAGE (no navigation away) -- Interpretation Wave 1, tracker item for-product-build-interpretation-wave-1--xuftyn', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [makeDream('ch-itp-1')] });

    await page.waitForSelector('#card-chamber', { timeout: 5000 });
    await page.click('#card-chamber');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
    assert.equal(page.url(), baseUrl + '/home.html', 'must open the overlay in place, never navigate to result.html');

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'interp_surface_opened').length, 1);
  } finally {
    await context.close();
  }
});

test('home.html: Chamber card, with NO completed dream, still navigates to create.html normally (a real link, not intercepted)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { username: 'chambernodream', dreams: [] });

    await page.waitForSelector('#card-chamber', { timeout: 5000 });
    await page.click('#card-chamber');
    await page.waitForURL(/create\.html/, { timeout: 5000, waitUntil: 'domcontentloaded' });
  } finally {
    await context.close();
  }
});

test('home.html: home_chamber_href_computed fires at render time (not gated on a click) with the branch actually taken and the resolved href -- diagnostic added for tracker item for-product-bug-founder-new-home-tapping-yuspxa (founder tapped Chamber, landed in the store; every hypothesis traced statically came back unsupported, so this is the concrete signal a recurrence would need)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });

    // Completed-dream branch -- never click the card, since this must fire
    // purely from href computation, matching what actually happened on the
    // live bug (the tap already landed somewhere before any click handler
    // could matter).
    await seedHomeUser(page, { dreams: [makeDream('ch-2')] });
    await page.waitForSelector('#card-chamber', { timeout: 5000 });
    var calls1 = await readPostHogCalls(page);
    var fired1 = captures(calls1, 'home_chamber_href_computed');
    assert.equal(fired1.length, 1, 'expected exactly one home_chamber_href_computed capture on load');
    assert.deepEqual(fired1[0][2], { branch: 'completed_dream', href: 'result.html?id=ch-2', dream_id: 'ch-2' });

    // No-completed-dream branch.
    await seedHomeUser(page, { username: 'nodreamsyet2', dreams: [] });
    await page.waitForSelector('#card-chamber', { timeout: 5000 });
    var calls2 = await readPostHogCalls(page);
    var fired2 = captures(calls2, 'home_chamber_href_computed');
    assert.equal(fired2.length, 1, 'expected exactly one home_chamber_href_computed capture on load');
    assert.deepEqual(fired2[0][2], { branch: 'no_completed_dream', href: 'create.html', dream_id: null });
  } finally {
    await context.close();
  }
});

test('home.html: Vault card shows the real token balance and links into shop.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 340, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForFunction(function () {
      var el = document.getElementById('vault-balance');
      return el && el.textContent === '340';
    }, null, { timeout: 5000 });
    var href = await page.locator('#card-vault').getAttribute('href');
    assert.equal(href, 'shop.html?source=home_vault_card');
  } finally {
    await context.close();
  }
});

test('home.html: bottom nav is Home (active) / +Create / Explore / Profile -- Explore stays one tap away, nothing existing lost', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('.bottom-nav', { timeout: 5000 });
    var labels = await page.locator('.bottom-nav > *').evaluateAll(function (els) {
      return els.map(function (e) { return (e.textContent || '').trim() || (e.classList.contains('nav-create') ? '+' : ''); });
    });
    assert.deepEqual(labels, ['Home', '+', 'Explore', 'Profile']);
    assert.equal(await page.locator('.bottom-nav .nav-item.active').textContent(), 'Home');
    var exploreHref = await page.locator('.bottom-nav a[href="explore.html"]').getAttribute('href');
    assert.equal(exploreHref, 'explore.html');
  } finally {
    await context.close();
  }
});

test('home.html: Write it / Speak it reuse create.html\'s EXISTING entry points via the same deep-link convention as ?record=1', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#btn-write', { timeout: 5000 });
    await page.click('#btn-write');
    await page.waitForURL(/create\.html\?write=1/, { timeout: 5000, waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#create-write').isVisible(), true, '?write=1 must land directly in Write mode');
  } finally {
    await context.close();
  }
});

test('home.html: Wizard is the first, primary entry button and reuses create.html\'s EXISTING chip-first "Build it" wizard via a ?build=1 deep-link (tracker item for-product-home-screen-spec-drift-from--575djz, fix 2 -- the founder-requested Wizard entry point that has a history of not surviving from mock into the live build)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#btn-wizard', { timeout: 5000 });
    assert.equal(await page.locator('#btn-wizard').isVisible(), true);
    assert.equal(await page.locator('#btn-wizard').getAttribute('class'), 'ebtn p', 'Wizard must carry the primary (.ebtn.p) treatment, same as the frozen spec\'s other primary actions');

    // DOM order: Wizard, Write, Speak, No recall -- Wizard leads as the
    // guided, primary path ahead of the three already-shipped manual entry
    // points (same #today-entrybtns row the D1/entry-button tests above
    // already assert on for visibility, but not yet on order).
    var entryIds = await page.locator('#today-entrybtns > *').evaluateAll(function (els) { return els.map(function (e) { return e.id; }); });
    assert.deepEqual(entryIds, ['btn-wizard', 'btn-write', 'btn-speak', 'btn-norecall']);

    await page.click('#btn-wizard');
    await page.waitForURL(/create\.html\?build=1/, { timeout: 5000, waitUntil: 'domcontentloaded' });

    // Not just a URL check -- confirm the actual chip-first wizard UI is
    // what's showing, same rigor as the ?write=1 test above confirming
    // #create-write. #choice-build's own click handler swaps the
    // Build/Write/Record choice screen (#create-select) out for the
    // chip-first build flow (#create-build); step 1 of 5 (subject chips)
    // is the first thing rendered into it.
    await page.waitForSelector('#create-build', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#create-select').isVisible(), false, 'the Build/Write/Record choice screen should be skipped entirely');
    var stepBodyText = await page.locator('#build-step-body').textContent();
    assert.match(stepBodyText, /step 1 of 5/i, 'must land showing the chip-first wizard\'s first step, not just an empty/generic build screen');
    assert.equal(await page.locator('#build-subject-chip-row').isVisible(), true, 'the chip row itself -- not just the step heading -- must be visible');
  } finally {
    await context.close();
  }
});

test('home.html: analytics -- home_viewed fires on load, home_today_entry_tapped fires for the no_recall tap, home_card_tapped fires on a card tap, and no event name or string prop is ever health/therapy-flavored', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#btn-norecall', { timeout: 5000 });
    var initialCalls = await readPostHogCalls(page);
    assert.equal(captures(initialCalls, 'home_viewed').length, 1);

    await page.click('#btn-norecall');
    await page.waitForSelector('#today-logged-row', { state: 'visible', timeout: 5000 });

    await page.click('#card-mydreams');

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'home_today_entry_tapped').length, 1);
    assert.equal(captures(phCalls, 'home_card_tapped').length >= 1, true);

    var allNames = phCalls.filter(function (e) { return e[0] === 'capture'; }).map(function (e) { return e[1]; });
    allNames.forEach(function (name) {
      assert.doesNotMatch(name, /therap|mental.?health|anxiety|depress|diagnos|sleep.?disorder/i, 'event name "' + name + '" must never be health/therapy-flavored');
    });
    // Every string PROPERTY VALUE too, not just event names -- copy like
    // "dream capture streak" is fine, but nothing health/therapy-flavored
    // should ever leak in as a prop value either (this app's ad-pixel
    // domain is scanned by Meta's health classifier).
    var allPropValues = phCalls.filter(function (e) { return e[0] === 'capture'; }).map(function (e) { return e[2] || {}; })
      .reduce(function (acc, props) { return acc.concat(Object.keys(props).map(function (k) { return props[k]; })); }, [])
      .filter(function (v) { return typeof v === 'string'; });
    allPropValues.forEach(function (v) {
      assert.doesNotMatch(v, /therap|mental.?health|anxiety|depress|diagnos|sleep.?disorder/i, 'prop value "' + v + '" must never be health/therapy-flavored');
    });
  } finally {
    await context.close();
  }
});

test('home.html: silent streak freeze -- a real gap since the last logged day fires home_streak_freeze_shown quietly, with no user-visible punitive message anywhere', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 5 });
    // Real dreams from 2 and 3 days ago -- NOT yesterday, NOT today -- so
    // the server-reported streak (5) implies a gap this page's own local
    // data confirms (loggedYesterday === false) without fabricating it.
    await seedHomeUser(page, {
      dreams: [
        makeDream('sf-1', { createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }),
        makeDream('sf-2', { createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000 })
      ]
    });

    await page.waitForFunction(function () {
      return window.posthog && typeof window.posthog.slice === 'function' && window.posthog.slice().some(function (e) { return e[0] === 'capture' && e[1] === 'home_streak_freeze_shown'; });
    }, null, { timeout: 5000 });

    var bodyText = await page.locator('#app').textContent();
    // Narrower than the D1 test's regex on purpose: this page's own
    // legitimate reassurance copy ("a quiet freeze protects a MISSED
    // night") contains the bare word "missed" -- these phrases are the
    // actual punitive shapes that copy must never take, not the word
    // itself.
    assert.doesNotMatch(bodyText, /you missed|broke your|lost your streak|reset to zero|streak reset/i, 'the freeze must stay silent -- no visible warning copy anywhere on the page');
  } finally {
    await context.close();
  }
});

test('home.html: the weekly-summary and streak-freeze analytics dedup flags are scoped per account, not just per date -- a second account sharing the same browser still fires its own first-time events (review finding, fixed)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // --- Account A earns the weekly summary + a streak freeze, same session ---
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 5 });
    await seedHomeUser(page, {
      username: 'homescopetesta',
      dreams: [
        makeDream('a-1', { ownerHandle: '@homescopetesta', createdAt: Date.now() }),
        makeDream('a-2', { ownerHandle: '@homescopetesta', createdAt: Date.now() - 1000 }),
        makeDream('a-3', { ownerHandle: '@homescopetesta', createdAt: Date.now() - 2000 }),
        // Gap dreams so loggedYesterday is false, matching the existing
        // streak-freeze test's own real-gap shape.
        makeDream('a-4', { ownerHandle: '@homescopetesta', createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 })
      ]
    });
    await page.waitForFunction(function () {
      var calls = window.posthog && typeof window.posthog.slice === 'function' ? window.posthog.slice() : [];
      var names = calls.filter(function (e) { return e[0] === 'capture'; }).map(function (e) { return e[1]; });
      return names.indexOf('home_weekly_summary_earned') !== -1 && names.indexOf('home_streak_freeze_shown') !== -1;
    }, null, { timeout: 5000 });

    // --- Account B logs in on the SAME browser/context (real shared-device
    // scenario, not a fresh browser.newPage() which would get isolated
    // storage and structurally can't reproduce this) and legitimately
    // earns the identical events for the first time ---
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 5 });
    await seedHomeUser(page, {
      username: 'homescopetestb',
      dreams: [
        makeDream('b-1', { ownerHandle: '@homescopetestb', createdAt: Date.now() }),
        makeDream('b-2', { ownerHandle: '@homescopetestb', createdAt: Date.now() - 1000 }),
        makeDream('b-3', { ownerHandle: '@homescopetestb', createdAt: Date.now() - 2000 }),
        makeDream('b-4', { ownerHandle: '@homescopetestb', createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 })
      ]
    });

    // Each full navigation gets a fresh in-page PostHog stub (its own
    // pending-call queue resets), so this checks Account B's OWN session
    // fired both events at least once -- NOT a cumulative count across
    // navigations. Before the account-scoping fix, this is exactly where
    // the bug bit: localStorage (unlike the in-page posthog stub) DOES
    // persist across navigation, so Account B's home.html would find
    // Account A's unscoped flag already set and silently skip firing
    // track() at all -- Account B's own fresh queue would stay empty for
    // both events forever.
    await page.waitForFunction(function () {
      var calls = window.posthog && typeof window.posthog.slice === 'function' ? window.posthog.slice() : [];
      var names = calls.filter(function (e) { return e[0] === 'capture'; }).map(function (e) { return e[1]; });
      return names.indexOf('home_weekly_summary_earned') !== -1 && names.indexOf('home_streak_freeze_shown') !== -1;
    }, null, { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('create.html: ?write=1 deep-link jumps straight into Write mode (mirrors the existing ?record=1 convention)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/create.html?write=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#create-write', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#create-select').isVisible(), false, 'the Build/Write/Record choice screen should be skipped entirely');
  } finally {
    await context.close();
  }
});

// The old ?openInterp=1 deep-link mechanism (result.html noticing a query
// param and synthesizing a click on its own pill) is GONE entirely --
// superseded by Interpretation Wave 1's "Chamber card opens
// InterpretExperience directly on home.html" tests above, and the surface
// itself is covered end-to-end by test/interp-analytics-behavioral.test.js.
// No dead code/dead test left behind for a mechanism that no longer exists.

test('login.html: a successful login now lands on home.html by default (was explore.html) -- an explicit ?next= override still wins', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      if (!state.accounts) state.accounts = {};
      state.accounts.logintester = { password: 'testpass1', email: 'logintester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    // js/store.js reads localStorage into its in-memory `state` ONCE at
    // page-load time -- writing straight to localStorage from here doesn't
    // retroactively update the already-running page's copy, so a reload is
    // needed before the login form can see this account (matches
    // test/meta-capi-behavioral.test.js's identical-purpose reload).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'logintester');
    await page.fill('#login-password', 'testpass1');
    await page.click('#login-submit');
    // A plain /home\.html/ regex would be satisfied by the query string of
    // an UNNAVIGATED login.html?next=... URL too (see the sibling test
    // below) -- match on pathname instead so this only passes on a real
    // navigation to home.html itself.
    await page.waitForURL(function (url) { return url.pathname === '/home.html'; }, { timeout: 5000, waitUntil: 'domcontentloaded' });
  } finally {
    await context.close();
  }
});

test('login.html: ?next= override still wins over the home.html default', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/login.html?next=' + encodeURIComponent('profile.html'), { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      if (!state.accounts) state.accounts = {};
      state.accounts.nexttester = { password: 'testpass1', email: 'nexttester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'nexttester');
    await page.fill('#login-password', 'testpass1');
    await page.click('#login-submit');
    // Pathname match, not a bare /profile\.html/ regex -- the STARTING url
    // itself is "login.html?next=profile.html", which already contains the
    // substring "profile.html" in its query string before any navigation
    // happens at all, so a substring/regex match here would pass even if
    // login never actually redirected anywhere (a real false-positive this
    // test tripped over during build).
    await page.waitForURL(function (url) { return url.pathname === '/profile.html'; }, { timeout: 5000, waitUntil: 'domcontentloaded' });
  } finally {
    await context.close();
  }
});
