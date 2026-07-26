// test/processing-preview-empty-sparse-fallback-behavioral.test.js
//
// Coverage for tracker.html's
// for-product-empty-sparse-feed-fallback-s-zldn85: processing.html's
// "while you wait" preview carousel (.proc-preview / #proc-preview-row) is
// the actual "first-timer carousel" the tracker item refers to -- a
// brand-new visitor has no dreams of their own yet, so renderPreview()
// falls back to the real shared Explore feed (DreamStore.getSharedFeed(),
// backed by netlify/functions/get-feed.js). This app is still early-stage,
// so that shared feed can genuinely be empty (nobody has published
// anything yet) or have only a handful of dreams in it -- previously an
// empty feed just hid the whole section, and a sparse feed (1-2 items)
// rendered a lonely, broken-looking horizontal scroll row.
//
// This file exercises the real page against a real static server
// (following test/token-daily-grant-copy-behavioral.test.js's
// seedLoggedInUserWithDraftAt pattern to reach processing.html with a
// valid draft) and intercepts get-feed.js via page.route() to control
// exactly how many shared dreams come back, plus stalls the real
// generate-video submission indefinitely (never fulfilled) so the
// underlying generation call can't fail/redirect out from under the
// assertions -- this suite only cares about the preview section, never
// about generation actually completing.

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

/** Never resolves -- keeps the real generation call permanently in flight so processing.html's proc-live/proc-preview stay visible for the whole test, instead of racing a fail-screen transition. */
function stallGeneration(page) {
  return page.route('**/.netlify/functions/generate-video', function () { /* deliberately never fulfilled */ });
}

/** Controls exactly what DreamStore.getSharedFeed() resolves to, by intercepting the real get-feed.js endpoint it fetches. */
function mockSharedFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: null }) });
  });
}

function sharedDream(id) {
  return { id: id, ownerHandle: '@someoneelse', caption: 'A shared dream', style: 'Cinematic', videoUrl: null, imageUrl: null, likes: 3, dur: '0:08' };
}

/** Seeds a brand-new, logged-in account with a valid draft (caption+style, no own dreams) directly in localStorage and navigates to processing.html -- the cheapest way to reach it without driving wizard.html's real chip flow, matching test/token-daily-grant-copy-behavioral.test.js's own seedLoggedInUserWithDraftAt convention. */
async function seedFirstTimerAt(page, username) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    if (!state.dreams) state.dreams = [];
    state.draft = Object.assign({}, state.draft, { caption: 'A dream about flying', style: 'Cinematic', mediaType: null, sourceImageUrl: null });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });
}

test('processing.html: a first-timer sees a friendly "be the first" fallback, not a hidden/broken section, when the shared feed is genuinely empty', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stallGeneration(page);
    await mockSharedFeed(page, []);

    await seedFirstTimerAt(page, 'emptyfeeduser');
    await page.waitForFunction(function () {
      var row = document.getElementById('proc-preview-row');
      return row && row.children.length > 0;
    }, { timeout: 5000 });

    var section = page.locator('#proc-preview');
    assert.equal(await section.evaluate(function (el) { return getComputedStyle(el).display; }), 'block', 'the preview section must stay visible (not hidden) for a friendly empty fallback to be seen at all');

    var rowHTML = await page.locator('#proc-preview-row').innerHTML();
    assert.match(rowHTML, /grid-empty/, 'must reuse the existing .grid-empty empty-state pattern rather than a bespoke one');
    assert.match(rowHTML, /Be the first to share a dream/i, 'empty shared feed should show the encouraging "be the first" copy, not a generic message');
    assert.doesNotMatch(rowHTML, /proc-preview-thumb/, 'zero real dreams means there must be no thumbnail markup at all');

    var labelText = await page.locator('#proc-preview-label').textContent();
    assert.doesNotMatch(labelText || '', /revisit your dreams|explore other dreams/, 'label copy referencing dreams that do not exist would be misleading here');
  } finally {
    await context.close();
  }
});

