// test/settings-sheet-swipe-and-shop-cta-behavioral.test.js
//
// Real browser-driven coverage for tracker.html's
// settings-sheet-profile-html-review-swipe-igw84s item, the two small
// fixes scoped to this branch (the email/backup copy and export-backup
// items in that same tracker entry were investigated separately and kept
// as-is -- not part of this file):
//
// 1. Swipe-down-to-dismiss on profile.html's Settings sheet
//    (#sheet-account-overlay). The sheet's grabber handle
//    (#account-sheet-handle) used to be purely decorative -- zero
//    touch/drag listener wired to it, despite the standard UI convention
//    it implies. Mirrors the app's existing swipe-right -> Explore
//    gesture (touchstart/touchend only, never preventDefault on
//    touchmove, distance/time/angle thresholds) but scoped specifically
//    to the handle rather than the whole sheet card, since the sheet's
//    own content can be taller than the viewport (.sheet has
//    max-height:88vh + overflow-y:auto) and a whole-card gesture would
//    risk eating a real attempt to scroll that content.
//
// 2. The Token shop row's visual redesign (.shop-cta) -- this is
//    primarily a styling change (verified visually already), so the
//    coverage here is deliberately light: the link still points at
//    shop.html and is still a single, reachable click target.
//
// Touch simulation uses a raw CDP session (Input.dispatchTouchEvent)
// rather than Playwright's page.touchscreen (tap-only, no drag support)
// -- a browser context created with hasTouch:true is required for
// Chromium to actually deliver synthesized touch input as real
// TouchEvents to addEventListener('touchstart'/'touchend', ...)
// listeners; without it, dispatched touch events are silently dropped.
// One real gotcha hit while building this: the sheet's own open
// transition (.3s transform slide-up) must be allowed to finish before
// reading element.boundingBox() for touch coordinates -- measuring
// mid-animation gives a stale/wrong position and the synthesized touch
// lands on the wrong element entirely (confirmed by instrumenting a
// debug touchstart listener on document during development).
//
// Follows test/profile-me-character-behavioral.test.js's conventions:
// node:test + real Chromium via Playwright (not a project dependency --
// resolved from this sandbox's global install, see CLAUDE.md), state
// seeded directly into localStorage rather than driving signup/login,
// and every page.goto wrapped against this sandbox's known intermittent
// outbound-network stalls on third-party hosts.

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel) -- none are needed for what these tests check, and this sandbox's outbound network can intermittently stall on them (see CLAUDE.md). */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** profile.html's owner-check fetch (admin-paywall-toggle.js) -- no local Netlify Functions runtime is available to these tests (see test/helpers/static-server.js's own doc comment), so it's stubbed the same way generate-avatar etc. are stubbed elsewhere in this repo's browser tests. Not owner, for every test here -- irrelevant to what's under test. */
function mockOwnerCheck(page) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isOwner: false }) });
  });
}

/** Wraps page.goto so a transient network stall on a blocked-in-vain third-party request doesn't crash the whole run -- see CLAUDE.md's environment-quirk note. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Seeds a logged-in "tester" account, same shortcut test/profile-me-character-behavioral.test.js's seedUser uses. */
async function seedUser(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var state = {
      user: { handle: '@tester', username: 'tester' },
      accounts: { tester: { password: 'testpass1', email: 'tester@example.com' } },
      charactersByUser: { tester: [] },
      dreams: [],
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null }
    };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

/** Opens profile.html's Settings sheet and waits out its .3s slide-up transition -- see this file's header comment for why that wait matters for touch coordinates. */
async function openSettingsSheet(page) {
  await safeGoto(page, baseUrl + '/profile.html');
  await page.click('#account-btn');
  await page.waitForSelector('#sheet-account-overlay.open');
  await page.waitForTimeout(400);
}

/** Real multi-point touch drag via CDP (Input.dispatchTouchEvent) -- Playwright's own page.touchscreen only supports tap(), no drag. touchMove is only dispatched when dx/dy move (a plain tap passes moveTo === start), matching a real single-point touch. */
async function touchDrag(context, page, x1, y1, x2, y2, opts) {
  opts = opts || {};
  var moveDelayMs = opts.moveDelayMs === undefined ? 50 : opts.moveDelayMs;
  var endDelayMs = opts.endDelayMs === undefined ? 50 : opts.endDelayMs;
  var client = await context.newCDPSession(page);
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
    if (moveDelayMs > 0) await new Promise(function (r) { setTimeout(r, moveDelayMs); });
    if (x1 !== x2 || y1 !== y2) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x2, y: y2 }] });
    }
    if (endDelayMs > 0) await new Promise(function (r) { setTimeout(r, endDelayMs); });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach();
  }
}

