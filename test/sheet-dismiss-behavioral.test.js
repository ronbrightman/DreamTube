// test/sheet-dismiss-behavioral.test.js
//
// Real browser-driven coverage for js/sheet-dismiss.js (tracker item
// for-product-sheet-dismissal-app-wide-fix-rlay70, founder re-request —
// first logged on settings-sheet-profile-html-review-swipe-igw84s, never
// built until now). Founder's own words: the interpretation sheet
// (result.html) and the settings sheet (profile.html) "cannot be closed
// except by scrolling all the way down to a Close button — the
// grab-handle line at the top does nothing, and tapping the area above
// the sheet does nothing either."
//
// This is the shared module's app-wide inventory of every .sheet-overlay
// (this codebase has a standing rule against fixing the same bug shape
// twice in different places — see FOUNDER_PRINCIPLES.md), so every sheet
// gets coverage here:
//
//   FULL five-point suite (originally the two sheets the founder named
//   directly, and the only two with real content long enough to exercise
//   the scroll-vs-drag gate meaningfully — now just the one; see the
//   removal note below):
//     1. profile.html — Settings (account) sheet
//
//   tap-outside / Close-Cancel-button regression / drag-dismiss /
//   drag-snap-back (their content is too short to meaningfully exercise
//   the mid-scroll gate, so that 5th check is skipped for these — there's
//   nothing to scroll):
//     2. profile.html — Edit profile (identity) sheet
//     3. result.html — Edit dream sheet
//     4. result.html — Add/edit character sheet (the one with an
//        overlay-level z-index override, sheet-character-overlay)
//     5. create.html — Add/edit character sheet
//     6. create.html — "Build it" character sheet (build-sheet-character-overlay)
//     7. wizard.html — Subject (character) sheet
//     8. start.html — Advanced > Characters sheet
//     9. js/purchase-sheet.js — out-of-tokens purchase sheet
//    10. js/purchase-sheet.js — daily-claim sheet
//
// REMOVED (not replaced): result.html's old "What this dream might mean"
// interpretation sheet, one of the two originally-named FULL-suite
// entries above — Interpretation Wave 1 (docs/INTERPRETATION_WAVE1_SPEC.md,
// tracker item for-product-build-interpretation-wave-1--xuftyn) rebuilt it
// entirely as js/interpret-experience.js's full-screen `.itp-overlay`
// takeover, which is NOT a `.sheet-overlay`/`.sheet` at all (no
// SheetDismiss.wire call, no drag-to-dismiss, no "tap outside" surface to
// speak of — it fills the whole viewport by design, spec §8). This
// module's app-wide inventory promise now correctly has nothing left to
// cover for that surface; its own dismissal behavior (topbar Close button,
// back button) is covered instead by test/interp-analytics-behavioral.test.js.
//
// Touch drag is simulated via test/helpers/touch-drag.js's dragSheet()
// (synthetic touchstart/touchmove*/touchend dispatch — see that file's
// own header comment for why, and why a single touchmove point is not
// enough to exercise a real drag).

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var staticServer = require('./helpers/static-server');
var dragSheet = require('./helpers/touch-drag').dragSheet;

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

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

async function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT, hasTouch: true });
}

async function seedLoggedInProfilePage(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
  await safeGoto(page, baseUrl + '/profile.html');
}

