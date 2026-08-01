// test/home-day0-dream-card-behavioral.test.js
//
// Behavioral coverage for home.html's day-0 EMBEDDED DREAM'S-ROOM CARD
// (tracker item for-product-build-ship-founder-go-08-01--ags710, founder
// GO 2026-08-01, "ship with or right after the 9-fix punch list"). Builds
// on top of the day-0 state-bug fix from the founder walkthrough punch
// list (tracker item for-product-founder-walkthrough-punch-li-t33k3y,
// already on main -- see home-behavioral.test.js's own regression test for
// that fix), which is unaffected by this change.
//
// The change itself: the OLD "Logged tonight ✓" hero-tonight square is
// DELETED for the one scenario where this account's very first-ever
// logged night is a REAL dream (still generating, or already finished) --
// replaced by a compact copy of result.html's own recently-shipped ritual
// card, embedded at the top of the home scroll, transforming forming ->
// ready IN PLACE (no reload, no toast-then-navigate). Visual/structural
// reference: funnel-end-mock-x7q4.html (repo root, "day-0 home leads with
// embedded dream's-room card"). See home.html's own shouldShowDay0Card()/
// renderDay0Card() for the implementation this exercises.
//
// Every OTHER Tonight state (unlogged, day-0-logged-via-"No recall"-only,
// ordinary returning-user logged) is untouched by this feature and stays
// covered by test/home-behavioral.test.js -- not re-covered here.
//
// Follows this repo's established Playwright/node:test convention
// (test/home-behavioral.test.js's own seedHomeUser/mockTokenStatus/
// blockThirdParty shape, test/first-video-created-explore-resume-
// behavioral.test.js's own seedAccountWithPendingJob pendingJob shape)
// rather than inventing a new one. Helpers below are deliberate, scoped
// near-copies rather than shared imports, matching this codebase's
// per-file test-helper self-containment convention.

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

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

/**
 * Seeds a logged-in, genuinely brand-new account (no prior dreams, no
 * no-recall history) with an in-flight pendingJob started "now" -- the
 * exact real-world shape of a just-completed funnel signup whose video is
 * still generating (same pendingJob shape test/first-video-created-
 * explore-resume-behavioral.test.js's own seedAccountWithPendingJob
 * establishes). Navigates straight to home.html.
 */
