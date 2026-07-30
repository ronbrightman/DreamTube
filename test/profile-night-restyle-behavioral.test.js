// test/profile-night-restyle-behavioral.test.js
//
// Coverage for the founder-approved Profile night restyle + "Bar A" night
// dock — tracker item for-product-build-founder-approved-2026--to6ew2,
// built against the frozen visual spec in profile-mock-x7q4.html.
//
// Two halves:
//
//   1. Pure unit coverage of js/dream-cards.js (required directly under
//      node --test, no browser) — the upcoming-night slot numbering/dating
//      rules behind the founder's amendment, plus the escaping and
//      relative-date helpers the tile markup depends on. Same dual-export
//      pattern test/purchase-sheet.test.js already uses for
//      js/purchase-sheet.js's pure helpers.
//
//   2. Real browser coverage of profile.html itself, following
//      test/profile-me-character-behavioral.test.js's conventions:
//      node:test + real Chromium via Playwright (resolved from this
//      sandbox's global install, not a project dependency — see
//      CLAUDE.md), state seeded straight into localStorage, third-party
//      hosts blocked, and every navigation wrapped against this sandbox's
//      known intermittent outbound-network stalls.
//
// THE MOST IMPORTANT THING THIS FILE PINS: the claim/ritual mechanics are
// GENUINELY GONE from Profile — no claim chip state, no tap-to-claim, no
// once-per-day auto-opening claim sheet, no polling interval. home.html is
// the sole claim surface now, and a claim affordance reappearing on this
// page is a regression, not a feature. Several of those behaviors were
// previously asserted (positively) in test/ui-behavioral.test.js and
// test/token-daily-grant-copy-behavioral.test.js; those assertions were
// removed there and inverted here, so the property is still covered rather
// than silently dropped.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var DreamCards = require('../js/dream-cards.js');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
// A real phone-sized viewport — this whole build is a mobile-webview
// restyle, and the overlay-positioned dock's clearance behavior is only
// meaningful at a height where the library actually scrolls.
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

// ===========================================================================
// 1. js/dream-cards.js — pure helpers (no browser)
// ===========================================================================

test('dream-cards: upcoming slots number from the dream count, and the FIRST one is the only "next"', function () {
  var slots = DreamCards.upcomingSlots({ dreamCount: 2, loggedToday: true, count: 2 });
  assert.equal(slots.length, 2);
  assert.equal(slots[0].night, 3);
  assert.equal(slots[1].night, 4);
  assert.equal(slots[0].isNext, true);
  assert.equal(slots[1].isNext, false);
});

test('dream-cards: with tonight already logged, the first upcoming slot reads "tomorrow" (the founder\'s own example: "Night 3 - tomorrow")', function () {
  var slots = DreamCards.upcomingSlots({ dreamCount: 2, loggedToday: true, count: 3 });
  assert.equal(slots[0].when, 'tomorrow');
  assert.equal(slots[1].when, 'in 2 days');
  assert.equal(slots[2].when, 'in 3 days');
  // The exact label shape the amendment describes.
  assert.match(DreamCards.slotHTML(slots[0]), /Night 3 · tomorrow/);
});

test('dream-cards: with nothing logged yet today, the first upcoming slot reads "tonight" — this is the whole sense in which Home\'s state shows through', function () {
  var slots = DreamCards.upcomingSlots({ dreamCount: 2, loggedToday: false, count: 2 });
  assert.equal(slots[0].when, 'tonight');
  assert.equal(slots[1].when, 'tomorrow');
});

test('dream-cards: a brand-new account\'s first upcoming slot is Night 1', function () {
  var slots = DreamCards.upcomingSlots({ dreamCount: 0, loggedToday: false, count: 2 });
  assert.equal(slots[0].night, 1);
  assert.equal(slots[0].when, 'tonight');
  assert.equal(slots[0].isNext, true);
});

