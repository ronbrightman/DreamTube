// test/out-of-tokens-purchase-sheet-behavioral.test.js
//
// Real browser-driven coverage for the out-of-tokens purchase sheet
// (tracker item for-product-build-out-of-tokens-purchase-2y8hyw, founder
// directive 2026-07-26: "the store must come up whenever a user tries any
// action without enough tokens"). See js/purchase-sheet.js's header
// comment for the full feature story and the draft-persistence bug this
// build fixed.
//
// Covers:
//  - the sheet appearing with correct shortfall arithmetic on style.html,
//    result.html ("Generate Again" AND "Turn this into a video"), and
//    home.html's own E112/E412 mid-generation-failure path (formerly
//    processing.html's, ported verbatim when that page was removed --
//    tracker item for-product-funnel-ending-v2-founder-ins-tfuu0q)
//  - the audit-found bug fix: the blocked action's full draft state is
//    genuinely persisted (DreamStore.setDraft/turnImageIntoVideo) the
//    moment the sheet opens on style.html AND result.html, not only on
//    the unblocked path
//  - the post-checkout auto-resume round trip on home.html (a mocked
//    successful checkout return re-fires the exact blocked generation
//    from the intact draft)
//  - the honest-degrade path when the token credit is still lagging past
//    the poll window
//
// The open-redirect guard on create-checkout-session-dodo.js's
// successUrl/cancelUrl is covered separately in
// test/create-checkout-session-dodo.test.js (a plain node --test, no
// browser needed for that part).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settle = require('./helpers/settle').settle;

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

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

/**
 * Records every posthog.capture() call into a plain Node-side array —
 * needed for the image-fallback tests below (tracker item
 * for-product-out-of-tokens-sheet-founder--dg5q1y), where tapping the
 * fallback link fires an event AND (on style.html/result.html)
 * immediately navigates away to home.html?generate=1.
 *
 * Root-cause note (systematic-debugging): two earlier approaches were
 * tried and both failed for real reasons, not flakiness --
 *  1. A plain post-click `page.evaluate(() => window.__phEvents)` read
 *     came back undefined even though the event genuinely fired: this
 *     app registers a service worker (sw.js), and Chromium's top-frame
 *     navigation to home.html completed essentially synchronously with
 *     the click, tearing down style.html's whole JS realm (window.__phEvents
 *     included) before the read could run -- confirmed by instrumenting
 *     a standalone repro with framenavigated/console logging.
 *  2. Trying to keep the OLD page alive by delaying a page.route()
 *     handler matching the home.html navigation never even fired (no log
 *     output from inside the handler) -- again the service worker, which intercepts
 *     navigation requests ahead of Playwright's own routing layer in
 *     this app.
 * Fixed with page.exposeFunction(), which installs a real Node-side
 * function callable from the page and, per Playwright's own docs,
 * survives navigations -- so events land directly in this array in the
 * TEST process, immune to the page's JS realm being torn down at all.
 * Call this ONCE, before the first page.goto (exposeFunction must be
 * registered before the page that will call it loads); call
 * wirePostHogCaptureForwarding(page) again after EVERY later goto, since
 * the window.posthog.capture wrap itself is page-JS-realm state that
 * does NOT survive navigation the way the exposed function does.
 */
async function capturePostHogEvents(page) {
  var events = [];
  await page.exposeFunction('__notifyPhEvent__', function (name, propsJson) {
    var props = null;
    try { props = JSON.parse(propsJson); } catch (e) { /* leave null */ }
    events.push({ name: name, props: props });
  });
  return events;
}

/** Wraps window.posthog.capture (once it's a real function -- call AFTER page.goto, same "analytics snippet already ran synchronously" timing the existing claim-inline tests already rely on) to forward every call to the exposed __notifyPhEvent__ -- see capturePostHogEvents' own doc comment for why this two-step split exists. */
function wirePostHogCaptureForwarding(page) {
  return page.evaluate(function () {
    var orig = window.posthog.capture.bind(window.posthog);
    window.posthog.capture = function (name, props) {
      try { window.__notifyPhEvent__(name, JSON.stringify(props)); } catch (e) { /* best effort */ }
      return orig(name, props);
    };
  });
}

/** Seeds a logged-in account (with email — DreamStore.getTokenStatus/getAccountEmail short-circuit without one) plus an optional draft and/or dream, mirroring test/image-generation-turn-into-video-behavioral.test.js's seedAccountWithDream. */
async function seedAccount(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || (o.username + '@example.com') };
    if (o.draft) {
      state.draft = Object.assign({ caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null }, o.draft);
    }
    if (o.dream) {
      if (!state.dreams) state.dreams = [];
      state.dreams.push(Object.assign({
        ownerHandle: '@' + o.username,
        caption: 'A dream about a floating library',
        style: 'Anime',
        isPublished: false,
        likes: 0, likedByMe: false
      }, o.dream));
    }
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    if (o.pendingPurchase) {
      sessionStorage.setItem('dreamtube_pending_purchase', JSON.stringify(o.pendingPurchase));
    }
  }, opts);
}

// ============================================================================
// Arithmetic + draft persistence — style.html
// ============================================================================
test('style.html: blocked generate opens the purchase sheet with correct shortfall arithmetic, and persists the FULL draft (style + mediaType) before the sheet even renders', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + (6 * 3600000) + (12 * 60000), dailyClaimAmount: 20, claimable: false, streak: 0 });

    await seedAccount(page, { username: 'styleblocked', draft: { caption: 'Flying over a glass city' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200); // let the async getTokenStatus() pre-check resolve

    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#generate-btn');

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    var title = await page.textContent('#ps-title');
    assert.match(title, /Almost there — this video needs 100 tokens/);
    var body = await page.textContent('#ps-body');
    assert.match(body, /You have\s*40/);
    assert.match(body, /60 more/);
    var waitLine = await page.textContent('#ps-wait-line');
    assert.match(waitLine, /Or claim 20 free tokens in 6h 1[23]m/);
    var buyLabel = await page.textContent('#ps-buy-label');
    // hasMadeFirstPurchase not set on this mocked tokenStatus -> fails
    // toward false -> the sheet offers the one-time $0.99 starter pack099
    // (see pickContextualPack's own doc comment).
    assert.match(buyLabel, /Get 300 tokens · \$0\.99/);

    // THE BUG FIX: the sheet must have already persisted the full blocked
    // action's draft (style + mediaType), not only on an unblocked path.
    var draft = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('dreamtube_state_v1')).draft;
    });
    assert.equal(draft.style, 'Realistic');
    assert.equal(draft.mediaType, 'video');
    assert.equal(draft.caption, 'Flying over a glass city');
  } finally {
    await context.close();
  }
});

test('PurchaseSheet.show affordability guard (founder bug 2026-08-10, "needs 0 more"): when balance already covers cost the sheet does NOT open, and any onAfford proceed-callback fires instead -- but a genuine shortfall still opens it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 500, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });
    await seedAccount(page, { username: 'guardtester' });
    // Any page that loads js/purchase-sheet.js will do -- style.html mounts it.
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () { return window.PurchaseSheet && typeof window.PurchaseSheet.show === 'function'; }, null, { timeout: 5000 });

    // balance > cost -> suppressed, onAfford invoked.
    var over = await page.evaluate(function () {
      window.__afforded = false;
      window.PurchaseSheet.show({ mediaType: 'video', cost: 100, balance: 150, source: 'test', onAfford: function () { window.__afforded = true; } });
      var el = document.getElementById('purchase-sheet-overlay');
      return { open: !!(el && el.classList.contains('open')), afforded: window.__afforded };
    });
    assert.equal(over.open, false, 'the sheet must NOT open when balance already exceeds cost');
    assert.equal(over.afforded, true, 'onAfford must be invoked as the proceed path when the action is already affordable');

    // balance === cost -> still "can afford", still suppressed (boundary).
    var equal = await page.evaluate(function () {
      window.__afforded = false;
      window.PurchaseSheet.show({ mediaType: 'video', cost: 100, balance: 100, source: 'test', onAfford: function () { window.__afforded = true; } });
      var el = document.getElementById('purchase-sheet-overlay');
      return { open: !!(el && el.classList.contains('open')), afforded: window.__afforded };
    });
    assert.equal(equal.open, false, 'balance === cost means the user can afford it -- still no sheet');
    assert.equal(equal.afforded, true, 'onAfford fires at the exact-cover boundary too');

    // A genuine shortfall must STILL open the sheet (the guard must not
    // over-suppress -- the founder directive that the store come up whenever
    // a user genuinely lacks tokens is preserved).
    var short = await page.evaluate(function () {
      window.PurchaseSheet.show({ mediaType: 'video', cost: 100, balance: 40, source: 'test' });
      var el = document.getElementById('purchase-sheet-overlay');
      return !!(el && el.classList.contains('open'));
    });
    assert.equal(short, true, 'a real shortfall (balance < cost) must still open the out-of-tokens sheet');
  } finally {
    await context.close();
  }
});