async function seedDay0Pending(page, opts) {
  opts = opts || {};
  var username = opts.username || 'day0user';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var handle = '@' + o.username;
    var state = {
      user: { handle: handle, username: o.username },
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: o.otherDreams || [],
      pendingJob: {
        operationName: 'mock:req-' + o.username,
        startedAt: Date.now(),
        caption: o.storyText || 'I was flying over a golden city at night',
        storyText: o.storyText || 'I was flying over a golden city at night',
        style: 'Cinematic',
        sourceDreamId: null,
        mediaType: 'video',
        notify: false,
        ownerHandle: handle
      }
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com', noRecallDates: [] };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, storyText: opts.storyText, otherDreams: opts.otherDreams });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

/**
 * Seeds a logged-in, genuinely brand-new account whose one-and-only dream
 * is ALREADY finished, created "now" (today) -- the day-0 "just completed"
 * half of this state, reached on a fresh page load rather than watching
 * the forming -> ready transition happen live. `otherDreams` (optional)
 * seeds additional same-day dreams for the My-dreams-row no-duplicate edge
 * case -- still isFirstEverNight, since every entry is from today.
 */
async function seedDay0Completed(page, opts) {
  opts = opts || {};
  var username = opts.username || 'day0readyuser';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var handle = '@' + o.username;
    var dream = Object.assign({
      id: 'd0-dream-1',
      ownerHandle: handle,
      caption: 'Flying over a golden city at night',
      storyText: 'Flying over a golden city at night',
      style: 'Cinematic',
      videoUrl: 'https://example.com/d0-dream-1.mp4',
      isPublished: false,
      likes: 0,
      createdAt: Date.now()
    }, o.dreamExtra || {});
    var state = {
      user: { handle: handle, username: o.username },
      accounts: {},
      draft: {},
      dreams: [dream].concat(o.otherDreams || [])
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com', noRecallDates: [] };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreamExtra: opts.dreamExtra, otherDreams: opts.otherDreams });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

// ============================================================================
// 1. Forming-state rendering
// ============================================================================

test('home.html day-0 card: forming state shows the shimmer/arc/caption veil, the dream\'s own quote, and a visible-but-disabled quiet row -- replacing (not duplicating) the old "Logged tonight" hero square, and never showing "No recall" anywhere', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    // Never resolves -- keeps this job in the forming state for the whole test.
    await page.route('**/.netlify/functions/video-status*', function () { /* stalled, deliberately */ });
    await seedDay0Pending(page, { username: 'formingtester', storyText: 'I was flying over a golden city at night' });

    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#hero-tonight').isVisible(), false, 'the old Logged-tonight square must be replaced, not shown alongside the new card');

    var frameClass = await page.locator('#d0-video').getAttribute('class');
    assert.doesNotMatch(frameClass, /\bready\b/, 'the video frame must not be marked ready while still forming');
    assert.equal(await page.locator('#d0-forming-veil').isVisible(), true, 'the shimmer/arc/caption veil must be visible while forming');
    assert.equal(await page.locator('#d0-watch').isVisible(), false, 'no watch pill until there is something to watch');

    var quote = await page.locator('#d0-quote').textContent();
    assert.match(quote, /flying over a golden city/i, 'the dream\'s own quote must render while forming, not a placeholder');

    assert.match(await page.locator('#d0-quiet').getAttribute('class'), /\bwaiting\b/);
    assert.equal((await page.locator('#d0-caption').textContent()).trim(), 'Ready when your dream is');

    var quietButtons = await page.locator('#d0-quiet .quietlink').all();
    assert.equal(quietButtons.length, 4, 'Publish / Make another / Edit / Delete -- same set as result.html\'s own quiet row');
    var labels = await page.locator('#d0-quiet .quietlink').allTextContents();
    assert.deepEqual(labels.map(function (l) { return l.trim(); }), ['Publish', 'Make another', 'Edit', 'Delete'], 'same order as result.html\'s own quiet row');
    for (var i = 0; i < quietButtons.length; i++) {
      assert.equal(await quietButtons[i].isDisabled(), true, 'every quiet-row action must be disabled while forming, not just visually muted');
    }

    // The My-dreams row never shows this same dream as a duplicate tile
    // while it's the account's only dream.
    assert.equal(await page.locator('#dreams').isVisible(), false);

    // innerText (not textContent) -- respects display:none, so a hidden
    // #hero-tonight's own "No recall" quiet link (still in the DOM, just
    // hidden while #day0-card owns this state) doesn't produce a false
    // positive here.
    var bodyText = await page.locator('#app').innerText();
    assert.doesNotMatch(bodyText, /no recall/i, 'this state must never show the literal "No recall" phrase anywhere VISIBLE on the page');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. Live in-place transition to the ready state on completion
// ============================================================================

test('home.html day-0 card: on completion, the SAME card comes alive in place -- a toast fires, the thumbnail + play badge replace the forming veil, the watch pill appears, and the quiet row enables -- no navigation, no reload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/d0-ready.mp4' }) });
    });
    await page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await seedDay0Pending(page, { username: 'readytransitiontester' });

    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    var beforeUrl = page.url();

    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });
    assert.equal(page.url(), beforeUrl, 'must resolve in place -- no navigation to result.html or anywhere else');

    await page.waitForSelector('.toast.show', { state: 'visible', timeout: 3000 });
    var toastText = await page.locator('.toast').textContent();
    assert.match(toastText, /your dream is ready/i);

    // The veil/play-badge crossfade is opacity-driven (a .6s/.5s CSS
    // transition, not an instant display:none) -- Playwright's isVisible()
    // doesn't treat opacity:0 as hidden, so wait for the transition to
    // actually settle, then check the computed style directly.
    await page.waitForFunction(function () {
      var el = document.getElementById('d0-forming-veil');
      return el && parseFloat(getComputedStyle(el).opacity) < 0.01;
    }, null, { timeout: 2000 });
    var veilOpacity = await page.locator('#d0-forming-veil').evaluate(function (el) { return getComputedStyle(el).opacity; });
    assert.equal(parseFloat(veilOpacity) < 0.01, true, 'the forming veil must have crossfaded away (opacity ~0)');
    var badgeOpacity = await page.locator('#d0-play-badge').evaluate(function (el) { return getComputedStyle(el).opacity; });
    assert.equal(parseFloat(badgeOpacity) > 0.99, true, 'the play badge must have faded in (opacity ~1)');
    assert.equal(await page.locator('#d0-caption').isVisible(), false);
    assert.equal(await page.locator('#d0-watch').isVisible(), true);
    assert.doesNotMatch(await page.locator('#d0-quiet').getAttribute('class'), /\bwaiting\b/);
    var quietButtons = await page.locator('#d0-quiet .quietlink').all();
    for (var i = 0; i < quietButtons.length; i++) {
      assert.equal(await quietButtons[i].isDisabled(), false, 'every quiet-row action must be enabled once ready');
    }
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3. Tapping through to the full dream's room
// ============================================================================

