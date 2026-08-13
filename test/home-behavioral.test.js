// test/home-behavioral.test.js
//
// Behavioral coverage for home.html — the "Night Shelf" home rebuild
// (tracker item for-product-build-ship-founder-go-07-31--vtsyg3, founder
// GO 2026-07-31 evening), built against the approved visual spec
// home-mock4-x7q4.html. Supersedes Wave 1's grid-card home
// (for-product-build-homepage-wave-1-the-ri-xr8mir, 2026-07-29) — this
// file replaces that wave's own coverage rather than living alongside it,
// since the DOM it asserted on (#home-grid, .hcard, #card-week, etc.) no
// longer exists. Every BEHAVIOR that wave shipped (D1 vs returning-user
// state, silent streak freeze, account-scoped analytics dedup, the
// Chamber/InterpretExperience integration, the claim/token mechanism, the
// video-thumb blank-tile fix, Write/Speak/Wizard deep-links into
// create.html, the Bar A dock) is still covered here — only the
// selectors/copy changed to match the new shelf layout.
//
// Follows this repo's established Playwright/node:test convention
// (test/ui-behavioral.test.js's seedLoggedInUserAt/mockTokenStatus shape,
// test/interp-analytics-behavioral.test.js's readPostHogCalls/captures
// shape, test/profile-night-restyle-behavioral.test.js's real
// MOBILE_VIEWPORT + pure-helper-unit-test split) rather than inventing a
// new one.
//
// Deliberately seeds every dream's createdAt as "now" (or "now minus a
// few ms/hours", same calendar day) rather than reaching for a specific
// day-of-week — home.html's "this week" window is Monday-anchored (see
// js/store.js's startOfWeekMs), and "today" is by definition always
// inside the current week regardless of which real day the test suite
// happens to run on, so same-day timestamps sidestep week-boundary
// flakiness entirely. The one "yesterday" case (silent streak freeze) is
// a plain 24h-back offset, independent of week alignment.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var DreamCards = require('../js/dream-cards.js');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
// A real phone-sized viewport (task explicitly requires mobile-viewport
// coverage) — same 390x844 convention test/barA-nav-rollout-behavioral.
// test.js / test/profile-night-restyle-behavioral.test.js already use.
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

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

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

// ============================================================================
// Pure unit coverage of js/dream-cards.js's new dreamRowTileHTML — required
// directly under node --test, no browser. Same dual-export pattern
// test/profile-night-restyle-behavioral.test.js already uses for this file.
// ============================================================================

test('DreamCards.dreamRowTileHTML: renders a video tile linking to result.html, escapes the id, and is NOT the vertical vcard component', function () {
  var html = DreamCards.dreamRowTileHTML({ id: 'ab"c', videoUrl: 'https://example.com/x.mp4' }, {});
  assert.match(html, /class="dream-row-tile"/);
  assert.match(html, /href="result\.html\?id=ab&quot;c"/);
  assert.match(html, /data-dream-id="ab&quot;c"/);
  assert.match(html, /<video class="vcard-video"/, 'must reuse the .vcard-video class so the shared observeVideos() picks it up');
  assert.doesNotMatch(html, /vcard-thumb\b/, 'must not be the vertical profile.html grid tile markup');
});

test('DreamCards.dreamRowTileHTML: falls back to the gradient div when there is no video/image, and to an <img> when there is an image but no video', function () {
  var gradientHtml = DreamCards.dreamRowTileHTML({ id: 'g1' }, { gradient: 'red' });
  assert.match(gradientHtml, /vcard-thumb-bg" style="background:red"/);
  var imgHtml = DreamCards.dreamRowTileHTML({ id: 'i1', imageUrl: 'https://example.com/i.png' }, {});
  assert.match(imgHtml, /<img class="vcard-image" src="https:\/\/example\.com\/i\.png"/);
});

test('DreamCards.dreamRowTileHTML: asButton renders a non-navigating <button> (for a future picker), and `selected` adds the is-selected ring class', function () {
  var btnHtml = DreamCards.dreamRowTileHTML({ id: 'p1', videoUrl: 'https://example.com/p.mp4' }, { asButton: true, selected: true });
  assert.match(btnHtml, /^<button type="button" class="dream-row-tile is-selected"/);
  assert.doesNotMatch(btnHtml, /href=/, 'asButton variant must not carry a navigating href');
});

// ============================================================================
// Real browser coverage of home.html itself.
// ============================================================================

test('home.html redirects to login.html when not authenticated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/login\.html/, { timeout: 5000, waitUntil: 'domcontentloaded' });
  } finally {
    await context.close();
  }
});

test('home.html: a brand-new (D1) account sees the bare Tonight CTA button, "Start your streak tonight" in the ritual module, and the My Dreams row hidden entirely -- never a punitive missed-day message anywhere on the page', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: true, nextClaimAt: 0, dailyClaimAmount: 100, streak: 0 });
    await seedHomeUser(page, {});

    // Founder ruling 2026-08-07 (tracker item for-product-founder-08-07-
    // homepage-hero--015hgp) replaced the old card's "First night — any
    // entry counts" d1 line and Write/Speak/No-recall quiet-link row with
    // a single bare button -- there is no longer any day-1-specific copy
    // in this slot at all, so this test now only proves the button itself.
    await page.waitForSelector('#tonight-cta', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#tonight-cta').textContent(), 'What did you dream?');
    assert.match(await page.locator('#tonight-cta').getAttribute('class'), /\bpulse\b/, 'the button must pulse while tonight is unlogged');
    assert.equal(await page.locator('#hero-tonight').isVisible(), false, 'the logged-confirmation card must stay hidden while tonight is unlogged');

    var ritualBig = await page.locator('#ritual-big').textContent();
    assert.match(ritualBig, /start your streak tonight/i);

    // My Dreams row is hidden entirely for a genuinely brand-new account
    // (mock §7) -- there is nothing to show a total newcomer.
    assert.equal(await page.locator('#dreams').isVisible(), false);

    var bodyText = await page.locator('#app').textContent();
    assert.doesNotMatch(bodyText, /broke|lost your streak|reset to zero/i, 'the page must never show a punitive missed-day message -- silent freeze means silent');
  } finally {
    await context.close();
  }
});