test('style.html: tapping the buy button POSTs the contextual pack (starter, since hasMadeFirstPurchase is unset) with a relative-path-only successUrl/cancelUrl', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    var captured = null;
    await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
      captured = JSON.parse(route.request().postData());
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'about:blank', sessionId: 'sess1', eventId: 'evt1' }) });
    });

    await seedAccount(page, { username: 'stylebuy', draft: { caption: 'A city made of light' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.click('.style-card[data-style="Anime"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    await page.click('#ps-buy-btn');
    await page.waitForTimeout(300);

    assert.ok(captured, 'create-checkout-session-dodo must have been called');
    assert.equal(captured.pack, 'pack099');
    assert.equal(captured.successUrl, '/home.html?checkout=success');
    assert.equal(captured.cancelUrl, '/style.html?checkout=cancelled');
  } finally {
    await context.close();
  }
});

test('style.html: dismissing the sheet right after tapping Buy, then reopening and tapping Buy again, does not let the first (dismissed) request\'s late failure corrupt the reopened sheet\'s in-flight state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // Round-5 review finding: wireBuyButton's checkout-session .catch() was
  // the one remaining async callback in purchase-sheet.js with no
  // currentGen staleness guard (every other one -- claimInline/runClaim --
  // was fixed in earlier rounds for the same reason). First click's
  // request fails slowly; before it settles, the sheet is dismissed and
  // reopened, and a SECOND Buy click starts a request that's still
  // genuinely in flight (never resolves within this test). The first
  // click's late failure must not revert the reopened sheet's button/label
  // out of its own in-flight "Redirecting..." state, nor show a bogus error.
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(err); });
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    var checkoutCalls = 0;
    await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
      checkoutCalls++;
      if (checkoutCalls === 1) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'server_error' }) });
            resolve();
          }, 500);
        });
      }
      // Second call: never resolves within this test -- the reopened
      // sheet's own request stays genuinely in flight throughout.
      return new Promise(function () {});
    });

    await seedAccount(page, { username: 'buydismissreopen', draft: { caption: 'A city made of light' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.click('.style-card[data-style="Anime"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    await page.click('#ps-buy-btn'); // kicks off the 500ms-delayed failing request
    await page.click('#purchase-sheet-overlay', { position: { x: 5, y: 5 } }); // dismiss immediately
    await page.waitForSelector('#purchase-sheet-overlay:not(.open)', { timeout: 3000 });

    await page.click('#generate-btn'); // reopen
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    await page.click('#ps-buy-btn'); // kicks off the never-resolving second request
    await page.waitForSelector('#ps-buy-label:has-text("Redirecting")', { timeout: 3000 });

    // Let the first (dismissed instance's) delayed failure resolve while
    // the REOPENED sheet's own request is still genuinely in flight.
    await page.waitForTimeout(800);

    var buyLabelAfter = await page.textContent('#ps-buy-label');
    assert.match(buyLabelAfter, /Redirecting/, 'the reopened sheet\'s own in-flight click must not be reverted by the stale dismissed instance\'s late failure');
    var buyBtnDisabled = await page.evaluate(function () { return document.getElementById('ps-buy-btn').disabled; });
    assert.equal(buyBtnDisabled, true, 'the reopened sheet\'s Buy button must stay disabled -- its own request is still genuinely in flight');
    var errorVisible = await page.isVisible('#ps-error');
    assert.equal(errorVisible, false, 'no error should show -- the failure belongs to the dismissed, stale instance, not the currently open one');
    assert.equal(pageErrors.length, 0, 'no uncaught error -- ' + pageErrors.map(function (e) { return e.message; }).join('; '));
  } finally {
    await context.close();
  }
});

// ============================================================================
// Arithmetic + draft persistence — result.html "Generate Again" (Edit
// sheet). Seeded as an IMAGE-type dream specifically to exercise the fix
// for the old flat-100-tokens assumption (an image regenerate costs 10,
// not 100) — the sheet's arithmetic must reflect the real cost.
// ============================================================================
test('result.html "Generate Again": opens the purchase sheet with correct per-mediaType arithmetic (image regenerate = 10 tokens, not a hardcoded 100), and persists the edit sheet\'s caption/style before the sheet renders', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 4, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    await seedAccount(page, {
      username: 'regenimage',
      dream: { id: 'dream-regen-image', mediaType: 'image', imageUrl: 'https://example.com/fake-image.jpg', videoUrl: null, caption: 'Original caption', style: 'Anime' }
    });
    await page.goto(baseUrl + '/result.html?id=dream-regen-image', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);

    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet this test's caption/style controls live in.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');
    await page.fill('#edit-text', 'An edited caption about the same dream');
    await page.click('#sheet-style-grid .style-card[data-style="Cinematic"]');
    await page.click('#edit-generate-again');

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    var title = await page.textContent('#ps-title');
    assert.match(title, /Almost there — this image needs 10 tokens/, 'must use the real per-mediaType cost, not a hardcoded flat 100');
    var body = await page.textContent('#ps-body');
    assert.match(body, /You have\s*4/);
    assert.match(body, /6 more/);

    // THE BUG FIX: caption/style from the edit sheet must be persisted
    // BEFORE the sheet renders, not only on the unblocked path.
    var draft = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('dreamtube_state_v1')).draft;
    });
    assert.equal(draft.caption, 'An edited caption about the same dream');
    assert.equal(draft.style, 'Cinematic');
    assert.equal(draft.sourceDreamId, 'dream-regen-image');
    assert.equal(draft.mediaType, 'image');
  } finally {
    await context.close();
  }
});

// ============================================================================
// Arithmetic + draft persistence — result.html "Turn this into a video"
// upsell (the image-to-video path spec item 1 calls out explicitly).
// ============================================================================
test('result.html "Turn this into a video": opens the purchase sheet with correct arithmetic, and persists the FULL turnImageIntoVideo draft before the sheet renders (the audit-found bug — previously only called on the unblocked path)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 30, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    var ORIGINAL_IMAGE_URL = 'https://fal.media/files/sample/original-image.png';
    await seedAccount(page, {
      username: 'turnvideoblocked',
      dream: { id: 'dream-to-upgrade', mediaType: 'image', imageUrl: ORIGINAL_IMAGE_URL, videoUrl: null, caption: 'A dream about a floating library', style: 'Anime' }
    });
    await page.goto(baseUrl + '/result.html?id=dream-to-upgrade', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#turn-video-btn', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(200);

    await page.click('#turn-video-btn');

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    var title = await page.textContent('#ps-title');
    assert.match(title, /Almost there — this video needs 100 tokens/);
    var body = await page.textContent('#ps-body');
    assert.match(body, /You have\s*30/);
    assert.match(body, /70 more/);
    assert.ok(page.url().indexOf('result.html') !== -1, 'must not navigate away when tokens are insufficient -- stays on result.html');

    // THE BUG FIX: turnImageIntoVideo's full draft (caption/style/
    // sourceDreamId/sourceImageUrl/mediaType) must already be persisted —
    // previously this only ran on the unblocked branch.
    var draft = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('dreamtube_state_v1')).draft;
    });
    assert.equal(draft.sourceDreamId, 'dream-to-upgrade');
    assert.equal(draft.sourceImageUrl, ORIGINAL_IMAGE_URL);
    assert.equal(draft.mediaType, 'video');
    assert.equal(draft.caption, 'A dream about a floating library');
  } finally {
    await context.close();
  }
});

