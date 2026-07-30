// test/token-daily-grant-copy-behavioral.test.js
//
// Regression coverage for review findings across two branches, PLUS the
// 2026-07-28 daily-claim switch (tracker item
// for-product-build-the-daily-token-claim--fngrwd) that flipped every one
// of these copy sites from grant-framing to claim-framing:
//
// (1) image-generation branch — style.html, result.html, shop.html
// (#shop-countdown), and profile.html all hardcoded the literal number
// "100" in their daily-free-grant copy ("...you'll get 100 more
// automatically...", "Next 100 free tokens in...", "+100 in...").
// entitlements.js's DAILY_GRANT_AMOUNT was retuned 100 -> 10 as part of
// this same branch (docs/IMAGE_GENERATION_SPEC.md §2b-revised) but these
// four hardcoded strings were missed — two (style.html/result.html) were
// disclosed as known-stale, two (shop.html/profile.html) were NOT and are
// not even scoped to the image feature (the daily amount is global, so
// every user would have seen a 10x-wrong number regardless of ever
// touching image generation).
// (2) raise-daily-token-award-to-200 branch (10 -> 200, 2026-07-26),
// review round 2 — a FIFTH such location, shop.html's #shop-cap-note
// ("Free tokens are capped — 100 every 24 hours..."), a different
// phrasing again that slipped past the grep patterns used to find the
// first four.
//
// Fix: all four read the daily amount live off tokenStatus instead of a
// hardcoded literal (see js/store.js's getTokenStatus / get-token-status.js
// / lib/entitlements.js's getTokenStatus, which already return this field
// for exactly this purpose — now called `dailyClaimAmount`, since
// 2026-07-28's daily-claim switch renamed it from `dailyGrantAmount`
// alongside the actual mechanism change). These tests mock a deliberately
// distinctive dailyClaimAmount (7 -- not 10, not 100, and not 20 as of the
// current retune) so a pass actually proves the copy is read live, not
// coincidentally matching whatever the real constant happens to be today.
//
// (3) 2026-07-28 daily-claim switch itself: the OLD "≥200 grant ceiling"
// (tracker item for-product-bug-founder-high-token-chip--kn1v8t)'s
// `grantCeiling`/`atCeiling` fields are RETIRED ENTIRELY — there is no
// ceiling anymore (see lib/entitlements.js's own doc block: an idle
// account accumulates nothing without an active claim tap, so there's
// nothing left for a ceiling to guard against). shop.html's #shop-cap-note
// no longer mentions a ceiling number at all — this file's old
// "grantCeiling read live" test is replaced with a plain "no ceiling
// number anywhere in this copy" assertion instead.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var DISTINCTIVE_CLAIM_AMOUNT = 7;

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

function mockClaim(page, response) {
  return page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

async function seedLoggedInUserAt(page, username, path) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded' });
}

/** Seeds a logged-in account with a real draft (caption+style) directly in localStorage -- the cheapest way to reach style.html without driving create.html's chip flow for real. */
async function seedLoggedInUserWithDraftAt(page, username, path) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    state.draft = Object.assign({}, state.draft, { caption: 'A dream about flying', style: null, mediaType: null, sourceImageUrl: null });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded' });
}

// The two tests below used to check the old #modal-quota-body's static
// "you'll get N more automatically" copy on style.html/result.html.
// That modal was replaced by the out-of-tokens purchase sheet (tracker
// item for-product-build-out-of-tokens-purchase-2y8hyw) — the equivalent
// "read the live daily amount, not a hardcoded literal" concern now lives
// in the sheet's own wait-line (js/purchase-sheet.js's waitLineText(),
// unit-tested directly in test/purchase-sheet.test.js). These two are now
// real-browser regression coverage that style.html/result.html actually
// WIRE the live tokenStatus into that wait line — the balance is set low
// enough to actually trigger the sheet, since (unlike the old
// always-rendered modal copy) the wait line only renders once the sheet
// is shown. claimable:false + a future nextClaimAt exercises the
// countdown half of waitLineText specifically (see
// test/purchase-sheet.test.js for the claimable:true "claim now" half).
test('style.html: the purchase sheet\'s wait line reads the live dailyClaimAmount, not a hardcoded 100', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 5, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: DISTINCTIVE_CLAIM_AMOUNT, streak: 0 });
    await seedLoggedInUserWithDraftAt(page, 'dailygrantstyle', '/style.html');
    await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });
    // Give the async getTokenStatus() a moment to resolve.
    await page.waitForTimeout(250);

    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var waitLine = await page.textContent('#ps-wait-line');
    assert.match(waitLine, new RegExp('claim ' + DISTINCTIVE_CLAIM_AMOUNT + ' free tokens in'));
    assert.doesNotMatch(waitLine, /100 free tokens/);
    assert.doesNotMatch(waitLine, /wait —/, 'the old "Or wait —" grant-framed phrasing must be gone entirely');
  } finally {
    await context.close();
  }
});