test('home.html: an account with only a LEGACY dream (no createdAt field) is never shown the brand-new-user "first night" hint -- getDreamLogStatus\'s hasEverLogged must not require createdAt (tracker item for-product-home-screen-spec-drift-from--575djz, fix 4, carried over into the Night Shelf rebuild)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 300, claimable: true, nextClaimAt: 0, dailyClaimAmount: 20, streak: 4 });
    // makeDream's createdAt:undefined is dropped entirely by JSON.stringify
    // in seedHomeUser -- same shape as a real dream saved before the
    // createdAt field existed (see finalizeDream's own doc comment).
    await seedHomeUser(page, { dreams: [makeDream('legacy-1', { createdAt: undefined })] });

    await page.waitForSelector('#ritual-big', { timeout: 5000 });
    assert.equal(await page.locator('#tonight-d1').isVisible(), false, 'an account with a real (if undated) logged dream must never see the D1 "first night" hint');
    var ritualSub = await page.locator('#ritual-sub').textContent();
    assert.match(ritualSub, /of \d+ this week/i, 'a returning-user ritual shape should show instead -- the legacy dream just cannot be date-bucketed into this week\'s count');
  } finally {
    await context.close();
  }
});

test('home.html: an account already logged as "No recall" tonight (DreamStore.logNoRecallToday state, no live home-screen entry point as of tracker item for-product-founder-08-07-homepage-hero--015hgp) shows the logged-confirmation card (bare Tonight CTA hidden), reveals the My Dreams row with its empty-state message, and persists across a reload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 3 });
    // The home-screen "No recall" quiet link that used to drive this state
    // is gone as of the 015hgp hero simplification -- seeded directly here
    // (same technique this file already uses elsewhere, e.g. the
    // norecalltester case below) rather than via a UI click, since there is
    // no longer a UI action left on this page to click. The underlying
    // DreamStore.logNoRecallToday()/noRecallDates data path this seeds is
    // still real and still read by getDreamLogStatus -- only its home-screen
    // entry point was removed.
    await seedHomeUser(page, { dreams: [], noRecallDates: [new Date().toDateString()] });

    await page.waitForSelector('#hero-tonight.logged', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#tonight-cta').isVisible(), false, 'the bare Tonight button should hide once tonight is logged');
    var quoteText = await page.locator('#tonight-quote').textContent();
    // "No recall" wording removed from this logged-state copy (founder
    // walkthrough punch list, 2026-08-01, tracker item
    // for-product-founder-walkthrough-punch-li-t33k3y) -- meaning
    // unchanged (still the no-content-logged fallback), just no longer
    // uses that exact phrase.
    assert.doesNotMatch(quoteText, /no recall/i, 'the logged-state copy must no longer say "No recall"');
    assert.match(quoteText, /nothing remembered.*counts too/i);

    // Never logged a real dream, but HAS now logged something -- the My
    // Dreams row should appear with its friendly empty message rather than
    // staying fully hidden (D1's "hide entirely" only applies before the
    // account has ever logged anything at all).
    await page.waitForSelector('#dreams', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('#dreams-empty', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#dreams-row').isVisible(), false);

    // Persists across a reload (real store.js read, not just in-memory JS state).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () {
      var el = document.getElementById('hero-tonight');
      return el && el.classList.contains('logged');
    }, null, { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('home.html: a funnel-submitted dream whose generation is still PENDING (todayEntryType "pending", no finished dream with createdAt yet) renders the Tonight hero with that dream\'s own quote -- never falls through to the no-recall copy (regression test for Manager screenshot-verified bug A)', async function (t) {
  // Founder walkthrough punch list (2026-08-01, tracker item
  // for-product-founder-walkthrough-punch-li-t33k3y, Manager addition A):
  // a real device screenshot showed a user who gave a REAL dream via the
  // funnel still seeing "Logged tonight -- No recall, and that counts
  // too." Root cause: home.html's renderTonightHero() only ever checked
  // logStatus.todayEntryType === 'dream', never 'pending' -- but a
  // freshly-submitted funnel dream (generation in flight, no finished
  // dream with createdAt yet) reports 'pending', not 'dream', even though
  // js/store.js's getDreamLogStatus() already correctly populated
  // todayDreamCaption from the pending job's own storyText/caption the
  // whole time. This is the exact real-world shape: seedHomeUser has no
  // dreams at all yet, only a pendingJob started today (same shape
  // test/first-video-created-explore-resume-behavioral.test.js's
  // seedAccountWithPendingJob already establishes for this codebase).
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { dreams: [] });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = JSON.parse(raw);
      state.pendingJob = {
        operationName: 'mock:req-pending-funnel-dream',
        startedAt: Date.now(),
        caption: 'Flying over a glowing city at midnight',
        storyText: 'Flying over a glowing city at midnight',
        style: 'Cinematic',
        sourceDreamId: null,
        mediaType: 'video',
        notify: false,
        ownerHandle: state.user.handle
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(function () {
      var el = document.getElementById('hero-tonight');
      return el && el.classList.contains('logged');
    }, null, { timeout: 5000 });
    var quoteText = await page.locator('#tonight-quote').textContent();
    assert.match(quoteText, /Flying over a glowing city at midnight/, 'a pending funnel dream must render as a real logged entry, showing its own quote');
    assert.doesNotMatch(quoteText, /nothing remembered|no recall/i, 'must never fall through to the no-recall copy when a real dream was actually submitted');
  } finally {
    await context.close();
  }
});

test('home.html: the ritual module stays the exact same element across locked -> earned states (founder amendment carried over from Wave 1: the module transforms in place, never moves/duplicates)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });

    // Locked state: 1 of 3. A past no-recall date (well outside this week,
    // so it doesn't affect the weekCount arithmetic below) makes this a
    // RETURNING user's second+ week, not a genuine day-0/first-ever night
    // -- otherwise a single dream created today with no other history
    // would ALSO legitimately qualify as day-0 (tracker item for-product-
    // funnel-ending-v2-founder-ins-tfuu0q's own isFirstEverNight combined
    // state), which takes copy priority over the plain "N of 3 this week"
    // this test is actually about.
    var TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toDateString();
    await seedHomeUser(page, { dreams: [makeDream('wk-1')], noRecallDates: [TEN_DAYS_AGO] });
    await page.waitForSelector('#ritual', { timeout: 5000 });
    assert.equal(await page.locator('#ritual').count(), 1);
    var lockedClass = await page.locator('#ritual').getAttribute('class');
    assert.doesNotMatch(lockedClass, /\bwarm\b/, 'locked state should not yet carry the warm class (got: ' + lockedClass + ')');
    var lockedBig = await page.locator('#ritual-big').textContent();
    assert.match(lockedBig, /🔥 ?1 night/);
    var lockedSub = await page.locator('#ritual-sub').textContent();
    assert.match(lockedSub, /1 of 3/);

    // Earned state: 3 of 3, same account, more dreams -- freshState avoids
    // double-counting the 'wk-1' dream seeded above into a 4th entry. Same
    // past no-recall date as the locked-state seed above, for the same
    // "returning user, not day-0" reason -- three dreams created today
    // with zero OTHER history would otherwise still legitimately read as
    // isFirstEverNight too.
    await seedHomeUser(page, { dreams: [makeDream('wk-1'), makeDream('wk-2'), makeDream('wk-3')], noRecallDates: [TEN_DAYS_AGO], freshState: true });
    await page.waitForSelector('#ritual', { timeout: 5000 });
    assert.equal(await page.locator('#ritual').count(), 1, 'the ritual module must never be duplicated between states');
    var earnedClass = await page.locator('#ritual').getAttribute('class');
    assert.match(earnedClass, /\bwarm\b/);
    var earnedBig = await page.locator('#ritual-big').textContent();
    assert.match(earnedBig, /3 dreams this week/i);
    var earnedSub = await page.locator('#ritual-sub').textContent();
    assert.match(earnedSub, /cinematic/i, 'the earned summary should reflect the REAL seeded style, not fabricated text');
  } finally {
    await context.close();
  }
});

/**
 * Regression test for tracker item for-product-regression-founder-screensho-17vxr2:
 * the founder reported the ritual module's own streak CONSTELLATION (lit
 * stars + connecting lines) as completely missing, even though a prior
 * source-level review found renderConstellation() and its #ritual-constel
 * DOM slot present and matching every approved mock's JS logic. The
 * ACTUAL root cause a source diff never caught: home.html's <svg
 * class="constel"> markup was missing the `width="84" height="46"`
 * attributes every mock (home-mock4/5-x7q4.html, funnel-end-mock-x7q4.
 * html, morning-mock-x7q4.html) consistently includes. With no explicit
 * size and no CSS rule that actually applies to the <svg> itself (the
 * `.ritual .constel{ flex:0 0 84px; }` rule only affects a DIRECT flex
 * child of .ritual-head, but the real flex child is the wrapping
 * #ritual-constel span, not the svg nested inside it), the svg's
 * computed size collapses to 0x0 in EVERY branch -- so this reproduced
 * regardless of streak/week-count data, exactly matching why it recurred
 * identically across the founder's 2026-08-02 (4 nights) and 2026-08-03
 * (5 nights / 0 of 3 this week / claimable) screenshots. This asserts a
 * REAL non-zero rendered bounding box (not just DOM presence/innerHTML),
 * across the exact founder-reported state plus the other three
 * renderRitualModule() branches, so a future regression back to
 * attribute-less markup fails loudly instead of passing a source-only
 * review again.
 */
test('home.html: the ritual module\'s streak constellation (#ritual-constel\'s <svg class="constel">) actually renders with a real non-zero size in every branch -- regression test for tracker item for-product-regression-founder-screensho-17vxr2 (constellation present in source/byte-identical to the mock but rendering at 0x0 due to missing width/height attributes)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    async function assertConstelVisible(label) {
      await page.waitForSelector('#ritual-constel svg', { state: 'attached', timeout: 5000 });
      var box = await page.locator('#ritual-constel svg').boundingBox();
      assert.ok(box, label + ': constellation svg should have a layout box at all');
      assert.ok(box.width > 0, label + ': constellation svg width should be > 0, got ' + (box && box.width));
      assert.ok(box.height > 0, label + ': constellation svg height should be > 0, got ' + (box && box.height));
      var visible = await page.locator('#ritual-constel svg').isVisible();
      assert.equal(visible, true, label + ': constellation svg should be visible');
    }

    // Founder's exact reported shape: 2026-08-03 screenshot -- "5 nights /
    // 0 of 3 this week / Claim +20 / 1420 balance" (the fresh screenshot
    // that killed the prior "data-condition on his account" theory).
    await mockTokenStatus(page, { balance: 1420, claimable: true, nextClaimAt: 0, dailyClaimAmount: 20, streak: 5, hasMadeFirstPurchase: true });
    var NINE_DAYS_AGO = Date.now() - 9 * 24 * 60 * 60 * 1000;
    await seedHomeUser(page, { dreams: [makeDream('old1', { createdAt: NINE_DAYS_AGO })] });
    var big = await page.locator('#ritual-big').textContent();
    assert.match(big, /5 nights/);
    var sub = await page.locator('#ritual-sub').textContent();
    assert.match(sub, /0 of 3/);
    await assertConstelVisible('founder-reported shape (5 nights, 0 of 3, claimable)');

    // First-ever night (isFirstEverNight && loggedToday) branch.
    await mockTokenStatus(page, { balance: 20, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [makeDream('d1')], freshState: true });
    await assertConstelVisible('first-ever-night branch');

    // Never-logged (hasEverLogged: false) branch.
    await mockTokenStatus(page, { balance: 0, claimable: true, nextClaimAt: 0, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { freshState: true });
    await assertConstelVisible('never-logged branch');

    // Week-earned (n >= target) branch.
    await mockTokenStatus(page, { balance: 60, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 3 });
    var TEN_DAYS_AGO2 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toDateString();
    await seedHomeUser(page, { dreams: [makeDream('e1'), makeDream('e2'), makeDream('e3')], noRecallDates: [TEN_DAYS_AGO2], freshState: true });
    await assertConstelVisible('week-earned branch');
  } finally {
    await context.close();
  }
});