test('dream-cards: a placeholder slot is inert markup — not a link, not a button, no handler surface', function () {
  var html = DreamCards.slotsHTML({ dreamCount: 1, loggedToday: true, count: 2 });
  // Any <a href> or <button> here would make an "upcoming night" tappable,
  // which is exactly the second-claim-surface the founder ruled out.
  assert.doesNotMatch(html, /<a[\s>]/i, 'an upcoming-night placeholder must never be a link');
  assert.doesNotMatch(html, /<button[\s>]/i, 'an upcoming-night placeholder must never be a button');
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /href/i);
  // First slot carries the "next" marker, the second does not.
  assert.equal((html.match(/is-next/g) || []).length, 1);
});

test('dream-cards: relativeDayLabel is calendar-day based, and never fabricates a date for a legacy pre-createdAt dream', function () {
  var now = new Date(2026, 6, 30, 9, 0, 0).getTime(); // 2026-07-30 09:00 local
  var lateLastNight = new Date(2026, 6, 29, 23, 50, 0).getTime();
  assert.equal(DreamCards.relativeDayLabel(lateLastNight, now), 'yesterday', 'a dream saved at 23:50 must read "yesterday" the next morning, not "today"');
  assert.equal(DreamCards.relativeDayLabel(new Date(2026, 6, 30, 1, 0, 0).getTime(), now), 'today');
  assert.equal(DreamCards.relativeDayLabel(new Date(2026, 6, 28).getTime(), now), '2 days ago');
  assert.equal(DreamCards.relativeDayLabel(new Date(2026, 6, 23).getTime(), now), '1 week ago');
  assert.equal(DreamCards.relativeDayLabel(new Date(2026, 6, 16).getTime(), now), '2 weeks ago');
  assert.equal(DreamCards.relativeDayLabel(undefined, now), '', 'a dream with no createdAt gets no date at all, never a made-up one');
});

test('dream-cards: esc is attribute-safe (the old profile.html copy left quotes unescaped)', function () {
  assert.equal(DreamCards.esc('a"b\'c<d>e&f'), 'a&quot;b&#39;c&lt;d&gt;e&amp;f');
  var html = DreamCards.tileHTML(
    { id: 'x"onerror="alert(1)', caption: '<script>bad</script>', isPublished: false, likes: 0, createdAt: Date.now() },
    { gradient: 'red' }
  );
  assert.doesNotMatch(html, /<script>/, 'a hostile caption must not survive into the markup as a real tag');
  assert.match(html, /result\.html\?id=x&quot;onerror/, 'the id must be escaped inside the href attribute');
});

// ===========================================================================
// 2. profile.html in a real browser
// ===========================================================================

/** Aborts requests to third-party hosts this page loads (fonts, PostHog, Meta Pixel) -- none are needed here, and this sandbox's outbound network can intermittently stall on them (see CLAUDE.md). */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Wraps page.goto so a transient network stall doesn't crash the whole run -- see CLAUDE.md's environment-quirk note. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/**
 * Stands in for netlify/functions/get-token-status.js (no local Netlify
 * Functions runtime is available to these tests — see
 * test/helpers/static-server.js). Also counts calls, so the "no polling"
 * property can be asserted directly.
 */
async function mockTokenStatus(page, status) {
  var calls = { count: 0 };
  var body = Object.assign({ balance: 240, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 }, status || {});
  await page.route('**/.netlify/functions/get-token-status*', function (route) {
    calls.count++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return calls;
}

/** The other network call profile.html makes on load (the new-likes total). Resolved to zero so it never hangs. */
function mockFeed(page) {
  return page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dreams: [] }) });
  });
}

function dream(overrides) {
  return Object.assign({
    id: 'd' + Math.random().toString(36).slice(2, 8),
    ownerHandle: '@tester',
    caption: 'Flying over a golden city',
    style: 'Cinematic',
    isPublished: false,
    likes: 0,
    createdAt: Date.now() - 2 * 86400000
  }, overrides || {});
}