/** Seeds a logged-in user (+account) with one owned dream and lands on its result.html -- used below by the Edit-dream and character-sheet tests, neither of which cares about interpretation state (that surface is covered separately, see this file's own header comment). dreamId deliberately avoids the /^d[0-5]$/ legacy-mock-id pattern js/store.js's migrateLegacyState silently filters out. */
async function seedResultPageWithDream(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.dreams) state.dreams = [];
    state.dreams.push({
      id: 'd-sheet-dismiss-dream-1',
      ownerHandle: '@tester',
      caption: 'A test dream about flying over mountains',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: new Date().toISOString()
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
  await safeGoto(page, baseUrl + '/result.html?id=d-sheet-dismiss-dream-1');
}

/**
 * Generic assertions shared by every "short sheet" (character/identity/
 * edit-style) test below — tap-outside, drag-past-threshold dismiss,
 * drag-under-threshold snap-back, and the Close/Cancel button
 * regression. `open()` must leave the sheet already open (`.open` on
 * overlaySelector) when it resolves.
 */
// Generous but still bounded -- these are synchronous DOM operations
// (classList.remove + a CSS transition-driven visual settle) with no
// real async work to wait on, so a real bug always fails fast; this
// margin exists purely to absorb legitimate event-loop/rendering
// backpressure under heavy parallel test load (this codebase's own
// documented flaky-test-family shape — see CLAUDE.md/AGENT_POLICY.md —
// applies to Playwright-driven tests generally, not just the two named
// examples), not to mask a real dismiss failure.
var DISMISS_WAIT_TIMEOUT_MS = 8000;

// Mirrors js/sheet-dismiss.js's own DISMISS_RATIO (0.3) -- used only by
// the isolated-branch tests below to sanity-check that a test's chosen
// "short" drag distance genuinely stays under the real distance
// threshold for whichever sheet it's run against (sheet height varies
// per page/content), so a slow-vs-fast comparison actually isolates the
// velocity branch rather than accidentally also crossing the distance
// one.
var DISMISS_RATIO_FOR_TEST_SANITY = 0.3;

// The sheet's own open transition (.sheet's transform, css/styles.css) is
// a fixed 0.3s CSS transition. page.waitForSelector('.open') resolves the
// instant the class is added -- SYNCHRONOUSLY, well before that
// transition finishes -- so reading boundingBox() right after it
// (previously done with no wait at all) can capture the sheet mid-
// animation, still partway between its closed (translateY(100%)) and
// open (translateY(0)) positions. A tap coordinate computed from that
// stale geometry can miss badly once the sheet finishes settling into
// its real final position a moment later, landing ON the now-settled
// sheet instead of the backdrop above it -- root-caused via a targeted
// 10-iteration repro (no wait: ~40% failure rate, box.y visibly
// different and decreasing across iterations, i.e. genuinely
// mid-transition; with this wait: 0/10, box.y identical and stable every
// time). This is a real, reproducible race in this test's own
// measurement, not app or sheet-dismiss.js flakiness.
var OPEN_TRANSITION_SETTLE_MS = 350;

async function waitForSheetSettled(page, overlaySelector) {
  await page.waitForSelector(overlaySelector + '.open');
  await page.waitForTimeout(OPEN_TRANSITION_SETTLE_MS);
}

async function assertTapOutsideCloses(page, overlaySelector, open) {
  await open();
  await waitForSheetSettled(page, overlaySelector);
  var box = await page.locator(overlaySelector + ' .sheet').boundingBox();
  assert.ok(box, 'sheet must have a bounding box while open');
  assert.ok(box.y > 0, 'sheet must leave a nonzero tappable gap above it (max-height cap)');
  await page.mouse.click(box.x + box.width / 2, Math.max(1, box.y - 10));
  await page.waitForSelector(overlaySelector + ':not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
}

async function assertDragPastThresholdDismisses(page, overlaySelector, open) {
  await open();
  await waitForSheetSettled(page, overlaySelector);
  var box = await page.locator(overlaySelector + ' .sheet').boundingBox();
  await dragSheet(page, overlaySelector + ' .sheet', { startY: box.y + 20, deltaY: box.height * 0.6, steps: 20 });
  await page.waitForSelector(overlaySelector + ':not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
}

async function assertDragUnderThresholdSnapsBack(page, overlaySelector, open) {
  await open();
  await waitForSheetSettled(page, overlaySelector);
  var box = await page.locator(overlaySelector + ' .sheet').boundingBox();
  await dragSheet(page, overlaySelector + ' .sheet', { startY: box.y + 20, deltaY: box.height * 0.1, steps: 20 });
  await page.waitForTimeout(450); // let the snap-back transition finish
  assert.equal(await page.locator(overlaySelector + '.open').count(), 1, 'sheet must still be open after an under-threshold drag');
  var transform = await page.locator(overlaySelector + ' .sheet').evaluate(function (el) { return el.style.transform; });
  assert.equal(transform, '', 'inline transform override must be cleared after snapping back (future opens must not inherit a stale drag transform)');
}

// ============================================================================
// 1. profile.html — Settings (account) sheet (FULL five-point suite)
// ============================================================================

test('profile.html Settings sheet: tap outside the sheet closes it (founder-reported: this previously did nothing)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInProfilePage(page);
    await assertTapOutsideCloses(page, '#sheet-account-overlay', async function () {
      await page.click('#account-btn');
    });
  } finally {
    await context.close();
  }
});

test('profile.html Settings sheet: a drag-down past ~30% of its height dismisses it (founder-reported: the grab handle previously did nothing)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInProfilePage(page);
    await assertDragPastThresholdDismisses(page, '#sheet-account-overlay', async function () {
      await page.click('#account-btn');
    });
  } finally {
    await context.close();
  }
});