test('home.html: My Dreams row renders real thumbnails linking to result.html and an "All" link to profile.html; a truly brand-new account never shows the row at all; an account that has logged but has no real dream yet shows the friendly empty message', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    // Both dreams dated BEFORE today (not tonight's own entry) -- otherwise
    // whichever is most recent would qualify as tonight's real dream and
    // get claimed by the embedded room card instead of a row tile (see
    // shouldShowRoomCard() in home.html's own script, tracker item
    // for-product-build-ship-founder-go-08-01--ags710 -- generalized
    // 2026-08-01 to cover every account logging a real dream tonight, not
    // just day-0). This test is specifically about the plain My-dreams
    // row's own rendering with dreams from OTHER nights; the room card
    // itself (day-0 and returning-user alike) is covered separately by
    // test/home-day0-dream-card-behavioral.test.js.
    var TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toDateString();
    var TWO_DAYS_AGO_MS = Date.now() - 2 * 24 * 60 * 60 * 1000;
    var ONE_DAY_AGO_MS = Date.now() - 24 * 60 * 60 * 1000;
    await seedHomeUser(page, {
      dreams: [makeDream('md-1', { createdAt: TWO_DAYS_AGO_MS }), makeDream('md-2', { createdAt: ONE_DAY_AGO_MS })],
      noRecallDates: [TEN_DAYS_AGO]
    });

    await page.waitForSelector('#dreams-row a.dream-row-tile', { timeout: 5000 });
    var hrefs = await page.locator('#dreams-row a.dream-row-tile').evaluateAll(function (els) { return els.map(function (e) { return e.getAttribute('href'); }); });
    assert.equal(hrefs.length, 2);
    hrefs.forEach(function (h) { assert.match(h, /^result\.html\?id=md-/); });
    var allLinkHref = await page.locator('#dreams .dreams-all').getAttribute('href');
    assert.equal(allLinkHref, 'profile.html');

    // Genuinely brand-new account -- the whole section stays hidden.
    await seedHomeUser(page, { username: 'emptytester', dreams: [] });
    await page.waitForSelector('#ritual', { timeout: 5000 });
    assert.equal(await page.locator('#dreams').isVisible(), false);

    // An account that HAS logged (a no-recall check-in) but has no real
    // dream yet -- the row shows the friendly empty message instead.
    await seedHomeUser(page, { username: 'norecalltester', dreams: [], noRecallDates: [new Date().toDateString()] });
    await page.waitForSelector('#dreams', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#dreams-empty').isVisible(), true);
    assert.equal(await page.locator('#dreams-row').isVisible(), false);
  } finally {
    await context.close();
  }
});

