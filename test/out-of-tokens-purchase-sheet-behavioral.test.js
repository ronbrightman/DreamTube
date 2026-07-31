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
//    processing.html's E112/E412 fail path
//  - the audit-found bug fix: the blocked action's full draft state is
//    genuinely persisted (DreamStore.setDraft/turnImageIntoVideo) the
//    moment the sheet opens on style.html AND result.html, not only on
//    the unblocked path
//  - the post-checkout auto-resume round trip on processing.html (a
//    mocked successful checkout return re-fires the exact blocked
//    generation from the intact draft)
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
    assert.match(buyLabel, /Get 200 tokens · \$2\.99/);

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

test('style.html: tapping the buy button POSTs the smallest sufficient pack with a relative-path-only successUrl/cancelUrl', async function (t) {
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
    assert.equal(captured.pack, 'pack100');
    assert.equal(captured.successUrl, '/processing.html?checkout=success');
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
    assert.equal(page.url().indexOf('processing.html'), -1, 'must not navigate away when tokens are insufficient');

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
// processing.html's E112/E412 fail path — the third blocked-action entry
// point named in the spec. The draft is already intact by construction
// here (submission itself required a complete draft), so this only
// checks the sheet's own arithmetic/auto-open behavior, not persistence.
// ============================================================================
test('processing.html: an E112 (insufficient tokens) generation failure auto-opens the purchase sheet with correct arithmetic', async function (t) {
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
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 8000 });
    var title = await page.textContent('#ps-title');
    assert.match(title, /Almost there — this video needs 100 tokens/);
    var body = await page.textContent('#ps-body');
    assert.match(body, /You have\s*25/);
    assert.match(body, /75 more/);
    // The underlying fail state is still visible/available underneath —
    // the sheet slides up OVER the current screen, per the founder-approved
    // mock, not a full replacement of it.
    assert.equal(await page.locator('#proc-fail').isVisible(), true);
  } finally {
    await context.close();
  }
});

// ============================================================================
// Media-aware fail-state copy (hardening fix, tracker item
// for-product-store-launch-copy-sweep-purc-m6xhkx): the fail screen's own
// copy ("Something went wrong while generating your ___") used to be
// static markup that always said "video", even for a failed image
// generation — misleading on the image path. Fixed to read
// currentMediaType() the same way the live-state title/sub already did.
// ============================================================================
test('processing.html: a failed VIDEO generation shows "video" in the fail copy', async function (t) {
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
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 8000 });
    var copy = await page.textContent('#proc-fail-copy');
    assert.match(copy, /generating your video/i);
    assert.doesNotMatch(copy, /generating your image/i);
  } finally {
    await context.close();
  }
});

test('processing.html: a failed IMAGE generation shows "image" in the fail copy, not "video"', async function (t) {
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
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 8000 });
    var copy = await page.textContent('#proc-fail-copy');
    assert.match(copy, /generating your image/i);
    assert.doesNotMatch(copy, /generating your video/i);
  } finally {
    await context.close();
  }
});

// ============================================================================
// Post-checkout auto-resume — processing.html?checkout=success
// ============================================================================
test('processing.html: a mocked successful checkout return auto-resumes the exact blocked generation from the intact draft', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Balance is already sufficient on the very first poll — the credit
    // "already landed" by the time this page loads.
    await mockTokenStatus(page, { balance: 150, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

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
      pendingPurchase: { pack: 'pack100', tokens: 200, price: 2.99, eventId: 'evt-resume-1', purchaseFlow: 'blocked_action', source: 'blocked_action', mediaType: 'video', cost: 100 }
    });

    await page.goto(baseUrl + '/processing.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForURL('**/result.html?id=*', { timeout: 15000, waitUntil: 'domcontentloaded' });

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
// Honest-degrade path — the credit is still lagging past the poll window
// ============================================================================
test('processing.html: when the token credit is still lagging past the poll window, it degrades honestly ("tap Generate when your balance updates") instead of erroring or hanging forever', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Balance never crosses the needed threshold during the (shrunk) poll window.
    await mockTokenStatus(page, { balance: 40, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:veo3.1:should-not-fire' }) });
    });

    // Shrinks pollForCredit's real ~75s window down to something a test can
    // actually run in — see js/purchase-sheet.js's pollForCredit doc
    // comment and processing.html's own window.__TEST_POLL_OVERRIDES__ read.
    await page.addInitScript(function () {
      window.__TEST_POLL_OVERRIDES__ = { intervalMs: 60, maxMs: 250 };
    });

    await seedAccount(page, {
      username: 'degradepath',
      draft: { caption: 'A dream about a lighthouse in the fog', style: 'Realistic', mediaType: 'video' },
      pendingPurchase: { pack: 'pack100', tokens: 200, price: 2.99, eventId: 'evt-degrade-1', purchaseFlow: 'blocked_action', source: 'blocked_action', mediaType: 'video', cost: 100 }
    });

    await page.goto(baseUrl + '/processing.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#proc-payment-manual-btn', { state: 'visible', timeout: 5000 });
    var copy = await page.textContent('#proc-payment-copy');
    assert.match(copy, /Tokens on the way — tap Generate when your balance updates\./);
    assert.equal(generateVideoCalls.length, 0, 'must never auto-fire generation while the credit is still unconfirmed');
    assert.equal(page.url().indexOf('result.html'), -1);

    // The manual fallback must still work once tapped (balance updates for real this time).
    await page.unroute('**/.netlify/functions/get-token-status*');
    await mockTokenStatus(page, { balance: 150, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/degraded-resume-video.mp4' }) });
    });
    await page.click('#proc-payment-manual-btn');
    await page.waitForURL('**/result.html?id=*', { timeout: 8000, waitUntil: 'domcontentloaded' });
    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1, 'the manual "Generate" tap must re-run the exact same resume');
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

test('processing.html: pagehide cancels the in-flight credit poll -- a stale poll tick must not resume generation after the user has navigated away', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Flips to a sufficient balance only AFTER the test cancels the poll --
    // this is what actually proves cancellation (not merely "the balance
    // never happened to cross the threshold") stopped the resume: without
    // the pagehide fix, this credit landing would have satisfied the very
    // next poll tick and fired runGeneration().
    var creditLanded = false;
    var tokenStatusCallCount = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      tokenStatusCallCount++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: creditLanded ? 150 : 10, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 }) });
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
      pendingPurchase: { pack: 'pack100', tokens: 200, price: 2.99, eventId: 'evt-pagehide-1', purchaseFlow: 'blocked_action', source: 'blocked_action', mediaType: 'video', cost: 100 }
    });

    await page.goto(baseUrl + '/processing.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#proc-payment-resume', { state: 'visible', timeout: 5000 });

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

test('processing.html: checkout=success with the pending-purchase marker missing still gets a polling grace period instead of firing runGeneration() immediately (private-browsing storage block / cross-tab checkout)', async function (t) {
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

    await page.goto(baseUrl + '/processing.html?checkout=success', { waitUntil: 'domcontentloaded' });

    // THE FIX: must show the same "payment received / finishing up" grace
    // state as the marker-present path, not fall straight through to an
    // immediate runGeneration() call just because there's no marker to read
    // a cost/source off of.
    await page.waitForSelector('#proc-payment-resume', { state: 'visible', timeout: 3000 });
    assert.equal(generateVideoCalls.length, 0, 'must not fire generation immediately just because the pending-purchase marker was missing');

    await page.waitForTimeout(150);
    creditLanded = true;

    await page.waitForURL('**/result.html?id=*', { timeout: 8000, waitUntil: 'domcontentloaded' });
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