/**
 * Seeds a logged-in "tester" account (plus optional dreams and a self
 * character) into js/store.js's localStorage state — the shortest path to
 * a real, authenticated render without driving signup. Mirrors
 * test/profile-me-character-behavioral.test.js's own seedUser.
 */
async function seedUser(page, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (opts) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = opts.selfCharacter ? [opts.selfCharacter] : [];
    state.dreams = opts.dreams || [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { dreams: opts.dreams || [], selfCharacter: opts.selfCharacter || null });
}

async function openProfile(page, opts) {
  await blockThirdParty(page);
  await mockFeed(page);
  var tokenCalls = await mockTokenStatus(page, (opts || {}).tokenStatus);
  await seedUser(page, opts);
  await safeGoto(page, baseUrl + '/profile.html');
  return tokenCalls;
}

// --- The deletion: no claim/ritual mechanics anywhere on this page ---------

test('profile.html: a CLAIMABLE account sees no claim sheet, no claim copy, and no claimable chip state — Home is the sole claim surface now', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    // The exact state that used to auto-open the claim sheet on this page.
    await openProfile(page, {
      tokenStatus: { balance: 240, claimable: true, nextClaimAt: Date.now() - 3600000, dailyClaimAmount: 20, streak: 4 },
      dreams: [dream({ isPublished: true })]
    });
    await page.waitForFunction(function () {
      var el = document.getElementById('topbar-token-chip-balance');
      return el && el.textContent !== '–';
    }, null, { timeout: 5000 });
    // Generous settle time -- maybeAutoOpenClaimSheet used to fire off the
    // same getTokenStatus resolution the chip renders from, so if it were
    // still wired the sheet would be open by now.
    await page.waitForTimeout(400);

    assert.equal(await page.locator('#claim-sheet-overlay.open').count(), 0, 'the daily-claim sheet must never auto-open on Profile anymore');
    assert.equal(await page.locator('.claimable').count(), 0, 'nothing on Profile may carry the pulsing claimable state');
    assert.equal(await page.locator('[data-claimable]').count(), 0, 'the claim-state attribute the old tap-to-claim handler read must be gone');
    assert.equal(await page.locator('#profile-tokens-meta').count(), 0, 'the old claim/countdown meta line must be gone');

    var chipText = await page.locator('#topbar-token-chip').textContent();
    assert.doesNotMatch(chipText, /claim/i, 'the plain chip must never render claim copy');
    assert.doesNotMatch(chipText, /\bin \d/i, 'the plain chip must never render a countdown');
  } finally {
    await context.close();
  }
});

test('profile.html: tapping the balance chip while claimable goes to the shop — it never opens a claim sheet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await openProfile(page, {
      tokenStatus: { balance: 240, claimable: true, nextClaimAt: Date.now() - 3600000, dailyClaimAmount: 20, streak: 4 },
      dreams: [dream({})]
    });
    await page.waitForSelector('#topbar-token-chip', { timeout: 5000 });

    await page.click('#topbar-token-chip');
    await page.waitForURL(/shop\.html/, { timeout: 5000 });
    assert.match(page.url(), /shop\.html/, 'the plain chip is a plain link to the shop in every token state');
  } finally {
    await context.close();
  }
});

test('profile.html: the token status is fetched once on load and never polled (the 60s claim-countdown interval is gone)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await page.clock.install({ time: Date.now() });
    var tokenCalls = await openProfile(page, {
      tokenStatus: { balance: 240, claimable: false, nextClaimAt: Date.now() + 1000 },
      dreams: [dream({})]
    });
    await page.waitForFunction(function () {
      var el = document.getElementById('topbar-token-chip-balance');
      return el && el.textContent !== '–';
    }, null, { timeout: 5000 });
    assert.equal(tokenCalls.count, 1, 'sanity: exactly one fetch on load');

    // Well past both the old 60s tick AND the point nextClaimAt passes --
    // the old code re-fetched here specifically to flip into the claimable
    // state. There is no claimable state to flip into anymore.
    await page.clock.fastForward(65000);
    await page.clock.fastForward(65000);
    await page.waitForTimeout(200);
    assert.equal(tokenCalls.count, 1, 'Profile must not poll get-token-status at all now');
  } finally {
    await context.close();
  }
});