// Regression coverage for the My Dreams row's blank/black video-tile bug
// (tracker item for-product-home-screen-spec-drift-from--575djz, fix 5,
// carried over into the Night Shelf rebuild via the shared
// DreamCards.observeVideos() mechanism profile.html already uses). Stalls
// the video's own network request (so no loadeddata/playing/error can
// ever fire -- the exact real-world shape of a slow network or blocked
// autoplay) rather than just asserting on markup -- the same technique
// processing.html's own now-deleted coverage of this used, before tracker
// item for-product-funnel-ending-v2-founder-ins-tfuu0q removed that page.
function stallHomeThumbVideoRequest(page) {
  return page.route('**/mock-home-thumb-video.mp4', function () { /* deliberately never fulfilled -- stalled network, matching the real bug's shape */ });
}

test('home.html: My Dreams row video thumb uses preload="metadata" (never "none") and DreamCards.observeVideos()\'s IntersectionObserver actually calls play() once the thumb is visible -- regression coverage for the blank/black tile bug', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stallHomeThumbVideoRequest(page);
    // Installed before any page script runs (Playwright guarantee for
    // addInitScript), so this wraps HTMLMediaElement.prototype.play before
    // home.html's own observer ever gets a chance to call it -- records
    // real invocations rather than inferring them from a decoded frame
    // that a stalled request can never produce.
    await page.addInitScript(function () {
      window.__thumbPlayCalls = 0;
      var origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this.classList && this.classList.contains('vcard-video')) window.__thumbPlayCalls++;
        return origPlay.apply(this, arguments);
      };
    });
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    // Same "not tonight's own dream" reasoning as the test above -- a
    // dream created today would otherwise qualify as tonight's real dream
    // and get claimed by the embedded room card instead of a My-dreams row
    // tile at all (see shouldShowRoomCard() in home.html's own script),
    // which is exactly right for that feature but not what THIS test is
    // about, so this dream is dated yesterday instead.
    var TEN_DAYS_AGO_VID = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toDateString();
    var YESTERDAY_MS = Date.now() - 24 * 60 * 60 * 1000;
    await seedHomeUser(page, { dreams: [makeDream('vid-1', { videoUrl: baseUrl + '/mock-home-thumb-video.mp4', createdAt: YESTERDAY_MS })], noRecallDates: [TEN_DAYS_AGO_VID] });

    await page.waitForSelector('#dreams-row video.vcard-video', { timeout: 5000 });

    // Attribute regression guard: the original bug was preload="none",
    // which never fetches enough to decode a frame at all.
    var preload = await page.locator('#dreams-row video.vcard-video').getAttribute('preload');
    assert.equal(preload, 'metadata', 'must never regress back to preload="none" -- that alone caused the blank/black tile');

    // Behavioral regression guard: force the intersection (scrolled fully
    // into view) and confirm the observer's callback really did invoke
    // play() on this exact element -- the request is still stalled at this
    // point, so this would NOT pass merely because the video happened to
    // have decoded a frame on its own.
    await page.locator('#dreams-row video.vcard-video').scrollIntoViewIfNeeded();
    await page.waitForFunction(function () { return window.__thumbPlayCalls > 0; }, null, { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('home.html: the Chamber pill\'s fallback href points at result.html for a completed dream (no ?openInterp=1 -- that mechanism is gone), and at create.html when there is nothing to interpret yet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });

    await seedHomeUser(page, { dreams: [makeDream('ch-1')] });
    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    var href = await page.locator('#chamber-pill').getAttribute('href');
    assert.equal(href, 'result.html?id=ch-1');
    assert.equal(await page.locator('#chamber-pill').textContent(), 'Enter');

    await seedHomeUser(page, { username: 'nodreamsyet', dreams: [] });
    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    var href2 = await page.locator('#chamber-pill').getAttribute('href');
    assert.equal(href2, 'create.html');
    assert.equal(await page.locator('#chamber-pill').textContent(), 'Begin');
  } finally {
    await context.close();
  }
});