// ============================================================================
// home.html's E112/E412 mid-generation-failure path (formerly
// processing.html's, ported when that page was removed -- tracker item
// for-product-funnel-ending-v2-founder-ins-tfuu0q) -- the third
// blocked-action entry point named in the spec. Reached via the
// `?generate=1` fresh-in-app-generation signal style.html's own Generate
// button sends (see home.html's own "Fresh in-app generation submission"
// script block). The draft is already intact by construction here
// (submission itself required a complete draft), so this only checks the
// sheet's own arithmetic/auto-open behavior, not persistence.
// ============================================================================
test('home.html: an E112 (insufficient tokens) generation failure auto-opens the purchase sheet with correct arithmetic', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 25, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E112: insufficient_tokens' }) });
    });

    await seedAccount(page, { username: 'e112fail', draft: { caption: 'A whale made of stars', style: 'Cinematic', mediaType: 'video' } });
    await page.goto(baseUrl + '/home.html?generate=1', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 8000 });
    var title = await page.textContent('#ps-title');
    assert.match(title, /Almost there — this video needs 100 tokens/);
    var body = await page.textContent('#ps-body');
    assert.match(body, /You have\s*25/);
    assert.match(body, /75 more/);
    // The underlying Home screen is still visible/available underneath --
    // the sheet slides up OVER it, same "overlay, not a full replacement"
    // treatment every other blocked-action entry point already has. This
    // account is unlogged, so the bare Tonight CTA button is what's
    // showing (not #hero-tonight -- that card is reserved for the
    // "logged tonight" confirmation state as of tracker item
    // for-product-founder-08-07-homepage-hero--015hgp).
    assert.equal(await page.locator('#tonight-cta').isVisible(), true);
  } finally {
    await context.close();
  }
});

// ============================================================================
// Media-aware fail-copy (hardening fix, tracker item
// for-product-store-launch-copy-sweep-purc-m6xhkx, carried over to
// home.html's own toast-based failure UX when processing.html's dedicated
// fail screen was removed): a failed generation's toast says "video" or
// "picture" specifically, never a static wrong media type.
// ============================================================================
test('home.html: a failed VIDEO generation (non-E112/E412) shows "video" in the failure toast', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 500, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });
    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E199: unknown_error' }) });
    });

    await seedAccount(page, { username: 'failcopyvideo', draft: { caption: 'A whale made of stars', style: 'Cinematic', mediaType: 'video' } });
    await page.goto(baseUrl + '/home.html?generate=1', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('.toast.show', { timeout: 8000 });
    var copy = await page.textContent('#toast');
    assert.match(copy, /generating your video/i);
    assert.doesNotMatch(copy, /generating your picture/i);
  } finally {
    await context.close();
  }
});

test('home.html: a failed IMAGE generation (non-E112/E412) shows "picture" in the failure toast, not "video"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 500, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });
    await page.route('**/.netlify/functions/generate-image', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E199: unknown_error' }) });
    });

    await seedAccount(page, { username: 'failcopyimage', draft: { caption: 'A whale made of stars', style: 'Cinematic', mediaType: 'image' } });
    await page.goto(baseUrl + '/home.html?generate=1', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('.toast.show', { timeout: 8000 });
    var copy = await page.textContent('#toast');
    assert.match(copy, /generating your picture/i);
    assert.doesNotMatch(copy, /generating your video/i);
  } finally {
    await context.close();
  }
});

// ============================================================================
// Post-checkout auto-resume — home.html?checkout=success (formerly
// processing.html's, moved when that page was removed -- tracker item
// for-product-funnel-ending-v2-founder-ins-tfuu0q)
// ============================================================================
test('home.html: a mocked successful checkout return auto-resumes the exact blocked generation from the intact draft', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Balance is already sufficient on the very first poll — the credit
    // "already landed" by the time this page loads. Set to EXACTLY
    // balanceBefore(50) + packTokens(300) = 350 -- the real
    // Math.min(balanceBefore, arrivalBalance) + packTokens threshold this
    // test is proving (tracker item follow-up-home-html-checkout-return-
    // has--hm8na5, bug 1 fix), not the old buggy flat-cost(100) threshold.
    await mockTokenStatus(page, { balance: 350, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateVideoCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:veo3.1:resume-op' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/resumed-video.mp4' }) });
    });

    await seedAccount(page, {
      username: 'autoresume',
      draft: { caption: 'A dream about flying whales over the ocean', style: 'Cinematic', mediaType: 'video' },
      // balanceBefore: 50 -- the account's balance when the out-of-tokens
      // sheet opened, threaded through by js/purchase-sheet.js's
      // wireBuyButton (see that file's own comment). Combined with
      // tokens:300 this pins the real confirmation threshold at 350.
      pendingPurchase: { pack: 'pack099', tokens: 300, price: 0.99, eventId: 'evt-resume-1', purchaseFlow: 'blocked_action', source: 'blocked_action', mediaType: 'video', cost: 100, balanceBefore: 50 }
    });

    await page.goto(baseUrl + '/home.html?checkout=success', { waitUntil: 'domcontentloaded' });

    // Resolves in place on home.html now (no more redirect to result.html)
    // -- the My-dreams row's generating tile appears and then flips to a
    // real finished tile.
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 15000 });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1, 'the blocked generation must have been re-fired exactly once');
    assert.equal(generateVideoCalls[0].caption, 'A dream about flying whales over the ocean');
    assert.equal(generateVideoCalls[0].style, 'Cinematic');

    // The pending-purchase marker must be consumed (read + removed) exactly
    // once, same contract as shop.html's own handleCheckoutReturn.
    var markerAfter = await page.evaluate(function () { return sessionStorage.getItem('dreamtube_pending_purchase'); });
    assert.equal(markerAfter, null);

    // The ?checkout=success query param must be stripped (no re-trigger on reload).
    assert.equal(page.url().indexOf('checkout=success'), -1);
  } finally {
    await context.close();
  }
});

// ============================================================================
// Bug 1 regression (tracker item follow-up-home-html-checkout-return-has--
// hm8na5): the OLD threshold was just pendingPurchase.cost (e.g. 100 for a
// video) -- a much smaller number than a real pack (300+), reachable by
// something that has nothing to do with the purchase at all (a daily-claim
// credit landing around the same time, a stale/racy read). The fix requires
// a genuine Math.min(balanceBefore, arrivalBalance) + packTokens jump.
// ============================================================================
test('home.html: an unrelated balance bump that clears the OLD flat-cost threshold does NOT fire a premature auto-resume', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // balanceBefore(90) + packTokens(300) = 390 is the REAL threshold this
    // test proves. The old buggy threshold was just pendingPurchase.cost
    // (100) -- bumped to 110 below ("bumped" phase), comfortably clearing
    // that old number while nowhere near a real pack credit. The old code
    // would have auto-resumed off this bump alone.
    var phase = 'before'; // 'before' -> 'bumped' (unrelated, e.g. a daily claim) -> 'realcredit'
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      var balance = phase === 'realcredit' ? 390 : (phase === 'bumped' ? 110 : 90);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: balance, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 }) });
    });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateVideoCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:veo3.1:bug1-regression' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/bug1-video.mp4' }) });
    });

    await page.addInitScript(function () {
      window.__TEST_POLL_OVERRIDES__ = { intervalMs: 60, maxMs: 5000 };
    });

    await seedAccount(page, {
      username: 'bug1regression',
      draft: { caption: 'A dream about two moons', style: 'Cinematic', mediaType: 'video' },
      pendingPurchase: { pack: 'pack099', tokens: 300, price: 0.99, eventId: 'evt-bug1-1', purchaseFlow: 'blocked_action', source: 'blocked_action', mediaType: 'video', cost: 100, balanceBefore: 90 }
    });

    await page.goto(baseUrl + '/home.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show') && /resuming your dream/i.test(t.textContent);
    }, null, { timeout: 3000 });

    // Let a couple of poll ticks pass at the starting balance first.
    await page.waitForTimeout(150);
    phase = 'bumped';
    // Give the bumped (but still-insufficient-for-a-real-pack) balance
    // several poll ticks to prove it does NOT satisfy the confirmation --
    // this is exactly what the old cost-only threshold (100) would have
    // fired on.
    await page.waitForTimeout(400);
    assert.equal(generateVideoCalls.length, 0, 'an unrelated balance bump clearing the OLD flat-cost(100) threshold must not fire the resume -- only a genuine pack-sized credit may');

    // Now the REAL pack credit lands.
    phase = 'realcredit';
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 8000 });
    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1, 'the genuine full pack credit must still resume the blocked generation correctly');
    assert.equal(generateVideoCalls[0].caption, 'A dream about two moons');
  } finally {
    await context.close();
  }
});