test('profile.html Settings sheet: a fast downward swipe on the handle closes it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  var page = await context.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  try {
    await seedUser(page);
    await openSettingsSheet(page);

    var box = await page.locator('#account-sheet-handle').boundingBox();
    var x = box.x + box.width / 2, y = box.y + box.height / 2;
    await touchDrag(context, page, x, y, x, y + 100);

    await page.waitForSelector('#sheet-account-overlay:not(.open)');
    assert.equal(await page.locator('#sheet-account-overlay.open').count(), 0);
  } finally {
    await page.close();
    await context.close();
  }
});

test('profile.html Settings sheet: a plain tap on the handle does NOT close it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  var page = await context.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  try {
    await seedUser(page);
    await openSettingsSheet(page);

    var box = await page.locator('#account-sheet-handle').boundingBox();
    var x = box.x + box.width / 2, y = box.y + box.height / 2;
    await touchDrag(context, page, x, y, x, y, { moveDelayMs: 0, endDelayMs: 0 });

    await page.waitForTimeout(200);
    assert.equal(await page.locator('#sheet-account-overlay.open').count(), 1, 'a plain tap must not dismiss the sheet');
  } finally {
    await page.close();
    await context.close();
  }
});

test('profile.html Settings sheet: an upward swipe on the handle does NOT close it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  var page = await context.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  try {
    await seedUser(page);
    await openSettingsSheet(page);

    var box = await page.locator('#account-sheet-handle').boundingBox();
    var x = box.x + box.width / 2, y = box.y + box.height / 2;
    await touchDrag(context, page, x, y, x, y - 100);

    await page.waitForTimeout(200);
    assert.equal(await page.locator('#sheet-account-overlay.open').count(), 1, 'an upward swipe must not dismiss the sheet');
  } finally {
    await page.close();
    await context.close();
  }
});

test('profile.html Settings sheet: a mostly-sideways swipe on the handle does NOT close it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  var page = await context.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  try {
    await seedUser(page);
    await openSettingsSheet(page);

    var box = await page.locator('#account-sheet-handle').boundingBox();
    var x = box.x + box.width / 2, y = box.y + box.height / 2;
    // Large horizontal movement, only a modest vertical one -- fails the
    // MAX_DX angle check even though dy alone would clear MIN_DY.
    await touchDrag(context, page, x, y, x + 120, y + 80);

    await page.waitForTimeout(200);
    assert.equal(await page.locator('#sheet-account-overlay.open').count(), 1, 'a mostly-sideways swipe must not dismiss the sheet');
  } finally {
    await page.close();
    await context.close();
  }
});

test('profile.html Settings sheet: a slow downward drag on the handle (exceeds the time threshold) does NOT close it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  var page = await context.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  try {
    await seedUser(page);
    await openSettingsSheet(page);

    var box = await page.locator('#account-sheet-handle').boundingBox();
    var x = box.x + box.width / 2, y = box.y + box.height / 2;
    // Same distance as the passing case, but held long enough to blow past MAX_MS (700ms).
    await touchDrag(context, page, x, y, x, y + 100, { moveDelayMs: 900, endDelayMs: 50 });

    await page.waitForTimeout(200);
    assert.equal(await page.locator('#sheet-account-overlay.open').count(), 1, 'a slow drag must not dismiss the sheet');
  } finally {
    await page.close();
    await context.close();
  }
});

test('profile.html Settings sheet: a fast downward swipe starting on the sheet body (off the handle) does NOT close it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  var page = await context.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  try {
    await seedUser(page);
    await openSettingsSheet(page);

    // Same fast/vertical/quick shape as the passing case, but starting on
    // the sheet's title text instead of the handle -- locks in the
    // deliberate "handle only, not the whole card" scoping decision (see
    // this file's header comment for why: the sheet's own content can
    // scroll, and a whole-card gesture risks eating that).
    var box = await page.locator('#sheet-account-overlay .sheet-title').boundingBox();
    var x = box.x + box.width / 2, y = box.y + box.height / 2;
    await touchDrag(context, page, x, y, x, y + 100);

    await page.waitForTimeout(200);
    assert.equal(await page.locator('#sheet-account-overlay.open').count(), 1, 'a swipe starting off the handle must not dismiss the sheet');
  } finally {
    await page.close();
    await context.close();
  }
});

test('profile.html Settings sheet: the Token shop row still links to shop.html and is a single, reachable click target', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  try {
    await seedUser(page);
    await openSettingsSheet(page);

    var link = page.locator('#account-shop-link');
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute('href'), 'shop.html');
    assert.equal(await link.isVisible(), true);
    // Redesigned into a richer icon+title+sub CTA row -- still exactly
    // one click target for the whole row (icon/title/sub are all inside
    // the same <a>, none of them independently clickable/tabbable).
    assert.equal(await page.locator('#account-shop-link a').count(), 0, 'no nested clickable elements inside the shop CTA');
    assert.equal(await link.locator('.shop-cta-title').textContent(), 'Token shop');

    var href = await link.evaluate(function (el) { return new URL(el.href).pathname.split('/').pop(); });
    assert.equal(href, 'shop.html');
  } finally {
    await page.close();
  }
});