test('result.html: the purchase sheet\'s wait line reads the live dailyClaimAmount, not a hardcoded 100', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 5, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: DISTINCTIVE_CLAIM_AMOUNT, streak: 0 });

    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@dailygrantresult', username: 'dailygrantresult' };
      if (!state.accounts) state.accounts = {};
      state.accounts.dailygrantresult = { password: 'testpass1', email: 'dailygrantresult@example.com' };
      if (!state.dreams) state.dreams = [];
      state.dreams.push({ id: 'dream-daily-grant', ownerHandle: '@dailygrantresult', caption: 'x', style: 'Cartoon', mediaType: 'video', videoUrl: 'https://example.com/fake-video.mp4', dur: '0:08', isPublished: false, likes: 0, likedByMe: false });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=dream-daily-grant', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);

    await page.click('#open-edit-sheet');
    await page.click('#edit-generate-again');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var waitLine = await page.textContent('#ps-wait-line');
    assert.match(waitLine, new RegExp('claim ' + DISTINCTIVE_CLAIM_AMOUNT + ' free tokens in'));
    assert.doesNotMatch(waitLine, /100 free tokens/);
  } finally {
    await context.close();
  }
});

test('shop.html: the countdown reads the live dailyClaimAmount, not a hardcoded "Next 100 free tokens"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: DISTINCTIVE_CLAIM_AMOUNT, streak: 0 });
    await seedLoggedInUserAt(page, 'dailygrantshop', '/shop.html');
    await page.waitForSelector('#shop-countdown:not(:empty)', { timeout: 5000 });

    var countdown = await page.textContent('#shop-countdown');
    assert.match(countdown, new RegExp('Next ' + DISTINCTIVE_CLAIM_AMOUNT + ' free tokens claimable in'));
    assert.doesNotMatch(countdown, /Next 100 free tokens/);
    // The claim button must stay hidden while not yet claimable.
    var claimBtnVisible = await page.isVisible('#shop-claim-btn');
    assert.equal(claimBtnVisible, false);
  } finally {
    await context.close();
  }
});

test('shop.html: claimable state shows a live-amount "Claim N free tokens" button, and the copy sweep removed the old grant-ceiling literal entirely', async function (t) {
  // 2026-07-28 daily-claim switch: shop.html's #shop-cap-note used to read
  // "Free tokens are capped — N every 24 hours, up to M banked" (M being
  // entitlements.js's GRANT_CEILING) -- that whole ceiling concept is
  // retired now (see lib/entitlements.js's own doc block: no ceiling is
  // needed once nothing accrues without an active claim). This test
  // proves BOTH halves of the fix: the claim button reads the live amount
  // (not a hardcoded 100/20), and the cap note contains no lingering
  // "banked"/ceiling-number literal from the old mechanism.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 50, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: DISTINCTIVE_CLAIM_AMOUNT, streak: 0 });
    await seedLoggedInUserAt(page, 'dailygrantshopcap', '/shop.html');
    await page.waitForSelector('#shop-claim-btn:visible', { timeout: 5000 });

    var claimLabel = await page.textContent('#shop-claim-label');
    assert.match(claimLabel, new RegExp('Claim ' + DISTINCTIVE_CLAIM_AMOUNT + ' free tokens'));
    assert.doesNotMatch(claimLabel, /Claim 100 free tokens/);

    var capNote = await page.textContent('#shop-cap-note');
    assert.match(capNote, new RegExp(DISTINCTIVE_CLAIM_AMOUNT + ' claimable once a day'));
    assert.doesNotMatch(capNote, /banked/, 'the retired grant-ceiling concept ("up to N banked") must not appear anywhere in this copy');
    assert.doesNotMatch(capNote, /capped/, 'the retired "tokens are capped" framing must not appear anywhere in this copy');

    // daily-claim-first-claim-bonus review round 2: the top-of-page
    // #shop-cost-banner had its own separate, hardcoded "Claim 20 free
    // tokens once a day" text node that never varied with tokenStatus,
    // even though the nearly-identical #shop-cap-note a few lines below
    // was already live -- the two contradicted each other the moment the
    // amount became genuinely variable (100 first-ever, 20 thereafter).
    var bannerAmount = await page.textContent('#shop-cost-banner-claim-amount');
    assert.equal(bannerAmount, String(DISTINCTIVE_CLAIM_AMOUNT), 'the cost banner\'s claim number must also read live off tokenStatus, not a hardcoded literal');
  } finally {
    await context.close();
  }
});