// ============================================================================
// Honest-degrade path — the credit is still lagging past the poll window.
// Rebuilt (tracker item follow-up-home-html-checkout-return-has--hm8na5,
// bug 2) to mirror shop.html's own retryable "still confirming" banner: a
// 2.2s toast that vanishes forever was the exact "silent give-up" bug this
// fix closes, so the honest-degrade state now renders the persistent
// #checkout-confirm-card instead, with a real "Check again" affordance
// (never a hang, never a silent auto-fire, and never a state that just
// disappears with no way back to it).
// ============================================================================
test('home.html: when the token credit is still lagging past the poll window, it degrades to a persistent, retryable card (never a hang, a silent auto-fire, or a vanishing toast)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Balance never crosses the needed threshold (balanceBefore 40 +
    // packTokens 300 = 340) during the (shrunk) poll window.
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:veo3.1:should-not-fire' }) });
    });

    // Shrinks pollForCredit's real ~75s window down to something a test can
    // actually run in — see js/purchase-sheet.js's pollForCredit doc
    // comment and home.html's own window.__TEST_POLL_OVERRIDES__ read
    // (formerly processing.html's, same mechanism).
    await page.addInitScript(function () {
      window.__TEST_POLL_OVERRIDES__ = { intervalMs: 60, maxMs: 250 };
    });

    await seedAccount(page, {
      username: 'degradepath',
      draft: { caption: 'A dream about a lighthouse in the fog', style: 'Realistic', mediaType: 'video' },
      pendingPurchase: { pack: 'pack099', tokens: 300, price: 0.99, eventId: 'evt-degrade-1', purchaseFlow: 'blocked_action', source: 'blocked_action', mediaType: 'video', cost: 100, balanceBefore: 40 }
    });

    await page.goto(baseUrl + '/home.html?checkout=success', { waitUntil: 'domcontentloaded' });

    // The initial "Payment received — resuming your dream…" toast still
    // fires (unchanged) before the poll window elapses.
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show') && /resuming your dream/i.test(t.textContent);
    }, null, { timeout: 3000 });

    // THE FIX: once the window elapses, an explicit, persistent, retryable
    // card appears -- not a toast that's already gone.
    await page.waitForSelector('#checkout-confirm-card:visible', { timeout: 3000 });
    var title = await page.textContent('#checkout-confirm-title');
    assert.match(title, /still confirming/i);
    var sub = await page.textContent('#checkout-confirm-sub');
    assert.match(sub, /haven.t reached your balance yet/i);
    var actionLabel = await page.textContent('#checkout-confirm-action');
    assert.match(actionLabel, /check again/i);
    var actionVisible = await page.isVisible('#checkout-confirm-action');
    assert.equal(actionVisible, true, 'a real retry affordance must be offered, not a state with no way back to it');

    // Give the card plenty of time to prove it does NOT auto-dismiss the
    // way the old 2.2s toast did.
    await page.waitForTimeout(1500);
    var stillVisible = await page.isVisible('#checkout-confirm-card');
    assert.equal(stillVisible, true, 'the card must stay on screen until the user acts -- never silently vanish like the old toast');

    assert.equal(generateVideoCalls.length, 0, 'must never auto-fire generation while the credit is still unconfirmed');
  } finally {
    await context.close();
  }
});

test('home.html: tapping "Check again" on the unconfirmed card re-polls and resumes normally once the real credit has landed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Starts short of the threshold (balanceBefore 40 + packTokens 300 =
    // 340) so the FIRST confirmation attempt times out into the card; the
    // real credit lands only after that, simulating a slow webhook the
    // user comes back and manually rechecks for.
    var creditLanded = false;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: creditLanded ? 340 : 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 }) });
    });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateVideoCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:veo3.1:check-again-resume' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/check-again-video.mp4' }) });
    });

    await page.addInitScript(function () {
      window.__TEST_POLL_OVERRIDES__ = { intervalMs: 60, maxMs: 250 };
    });

    await seedAccount(page, {
      username: 'checkagainresume',
      draft: { caption: 'A dream about a train through the mountains', style: 'Anime', mediaType: 'video' },
      pendingPurchase: { pack: 'pack099', tokens: 300, price: 0.99, eventId: 'evt-checkagain-1', purchaseFlow: 'blocked_action', source: 'blocked_action', mediaType: 'video', cost: 100, balanceBefore: 40 }
    });

    await page.goto(baseUrl + '/home.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#checkout-confirm-card:visible', { timeout: 3000 });
    assert.equal(generateVideoCalls.length, 0, 'must not have fired yet -- the first attempt genuinely timed out unconfirmed');

    // The real credit lands NOW, between the first timeout and the retry.
    creditLanded = true;
    await page.click('#checkout-confirm-action');

    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 8000 });
    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1, 'the retry must resume the exact blocked generation once the real credit is found');
    assert.equal(generateVideoCalls[0].caption, 'A dream about a train through the mountains');
    var cardHiddenAfter = await page.isVisible('#checkout-confirm-card');
    assert.equal(cardHiddenAfter, false, 'the card must clear itself once the retry actually confirms the credit');
  } finally {
    await context.close();
  }
});

// ============================================================================
// No-baseline fallback — a marker-less return (private-mode / cross-tab
// checkout) whose FIRST arrival read also fails must retry inside the same
// shared window and resolve into the same honest "unconfirmed" card if
// nothing ever succeeds, never a fabricated confirmation and never a hang.
// Exercises retryArrivalBalance/resolveUnconfirmed('no_baseline'), the one
// branch of startCreditConfirmation none of the other tests in this file
// reach (every other test's arrival read succeeds on the first try).
// ============================================================================
test('home.html: checkout=success with no marker AND a persistently failing balance read resolves into the honest unconfirmed card, never a hang or a fabricated confirmation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Every get-token-status read fails -- no baseline is EVER obtainable
    // (real DreamStore.getTokenStatus() rejects on a data.error response —
    // see that function's own `if (data.error) throw ...`).
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'E_FAKE: simulated persistent failure' }) });
    });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:veo3.1:should-not-fire-nobaseline' }) });
    });

    await page.addInitScript(function () {
      window.__TEST_POLL_OVERRIDES__ = { intervalMs: 60, maxMs: 250 };
    });

    // Deliberately no pendingPurchase -- no balanceBefore is obtainable
    // from a marker either, so this exercises the true no-baseline-at-all
    // path.
    await seedAccount(page, {
      username: 'nobaselineever',
      draft: { caption: 'A dream about an empty train station', style: 'Realistic', mediaType: 'video' }
    });

    await page.goto(baseUrl + '/home.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#checkout-confirm-card:visible', { timeout: 3000 });
    var title = await page.textContent('#checkout-confirm-title');
    assert.match(title, /still confirming/i);
    assert.equal(generateVideoCalls.length, 0, 'must never fabricate a confirmation when no real baseline was ever obtainable');
  } finally {
    await context.close();
  }
});

// ============================================================================
// Robustness gaps found in review of the build above (tracker item
// purchase-sheet-checkout-auto-resume-two--ltinmn, non-blocking, fixed in a
// follow-up pass):
//
// 1. pollForCredit() (js/purchase-sheet.js) already returned a cancel()
//    function, but processing.html never called it -- a poll left running
//    when the user navigates away could still fire onCredited ->
//    runGeneration() later if the browser bfcache-restores this exact page
//    with the poll's setTimeout chain still alive. Same bug class as the
//    already-fixed fix-pre-existing-photo-upload-cancel-reo item: an async
//    callback not scoped/cancelled to the navigation that started it. Fixed
//    by cancelling the active poll on 'pagehide'.
//
// 2. checkout=success with the dreamtube_pending_purchase marker missing
//    (private-browsing storage block, or checkout completed in a different
//    tab) used to fall straight through to an immediate runGeneration()
//    call with zero polling grace period -- defeating the whole auto-resume
//    promise for exactly the rare case it exists to cover. Fixed by giving
//    that path the same polling grace period as the marker-present happy
//    path, just with a currentMediaTypeCost() fallback (no pendingPurchase
//    to read a real cost from) and no Purchase-conversion analytics fire
//    (no marker data to report).
// ============================================================================