test('home.html day-0 card: tapping the ready video opens the FULL dream\'s room via result.html?id=...; tapping while still forming does not navigate anywhere', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });

    // Still forming -- tapping must NOT navigate.
    await page.route('**/.netlify/functions/video-status*', function () { /* stalled, deliberately */ });
    await seedDay0Pending(page, { username: 'tapformingtester' });
    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    await page.click('#d0-video');
    await page.waitForTimeout(300);
    assert.match(page.url(), /home\.html/, 'a tap while still forming must not navigate anywhere');
    await page.waitForSelector('.toast.show', { state: 'visible', timeout: 3000 });

    // Already-completed dream -- tapping the video opens the full room.
    await seedDay0Completed(page, { username: 'tapreadytester' });
    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    await Promise.all([
      page.waitForURL(/result\.html\?id=d0-dream-1/, { timeout: 5000, waitUntil: 'domcontentloaded' }),
      page.click('#d0-video')
    ]);
  } finally {
    await context.close();
  }
});

test('home.html day-0 card: the ready watch pill opens the full room too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    await seedDay0Completed(page, { username: 'watchpilltester' });
    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });

    await Promise.all([
      page.waitForURL(/result\.html\?id=d0-dream-1/, { timeout: 5000, waitUntil: 'domcontentloaded' }),
      page.click('#d0-watch')
    ]);
  } finally {
    await context.close();
  }
});

test('home.html day-0 card: each quiet-row action (Publish / Make another / Edit / Delete) opens the dream\'s full room once enabled -- "become real, clickable" means real navigation to where that action actually lives, not a duplicate set of handlers', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var ids = ['d0-publish', 'd0-make-another', 'd0-edit', 'd0-delete'];
  for (var i = 0; i < ids.length; i++) {
    var context = await newMobileContext();
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
      await seedDay0Completed(page, { username: 'quietactiontester' + i });
      await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
      await Promise.all([
        page.waitForURL(/result\.html\?id=d0-dream-1/, { timeout: 5000, waitUntil: 'domcontentloaded' }),
        page.click('#' + ids[i])
      ]);
    } finally {
      await context.close();
    }
  }
});

// ============================================================================
// 4. My-dreams-row no-duplicate behavior
// ============================================================================

test('home.html day-0 card: the My-dreams row never duplicates the embedded dream -- hidden entirely when it is the account\'s only dream, but still shows any OTHER same-day dream as its own tile', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });

    // Common case: the embedded dream is the account's ONLY dream -- the
    // whole My-dreams section stays hidden ("the top card IS the dream").
    await seedDay0Completed(page, { username: 'onlydreamtester' });
    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    assert.equal(await page.locator('#dreams').isVisible(), false);

    // Rare edge case: a second same-day dream still qualifies as
    // isFirstEverNight (every entry is from today) -- #day0-card owns the
    // most recently created one, but the OTHER dream must still get its
    // own row tile, never silently dropped.
    var otherDream = {
      id: 'd0-other-dream', ownerHandle: '@rowedgetester',
      caption: 'An earlier dream tonight', storyText: 'An earlier dream tonight',
      style: 'Cinematic', videoUrl: 'https://example.com/d0-other.mp4',
      isPublished: false, likes: 0, createdAt: Date.now() - 60000
    };
    await seedDay0Completed(page, { username: 'rowedgetester', otherDreams: [otherDream] });
    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    await page.waitForSelector('#dreams', { state: 'visible', timeout: 5000 });
    var rowHrefs = await page.locator('#dreams-row a.dream-row-tile').evaluateAll(function (els) { return els.map(function (e) { return e.getAttribute('href'); }); });
    assert.deepEqual(rowHrefs, ['result.html?id=d0-other-dream'], 'the OTHER same-day dream must still get its own row tile, and the embedded dream must never also appear here');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 5. Chamber hero stays untouched, and unrelated Tonight states are unaffected