test('shop.html: a successful claim\'s toast shows the response\'s real amountClaimed, not a stale cached dailyClaimAmount', async function (t) {
  // daily-claim-first-claim-bonus review round 1: shop.html's own inline
  // balance-card claim button is a SEPARATE code path from the shared
  // claim sheet (js/purchase-sheet.js, covered by
  // test/daily-claim-behavioral.test.js's first-claim-bonus tests) --
  // its success toast used to read the pre-claim cached
  // tokenStatus.dailyClaimAmount instead of the claim response's own
  // authoritative amountClaimed. Harmless while the amount was always a
  // flat 20; genuinely wrong now that first-ever claims are 100. This
  // mocks a cached projection of 20 but a real credited amount of 100 to
  // prove the toast reads the live response, not the stale cache.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 0 });
    await mockClaim(page, { claimed: true, balance: 320, streak: 1, nextClaimAt: Date.now() + 72000000, amountClaimed: 100 });

    // shop.html also auto-opens the shared claim sheet on top of its own
    // inline button (PurchaseSheet.maybeAutoOpenClaimSheet), gated on a
    // once-per-day localStorage marker -- pre-set it so the inline button
    // this test targets is actually clickable, matching a real returning
    // user's second visit that day rather than their very first.
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function (u) {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@' + u, username: u };
      if (!state.accounts) state.accounts = {};
      state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
      localStorage.setItem('dreamtube_claim_sheet_shown_date', new Date().toDateString());
    }, 'shopclaimtoastamount');
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#shop-claim-btn:visible', { timeout: 5000 });

    await page.click('#shop-claim-btn');
    await page.waitForFunction(function () {
      var el = document.getElementById('toast');
      return el && el.classList.contains('show') && el.textContent.length > 0;
    }, { timeout: 3000 });

    var toastText = await page.textContent('#toast');
    assert.match(toastText, /\+100 tokens claimed!/, 'must show the response\'s real amountClaimed (100), not the stale cached dailyClaimAmount (20)');
  } finally {
    await context.close();
  }
});

// REMOVED (2026-07-30, tracker item
// for-product-build-founder-approved-2026--to6ew2): the two profile.html
// tests that used to sit here -- "the token countdown reads the live
// dailyClaimAmount, not a hardcoded +100 in" and "claimable state shows the
// live 'Claim +N free' copy and the pulsing chip class". profile.html has
// no countdown, no claim copy, and no claimable chip state anymore: the
// founder-approved night restyle replaced its chip with
// js/purchase-sheet.js's PLAIN variant (balance + Shop link only), making
// home.html the sole claim surface. There is no hardcoded daily amount left
// on that page for this file's whole premise to catch -- there is no daily
// amount rendered there at all. The four remaining copy sites this file
// covers (style.html, result.html, shop.html's #shop-countdown and
// #shop-cap-note) are unaffected and still tested above/below;
// test/profile-night-restyle-behavioral.test.js asserts the absence on
// Profile directly.