test('home.html: pagehide cancels the in-flight credit poll -- a stale poll tick must not resume generation after the user has navigated away', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Flips to a sufficient balance only AFTER the test cancels the poll --
    // this is what actually proves cancellation (not merely "the balance
    // never happened to cross the threshold") stopped the resume: without
    // the pagehide fix, this credit landing would have satisfied the very
    // next poll tick and fired runGeneration(). No balanceBefore in the
    // marker below, so the real (post-fix) baseline comes from the arrival
    // read (10) -- 10 + packTokens(300) = 310 is the genuine confirmation
    // threshold this credit landing must clear.
    var creditLanded = false;
    var tokenStatusCallCount = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      tokenStatusCallCount++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: creditLanded ? 310 : 10, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 }) });
    });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:veo3.1:should-not-fire' }) });
    });

    // Shrinks the poll interval so several ticks fit comfortably inside the
    // test's own timeout, same mechanism as the honest-degrade test above.
    await page.addInitScript(function () {
      window.__TEST_POLL_OVERRIDES__ = { intervalMs: 60, maxMs: 5000 };
    });

    await seedAccount(page, {
      username: 'pagehidecancel',
      draft: { caption: 'A dream about a slow-motion waterfall', style: 'Realistic', mediaType: 'video' },
      pendingPurchase: { pack: 'pack099', tokens: 300, price: 0.99, eventId: 'evt-pagehide-1', purchaseFlow: 'blocked_action', source: 'blocked_action', mediaType: 'video', cost: 100 }
    });

    await page.goto(baseUrl + '/home.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show') && /resuming your dream/i.test(t.textContent);
    }, null, { timeout: 5000 });

    // Let the poll actually start (at least one real tick) before cancelling
    // it -- the test must not pass trivially just because the poll never
    // got going in the first place.
    await page.waitForRequest(/get-token-status/, { timeout: 3000 });
    var callsAtCancel = tokenStatusCallCount;

    await page.evaluate(function () { window.dispatchEvent(new Event('pagehide')); });
    creditLanded = true;

    // Several poll intervals' worth of real time (60ms interval, waited
    // 500ms = ~8 ticks) -- if cancellation didn't actually stop the poll
    // loop, at least one more tick would see the now-sufficient balance and
    // fire onCredited -> runGeneration() within this window.
    await page.waitForTimeout(500);

    assert.equal(generateVideoCalls.length, 0, 'a poll cancelled on pagehide must never resume generation, even once the credit lands afterward');
    assert.equal(page.url().indexOf('result.html'), -1, 'must not have navigated to result.html after the cancelled poll\'s target credit landed');
    assert.ok(tokenStatusCallCount <= callsAtCancel + 1, 'the poll loop itself must stop scheduling further ticks once cancelled (allowing at most one already-in-flight request to land)');
  } finally {
    await context.close();
  }
});

test('home.html: checkout=success with the pending-purchase marker missing still gets a polling grace period instead of firing the resume generation immediately (private-browsing storage block / cross-tab checkout)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Balance starts short, then updates to sufficient partway through the
    // grace-period poll -- proves this is real polling, not an immediate
    // pass-through dressed up with a spinner.
    var creditLanded = false;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: creditLanded ? 150 : 10, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 }) });
    });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:veo3.1:missing-marker-resume' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/missing-marker-video.mp4' }) });
    });

    // Shrinks the poll window the same way every other test in this file
    // does -- see js/purchase-sheet.js's pollForCredit doc comment.
    await page.addInitScript(function () {
      window.__TEST_POLL_OVERRIDES__ = { intervalMs: 60, maxMs: 2000 };
    });

    // Deliberately NO pendingPurchase seeded -- simulates the
    // dreamtube_pending_purchase sessionStorage marker being absent on
    // return from checkout (private-browsing storage block, or the
    // checkout completing in a different tab than it started in).
    await seedAccount(page, {
      username: 'missingmarker',
      draft: { caption: 'A dream about a train through the clouds', style: 'Anime', mediaType: 'video' }
    });

    await page.goto(baseUrl + '/home.html?checkout=success', { waitUntil: 'domcontentloaded' });

    // THE FIX: must show the same "payment received / resuming" grace
    // toast as the marker-present path, not fall straight through to an
    // immediate resume-generation call just because there's no marker to
    // read a cost/source off of.
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show') && /resuming your dream/i.test(t.textContent);
    }, null, { timeout: 3000 });
    assert.equal(generateVideoCalls.length, 0, 'must not fire generation immediately just because the pending-purchase marker was missing');

    await page.waitForTimeout(150);
    creditLanded = true;

    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 8000 });
    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1, 'once the credit lands within the grace period, the blocked generation must still auto-resume even without marker data');
    assert.equal(page.url().indexOf('checkout=success'), -1, 'the ?checkout=success param must still be stripped on the missing-marker path too');
  } finally {
    await context.close();
  }
});

// ============================================================================
// Inline "Claim +N" affordance (tracker item
// for-product-build-the-daily-token-claim--fngrwd, item 5): "when a user is
// blocked on insufficient tokens AND has an unclaimed daily grant available,
// show Claim +20 above the existing buy-tokens CTA".
// ============================================================================
test('style.html: claimable state shows "Claim +N free tokens" above the buy CTA, and claiming it updates the sheet live off the real server response', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Stateful get-token-status mock (not the shared static mockTokenStatus
    // helper) -- this test needs the SECOND read (triggered by claimInline's
    // own onClaimed refresh, review finding round 4: claimInline never used
    // to notify the page/topbar chip of a successful claim at all) to
    // reflect the post-claim balance/claimable state.
    var tokenStatusCalls = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      tokenStatusCalls++;
      var status = tokenStatusCalls === 1
        ? { balance: 40, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 2 }
        : { balance: 60, claimable: false, nextClaimAt: Date.now() + 72000000, dailyClaimAmount: 20, streak: 3 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
    });
    var claimCalls = 0;
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      claimCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 60, streak: 3, nextClaimAt: Date.now() + 72000000 }) });
    });

    await seedAccount(page, { username: 'claiminline', draft: { caption: 'A dream about flying' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    // A claimable tokenStatus also auto-opens the DEDICATED claim sheet on
    // this same load (tracker item for-product-build-the-daily-token-claim
    // --fngrwd, item 4) -- dismiss it first, same as a real user would,
    // before the normal style-picking flow below can proceed.
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });
    await page.waitForTimeout(200);

    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    await page.waitForSelector('#ps-claim-btn:visible', { timeout: 3000 });
    var claimLabel = await page.textContent('#ps-claim-label');
    assert.match(claimLabel, /Claim \+20 free tokens/);

    await page.evaluate(function () {
      window.__phCalls = [];
      var orig = window.posthog.capture.bind(window.posthog);
      window.posthog.capture = function (name, props) { window.__phCalls.push({ name: name, props: props }); return orig(name, props); };
    });

    await page.click('#ps-claim-btn');
    await page.waitForFunction(function () {
      var body = document.getElementById('ps-body');
      return body && /You have\s*<b>60/.test(body.innerHTML);
    }, { timeout: 3000 });

    await settle(function () { return claimCalls >= 1; });
    assert.equal(claimCalls, 1, 'the real claim-daily-tokens endpoint was called exactly once');
    var claimBtnVisibleAfter = await page.isVisible('#ps-claim-btn');
    assert.equal(claimBtnVisibleAfter, false, 'the claim button hides itself once claimed -- nothing left to claim this cooldown');

    // Regression coverage (tracker item for-product-low-out-of-tokens-
    // sheet-inli-uqt6or): this claim (40 -> 60) still leaves the video's
    // 100-token cost short by 40 -- the sheet must stay open and
    // renderPurchaseAmounts() must still re-render with the REAL updated
    // shortfall, not the "close and proceed" branch that only fires once
    // balance actually covers cost.
    var sheetStillOpen = await page.evaluate(function () {
      return document.getElementById('purchase-sheet-overlay').classList.contains('open');
    });
    assert.ok(sheetStillOpen, 'a claim that does not cover cost must leave the sheet open, not close it');
    var bodyAfterClaim = await page.textContent('#ps-body');
    assert.match(bodyAfterClaim, /You have\s*60/, 'the balance shown must reflect the real post-claim balance');
    assert.match(bodyAfterClaim, /40 more/, 'the shortfall must be recomputed off the new balance (100 - 60), not left stale or shown as 0');

    var phCalls = await page.evaluate(function () { return window.__phCalls; });
    var completedCalls = phCalls.filter(function (c) { return c.name === 'daily_claim_completed'; });
    assert.equal(completedCalls.length, 1, 'daily_claim_completed fires exactly once, on the real server-confirmed response');
    assert.equal(completedCalls[0].props.streak, 3);
    assert.equal(completedCalls[0].props.balance, 60);

    // Review finding (round 4): claimInline() used to update ONLY the
    // sheet's own internal DOM -- the page's own cached tokenStatus and
    // topbar chip never learned a claim had happened at all, so a retry
    // of the same blocked action would still see stale (pre-claim) state.
    // Confirms the page genuinely re-fetches and the topbar chip reflects
    // the real post-claim balance/claimable state.
    await page.waitForFunction(function () {
      var el = document.getElementById('topbar-token-chip-balance');
      return el && el.textContent.indexOf('60') !== -1;
    }, { timeout: 3000 });
    var chipClaimableAfter = await page.evaluate(function () {
      return document.getElementById('topbar-token-chip').classList.contains('claimable');
    });
    assert.equal(chipClaimableAfter, false, 'the topbar chip must stop pulsing "claimable" once the inline claim actually lands');
    assert.ok(tokenStatusCalls >= 2, 'the page must re-fetch getTokenStatus after a successful inline claim, not just trust the pre-claim cached value');
  } finally {
    await context.close();
  }
});