// --- Part 2: the night restyle itself --------------------------------------

test('profile.html: the night theme is really applied — #0c0a1a theme-color, sky layers, and the identity anchor copy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await openProfile(page, { dreams: [dream({})] });

    assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), '#0c0a1a');
    assert.equal(await page.locator('.home-bg').count(), 1);
    assert.equal(await page.locator('.home-stars-a').count(), 1);
    assert.equal(await page.locator('.home-stars-b').count(), 1);
    assert.equal(await page.locator('.home-aurora').count(), 1);
    assert.equal(await page.locator('.profile-caption').textContent(), 'This is you in your dreams');

    // The plain chip's own shape, per the mock: "✦ 240 · Shop".
    var chip = await page.locator('#topbar-token-chip').innerText();
    assert.match(chip.replace(/\s+/g, ' '), /✦ 240 · Shop/);
  } finally {
    await context.close();
  }
});

test('profile.html: SHARED and PRIVATE kickers are present, and the tiles are tall 9:14', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await openProfile(page, {
      dreams: [dream({ isPublished: true, caption: 'A shared one' }), dream({ isPublished: false, caption: 'A private one' })]
    });
    await page.waitForSelector('.vcard', { timeout: 5000 });

    var kickers = await page.locator('#profile-lists .section-label').allTextContents();
    assert.deepEqual(kickers, ['Shared', 'Private']);
    // The kicker treatment itself (uppercase, accent-colored) -- part of
    // the approved spec, not just the words.
    var kickerStyle = await page.locator('#profile-lists .section-label').first().evaluate(function (el) {
      var cs = getComputedStyle(el);
      return { transform: cs.textTransform, color: cs.color };
    });
    assert.equal(kickerStyle.transform, 'uppercase');
    assert.equal(kickerStyle.color, 'rgb(157, 144, 255)', 'kickers use the night accent (--home-acc)');

    assert.equal(await page.locator('#shared-grid .vcard').count(), 1);
    assert.equal(await page.locator('#private-grid .vcard').count(), 1);

    var ratio = await page.locator('#shared-grid .vcard-thumb').first().evaluate(function (el) {
      var r = el.getBoundingClientRect();
      return r.width / r.height;
    });
    assert.ok(Math.abs(ratio - 9 / 14) < 0.02, 'tiles must be the tall 9:14 shape, got ratio ' + ratio);
  } finally {
    await context.close();
  }
});

// --- The founder amendment: empty slots as next steps ----------------------