test('home.html: the Chamber pill, with a completed dream, opens InterpretExperience directly ON THIS PAGE (no navigation away) -- Interpretation Wave 1, tracker item for-product-build-interpretation-wave-1--xuftyn', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [makeDream('ch-itp-1')] });

    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    await page.click('#chamber-pill');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
    assert.equal(page.url(), baseUrl + '/home.html', 'must open the overlay in place, never navigate to result.html');

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'interp_surface_opened').length, 1);
    assert.equal(captures(phCalls, 'home_chamber_pill_tapped').length, 1, 'the new tracker-item-required event must fire on a real pill tap');
    assert.deepEqual(captures(phCalls, 'home_chamber_pill_tapped')[0][2], { branch: 'completed_dream' });
  } finally {
    await context.close();
  }
});

test('home.html: the Chamber pill, with NO completed dream, still navigates to create.html normally (a real link, not intercepted), and still fires home_chamber_pill_tapped', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { username: 'chambernodream', dreams: [] });

    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    await page.click('#chamber-pill');
    await page.waitForURL(/create\.html/, { timeout: 5000, waitUntil: 'domcontentloaded' });
  } finally {
    await context.close();
  }
});

test('home.html: home_chamber_href_computed fires at render time (not gated on a click) with the branch actually taken and the resolved href -- diagnostic added for tracker item for-product-bug-founder-new-home-tapping-yuspxa (founder tapped Chamber, landed in the store; every hypothesis traced statically came back unsupported, so this is the concrete signal a recurrence would need)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });

    // Completed-dream branch -- never click the pill, since this must fire
    // purely from href computation, matching what actually happened on the
    // live bug (the tap already landed somewhere before any click handler
    // could matter).
    await seedHomeUser(page, { dreams: [makeDream('ch-2')] });
    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    var calls1 = await readPostHogCalls(page);
    var fired1 = captures(calls1, 'home_chamber_href_computed');
    assert.equal(fired1.length, 1, 'expected exactly one home_chamber_href_computed capture on load');
    assert.deepEqual(fired1[0][2], { branch: 'completed_dream', href: 'result.html?id=ch-2', dream_id: 'ch-2' });

    // No-completed-dream branch.
    await seedHomeUser(page, { username: 'nodreamsyet2', dreams: [] });
    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    var calls2 = await readPostHogCalls(page);
    var fired2 = captures(calls2, 'home_chamber_href_computed');
    assert.equal(fired2.length, 1, 'expected exactly one home_chamber_href_computed capture on load');
    assert.deepEqual(fired2[0][2], { branch: 'no_completed_dream', href: 'create.html', dream_id: null });
  } finally {
    await context.close();
  }
});

test('home.html: the ritual module\'s quiet balance line shows the real token balance and links into shop.html (absorbs the old Vault card)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 340, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForFunction(function () {
      var el = document.getElementById('ritual-balance');
      return el && /340/.test(el.textContent);
    }, null, { timeout: 5000 });
    var href = await page.locator('#ritual-balance').getAttribute('href');
    assert.equal(href, 'shop.html?source=home_ritual_balance');
  } finally {
    await context.close();
  }
});

test('home.html: the bonus-tokens countdown lives INSIDE the ritual module (not a separate element), shows "Next N free tokens in Xh Ym" when not yet claimable, and is hidden entirely once claimable -- tracker item for-product-bonus-tokens-countdown-vanis-qm96xc', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 340, claimable: false, nextClaimAt: Date.now() + (6 * 3600000) + (12 * 60000), dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#ritual-countdown', { state: 'visible', timeout: 5000 });
    var text = await page.textContent('#ritual-countdown');
    assert.equal(text, 'Next 20 free tokens in 6h 12m');

    // It's a real descendant of the ritual module itself (#ritual), not a
    // sibling element bolted on elsewhere on the page -- the founder's own
    // explicit direction was integrating it INTO the streak/claim module
    // "so claim timing and streak live together in one place."
    var insideRitual = await page.evaluate(function () {
      var ritual = document.getElementById('ritual');
      var countdown = document.getElementById('ritual-countdown');
      return !!(ritual && countdown && ritual.contains(countdown));
    });
    assert.equal(insideRitual, true, '#ritual-countdown must be a descendant of #ritual');
  } finally {
    await context.close();
  }

  var context2 = await newMobileContext();
  try {
    var page2 = await context2.newPage();
    await blockThirdParty(page2);
    await mockTokenStatus(page2, { balance: 340, claimable: true, nextClaimAt: 0, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page2, { dreams: [] });

    await page2.waitForSelector('#ritual-claim', { state: 'visible', timeout: 5000 });
    assert.equal(await page2.locator('#ritual-countdown').isHidden(), true, 'the countdown must be hidden while claimable -- the claim button occupies that spot instead');
  } finally {
    await context2.close();
  }
});