test('processing.html: a first-timer sees an encouraging (not broken-looking) sparse fallback when the shared feed has only 2 dreams', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stallGeneration(page);
    await mockSharedFeed(page, [sharedDream('shared-1'), sharedDream('shared-2')]);

    await seedFirstTimerAt(page, 'sparsefeeduser');
    await page.waitForFunction(function () {
      var row = document.getElementById('proc-preview-row');
      return row && row.children.length > 0;
    }, { timeout: 5000 });

    var section = page.locator('#proc-preview');
    assert.equal(await section.evaluate(function (el) { return getComputedStyle(el).display; }), 'block', 'the preview section must stay visible for the sparse fallback to be seen');

    var rowHTML = await page.locator('#proc-preview-row').innerHTML();
    assert.match(rowHTML, /grid-empty/, 'must reuse the existing .grid-empty empty-state pattern');
    assert.match(rowHTML, /Only a few dreams shared so far/i, 'a sparse (below-threshold) feed should get the encouraging "more coming" copy, distinct from the zero-item copy');
    assert.doesNotMatch(rowHTML, /Be the first to share a dream/i, 'sparse (non-zero) and empty (zero) states must use different copy');
    assert.doesNotMatch(rowHTML, /proc-preview-thumb/, 'a below-threshold feed must not render a lonely, broken-looking 1-2 thumbnail row');
  } finally {
    await context.close();
  }
});

test('processing.html: REGRESSION -- a healthy shared feed (5 dreams, at/above the sparse threshold) still renders the normal scrollable thumbnail carousel unaffected', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stallGeneration(page);
    var feed = [1, 2, 3, 4, 5].map(function (n) { return sharedDream('shared-' + n); });
    await mockSharedFeed(page, feed);

    await seedFirstTimerAt(page, 'healthyfeeduser');
    await page.waitForFunction(function () {
      var row = document.getElementById('proc-preview-row');
      return row && row.querySelectorAll('.proc-preview-thumb').length > 0;
    }, { timeout: 5000 });

    var section = page.locator('#proc-preview');
    assert.equal(await section.evaluate(function (el) { return getComputedStyle(el).display; }), 'block');

    var thumbCount = await page.locator('#proc-preview-row .proc-preview-thumb').count();
    assert.equal(thumbCount, 5, 'a healthy feed must render one thumbnail per dream, exactly like before this change');

    var rowHTML = await page.locator('#proc-preview-row').innerHTML();
    assert.doesNotMatch(rowHTML, /grid-empty/, 'a healthy feed must never show the empty/sparse fallback markup');

    var labelText = await page.locator('#proc-preview-label').textContent();
    assert.match(labelText || '', /explore other dreams/i, 'the normal shared-feed label copy must be unchanged for a healthy feed');
  } finally {
    await context.close();
  }
});

test('processing.html: REGRESSION -- a returning user\'s own published dreams still render as the normal carousel, untouched by the shared-feed fallback logic', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stallGeneration(page);
    // Shared feed intentionally left un-mocked-empty (mocked to something
    // irrelevant) -- the mine-branch must return early and never even look
    // at it when the account already has published dreams of its own.
    await mockSharedFeed(page, []);

    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@returninguser', username: 'returninguser' };
      if (!state.accounts) state.accounts = {};
      state.accounts.returninguser = { password: 'testpass1', email: 'returning@example.com' };
      state.dreams = [
        { id: 'mine-1', ownerHandle: '@returninguser', caption: 'mine 1', style: 'Cinematic', videoUrl: null, isPublished: true, likes: 0 },
        { id: 'mine-2', ownerHandle: '@returninguser', caption: 'mine 2', style: 'Cinematic', videoUrl: null, isPublished: true, likes: 0 }
      ];
      state.draft = Object.assign({}, state.draft, { caption: 'Another dream', style: 'Cinematic', mediaType: null, sourceImageUrl: null });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(function () {
      var row = document.getElementById('proc-preview-row');
      return row && row.children.length > 0;
    }, { timeout: 5000 });

    var thumbCount = await page.locator('#proc-preview-row .proc-preview-thumb').count();
    assert.equal(thumbCount, 2, 'own published dreams must still render as thumbnails exactly as before, even though there are fewer than the sparse threshold');

    var labelText = await page.locator('#proc-preview-label').textContent();
    assert.match(labelText || '', /revisit your dreams/i, 'the mine-branch label copy must be unchanged');
  } finally {
    await context.close();
  }
});