test('profile.html: upcoming-night placeholders follow the real tiles, the first one reads brighter as "next", and the labels mirror Home\'s log state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    // Two dreams, NEITHER created today -> tonight is still unlogged, so
    // the first upcoming slot must read "tonight" and be Night 3.
    await openProfile(page, {
      dreams: [
        dream({ isPublished: true, createdAt: Date.now() - 2 * 86400000 }),
        dream({ isPublished: false, createdAt: Date.now() - 5 * 86400000 })
      ]
    });
    await page.waitForSelector('#private-grid .vcard-slot', { timeout: 5000 });

    var labels = await page.locator('#private-grid .vcard-slot-label').allTextContents();
    assert.deepEqual(labels, ['Night 3 · tonight', 'Night 4 · tomorrow']);

    // Exactly one "next" slot, and it is the FIRST one.
    assert.equal(await page.locator('#private-grid .vcard-slot.is-next').count(), 1);
    var firstIsNext = await page.locator('#private-grid .vcard-slot').first().evaluate(function (el) { return el.classList.contains('is-next'); });
    assert.equal(firstIsNext, true);

    // "Slightly brighter as next" / "dimmest text tier" -- measured, not
    // assumed: the next slot's square and label both read stronger than
    // the one after it, and both squares are dimmer than a real tile.
    var opacities = await page.evaluate(function () {
      var slots = document.querySelectorAll('#private-grid .vcard-slot');
      function op(el) { return parseFloat(getComputedStyle(el).opacity); }
      return {
        nextThumb: op(slots[0].querySelector('.vcard-slot-thumb')),
        laterThumb: op(slots[1].querySelector('.vcard-slot-thumb')),
        nextLabel: op(slots[0].querySelector('.vcard-slot-label')),
        laterLabel: op(slots[1].querySelector('.vcard-slot-label')),
        realTile: op(document.querySelector('#private-grid .vcard-thumb'))
      };
    });
    assert.ok(opacities.nextThumb > opacities.laterThumb, 'the first empty slot must read brighter than the ones after it');
    assert.ok(opacities.nextLabel > opacities.laterLabel, 'the "next" label must sit above the dimmest text tier');
    assert.ok(opacities.laterThumb < opacities.realTile, 'placeholders must be dimmer than real dream tiles');

    // Still not a claim/entry surface: tapping one does nothing at all.
    var urlBefore = page.url();
    await page.locator('#private-grid .vcard-slot').first().click();
    await page.waitForTimeout(200);
    assert.equal(page.url(), urlBefore, 'a placeholder must not navigate anywhere');
    assert.equal(await page.locator('#claim-sheet-overlay.open').count(), 0, 'and must certainly not open a claim sheet');
  } finally {
    await context.close();
  }
});

test('profile.html: with tonight already logged, the first upcoming slot shifts to "tomorrow" — the streak genuinely shows through', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await openProfile(page, {
      dreams: [
        dream({ isPublished: true, createdAt: Date.now() - 2 * 86400000 }),
        dream({ isPublished: false, createdAt: Date.now() }) // logged today
      ]
    });
    await page.waitForSelector('#private-grid .vcard-slot', { timeout: 5000 });
    var labels = await page.locator('#private-grid .vcard-slot-label').allTextContents();
    assert.deepEqual(labels, ['Night 3 · tomorrow', 'Night 4 · in 2 days']);
  } finally {
    await context.close();
  }
});

test('profile.html: a brand-new account\'s empty library still shows the journey, starting at Night 1', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await openProfile(page, { dreams: [] });
    await page.waitForSelector('#profile-empty .vcard-slot', { timeout: 5000 });

    assert.equal(await page.locator('#profile-lists').isVisible(), false);
    var labels = await page.locator('#empty-slots-grid .vcard-slot-label').allTextContents();
    assert.deepEqual(labels, ['Night 1 · tonight', 'Night 2 · tomorrow']);
    assert.equal(await page.locator('#empty-slots-grid .vcard-slot.is-next').count(), 1);
  } finally {
    await context.close();
  }
});

// --- Part 3: the Bar A night dock -----------------------------------------