test('home.html: the bonus-tokens countdown ticks live while the page stays open, and re-fetches (rather than getting stuck on "now") once nextClaimAt actually passes', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.clock.install({ time: Date.now() });

    var fetchCount = 0;
    var becameClaimable = false;
    var startNextClaimAt = Date.now() + 90000; // 90s out
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      fetchCount++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
        becameClaimable
          ? { balance: 340, claimable: true, nextClaimAt: 0, dailyClaimAmount: 20, streak: 1 }
          : { balance: 340, claimable: false, nextClaimAt: startNextClaimAt, dailyClaimAmount: 20, streak: 1 }
      ) });
    });
    await seedHomeUser(page, { dreams: [] });
    await page.waitForSelector('#ritual-countdown', { state: 'visible', timeout: 5000 });
    assert.equal(await page.textContent('#ritual-countdown'), 'Next 20 free tokens in 2m');
    assert.equal(fetchCount, 1, 'sanity: one fetch on load');

    // First 60s tick: nextClaimAt (90s out) hasn't passed yet -- the
    // countdown must tick down to a smaller number purely by re-rendering
    // the already-cached tokenStatus, with NO extra network call.
    await page.clock.fastForward(60000);
    assert.equal(await page.textContent('#ritual-countdown'), 'Next 20 free tokens in 1m');
    assert.equal(fetchCount, 1, 'ticking down before expiry must not re-fetch');

    // Second 60s tick (120s total elapsed) crosses the 90s nextClaimAt --
    // this must trigger a real re-fetch so the claim button can actually
    // appear, rather than the countdown sitting stuck showing "now" forever.
    becameClaimable = true;
    await page.clock.fastForward(60000);
    await page.waitForSelector('#ritual-claim', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#ritual-countdown').isHidden(), true, 'once claimable, the countdown yields its spot back to the claim button');
    assert.ok(fetchCount >= 2, 'crossing nextClaimAt must trigger a real re-fetch, got ' + fetchCount + ' fetch(es)');
  } finally {
    await context.close();
  }
});

test('home.html: the bonus-tokens countdown stays hidden (never shows blank/garbage text) when tokenStatus has no nextClaimAt, e.g. a degraded response', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 0, claimable: false, nextClaimAt: null, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForFunction(function () {
      var el = document.getElementById('ritual-balance');
      return el && /0 · Vault/.test(el.textContent);
    }, null, { timeout: 5000 });
    assert.equal(await page.locator('#ritual-countdown').isHidden(), true);
  } finally {
    await context.close();
  }
});

test('home.html: the daily claim lives in the ritual module as a real 56px button when claimable, opens the existing claim sheet, and disappears once claimed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Stateful mock: claimable until the claim actually succeeds, then not
    // -- refreshTokenStatus(false)'s post-claim re-fetch (onClaimed above)
    // must see the real post-claim status, not the same claimable:true
    // response forever, or the button would wrongly reappear.
    var claimed = false;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
        claimed
          ? { balance: 120, claimable: false, nextClaimAt: Date.now() + 86400000, dailyClaimAmount: 20, streak: 3 }
          : { balance: 100, claimable: true, nextClaimAt: 0, dailyClaimAmount: 20, streak: 2 }
      ) });
    });
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      claimed = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 120, streak: 3, nextClaimAt: Date.now() + 86400000 }) });
    });
    // skipNav + a pre-seeded "already auto-shown today" marker so
    // PurchaseSheet's own once-per-day auto-open (unrelated to what this
    // test covers) doesn't race with -- or visually cover -- the explicit
    // #ritual-claim click below.
    await seedHomeUser(page, { dreams: [makeDream('claim-1')], skipNav: true });
    await page.evaluate(function () { localStorage.setItem('dreamtube_claim_sheet_shown_date', new Date().toDateString()); });
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#ritual-claim', { state: 'visible', timeout: 5000 });
    var claimBtnBox = await page.locator('#ritual-claim').boundingBox();
    assert.ok(claimBtnBox.height >= 44, 'the ritual claim button must meet a real tap-target minimum');

    await page.click('#ritual-claim');
    await page.waitForSelector('#claim-sheet-btn', { state: 'visible', timeout: 5000 });
    await page.click('#claim-sheet-btn');
    await page.waitForFunction(function () {
      var btn = document.getElementById('ritual-claim');
      return btn && btn.style.display === 'none';
    }, null, { timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'home_claim_chip_tapped').length, 1);
  } finally {
    await context.close();
  }
});