// ============================================================================

test('home.html day-0 card: the Chamber hero keeps its own pulse and "reading doesn\'t need the video" copy, untouched by this change, while the embedded card is showing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    await page.route('**/.netlify/functions/video-status*', function () { /* stalled, deliberately */ });
    await seedDay0Pending(page, { username: 'chambertester' });
    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });

    assert.match(await page.locator('#chamber-pill').getAttribute('class'), /\bpulse\b/, 'the Chamber pill must keep carrying the page\'s single pulse');
    var chamberSub = await page.locator('#chamber-sub').textContent();
    assert.match(chamberSub, /reading is ready.*no need to wait for the video/i);
  } finally {
    await context.close();
  }
});

test('home.html: a day-0 account whose ONLY entry is a "No recall" check-in still gets the ordinary hero-tonight.logged square, not the embedded dream card -- there is no dream to embed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var state = {
        user: { handle: '@norecallonlytester', username: 'norecallonlytester' },
        accounts: { norecallonlytester: { password: 'testpass1', email: 'x@example.com', noRecallDates: [new Date().toDateString()] } },
        draft: {},
        dreams: []
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#hero-tonight', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#day0-card').isVisible(), false, 'no real dream exists yet -- the embedded card must not show');
    assert.match(await page.locator('#hero-tonight').getAttribute('class'), /\blogged\b/);
  } finally {
    await context.close();
  }
});

test('home.html: an ordinary RETURNING user (not day-0) with a real dream never shows the embedded day-0 card -- unaffected by this change', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 3 });
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var handle = '@returningtester';
      var TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).getTime();
      var state = {
        user: { handle: handle, username: 'returningtester' },
        accounts: { returningtester: { password: 'testpass1', email: 'x@example.com', noRecallDates: [] } },
        draft: {},
        dreams: [{
          id: 'old-dream', ownerHandle: handle, caption: 'An old dream', storyText: 'An old dream',
          style: 'Cinematic', videoUrl: 'https://example.com/old.mp4', isPublished: false, likes: 0,
          createdAt: TEN_DAYS_AGO
        }, {
          id: 'today-dream', ownerHandle: handle, caption: 'Tonight\'s dream', storyText: 'Tonight\'s dream',
          style: 'Cinematic', videoUrl: 'https://example.com/today.mp4', isPublished: false, likes: 0,
          createdAt: Date.now()
        }]
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#hero-tonight', { state: 'visible', timeout: 5000 });
    assert.match(await page.locator('#hero-tonight').getAttribute('class'), /\blogged\b/);
    assert.equal(await page.locator('#day0-card').isVisible(), false, 'a returning user (real prior history) must never see the day-0 embedded card');
    // Both dreams show as ordinary My-dreams row tiles -- nothing hidden.
    await page.waitForSelector('#dreams', { state: 'visible', timeout: 5000 });
    var rowHrefs = await page.locator('#dreams-row a.dream-row-tile').evaluateAll(function (els) { return els.map(function (e) { return e.getAttribute('href'); }); });
    assert.equal(rowHrefs.length, 2);
  } finally {
    await context.close();
  }
});

test('home.html: the "haven\'t logged yet today" prompt state (unlogged Tonight hero) is unaffected -- never shows the day-0 embedded card', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 });
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var handle = '@unloggedtester';
      var TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).getTime();
      var state = {
        user: { handle: handle, username: 'unloggedtester' },
        accounts: { unloggedtester: { password: 'testpass1', email: 'x@example.com', noRecallDates: [] } },
        draft: {},
        dreams: [{
          id: 'old-dream-2', ownerHandle: handle, caption: 'An old dream', storyText: 'An old dream',
          style: 'Cinematic', videoUrl: 'https://example.com/old2.mp4', isPublished: false, likes: 0,
          createdAt: TEN_DAYS_AGO
        }]
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#tonight-pill', { state: 'visible', timeout: 5000 });
    assert.doesNotMatch(await page.locator('#hero-tonight').getAttribute('class'), /\blogged\b/);
    assert.equal(await page.locator('#day0-card').isVisible(), false);
  } finally {
    await context.close();
  }
});