test('profile.html: the night dock renders as the anchored bar the mock specifies — labels, in-row 44px gradient +, avatar-as-Profile-icon', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await openProfile(page, { dreams: [dream({})], selfCharacter: { id: 'cself1', name: 'Ron', isSelf: true, description: 'tall' } });
    await page.waitForSelector('.night-dock', { timeout: 5000 });

    // The old sticky in-flow nav is gone from this page.
    assert.equal(await page.locator('.bottom-nav').count(), 0);

    // Labels, in the tab set/order profile.html already had on main --
    // this build restyles that bar, it does not add or remove a
    // destination (the open Home-tab question on tracker item
    // for-product-bug-design-pass-find-bottom--g0m6ck is NOT resolved here).
    var labels = await page.locator('.night-dock .night-dock-label').allTextContents();
    assert.deepEqual(labels, ['Home', 'Explore', 'Profile']);
    var hrefs = await page.locator('.night-dock a').evaluateAll(function (els) {
      return els.map(function (el) { return el.getAttribute('href'); });
    });
    assert.deepEqual(hrefs, ['home.html', 'explore.html', 'create.html', 'profile.html']);

    // Profile is the active tab.
    var activeHref = await page.locator('.night-dock .night-dock-item.active').getAttribute('href');
    assert.equal(activeHref, 'profile.html');

    // The "+" sits IN the row (not protruding above it, which is Bar B)
    // and is a real 44px gradient circle.
    var plus = await page.locator('.night-dock-create').boundingBox();
    var dock = await page.locator('.night-dock').boundingBox();
    assert.ok(Math.abs(plus.width - 44) < 1.5 && Math.abs(plus.height - 44) < 1.5, 'the create button must be 44x44, got ' + plus.width + 'x' + plus.height);
    assert.ok(plus.y >= dock.y - 1, 'the create button must sit inside the bar, not protrude above it');
    var plusBg = await page.locator('.night-dock-create').evaluate(function (el) { return getComputedStyle(el).backgroundImage; });
    assert.match(plusBg, /linear-gradient/, 'the create button keeps the app\'s one gradient treatment');

    // Avatar-as-Profile-icon: the Me character's initial, not a person glyph.
    assert.equal(await page.locator('.night-dock .nav-icon').count(), 2, 'only Home and Explore draw glyph icons; Profile draws the avatar');
    assert.equal((await page.locator('#dock-avatar').textContent()).trim(), 'R');
  } finally {
    await context.close();
  }
});

test('profile.html: the dock overlays the content, and --nav-clearance keeps the last row of the library reachable', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    // Enough tiles to genuinely overflow the viewport.
    var many = [];
    for (var i = 0; i < 8; i++) many.push(dream({ isPublished: i % 2 === 0, caption: 'Dream ' + i }));
    await openProfile(page, { dreams: many });
    await page.waitForSelector('#private-grid .vcard-slot', { timeout: 5000 });

    // The bar is genuinely overlaid (absolutely positioned), not in flow.
    var dockPosition = await page.locator('.night-dock').evaluate(function (el) { return getComputedStyle(el).position; });
    assert.equal(dockPosition, 'absolute');

    // The clearance variable exists and the scroll area actually reserves
    // at least the bar's own height for it.
    var geom = await page.evaluate(function () {
      var scroll = document.querySelector('.scroll-area');
      var dock = document.querySelector('.night-dock');
      return {
        paddingBottom: parseFloat(getComputedStyle(scroll).paddingBottom),
        dockHeight: dock.getBoundingClientRect().height
      };
    });
    assert.ok(geom.paddingBottom >= geom.dockHeight, 'the scroll area must reserve at least the dock height (' + geom.paddingBottom + ' vs ' + geom.dockHeight + ')');

    // The real property that matters: scrolled all the way down, the last
    // placeholder is fully above the bar, not hidden behind it.
    await page.evaluate(function () {
      var scroll = document.querySelector('.scroll-area');
      scroll.scrollTop = scroll.scrollHeight;
    });
    await page.waitForTimeout(200);
    var clearance = await page.evaluate(function () {
      var slots = document.querySelectorAll('#private-grid .vcard-slot');
      var last = slots[slots.length - 1].getBoundingClientRect();
      var dock = document.querySelector('.night-dock').getBoundingClientRect();
      return dock.top - last.bottom;
    });
    assert.ok(clearance >= 0, 'the last library row must not end up behind the dock (overlap of ' + (-clearance) + 'px)');
  } finally {
    await context.close();
  }
});

test('explore.html is untouched by this build — it keeps its existing .bottom-nav and gains no night dock', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page);
    await mockTokenStatus(page, {});
    await seedUser(page, { dreams: [] });
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.bottom-nav', { timeout: 5000 });

    assert.equal(await page.locator('.night-dock').count(), 0, 'the Profile-scoped night dock must not leak onto Explore');
    // Its own tab set is exactly what it was -- this build resolves nothing
    // about the still-open Home-tab question on tracker item
    // for-product-bug-design-pass-find-bottom--g0m6ck.
    var hrefs = await page.locator('.bottom-nav a').evaluateAll(function (els) {
      return els.map(function (el) { return el.getAttribute('href'); });
    });
    assert.deepEqual(hrefs, ['home.html', 'explore.html', 'create.html', 'profile.html']);
  } finally {
    await context.close();
  }
});