test('style.html: dismissing the out-of-tokens sheet (tap outside) while an inline claim is still in flight does not crash -- the genuinely successful claim still lands server-side', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // Review finding (round 2): claimInline() used to dereference the shared
  // module-level `current` var directly inside its .then()/.catch()
  // callbacks -- the identical stale-async-callback shape runClaim() (the
  // dedicated claim sheet) was fixed for in round 1, unfixed here in this
  // sibling function since round 1 only looked at the one function its
  // own finding named. hide() (this test's tap-outside dismiss) nulls
  // `current` with no in-flight guard, so this exact sequence used to
  // throw a TypeError inside the delayed claim response's .then()/.catch(),
  // an uncaught page error this test would surface via the pageerror spy
  // below. Fixed by capturing `current` into a local `claimTarget` at the
  // top of claimInline(), closed over instead of the shared var.
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(err); });
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 2 });
    var claimCalls = 0;
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      claimCalls++;
      // Deliberately delayed so the test can dismiss the sheet WHILE this
      // request is still in flight -- the exact race the fix closes.
      return new Promise(function (resolve) {
        setTimeout(function () {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 60, streak: 3, nextClaimAt: Date.now() + 72000000 }) });
          resolve();
        }, 400);
      });
    });

    await seedAccount(page, { username: 'claiminlinedismiss', draft: { caption: 'A dream about flying' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });
    await page.waitForTimeout(200);

    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    await page.waitForSelector('#ps-claim-btn:visible', { timeout: 3000 });

    await page.click('#ps-claim-btn');
    // Dismiss the whole sheet (tap outside) WHILE the 400ms-delayed claim
    // response is still pending.
    await page.click('#purchase-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#purchase-sheet-overlay:not(.open)', { timeout: 3000 });

    // Give the delayed response time to actually resolve and run its
    // (now-dismissed-sheet) callback.
    await page.waitForTimeout(700);

    await settle(function () { return claimCalls >= 1; });
    assert.equal(claimCalls, 1, 'the real claim-daily-tokens endpoint was actually called');
    assert.equal(pageErrors.length, 0, 'no uncaught error from the claim response resolving after the sheet was dismissed -- ' + pageErrors.map(function (e) { return e.message; }).join('; '));
  } finally {
    await context.close();
  }
});

test('style.html: dismissing while an inline claim is in flight, then reopening the sheet BEFORE the original request resolves, does not corrupt the reopened sheet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // Review finding (round 3): capturing `current` into a local (round 2's
  // fix) stopped the crash, but a stale-but-non-null capture could still
  // mutate the shared #ps-claim-btn/#ps-claim-label/#ps-error nodes after
  // the sheet was dismissed and reopened for a different blocked action.
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(err); });
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 2 });
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 60, streak: 3, nextClaimAt: Date.now() + 72000000 }) });
          resolve();
        }, 500);
      });
    });

    await seedAccount(page, { username: 'claiminlinereopen', draft: { caption: 'A dream about flying' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });
    await page.waitForTimeout(200);

    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    await page.waitForSelector('#ps-claim-btn:visible', { timeout: 3000 });

    await page.click('#ps-claim-btn'); // kicks off the 500ms-delayed request
    await page.click('#purchase-sheet-overlay', { position: { x: 5, y: 5 } }); // dismiss immediately
    await page.waitForSelector('#purchase-sheet-overlay:not(.open)', { timeout: 3000 });

    // Reopen (same blocked action, still not claimed since nothing has
    // refreshed the tokenStatus yet) BEFORE the original request resolves.
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    await page.waitForSelector('#ps-claim-btn:visible', { timeout: 3000 });
    var labelOnReopen = await page.textContent('#ps-claim-label');
    assert.match(labelOnReopen, /Claim \+20 free tokens/, 'reopened sheet starts fresh with its normal idle claim label');

    // Let the original (dismissed instance's) delayed request resolve
    // while the REOPENED sheet is what's on screen.
    await page.waitForTimeout(800);

    var stillOpen = await page.evaluate(function () {
      return document.getElementById('purchase-sheet-overlay').classList.contains('open');
    });
    assert.ok(stillOpen, 'the reopened sheet must still be open');
    var labelAfter = await page.textContent('#ps-claim-label');
    assert.match(labelAfter, /Claim \+20 free tokens/, 'the reopened sheet\'s claim label must not be overwritten by the stale dismissed instance\'s response');
    assert.equal(pageErrors.length, 0, 'no uncaught error -- ' + pageErrors.map(function (e) { return e.message; }).join('; '));
  } finally {
    await context.close();
  }
});

test('style.html: NOT claimable -> the inline claim button stays hidden entirely, only the buy CTA shows', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });

    await seedAccount(page, { username: 'noclaiminline', draft: { caption: 'A dream about flying' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);

    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var claimBtnVisible = await page.isVisible('#ps-claim-btn');
    assert.equal(claimBtnVisible, false);
  } finally {
    await context.close();
  }
});

// ============================================================================
// Inline claim that itself lifts balance to cover cost (tracker item
// for-product-low-out-of-tokens-sheet-inli-uqt6or, LOW, founder-reported
// 08-10): sibling of the show()-time affordability guard (BUG 1, commit
// e67a52e) -- that fix only covered a balance that was ALREADY sufficient
// the moment the sheet opened; this covers the claim landing WHILE the
// sheet is open and itself bridging the gap. Before this fix,
// renderPurchaseAmounts() just re-rendered the nonsensical "You need 0
// more" instead of closing/proceeding.
// ============================================================================