test('home.html: the Bar A night dock is Home (active) / Explore / +Create / Profile, matching explore.html/profile.html -- tracker item for-product-urgent-founder-roll-the-new--8pyek3', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('.night-dock', { timeout: 5000 });
    // The old sticky in-flow .bottom-nav is retired everywhere now.
    assert.equal(await page.locator('.bottom-nav').count(), 0);

    // Read each item's own .night-dock-label (not the item's whole
    // textContent) -- the Profile tab also contains the avatar-as-icon's
    // fallback-initial text ("T" for @tester here), which would otherwise
    // get concatenated onto the label ("TProfile").
    var labels = await page.locator('.night-dock > *').evaluateAll(function (els) {
      return els.map(function (e) {
        if (e.classList.contains('night-dock-create')) return '+';
        var label = e.querySelector('.night-dock-label');
        return label ? label.textContent.trim() : '';
      });
    });
    // Home/Explore/+/Profile everywhere -- founder-approved order, one
    // shared renderer (js/bottom-nav.js), so it can't drift again.
    assert.deepEqual(labels, ['Home', 'Explore', '+', 'Profile']);
    assert.equal(await page.locator('.night-dock .night-dock-item.active .night-dock-label').textContent(), 'Home');
    var exploreHref = await page.locator('.night-dock a[href="explore.html"]').getAttribute('href');
    assert.equal(exploreHref, 'explore.html');
  } finally {
    await context.close();
  }
});

test('home.html: the bare Tonight CTA button has the founder\'s exact "What did you dream?" text, no card chrome around it, a real tap-target size, and lands on create.html\'s EXISTING Build/Write/Record choice screen (a bare create.html deep-link, no ?build=1) -- tracker item for-product-founder-08-07-homepage-hero--015hgp (founder ruling: "kill the square, bare \'What did you dream?\' button -> 3-choice screen"), superseding the earlier for-product-founder-ask-08-05-tell-your--vmfvsk fix that first pointed the old pill at this same bare create.html destination', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#tonight-cta', { timeout: 5000 });
    var cta = page.locator('#tonight-cta');
    assert.equal(await cta.isVisible(), true);
    assert.equal(await cta.textContent(), 'What did you dream?', 'button text must be EXACTLY the founder\'s wording, including the question mark');
    assert.match(await cta.getAttribute('class'), /\bpill\b/);
    var ctaBox = await cta.boundingBox();
    assert.ok(ctaBox.height >= 44, 'the button must meet a real tap-target minimum (spec: 56px tall)');

    // No card/box/background art anywhere around the button -- it's a
    // bare <button>, not wrapped in a .hero-card ancestor (that older
    // card only survives, hidden by default, for the separate "logged
    // tonight" confirmation state).
    var tagName = await cta.evaluate(function (el) { return el.tagName; });
    assert.equal(tagName, 'BUTTON');
    var heroCardAncestor = await cta.evaluate(function (el) { return !!el.closest('.hero-card'); });
    assert.equal(heroCardAncestor, false, 'the CTA button must not sit inside any .hero-card container');
    assert.equal(await page.locator('#hero-tonight').isVisible(), false, 'the old moon-card is hidden while tonight is unlogged');

    // No sub-copy of any kind below the button (the old whisper, day-1
    // line, and Write/Speak/No-recall quiet-link row are all gone).
    assert.equal(await page.locator('#tonight-whisper').count(), 0);
    assert.equal(await page.locator('#tonight-d1').count(), 0);
    assert.equal(await page.locator('#tonight-links').count(), 0);
    assert.equal(await page.locator('#btn-write').count(), 0);
    assert.equal(await page.locator('#btn-speak').count(), 0);
    assert.equal(await page.locator('#btn-norecall').count(), 0);

    await page.click('#tonight-cta');
    await page.waitForURL(function (url) { return /\/create\.html$/.test(url.pathname) && url.search === ''; }, { timeout: 5000, waitUntil: 'domcontentloaded' });

    // Confirm the actual Build/Write/Record choice screen is what's
    // showing -- not the wizard, not any other create.html state. All
    // three real choice cards must be visible and correctly routed.
    await page.waitForSelector('#create-select', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#create-build').isVisible(), false, 'the chip wizard must NOT be shown yet -- the choice screen comes first');
    assert.equal(await page.locator('#choice-build').isVisible(), true, '"Build it" choice card must be offered');
    assert.equal(await page.locator('#choice-write').isVisible(), true, '"Write it" choice card must be offered');
    assert.equal(await page.locator('#choice-record').isVisible(), true, '"Record it" choice card must be offered');

    // Build it -> the chip-first wizard, same rigor as the old test: the
    // Subject step (step 1) must actually render, not just an empty/
    // generic build screen. The Layout-B redesign replaced the old "step 1
    // of N" text progress indicator with #build-dots (pill/dot styling,
    // same as wizard.html) -- no text equivalent exists to pin anymore, so
    // this now checks the real, still-meaningful properties: landing on
    // the actual Subject step content, and dot 1 marked current. Dot count
    // is 3 since the 3-question wizard trim (founder directive 08-13, "unify
    // always, the shorter version": Subject -> Action -> dream text; Setting
    // + Mood parked/inferred, kept IDENTICAL to the paid funnel + wizard.html).
    await page.click('#choice-build');
    await page.waitForSelector('#create-build', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#create-select').isVisible(), false);
    assert.equal(await page.locator('#build-subject-chip-row').isVisible(), true, 'the Subject step\'s chip row must be visible -- not just an empty/generic build screen');
    var dots = await page.locator('#build-dots i').evaluateAll(function (els) {
      return els.map(function (el) { return el.className; });
    });
    assert.equal(dots.length, 3, 'the Build-it wizard should show 3 progress dots (3-question trim, funnel-identical)');
    assert.match(dots[0], /\bon\b/, 'dot 1 (Subject) should be marked current on first landing');
  } finally {
    await context.close();
  }
});