// --- Regression: everything NOT redesigned here still works ---------------

test('profile.html: identity editing, Settings, and the delete-account gate all still work after the restyle', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    // Describe mode with real text makes a genuine generate-avatar.js call
    // on save (see profile.html's own identity-save handler) -- stood in
    // for here, same as test/profile-me-character-behavioral.test.js does.
    // Clearing the description instead would hit saveCharacter's "add a
    // description or a photo" validation and never close the sheet.
    await page.route('**/.netlify/functions/generate-avatar', function (route) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ photoDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' })
      });
    });
    await openProfile(page, { dreams: [dream({})], selfCharacter: { id: 'cself1', name: 'Ron', isSelf: true, description: 'tall' } });
    await page.waitForSelector('.night-dock', { timeout: 5000 });

    // Identity: header name, and the SAME Me character reflected in the dock avatar.
    assert.equal(await page.locator('#profile-handle').textContent(), 'Ron');
    assert.equal((await page.locator('#dock-avatar').textContent()).trim(), 'R');

    // Edit-profile sheet still opens from the avatar and saves through
    // DreamStore.saveCharacter, updating BOTH renders in one go.
    await page.click('#profile-avatar-edit');
    await page.waitForSelector('#sheet-identity-overlay.open');
    await page.fill('#identity-name-input', 'Dana');
    await page.click('#identity-save-btn');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');
    assert.equal(await page.locator('#profile-handle').textContent(), 'Dana');
    // The generated avatar lands on BOTH renders of the same Me character
    // -- the header ring and the dock's Profile tab -- from one save.
    assert.equal(await page.locator('#profile-avatar img').count(), 1);
    assert.equal(await page.locator('#dock-avatar img').count(), 1);

    // Settings sheet still opens over the dock (z-order regression guard --
    // the dock is a new absolutely-positioned sibling of the overlays).
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');
    var overlayAboveDock = await page.evaluate(function () {
      var overlay = document.getElementById('sheet-account-overlay');
      var dock = document.querySelector('.night-dock');
      return parseInt(getComputedStyle(overlay).zIndex, 10) > parseInt(getComputedStyle(dock).zIndex, 10);
    });
    assert.equal(overlayAboveDock, true, 'an open sheet must cover the night dock');

    // Danger zone still only OPENS the confirmation modal, and Delete stays
    // disabled until a real password is typed.
    await page.locator('#delete-account-row').scrollIntoViewIfNeeded();
    await page.click('#delete-account-row');
    await page.waitForSelector('#modal-delete-account.open');
    assert.equal(await page.locator('#delete-account-confirm').isDisabled(), true);
  } finally {
    await context.close();
  }
});

test('profile.html: the new-likes banner and nav badge still render after the restyle', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, {});
    var published = dream({ id: 'dpub1', isPublished: true, likes: 1 });
    // The feed reports more likes than the locally-known count -> a real
    // "new likes since your last visit" total.
    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // js/store.js's refreshNewLikesCount reads data.feed (not
        // data.dreams) -- see its own doc comment.
        body: JSON.stringify({ feed: [{ id: 'dpub1', ownerHandle: '@tester', likes: 4 }] })
      });
    });
    await seedUser(page, { dreams: [published] });
    await safeGoto(page, baseUrl + '/profile.html');

    await page.waitForSelector('#new-likes-banner', { state: 'visible', timeout: 5000 });
    var text = await page.locator('#new-likes-banner-text').textContent();
    assert.match(text, /3 new likes/);
    assert.equal(await page.locator('#nav-profile-badge').evaluate(function (el) { return el.hidden; }), false, 'the badge dot still rides on the dock\'s Profile tab');
  } finally {
    await context.close();
  }
});