test('style.html: an inline claim that itself lifts balance to cover cost closes the sheet and proceeds (generates), instead of re-rendering "need 0 more"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Balance 0 blocks everything; the daily claim (+20) covers the
    // 10-token image cost but would NOT cover a 100-token video -- picking
    // the image media type below is what makes this claim genuinely
    // unblock the action, proving the fix rather than just the arithmetic.
    await mockTokenStatus(page, { balance: 0, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 0 });
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 20, streak: 1, nextClaimAt: Date.now() + 72000000 }) });
    });
    var generateImageCalls = [];
    await page.route('**/.netlify/functions/generate-image', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateImageCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/flux/dev:claim-unblock-1' }) });
    });
    await page.route('**/.netlify/functions/image-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, imageUrl: 'https://example.com/claim-unblock-image.jpg' }) });
    });

    await seedAccount(page, { username: 'claimunblocks', draft: { caption: 'A dream about the tide' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });
    await page.waitForTimeout(200);

    await page.click('.media-type-btn[data-media-type="image"]');
    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    var title = await page.textContent('#ps-title');
    assert.match(title, /Almost there — this image needs 10 tokens/);

    await page.waitForSelector('#ps-claim-btn:visible', { timeout: 3000 });
    await page.click('#ps-claim-btn');

    // The claim (0 -> 20) covers the 10-token image cost -- the sheet must
    // close and proceed (onAfford = proceedToGenerate navigates away
    // essentially synchronously with the classList removal, same as the
    // image-fallback-link tests above -- checking for a lingering
    // "need 0 more" DOM state here would race the navigation itself, so
    // the real proof is what proceeding actually produces: a real
    // navigation + a real generate-image submission carrying the same
    // persisted draft, not just an inert close).
    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 8000 });
    await settle(function () { return generateImageCalls.length >= 1; });
    assert.equal(generateImageCalls.length, 1, 'the proceed callback must have actually submitted the generation');
    assert.equal(generateImageCalls[0].caption, 'A dream about the tide', 'the SAME persisted draft must carry through, not a fresh/empty one');
  } finally {
    await context.close();
  }
});

test('PurchaseSheet: an inline claim that lifts balance to cover cost still closes the sheet even when the caller supplied NO onAfford -- never left stuck on "need 0 more"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(err); });
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 0 });
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 60, streak: 1, nextClaimAt: Date.now() + 72000000 }) });
    });

    await seedAccount(page, { username: 'claimunblocknoop', draft: { caption: 'A dream about the shore' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });
    await page.waitForTimeout(200);
    await page.waitForFunction(function () { return window.PurchaseSheet && typeof window.PurchaseSheet.show === 'function'; }, null, { timeout: 5000 });

    // Manually open the sheet with a cost (50) the pre-claim balance (40)
    // can't cover but the post-claim balance (60) can -- and deliberately
    // no onAfford, exercising the no-callback fallback path directly.
    await page.evaluate(function () {
      window.PurchaseSheet.show({
        mediaType: 'video', cost: 50, balance: 40,
        tokenStatus: { claimable: true, dailyClaimAmount: 20, streak: 0 },
        source: 'test'
      });
    });
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    await page.waitForSelector('#ps-claim-btn:visible', { timeout: 3000 });
    await page.click('#ps-claim-btn');

    await page.waitForSelector('#purchase-sheet-overlay:not(.open)', { timeout: 3000 });
    var bodyAfterClose = await page.textContent('#ps-body');
    assert.ok(bodyAfterClose.indexOf('need 0 more') === -1, 'must never render "need 0 more", even with no onAfford supplied -- the safest fallback is closing, not re-rendering the nonsensical shortfall');
    assert.equal(pageErrors.length, 0, 'no uncaught error when onAfford is absent -- ' + pageErrors.map(function (e) { return e.message; }).join('; '));
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2026-07-28 first-claim-bonus amendment (founder-approved, tracker item
// for-product-daily-claim-bugs-founder-rea-kei2ub): the out-of-tokens
// sheet's inline "Claim +N" affordance must show the REAL server-reported
// amount too, not a hardcoded 20 -- proven here with a first-ever-claimer's
// 100-token bonus.
// ============================================================================

test('style.html: the inline claim button shows "Claim +100 free tokens" (not +20) when the server reports the first-claim bonus', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 100, streak: 0 });

    await seedAccount(page, { username: 'firstclaiminline', draft: { caption: 'A dream about flying' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    // A claimable tokenStatus also auto-opens the dedicated claim sheet --
    // dismiss it first, same as the existing claimable-state test above.
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });
    await page.waitForTimeout(200);

    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    await page.waitForSelector('#ps-claim-btn:visible', { timeout: 3000 });
    var claimLabel = await page.textContent('#ps-claim-label');
    assert.match(claimLabel, /Claim \+100 free tokens/, 'must read the real 100 first-claim bonus, never a hardcoded 20');
  } finally {
    await context.close();
  }
});

test('style.html: a failed inline claim restores the button label to "Claim +100 free tokens", not a stale hardcoded 20', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 100, streak: 0 });
    // A malformed/error response (data.error present) drives
    // js/purchase-sheet.js's claimInline() into its .catch() branch -- see
    // that function's own doc comment.
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E5: claim_write_failed' }) });
    });

    await seedAccount(page, { username: 'firstclaiminlineerr', draft: { caption: 'A dream about flying' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });
    await page.waitForTimeout(200);

    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    await page.waitForSelector('#ps-claim-btn:visible', { timeout: 3000 });

    await page.click('#ps-claim-btn');
    await page.waitForSelector('#ps-error:visible', { timeout: 3000 });
    var claimLabel = await page.textContent('#ps-claim-label');
    assert.match(claimLabel, /Claim \+100 free tokens/, 'the error-recovery label must restore the real 100 amount, never fall back to a hardcoded 20');
  } finally {
    await context.close();
  }
});

// ============================================================================
// "Make it as an image instead" fallback (tracker item
// for-product-out-of-tokens-sheet-founder--dg5q1y, founder-directed
// 2026-08-01). See js/purchase-sheet.js's own header comment for the full
// feature story. Covers the four conditions the spec names:
//  1. only for a blocked VIDEO generation via a general route (style.html,
//     result.html's edit mechanisms, home.html's own E112/E412 catch) --
//     never the "Turn this into a video" image-to-video upsell
//  2. only when balance >= IMAGE_TOKEN_COST (10)
//  3. quiet-link treatment under the buy CTA, exact copy
//  4. tapping carries the same prompt content into the image path and
//     fires out_of_tokens_image_fallback_tapped
// ============================================================================