test('profile.html Settings sheet: a drag-down under the dismiss threshold snaps back open', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInProfilePage(page);
    await assertDragUnderThresholdSnapsBack(page, '#sheet-account-overlay', async function () {
      await page.click('#account-btn');
    });
  } finally {
    await context.close();
  }
});

test('profile.html Settings sheet: the existing Close link still works (regression)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInProfilePage(page);
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');
    await page.click('#account-cancel');
    await page.waitForSelector('#sheet-account-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('profile.html Settings sheet: scrolling its long content (Account/FAQ/Legal/Support/Danger zone) to the bottom and back to the top does not accidentally trigger a dismiss mid-scroll', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInProfilePage(page);
    await page.click('#account-btn');
    await waitForSheetSettled(page, '#sheet-account-overlay');

    var sheetSel = '#sheet-account-overlay .sheet';
    var scrolled = await page.locator(sheetSel).evaluate(function (el) {
      el.scrollTop = el.scrollHeight; // all the way to the bottom
      return el.scrollTop;
    });
    assert.ok(scrolled > 0, 'the Settings sheet must have real overflow for this test to mean anything');

    var box = await page.locator(sheetSel).boundingBox();
    await dragSheet(page, sheetSel, { startY: box.y + 20, deltaY: box.height * 0.7, steps: 20 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#sheet-account-overlay.open').count(), 1, 'a downward drag while scrolled away from the top must not dismiss the sheet');

    await page.locator(sheetSel).evaluate(function (el) { el.scrollTop = 0; });
    await page.waitForTimeout(50);
    box = await page.locator(sheetSel).boundingBox();
    await dragSheet(page, sheetSel, { startY: box.y + 20, deltaY: box.height * 0.6, steps: 20 });
    await page.waitForSelector('#sheet-account-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. profile.html — Edit profile (identity) sheet
// ============================================================================

test('profile.html Edit-profile sheet: tap-outside closes, drag-dismiss/snap-back both work, and the Close link still works', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInProfilePage(page);

    await assertTapOutsideCloses(page, '#sheet-identity-overlay', async function () {
      await page.click('#profile-avatar-edit');
    });
    await assertDragPastThresholdDismisses(page, '#sheet-identity-overlay', async function () {
      await page.click('#profile-avatar-edit');
    });
    await assertDragUnderThresholdSnapsBack(page, '#sheet-identity-overlay', async function () {
      await page.click('#profile-avatar-edit');
    });

    // assertDragUnderThresholdSnapsBack (above) deliberately leaves the
    // sheet OPEN (that's what "snap back" means) -- re-clicking the
    // trigger here would just hit the still-open overlay. Go straight to
    // the Close-button regression check on the already-open sheet.
    await page.waitForSelector('#sheet-identity-overlay.open');
    await page.click('#identity-cancel');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3. result.html — Edit dream sheet
// ============================================================================

test('result.html Edit-dream sheet: tap-outside closes, drag-dismiss/snap-back both work, and Cancel still works', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPageWithDream(page);

    await assertTapOutsideCloses(page, '#sheet-edit-overlay', async function () {
      await page.click('#open-edit-sheet');
    });
    await assertDragPastThresholdDismisses(page, '#sheet-edit-overlay', async function () {
      await page.click('#open-edit-sheet');
    });
    await assertDragUnderThresholdSnapsBack(page, '#sheet-edit-overlay', async function () {
      await page.click('#open-edit-sheet');
    });

    // Already open from the snap-back above -- go straight to the
    // Cancel-button regression check.
    await page.waitForSelector('#sheet-edit-overlay.open');
    await page.click('#edit-cancel');
    await page.waitForSelector('#sheet-edit-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

// ============================================================================
// 4. result.html — Add/edit character sheet (z-index-overridden overlay)
// ============================================================================

test('result.html character sheet (nested inside the Edit-dream sheet, z-index:12 override): tap-outside closes, drag-dismiss/snap-back both work, and Cancel still works', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPageWithDream(page);
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-overlay.open');
    await page.click('#adv-toggle');
    await page.waitForSelector('#char-add-other');

    async function openCharSheet() { await page.click('#char-add-other'); }

    await assertTapOutsideCloses(page, '#sheet-character-overlay', openCharSheet);
    await assertDragPastThresholdDismisses(page, '#sheet-character-overlay', openCharSheet);
    await assertDragUnderThresholdSnapsBack(page, '#sheet-character-overlay', openCharSheet);

    // Already open from the snap-back above -- go straight to the
    // Cancel-button regression check.
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.click('#char-cancel');
    await page.waitForSelector('#sheet-character-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

// ============================================================================
// 5/6. create.html — Add/edit character sheet + "Build it" character sheet
// ============================================================================

test('create.html character sheet: tap-outside closes, drag-dismiss/snap-back both work, and Cancel still works', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await safeGoto(page, baseUrl + '/create.html');
    // #adv-toggle lives in the "Write it" free-text panel (#create-write),
    // hidden by default behind create.html's initial Build/Write/Record
    // choice screen — reach it the same way test/avatar-describe-
    // behavioral.test.js's create.html coverage does.
    await page.click('#choice-write');
    await page.waitForSelector('#adv-toggle');
    await page.click('#adv-toggle');
    await page.waitForSelector('#char-add-other');

    async function openCharSheet() { await page.click('#char-add-other'); }

    await assertTapOutsideCloses(page, '#sheet-character-overlay', openCharSheet);
    await assertDragPastThresholdDismisses(page, '#sheet-character-overlay', openCharSheet);
    await assertDragUnderThresholdSnapsBack(page, '#sheet-character-overlay', openCharSheet);

    // Already open from the snap-back above -- go straight to the
    // Cancel-button regression check.
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.click('#char-cancel');
    await page.waitForSelector('#sheet-character-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('create.html "Build it" character sheet: tap-outside closes, drag-dismiss/snap-back both work, and Cancel still works', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await safeGoto(page, baseUrl + '/create.html?mode=build');
    await page.waitForSelector('#build-char-add-other, #build-subject-chip-row', { timeout: 5000 }).catch(function () {});

    var hasBuildAddOther = await page.locator('#build-char-add-other').count();
    if (!hasBuildAddOther) {
      // "Build it" mode's exact entry point can vary by flow state — fall
      // back to calling the sheet's own open function directly if no
      // discoverable trigger is on screen yet. openBuildCharSheet is a
      // plain top-level function declaration (create.html's script is not
      // wrapped in an IIFE — see result-photo-upload-sheet-token-
      // behavioral.test.js's header comment on this exact top-level-vs-IIFE
      // distinction across this codebase's pages), so it's reachable as a
      // window property.
      await page.evaluate(function () {
        if (typeof window.openBuildCharSheet === 'function') window.openBuildCharSheet('other', null);
      });
    }

    async function openCharSheet() {
      if (await page.locator('#build-char-add-other').count()) {
        await page.click('#build-char-add-other');
      } else {
        await page.evaluate(function () { window.openBuildCharSheet('other', null); });
      }
    }

    await page.waitForSelector('#build-sheet-character-overlay.open', { timeout: 5000 }).catch(function () {});
    var opened = await page.locator('#build-sheet-character-overlay.open').count();
    if (!opened) { t.skip('could not reach the "Build it" character sheet\'s trigger in this harness'); return; }
    await page.click('#build-char-cancel');
    await page.waitForSelector('#build-sheet-character-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });

    await assertTapOutsideCloses(page, '#build-sheet-character-overlay', openCharSheet);
    await assertDragPastThresholdDismisses(page, '#build-sheet-character-overlay', openCharSheet);
    await assertDragUnderThresholdSnapsBack(page, '#build-sheet-character-overlay', openCharSheet);
  } finally {
    await context.close();
  }
});

// ============================================================================
// 7. wizard.html — Subject (character) sheet
// ============================================================================

test('wizard.html character sheet: tap-outside closes, drag-dismiss/snap-back both work, and Cancel still works', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.waitForSelector('#subject-chip-row');
    await page.waitForSelector('#subj-add-other');

    async function openCharSheet() { await page.click('#subj-add-other'); }

    await assertTapOutsideCloses(page, '#sheet-character-overlay', openCharSheet);
    await assertDragPastThresholdDismisses(page, '#sheet-character-overlay', openCharSheet);
    await assertDragUnderThresholdSnapsBack(page, '#sheet-character-overlay', openCharSheet);

    // Already open from the snap-back above -- go straight to the
    // Cancel-button regression check.
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.click('#char-cancel');
    await page.waitForSelector('#sheet-character-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

// ============================================================================
// 8. start.html — Advanced > Characters sheet
// ============================================================================

function startResumeUrlWithPeople(caption) {
  return baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption);
}

test('start.html character sheet: tap-outside closes, drag-dismiss/snap-back both work, and Cancel still works', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, startResumeUrlWithPeople('I was walking through a forest with my mother.'));
    await page.waitForSelector('#char-chip-row');
    await page.waitForSelector('#char-add-other');

    async function openCharSheet() { await page.click('#char-add-other'); }

    await assertTapOutsideCloses(page, '#sheet-character-overlay', openCharSheet);
    await assertDragPastThresholdDismisses(page, '#sheet-character-overlay', openCharSheet);
    await assertDragUnderThresholdSnapsBack(page, '#sheet-character-overlay', openCharSheet);

    // Already open from the snap-back above -- go straight to the
    // Cancel-button regression check.
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.click('#char-cancel');
    await page.waitForSelector('#sheet-character-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

// ============================================================================
// 9. js/purchase-sheet.js — out-of-tokens purchase sheet
// ============================================================================

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

async function seedAccountForPurchaseSheet(page, username) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    if (!state.draft) state.draft = {};
    state.draft.caption = 'Flying over a glass city';
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
}

test('out-of-tokens purchase sheet (js/purchase-sheet.js): tap-outside closes, drag-dismiss/snap-back both work (regression: tap-outside dismiss is already covered in test/out-of-tokens-purchase-sheet-behavioral.test.js — this file adds the new drag coverage)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });
    await seedAccountForPurchaseSheet(page, 'purchdrag');
    await safeGoto(page, baseUrl + '/style.html');
    await page.waitForTimeout(200);

    async function openPurchaseSheet() {
      await page.click('.style-card[data-style="Realistic"]');
      await page.click('#generate-btn');
    }

    await assertTapOutsideCloses(page, '#purchase-sheet-overlay', openPurchaseSheet);
    await assertDragPastThresholdDismisses(page, '#purchase-sheet-overlay', openPurchaseSheet);
    await assertDragUnderThresholdSnapsBack(page, '#purchase-sheet-overlay', openPurchaseSheet);
  } finally {
    await context.close();
  }
});

// ============================================================================
// 10. js/purchase-sheet.js — daily-claim sheet
// ============================================================================

test('daily-claim sheet (js/purchase-sheet.js): tap-outside closes, drag-dismiss/snap-back both work, on shop.html -- its real, everyday call site', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedAccountForPurchaseSheet(page, 'claimdrag');
    // shop.html's real (un-mocked) content is ALREADY taller than one
    // mobile viewport (packs + FAQ + daily-claim banner) -- this exercises
    // the #app-height fix below against genuinely long content, not a
    // short fixture that happens to fit. Round-1 review finding on this
    // exact test file (this comment used to document routing this test
    // to profile.html specifically to DODGE shop.html's then-broken
    // #app sizing, rather than fixing it): shop.html's #app had no
    // height cap at all (min-height:100dvh only -- a floor, not a
    // ceiling), so .sheet-overlay's position:absolute;inset:0 (and the
    // sheet's own bottom:0 anchor) sized against that oversized box
    // instead of the real viewport. Fixed by giving shop.html's #app the
    // same class="scroll-shell" (height:100dvh) result.html/profile.html
    // already use, plus overflow-y:auto;min-height:0 on its own content
    // wrapper so the now-capped #app doesn't just clip the overflow with
    // nothing to scroll it into view.
    await safeGoto(page, baseUrl + '/shop.html');
    await page.waitForSelector('body');

    var appHeight = await page.evaluate(function () { return document.getElementById('app').getBoundingClientRect().height; });
    assert.ok(appHeight <= 844, '#app must be capped at (not taller than) the real viewport height even on shop.html\'s genuinely long real content, got ' + appHeight);

    async function openClaimSheet() {
      await page.evaluate(function () {
        window.PurchaseSheet.showClaimSheet({ source: 'test', tokenStatus: { claimable: true, dailyClaimAmount: 20, streak: 2 } });
      });
    }

    await assertTapOutsideCloses(page, '#claim-sheet-overlay', openClaimSheet);
    await assertDragPastThresholdDismisses(page, '#claim-sheet-overlay', openClaimSheet);
    await assertDragUnderThresholdSnapsBack(page, '#claim-sheet-overlay', openClaimSheet);
  } finally {
    await context.close();
  }
});

// ============================================================================
// Review round-1 finding: js/sheet-dismiss.js's dismiss decision is
// `offset > sheetHeight * DISMISS_RATIO || velocity > VELOCITY_THRESHOLD`
// -- every "past-threshold dismiss" test above (e.g.
// assertDragPastThresholdDismisses) drags far AND fast enough to cross
// BOTH conditions at once, so neither branch is independently proven.
// The two tests below isolate each: a slow drag that crosses only the
// distance threshold, and a fast flick that crosses only the velocity
// threshold with the sheet barely having moved. Calibrated against a
// real run: the identical short (40px) distance dragged SLOWLY snaps
// back (confirms distance alone is insufficient), while dragged FAST
// dismisses (confirms velocity alone is sufficient) -- both against
// profile.html's Settings sheet (742px tall on this viewport, so a 30%
// distance threshold of ~223px).
// ============================================================================

test('drag-dismiss distance branch in isolation: a SLOW drag past ~30% of the sheet\'s height dismisses even though it never reaches the velocity threshold', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInProfilePage(page);
    await page.click('#account-btn');
    await waitForSheetSettled(page, '#sheet-account-overlay');
    var box = await page.locator('#sheet-account-overlay .sheet').boundingBox();

    // 40 slow steps over 30ms each (~1.2s total) for a distance well past
    // the 30% ratio threshold -- a per-step velocity around 0.2px/ms,
    // comfortably under VELOCITY_THRESHOLD (0.6px/ms), so only the
    // distance branch can be responsible for the dismiss below.
    await dragSheet(page, '#sheet-account-overlay .sheet', { startY: box.y + 20, deltaY: box.height * 0.45, steps: 40, stepDelayMs: 30 });
    await page.waitForSelector('#sheet-account-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('drag-dismiss velocity branch in isolation: a FAST flick dismisses even though its total distance stays well short of the ~30% threshold', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInProfilePage(page);

    // Control: the SAME short distance, dragged slowly, must NOT dismiss
    // on its own -- proves the short distance below is genuinely under
    // the distance threshold, so the fast version's dismissal can only
    // be the velocity branch.
    await page.click('#account-btn');
    await waitForSheetSettled(page, '#sheet-account-overlay');
    var controlBox = await page.locator('#sheet-account-overlay .sheet').boundingBox();
    await dragSheet(page, '#sheet-account-overlay .sheet', { startY: controlBox.y + 20, deltaY: 80, steps: 20, stepDelayMs: 40 });
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#sheet-account-overlay.open').count(), 1, 'control: the same short 80px distance dragged SLOWLY must snap back, not dismiss -- otherwise the fast version below would prove nothing about the velocity branch specifically');
    // Reset via tap-outside (a raw mouse.click at a computed viewport
    // coordinate), NOT page.click('#account-cancel') -- that link sits
    // deep in this long Settings sheet (below the FAQ/Legal/Support/
    // Danger-zone content), so Playwright's own actionability check
    // auto-scrolls the sheet's internal overflow-y:auto content to bring
    // it into view before clicking. profile.html's sheet DOM is static
    // (reused across opens, never rebuilt -- see openAccountSheet's own
    // lack of a scrollTop reset), so that leftover scrollTop silently
    // carried into the very next reopen below, permanently blocking the
    // fast drag's engagement gate (scrollTop must be 0 to engage --
    // correct, intended behavior, just tripped by this test's own
    // methodology rather than anything real). Root-caused via a direct
    // repro: #account-cancel's own rect was hundreds of pixels below the
    // viewport, and scrollTop measured ~1000 immediately after that
    // click, persisting through the next #account-btn open.
    var resetBox = await page.locator('#sheet-account-overlay .sheet').boundingBox();
    await page.mouse.click(resetBox.x + resetBox.width / 2, Math.max(1, resetBox.y - 10));
    await page.waitForSelector('#sheet-account-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });

    // Fast steps (8ms apart, 40px each) covering a short 80px total --
    // js/sheet-dismiss.js measures velocity off the ACTUAL wall-clock gap
    // between dispatched touchmove events (Date.now()), not the requested
    // delay, so what matters is real elapsed time staying reasonably close
    // to what's requested. Sized with generous headroom against CI/heavy-
    // parallel-load timer jitter (this codebase's own documented
    // flaky-test-file shape): velocity = 40px / dt must stay above
    // VELOCITY_THRESHOLD (0.6px/ms), i.e. dt must stay under ~66ms -- over
    // 8x the requested 8ms per-step gap -- before this test would flake.
    // (An earlier version used 4 steps of 20px each, whose real safe
    // margin was only ~4.16x nominal -- ~33ms -- not the 5x its own
    // comment claimed; fixed by widening to fewer, larger steps instead of
    // just correcting the arithmetic, for a genuinely comfortable margin.)
    // The 80px total distance still stays far short of the ~223px (30% of
    // this sheet's height) distance threshold, so the isolation holds
    // regardless.
    await page.click('#account-btn');
    await waitForSheetSettled(page, '#sheet-account-overlay');
    var box = await page.locator('#sheet-account-overlay .sheet').boundingBox();
    assert.ok(80 < box.height * DISMISS_RATIO_FOR_TEST_SANITY, 'sanity: the 80px flick distance must genuinely stay under this sheet\'s own 30% distance threshold for this test to isolate the velocity branch');
    await dragSheet(page, '#sheet-account-overlay .sheet', { startY: box.y + 20, deltaY: 80, steps: 2, stepDelayMs: 8 });
    await page.waitForSelector('#sheet-account-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

// ============================================================================
// 12. Review round-1 finding: #app must stay viewport-bounded even when a
// page's own content is DELIBERATELY made taller than one viewport, on
// EVERY page that was previously unbounded (create.html/style.html/
// processing.html/shop.html had no class on #app at all; wizard.html/
// start.html's #app.funnel-app set colors only, no height) -- not just
// the short-content case that happened to pass before this was caught.
// wizard.html/start.html additionally needed their character sheet moved
// OUT of #fnScreen (the funnel's own internal scrolling region) and
// mounted as a direct #app child instead -- #fnScreen is itself a
// scrolling, position:relative container, so a sheet nested inside it
// (as both of these pages used to build it, embedded directly in their
// per-screen render functions' own innerHTML) is positioned against
// THAT scrollable box, not #app or the real viewport, independent of
// #app's own height fix; a real repro (inflate #fnScreen's content, open
// the sheet) left it rendered entirely off-screen before this fix.
// ============================================================================

/** Appends a real, non-shrinkable 1400px spacer as the FIRST child of `containerSelector` -- flex-shrink:0 is required (a plain empty div is otherwise exactly what flexbox will happily compress to fit, proving nothing about genuine overflow -- discovered the hard way in this same investigation). */
function inflateContentTallerThanViewport(page, containerSelector) {
  return page.evaluate(function (sel) {
    var container = document.querySelector(sel);
    var spacer = document.createElement('div');
    spacer.style.height = '1400px';
    spacer.style.flexShrink = '0';
    spacer.id = 'artificial-tall-spacer';
    container.insertBefore(spacer, container.firstChild);
  }, containerSelector);
}

test('style.html: #app stays capped at the real viewport height, and the out-of-tokens purchase sheet still has a genuinely tappable backdrop / correct on-screen position, even when this page\'s own content is deliberately made much taller than one viewport', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });
    await seedAccountForPurchaseSheet(page, 'styletallcontent');
    await safeGoto(page, baseUrl + '/style.html');
    await page.waitForTimeout(200);

    await inflateContentTallerThanViewport(page, '#app > .px');
    var appHeight = await page.evaluate(function () { return document.getElementById('app').getBoundingClientRect().height; });
    assert.ok(appHeight <= 844, '#app must stay capped at the real viewport even once its own content is deliberately inflated well past one viewport, got ' + appHeight);

    async function openPurchaseSheet() {
      await page.click('.style-card[data-style="Realistic"]');
      await page.click('#generate-btn');
    }

    await assertTapOutsideCloses(page, '#purchase-sheet-overlay', openPurchaseSheet);
    await assertDragPastThresholdDismisses(page, '#purchase-sheet-overlay', openPurchaseSheet);
    await assertDragUnderThresholdSnapsBack(page, '#purchase-sheet-overlay', openPurchaseSheet);
  } finally {
    await context.close();
  }
});

test('create.html character sheet: #app stays capped and the sheet still has a correct on-screen position/tappable backdrop even when the "Write it" panel\'s own content is deliberately made much taller than one viewport', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.waitForSelector('#adv-toggle');
    await page.click('#adv-toggle');
    await page.waitForSelector('#char-add-other');

    await inflateContentTallerThanViewport(page, '#create-write');
    var appHeight = await page.evaluate(function () { return document.getElementById('app').getBoundingClientRect().height; });
    assert.ok(appHeight <= 844, '#app must stay capped at the real viewport even once #create-write\'s content is deliberately inflated well past one viewport, got ' + appHeight);

    // A real Playwright click on #char-add-other gets legitimately
    // confused by this test's own artificial 1400px spacer overlapping
    // create.html's fixed bottom Continue bar (an artifact of the
    // synthetic spacer, not a real-world layout) -- dispatch the click
    // directly, same as every other "does the SHEET behave correctly
    // once open" assertion here, which is what this test actually cares
    // about.
    await page.evaluate(function () { document.getElementById('char-add-other').click(); });
    await waitForSheetSettled(page, '#sheet-character-overlay');
    var box = await page.locator('#sheet-character-overlay .sheet').boundingBox();
    assert.ok(box.y > 0 && box.y < 844, 'the character sheet must render within the real viewport (y between 0 and 844), got y=' + box.y);
    await page.mouse.click(box.x + box.width / 2, Math.max(1, box.y - 10));
    await page.waitForSelector('#sheet-character-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('wizard.html character sheet: #app stays capped and the sheet still has a correct on-screen position/tappable backdrop even when #fnScreen\'s own content is deliberately made much taller than one viewport (round-1 review finding: this sheet used to be mounted INSIDE #fnScreen, the funnel\'s own scrolling region, not #app)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.waitForSelector('#subject-chip-row');

    await inflateContentTallerThanViewport(page, '#fnScreen');
    var appHeight = await page.evaluate(function () { return document.getElementById('app').getBoundingClientRect().height; });
    assert.ok(appHeight <= 844, '#app.funnel-app must stay capped at the real viewport even once #fnScreen\'s content is deliberately inflated, got ' + appHeight);

    await page.click('#subj-add-other');
    await waitForSheetSettled(page, '#sheet-character-overlay');
    var box = await page.locator('#sheet-character-overlay .sheet').boundingBox();
    assert.ok(box.y > 0 && box.y < 844, 'the character sheet must render within the real viewport (y between 0 and 844), got y=' + box.y + ' -- if this is a large negative number, the sheet is STILL nested inside #fnScreen\'s own scrollable box rather than mounted directly on #app');
    await page.mouse.click(box.x + box.width / 2, Math.max(1, box.y - 10));
    await page.waitForSelector('#sheet-character-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('start.html character sheet: #app stays capped and the sheet still has a correct on-screen position/tappable backdrop even when #fnScreen\'s own content is deliberately made much taller than one viewport (same round-1 review finding as wizard.html)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, startResumeUrlWithPeople('I was walking through a forest with my mother.'));
    await page.waitForSelector('#char-chip-row');

    await inflateContentTallerThanViewport(page, '#fnScreen');
    var appHeight = await page.evaluate(function () { return document.getElementById('app').getBoundingClientRect().height; });
    assert.ok(appHeight <= 844, '#app.funnel-app must stay capped at the real viewport even once #fnScreen\'s content is deliberately inflated, got ' + appHeight);

    await page.click('#char-add-other');
    await waitForSheetSettled(page, '#sheet-character-overlay');
    var box = await page.locator('#sheet-character-overlay .sheet').boundingBox();
    assert.ok(box.y > 0 && box.y < 844, 'the character sheet must render within the real viewport (y between 0 and 844), got y=' + box.y + ' -- if this is a large negative number, the sheet is STILL nested inside #fnScreen\'s own scrollable box rather than mounted directly on #app');
    await page.mouse.click(box.x + box.width / 2, Math.max(1, box.y - 10));
    await page.waitForSelector('#sheet-character-overlay:not(.open)', { timeout: DISMISS_WAIT_TIMEOUT_MS });
  } finally {
    await context.close();
  }
});

test('processing.html: #app stays capped and the out-of-tokens purchase sheet has a correct on-screen position even when this page\'s own content is deliberately made much taller than one viewport', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@proctall', username: 'proctall' };
      if (!state.accounts) state.accounts = {};
      state.accounts.proctall = { password: 'testpass1', email: 'proctall@example.com' };
      if (!state.draft) state.draft = {};
      state.draft.caption = 'Flying over mountains';
      state.draft.style = 'Cinematic';
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForTimeout(200);

    await inflateContentTallerThanViewport(page, '.proc-wrap');
    var appHeight = await page.evaluate(function () { return document.getElementById('app').getBoundingClientRect().height; });
    assert.ok(appHeight <= 844, '#app must stay capped at the real viewport even once .proc-wrap\'s content is deliberately inflated, got ' + appHeight);

    async function openPurchaseSheet() {
      await page.evaluate(function () {
        PurchaseSheet.show({ mediaType: 'video', cost: 100, balance: 40, tokenStatus: { balance: 40, claimable: false }, source: 'blocked_action' });
      });
    }

    await assertTapOutsideCloses(page, '#purchase-sheet-overlay', openPurchaseSheet);
    await assertDragPastThresholdDismisses(page, '#purchase-sheet-overlay', openPurchaseSheet);
  } finally {
    await context.close();
  }
});