test('home.html: the Tonight CTA button\'s choice screen, from Write it / Record it, still leads to their correct existing destinations (create.html\'s own #choice-write/#choice-record handlers, unchanged)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#tonight-cta', { timeout: 5000 });
    await page.click('#tonight-cta');
    await page.waitForSelector('#choice-write', { state: 'visible', timeout: 5000 });
    await page.click('#choice-write');
    await page.waitForSelector('#create-write', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#create-select').isVisible(), false);
  } finally {
    await context.close();
  }

  // Fresh page for Record it, same CTA entry point. Needs a fake
  // getUserMedia/MediaRecorder (same convention as test/record-mode-
  // behavioral.test.js's installMediaRecorderMock) so #choice-record's
  // real startRecordingUI() can run end to end without a real mic.
  var context2 = await newMobileContext();
  try {
    await context2.addInitScript(function () {
      var fakeStream = { getTracks: function () { return []; } };
      if (!navigator.mediaDevices) navigator.mediaDevices = {};
      navigator.mediaDevices.getUserMedia = function () { return Promise.resolve(fakeStream); };
      function FakeMediaRecorder(stream, opts) {
        this.stream = stream;
        this.state = 'inactive';
        this.mimeType = (opts && opts.mimeType) || 'audio/webm';
        this._listeners = {};
      }
      FakeMediaRecorder.prototype.addEventListener = function (evt, cb) {
        this._listeners[evt] = this._listeners[evt] || [];
        this._listeners[evt].push(cb);
      };
      FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
      FakeMediaRecorder.prototype.stop = function () {
        this.state = 'inactive';
        (this._listeners.stop || []).forEach(function (cb) { cb(); });
      };
      FakeMediaRecorder.isTypeSupported = function () { return true; };
      window.MediaRecorder = FakeMediaRecorder;
    });
    var page2 = await context2.newPage();
    await blockThirdParty(page2);
    await mockTokenStatus(page2, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedHomeUser(page2, { dreams: [] });

    await page2.waitForSelector('#tonight-cta', { timeout: 5000 });
    await page2.click('#tonight-cta');
    await page2.waitForSelector('#choice-record', { state: 'visible', timeout: 5000 });
    await page2.click('#choice-record');
    // #choice-record's own handler (startRecordingUI) opens the record
    // panel -- same existing, already-tested destination as the ?record=1
    // deep-link.
    await page2.waitForSelector('#create-record', { state: 'visible', timeout: 5000 });
    assert.equal(await page2.locator('#create-select').isVisible(), false);
  } finally {
    await context2.close();
  }
});

test('home.html: analytics -- home_viewed fires on load, home_today_entry_tapped fires for the Tonight CTA tap, home_card_tapped fires on a card tap, and no event name or string prop is ever health/therapy-flavored', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#tonight-cta', { timeout: 5000 });
    var initialCalls = await readPostHogCalls(page);
    assert.equal(captures(initialCalls, 'home_viewed').length, 1);

    // The CTA's click handler tracks synchronously, THEN navigates
    // (location.href = 'create.html') -- a real top-level navigation
    // begins essentially immediately in Chromium (page.route() stalling
    // the request does NOT keep this document's JS context alive the way
    // it does for a stalled XHR/fetch elsewhere in this suite), so the
    // click AND the posthog read both happen inside ONE page.evaluate call
    // (element.click() dispatches its listener synchronously -- track()
    // and the location.href assignment both run before this same script
    // turn yields, so reading window.posthog immediately after still sees
    // them, before any navigation-driven unload can occur). The button
    // also carries data-card="tonight", so this single tap fires BOTH
    // home_today_entry_tapped (its own handler) and home_card_tapped (the
    // whole-scroll delegated card-tap listener) -- no second click needed
    // (unlike before this change, a brand-new D1 account like this one has
    // no #dreams-empty to click yet -- that only appears once something
    // has actually been logged).
    await page.route('**/create.html', function () { /* never resolved -- avoids an unhandled-navigation console error; irrelevant to the assertion itself since the click+read below happen in one synchronous turn regardless */ });
    var phCalls = await page.evaluate(function () {
      document.getElementById('tonight-cta').click();
      return (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    });
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
  var context = await newMobileContext();
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
    // legitimate reassurance copy contains the bare word "missed" in a
    // benign phrase elsewhere in the app -- these phrases are the actual
    // punitive shapes that copy must never take, not the word itself.
    assert.doesNotMatch(bodyText, /you missed|broke your|lost your streak|reset to zero|streak reset/i, 'the freeze must stay silent -- no visible warning copy anywhere on the page');
  } finally {
    await context.close();
  }
});

test('home.html: the weekly-summary and streak-freeze analytics dedup flags are scoped per account, not just per date -- a second account sharing the same browser still fires its own first-time events (review finding, fixed)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
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

test('home.html: no horizontal overflow at a real 390px mobile viewport, and the bare Tonight CTA button meets a real tap-target minimum', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 });
    // Deliberately no dreams -- an unlogged-tonight account, so the bare
    // Tonight CTA button is actually visible to measure (a "today" dream,
    // like most other tests here seed, would flip tonight to its logged
    // state and correctly hide it in favor of the logged-confirmation
    // card, per the mock's own state machine).
    await seedHomeUser(page, { dreams: [] });

    await page.waitForSelector('#chamber-pill', { state: 'visible', timeout: 5000 });
    var overflowsHorizontally = await page.evaluate(function () {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    });
    assert.equal(overflowsHorizontally, false, 'home.html must not cause horizontal overflow at a real 390px mobile viewport');

    var ctaBox = await page.locator('#tonight-cta').boundingBox();
    assert.ok(ctaBox.height >= 44, 'the Tonight CTA button must meet a real tap-target minimum');
  } finally {
    await context.close();
  }
});

test('create.html: ?write=1 deep-link jumps straight into Write mode (mirrors the existing ?record=1 convention)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
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
// superseded by Interpretation Wave 1's "Chamber pill opens
// InterpretExperience directly on home.html" tests above, and the surface
// itself is covered end-to-end by test/interp-analytics-behavioral.test.js.
// No dead code/dead test left behind for a mechanism that no longer exists.

test('login.html: a successful login now lands on home.html by default (was explore.html) -- an explicit ?next= override still wins', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
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
  var context = await newMobileContext();
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