test('style.html: the fallback link shows for a blocked VIDEO generation when the balance can afford the cheaper image, with the exact quiet-link copy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // 40 < 100 (video cost, blocks the primary action) but >= 10 (image
    // cost) -- exactly the "can afford the cheaper alternative" case.
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    await seedAccount(page, { username: 'fallbackvisible', draft: { caption: 'A city made of light' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.click('.style-card[data-style="Anime"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var visible = await page.isVisible('#ps-image-fallback');
    assert.equal(visible, true, 'the fallback link must show -- blocked video, balance affords the 10-token image');
    var text = await page.textContent('#ps-image-fallback');
    assert.equal(text, 'or make it as an image — 10 tokens');
  } finally {
    await context.close();
  }
});

test('style.html: the fallback link stays hidden when the balance cannot even afford the cheaper image', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // 5 < 10 -- offering "make it as an image" here would be showing an
    // option the user still can't take (the founder's own "otherwise
    // it's a lie" framing).
    await mockTokenStatus(page, { balance: 5, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    await seedAccount(page, { username: 'fallbackunaffordable', draft: { caption: 'A city made of light' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.click('.style-card[data-style="Anime"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var visible = await page.isVisible('#ps-image-fallback');
    assert.equal(visible, false, 'the fallback link must stay hidden -- the account cannot afford the 10-token image either');
  } finally {
    await context.close();
  }
});

test('style.html: the fallback link stays hidden when Image is already the selected media type (no cheaper alternative to offer)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Blocks even the (already cheapest) image action -- the sheet still
    // opens, but there is nothing cheaper left to offer.
    await mockTokenStatus(page, { balance: 5, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    await seedAccount(page, { username: 'fallbackalreadyimage', draft: { caption: 'A city made of light' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.click('.style-card[data-style="Anime"]');
    await page.click('.media-type-btn[data-media-type="image"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var title = await page.textContent('#ps-title');
    assert.match(title, /this image needs 10 tokens/);
    var visible = await page.isVisible('#ps-image-fallback');
    assert.equal(visible, false);
  } finally {
    await context.close();
  }
});

test('style.html: tapping the fallback link fires out_of_tokens_image_fallback_tapped and carries the SAME prompt/style into the image path (not a fresh/empty submission)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    var generateImageCalls = [];
    await page.route('**/.netlify/functions/generate-image', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateImageCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/flux/dev:fallback-op-1' }) });
    });
    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E999: should_not_be_called' }) });
    });
    await page.route('**/.netlify/functions/image-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, imageUrl: 'https://example.com/fallback-image.jpg' }) });
    });
    var phEvents = await capturePostHogEvents(page);

    await seedAccount(page, { username: 'fallbacktap', draft: { caption: 'A dream about a floating library' } });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await wirePostHogCaptureForwarding(page);
    await page.waitForTimeout(200);
    await page.click('.style-card[data-style="Anime"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    await page.waitForSelector('#ps-image-fallback:visible', { timeout: 3000 });

    await page.click('#ps-image-fallback');

    var fallbackEvents = phEvents.filter(function (e) { return e.name === 'out_of_tokens_image_fallback_tapped'; });
    assert.equal(fallbackEvents.length, 1, 'out_of_tokens_image_fallback_tapped must fire exactly once on tap');
    assert.equal(fallbackEvents[0].props.cost, 10);
    assert.equal(fallbackEvents[0].props.source, 'blocked_action');

    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 8000 });

    assert.equal(generateVideoCalls.length, 0, 'generate-video.js must never be called -- the tap switched this generation to the image path');
    await settle(function () { return generateImageCalls.length >= 1; });
    assert.equal(generateImageCalls.length, 1);
    assert.equal(generateImageCalls[0].caption, 'A dream about a floating library', 'the SAME prompt must carry into the image path, not a fresh/empty one');
    assert.equal(generateImageCalls[0].style, 'Anime');
  } finally {
    await context.close();
  }
});

test('result.html "Turn this into a video": the fallback link never shows, even with a balance that could afford the image (the founder\'s explicit exclusion)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // 30 < 100 (blocks the video upsell) but >= 10 -- if this were a
    // general route the fallback would show; it must not, here.
    await mockTokenStatus(page, { balance: 30, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    await seedAccount(page, {
      username: 'upsellnofallback',
      dream: { id: 'dream-upsell-nofallback', mediaType: 'image', imageUrl: 'https://fal.media/files/sample/original-image.png', videoUrl: null, caption: 'A dream about a floating library', style: 'Anime' }
    });
    await page.goto(baseUrl + '/result.html?id=dream-upsell-nofallback', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#turn-video-btn', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(200);

    await page.click('#turn-video-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var visible = await page.isVisible('#ps-image-fallback');
    assert.equal(visible, false, 'the image-to-video upsell must never offer the cheaper-image fallback');
  } finally {
    await context.close();
  }
});

test('result.html "Generate Again" (the older full edit-wizard sheet, reached via "Start over instead"): the fallback link shows for a blocked video regenerate, and tapping it carries the edited caption/style into the image path', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    var generateImageCalls = [];
    await page.route('**/.netlify/functions/generate-image', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateImageCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/flux/dev:fallback-op-2' }) });
    });
    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E999: should_not_be_called' }) });
    });
    await page.route('**/.netlify/functions/image-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, imageUrl: 'https://example.com/fallback-edit-image.jpg' }) });
    });
    var phEvents = await capturePostHogEvents(page);

    await seedAccount(page, {
      username: 'editagainfallback',
      dream: { id: 'dream-edit-again-fallback', mediaType: 'video', imageUrl: null, videoUrl: 'https://example.com/original-video.mp4', caption: 'Original caption', style: 'Anime' }
    });
    await page.goto(baseUrl + '/result.html?id=dream-edit-again-fallback', { waitUntil: 'domcontentloaded' });
    await wirePostHogCaptureForwarding(page);
    await page.waitForTimeout(200);

    // #open-edit-sheet opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) -- "Start over instead" reaches the OLD full
    // mini-wizard sheet #edit-generate-again lives in.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');
    await page.fill('#edit-text', 'An edited caption about the same dream');
    await page.click('#sheet-style-grid .style-card[data-style="Cinematic"]');
    await page.click('#edit-generate-again');

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    var visible = await page.isVisible('#ps-image-fallback');
    assert.equal(visible, true, 'a video-type dream\'s "Generate Again" is a general route -- the fallback must show');

    await page.click('#ps-image-fallback');

    var fallbackEvents = phEvents.filter(function (e) { return e.name === 'out_of_tokens_image_fallback_tapped'; });
    assert.equal(fallbackEvents.length, 1);

    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 8000 });

    assert.equal(generateVideoCalls.length, 0);
    await settle(function () { return generateImageCalls.length >= 1; });
    assert.equal(generateImageCalls.length, 1);
    assert.equal(generateImageCalls[0].caption, 'An edited caption about the same dream', 'the edited caption must carry into the image path');
    assert.equal(generateImageCalls[0].style, 'Cinematic');
  } finally {
    await context.close();
  }
});

test('home.html E112 fail path: the fallback link shows for a blocked general-route video generation, and tapping it retries in place as an image with the SAME prompt (no navigation needed)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 25, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E112: insufficient_tokens' }) });
    });
    var generateImageCalls = [];
    await page.route('**/.netlify/functions/generate-image', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateImageCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/flux/dev:home-fallback-op' }) });
    });
    await page.route('**/.netlify/functions/image-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, imageUrl: 'https://example.com/home-fallback-image.jpg' }) });
    });
    var phEvents = await capturePostHogEvents(page);

    // No sourceImageUrl -- this is a general-route video draft (e.g. from
    // style.html/wizard.html), never a turnImageIntoVideo one.
    await seedAccount(page, { username: 'homee112fallback', draft: { caption: 'A whale made of stars', style: 'Cinematic', mediaType: 'video', sourceImageUrl: null } });
    await page.goto(baseUrl + '/home.html?generate=1', { waitUntil: 'domcontentloaded' });
    await wirePostHogCaptureForwarding(page);

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 8000 });
    var visible = await page.isVisible('#ps-image-fallback');
    assert.equal(visible, true);

    await page.click('#ps-image-fallback');

    var fallbackEvents = phEvents.filter(function (e) { return e.name === 'out_of_tokens_image_fallback_tapped'; });
    assert.equal(fallbackEvents.length, 1);

    // No navigation on this path -- the tap retries in place on home.html.
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 8000 });
    await settle(function () { return generateImageCalls.length >= 1; });
    assert.equal(generateImageCalls.length, 1);
    assert.equal(generateImageCalls[0].caption, 'A whale made of stars');
    assert.equal(generateImageCalls[0].style, 'Cinematic');
    assert.ok(page.url().indexOf('home.html') !== -1, 'stays on home.html -- no navigation for the in-place retry');
  } finally {
    await context.close();
  }
});

test('home.html E112 fail path: the fallback link stays hidden when the failed submission was itself the image-to-video upsell (draft.sourceImageUrl set), even though the balance could afford the image', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // 25 >= 10 -- would afford the image; must still be excluded here.
    await mockTokenStatus(page, { balance: 25, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E112: insufficient_tokens' }) });
    });

    // Mirrors what DreamStore.turnImageIntoVideo actually persists
    // (sourceImageUrl set to the original image's URL) -- home.html's
    // single generic E112/E412 catch has no other record of which page a
    // failed submission came from, so this is the one durable signal it
    // checks (see that call site's own comment in home.html). No
    // sourceDreamId here on purpose -- isolates the sourceImageUrl gating
    // logic under test from regenerateDream's separate ownership-check
    // code path.
    await seedAccount(page, {
      username: 'homee112upsellnofallback',
      draft: { caption: 'A dream about a floating library', style: 'Anime', mediaType: 'video', sourceImageUrl: 'https://fal.media/files/sample/original-image.png' }
    });
    await page.goto(baseUrl + '/home.html?generate=1', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 8000 });
    var visible = await page.isVisible('#ps-image-fallback');
    assert.equal(visible, false, 'a failed image-to-video upsell submission must never offer the cheaper-image fallback, even via the generic E112 catch');
  } finally {
    await context.close();
  }
});
