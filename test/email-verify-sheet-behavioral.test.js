// test/email-verify-sheet-behavioral.test.js
//
// Real browser-driven coverage for js/email-verify-sheet.js's "next visit"
// deferred-verification trigger (tracker item for-product-build-
// passwordless-signup-fo-at2fko), wired on home.html. Follows this repo's
// established seedHomeUser/mockTokenStatus convention (see test/home-
// behavioral.test.js's own header comment for the full "why this shape"
// writeup).

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

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 100, claimable: false, nextClaimAt: 0, dailyClaimAmount: 100, streak: 0 }) });
  });
}

/** Seeds a signed-in account (optionally passwordless/unverified) and navigates to home.html, mirroring test/home-behavioral.test.js's seedHomeUser. */
async function seedHomeUser(page, opts) {
  opts = opts || {};
  var username = opts.username || 'pwlesstester';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {};
    state.user = { handle: '@' + args.username, username: args.username, authToken: args.authToken || 'fake-auth-token' };
    state.accounts = {};
    state.accounts[args.username] = {
      password: args.password === undefined ? 'testpass1' : args.password,
      email: args.username + '@example.com',
      emailVerified: args.emailVerified
    };
    state.dreams = [];
    state.draft = {};
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    if (args.presetSessionMarker) sessionStorage.setItem('dreamtube_email_verify_sheet_shown', '1');
  }, { username: username, emailVerified: opts.emailVerified, password: opts.password, authToken: opts.authToken, presetSessionMarker: !!opts.presetSessionMarker });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

test('email-verify-sheet: an UNVERIFIED account is offered the code prompt on this (fresh) visit to home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    var copy = await page.locator('#email-verify-sheet-copy').textContent();
    assert.match(copy, /pwlesstester@example\.com/);
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: entering the correct code marks the account verified and shows the confirmation view', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    var verifyCalls = [];
    await page.route('**/.netlify/functions/verify-email-code', function (route) {
      verifyCalls.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.fill('#email-verify-code-input', '123456');
    await page.click('#email-verify-submit-btn');

    await page.waitForSelector('#email-verify-sheet-done', { state: 'visible', timeout: 4000 });
    assert.equal(verifyCalls.length, 1);
    assert.equal(verifyCalls[0].code, '123456');
    assert.equal(verifyCalls[0].authToken, 'fake-auth-token');

    // Local cache actually updated -- a page reload must not re-offer it.
    var nowVerified = await page.evaluate(function () { return DreamStore.getAccountEmailVerified(); });
    assert.equal(nowVerified, true);
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: a wrong code shows an inline error and does NOT close the sheet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    await page.route('**/.netlify/functions/verify-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E6: invalid_code' }) });
    });

    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.fill('#email-verify-code-input', '000000');
    await page.click('#email-verify-submit-btn');

    await page.waitForSelector('#email-verify-sheet-error:not(:empty)', { timeout: 4000 });
    assert.equal(await page.locator('#email-verify-sheet-overlay').getAttribute('class'), 'sheet-overlay open');
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: "Resend code" calls the resend endpoint', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    var resendCalls = 0;
    await page.route('**/.netlify/functions/resend-verification-code', function (route) {
      resendCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    // Opening the sheet now auto-sends a code (founder repro 2026-08-07:
    // the copy claimed "we sent a code" while nothing had been sent) —
    // so by the time the sheet is open, one call has already happened.
    await page.waitForFunction(function () { return true; });
    var manualBaseline = resendCalls;
    assert.equal(manualBaseline, 1, 'opening the sheet must itself send a code — the copy promises one');
    await page.click('#email-verify-resend-link');
    await page.waitForFunction(function () {
      return document.getElementById('email-verify-resend-link').textContent.indexOf('Sent') !== -1;
    }, { timeout: 3000 });
    assert.equal(resendCalls, 2, 'manual Resend still works on top of the auto-send');
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: a VERIFIED account is never shown the prompt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: true, password: null });

    await page.waitForTimeout(1800); // longer than the 1200ms scheduling delay
    assert.equal(await page.locator('#email-verify-sheet-overlay').count(), 0, 'the sheet must never even mount for a verified account');
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: a PASSWORD-based account (emailVerified defaults true, never explicitly set) is never shown the prompt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    // emailVerified left undefined -- the exact shape a real password-
    // signup local account has (js/store.js's own local mirror never
    // wrote this field before this feature existed) -- must default to
    // "don't ever gate/prompt", never crash on a missing field.
    await seedHomeUser(page, { emailVerified: undefined, password: 'testpass1' });

    await page.waitForTimeout(1800);
    assert.equal(await page.locator('#email-verify-sheet-overlay').count(), 0);
  } finally {
    await context.close();
  }
});

test('email-verify-sheet: does NOT reopen on this same tab session once already offered (e.g. the immediate post-signup landing)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null, presetSessionMarker: true });

    await page.waitForTimeout(1800);
    assert.equal(await page.locator('#email-verify-sheet-overlay').count(), 0, 'a tab that already marked this session as offered must stay silent');
  } finally {
    await context.close();
  }
});


test('email-verify-sheet: the on-open auto-send fires ONCE per page load — dismissing and re-opening the sheet does not send again', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });
    var resendCalls = 0;
    await page.route('**/.netlify/functions/resend-verification-code', function (route) {
      resendCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.click('#email-verify-later-link');
    await page.evaluate(function () { EmailVerifySheet.show({ source: 'test_reopen' }); });
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 3000 });
    await page.waitForTimeout(400);
    assert.equal(resendCalls, 1, 're-opening in the same page load reuses the already-sent code (manual Resend covers a lost email)');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// +20 email-verification bonus (founder-authorized 2026-08-08): home.html's
// Make-it-yours card gains a "Verify your email · +20" row, and the sheet's
// done view celebrates the grant when (and only when) the server says it
// landed. Server-side grant coverage lives in test/passwordless-signup.
// test.js; these tests cover the client surfaces.
// ===========================================================================

test('verify bonus: the sheet\'s done view shows "+20 tokens added" when the verify response carries bonus.granted, and NO bonus line when it doesn\'t', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null });

    await page.route('**/.netlify/functions/verify-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bonus: { granted: true, amount: 20, balance: 340 } }) });
    });
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.fill('#email-verify-code-input', '123456');
    await page.click('#email-verify-submit-btn');
    await page.waitForSelector('#email-verify-sheet-done', { state: 'visible', timeout: 4000 });
    assert.equal(await page.locator('#email-verify-bonus-line').isVisible(), true, 'the +20 line must show when the server reported the grant');
    assert.match(await page.locator('#email-verify-bonus-line').textContent(), /\+20 tokens added/);
  } finally {
    await context.close();
  }

  // Second pass: a response with NO grant (already granted / legacy shape)
  // must not celebrate anything.
  var context2 = await browser.newContext();
  try {
    var page2 = await context2.newPage();
    await blockThirdParty(page2);
    await mockTokenStatus(page2);
    await seedHomeUser(page2, { emailVerified: false, password: null });
    await page2.route('**/.netlify/functions/verify-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page2.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page2.fill('#email-verify-code-input', '123456');
    await page2.click('#email-verify-submit-btn');
    await page2.waitForSelector('#email-verify-sheet-done', { state: 'visible', timeout: 4000 });
    assert.equal(await page2.locator('#email-verify-bonus-line').isVisible(), false, 'no server-confirmed grant, no celebration — the client never guesses');
  } finally {
    await context2.close();
  }
});

test('verify bonus row: visible with the +20 chip for an unverified signed-in account, hidden entirely for a verified one; tapping it opens the verify sheet (source: bonus_row)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    // presetSessionMarker stops the next-visit auto-offer so the ROW is
    // what opens the sheet here.
    await seedHomeUser(page, { emailVerified: false, password: null, presetSessionMarker: true });

    await page.waitForSelector('#mky-item-verify:not([hidden])', { timeout: 4000 });
    assert.match(await page.locator('#mky-verify-chip').textContent(), /\+20/, 'the row must carry the +20 chip');
    assert.equal(await page.locator('#email-verify-sheet-overlay.open').count(), 0, 'sanity: sheet not open before the tap');

    await page.click('#mky-verify-row');
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
  } finally {
    await context.close();
  }

  var context2 = await browser.newContext();
  try {
    var page2 = await context2.newPage();
    await blockThirdParty(page2);
    await mockTokenStatus(page2);
    await seedHomeUser(page2, { emailVerified: true, password: null });
    await page2.waitForSelector('#mky', { timeout: 4000 });
    var hidden = await page2.evaluate(function () { return document.getElementById('mky-item-verify').hidden; });
    assert.equal(hidden, true, 'a verified account must never see the row');
  } finally {
    await context2.close();
  }
});

test('verify bonus row: after an in-sheet verification the row flips to its ✓ state (chip retired), the balance re-fetches, and the toast reports the server-confirmed +20', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var tokenStatusCalls = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      tokenStatusCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: tokenStatusCalls > 1 ? 340 : 320, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 }) });
    });
    await seedHomeUser(page, { emailVerified: false, password: null, presetSessionMarker: true });

    await page.route('**/.netlify/functions/verify-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bonus: { granted: true, amount: 20, balance: 340 } }) });
    });
    await page.waitForSelector('#mky-item-verify:not([hidden])', { timeout: 4000 });
    var callsBeforeVerify = tokenStatusCalls;

    await page.click('#mky-verify-row');
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.fill('#email-verify-code-input', '123456');
    await page.click('#email-verify-submit-btn');
    await page.waitForSelector('#email-verify-sheet-done', { state: 'visible', timeout: 4000 });

    // Row flipped: ✓ shown, +20 chip retired, row still present this view.
    await page.waitForFunction(function () {
      return !document.getElementById('mky-verify-check').hidden;
    }, null, { timeout: 4000 });
    assert.equal(await page.evaluate(function () { return document.getElementById('mky-item-verify').hidden; }), false, 'the row stays visible in its done state for this page view');
    assert.equal(await page.evaluate(function () { return document.getElementById('mky-verify-chip').hidden; }), true, 'the +20 ask retires once earned');
    // Balance re-fetched off the verified event (the check ✓ above only
    // renders from that same event handler, so the refresh call has
    // already been issued by the time we get here).
    assert.ok(tokenStatusCalls > callsBeforeVerify, 'the balance must re-fetch after verification (got ' + tokenStatusCalls + ' calls)');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Standalone (add-to-homescreen) survival — tracker item for-product-auto-
// drive-email-verify-earl-qzq652 part 2 (founder-authorized 2026-08-09).
// The founder's own read of the code ("refreshMky()'s visibility logic
// appears to be driven purely by DreamStore flags, not any explicit
// display-mode check") suggested this should already work, but the item
// explicitly asked for it to be PROVEN, not assumed. forceStandalone below
// is the same technique test/a2hs-install-nudge-journey-behavioral.test.js
// already established for the install-bonus half of this same card (see
// that file's own doc comment for exactly why addInitScript, not a
// post-load page.evaluate, is required) -- duplicated here rather than
// imported, matching this suite's existing per-file helper convention.
// ===========================================================================

/**
 * Forces `window.matchMedia('(display-mode: standalone)').matches` to true
 * BEFORE any page script runs -- the exact same check PwaInstall.
 * isStandalone() reads (js/pwa.js). Must be an addInitScript so js/pwa.js's
 * own on-load standalone check (which runs synchronously as the script
 * parses) sees it too.
 */
function forceStandalone(page) {
  return page.addInitScript(function () {
    var real = window.matchMedia ? window.matchMedia.bind(window) : null;
    window.matchMedia = function (q) {
      if (String(q).indexOf('display-mode') !== -1) {
        return { matches: true, media: q, addListener: function () {}, removeListener: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
      }
      return real ? real(q) : { matches: false, media: q };
    };
  });
}

test('STANDALONE SURVIVAL: an unverified account opening home.html in simulated standalone display-mode still gets the verify row rendered, tappable, and the sheet flow completes + grants the bonus exactly as in a normal tab', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await forceStandalone(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: false, password: null, presetSessionMarker: true, username: 'standaloneverifyemail' });

    // Sanity: this load really is standalone, per the same check js/pwa.js
    // itself reads -- if this ever failed, the rest of the test would be
    // proving nothing.
    var reallyStandalone = await page.evaluate(function () { return window.PwaInstall && PwaInstall.isStandalone(); });
    assert.equal(reallyStandalone, true, 'sanity: forceStandalone must actually make PwaInstall.isStandalone() true, or this test proves nothing');

    await page.waitForSelector('#mky-item-verify:not([hidden])', { timeout: 4000 });
    assert.match(await page.locator('#mky-verify-chip').textContent(), /\+20/, 'the +20 chip must render in standalone mode same as a normal tab');

    await page.route('**/.netlify/functions/verify-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, bonus: { granted: true, amount: 20, balance: 340 } }) });
    });

    await page.click('#mky-verify-row');
    await page.waitForSelector('#email-verify-sheet-overlay.open', { timeout: 4000 });
    await page.fill('#email-verify-code-input', '123456');
    await page.click('#email-verify-submit-btn');
    await page.waitForSelector('#email-verify-sheet-done', { state: 'visible', timeout: 4000 });

    assert.equal(await page.locator('#email-verify-bonus-line').isVisible(), true, 'the +20 celebration must show in standalone mode exactly as in a normal tab');
    await page.waitForFunction(function () {
      return !document.getElementById('mky-verify-check').hidden;
    }, null, { timeout: 4000 });
    assert.equal(await page.evaluate(function () { return DreamStore.getAccountEmailVerified(); }), true, 'the account must genuinely end up verified, not just show a UI state');
  } finally {
    await context.close();
  }
});

test('STANDALONE SURVIVAL: a VERIFIED account opening home.html in simulated standalone display-mode never sees the verify row (matches normal-tab behavior)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await forceStandalone(page);
    await mockTokenStatus(page);
    await seedHomeUser(page, { emailVerified: true, password: null, username: 'standaloneverified' });

    await page.waitForSelector('#mky', { timeout: 4000 });
    var hidden = await page.evaluate(function () { return document.getElementById('mky-item-verify').hidden; });
    assert.equal(hidden, true, 'a verified account must never see the row, standalone or not');
  } finally {
    await context.close();
  }
});

test('verify bonus row: an install-claimed-on-an-earlier-visit account with an UNVERIFIED email keeps the Make-it-yours card, shrunk to just the verify row (the install machinery stays retired)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var state = {
        user: { handle: '@shrunkcard', username: 'shrunkcard', authToken: 'fake-auth-token' },
        accounts: { shrunkcard: { password: null, email: 'shrunkcard@example.com', emailVerified: false, installBonusClaimed: true } },
        dreams: [], draft: {}
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
      sessionStorage.setItem('dreamtube_email_verify_sheet_shown', '1');
    });
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#mky-item-verify:not([hidden])', { timeout: 4000 });
    var state = await page.evaluate(function () {
      return {
        sectionShown: document.getElementById('mky').style.display !== 'none',
        installHidden: document.getElementById('mky-item-install').hidden,
        rewardHidden: document.getElementById('mky-reward-line').hidden,
        claimHidden: document.getElementById('mky-claim').hidden
      };
    });
    assert.equal(state.sectionShown, true, 'the card must stay for the still-earnable email bonus');
    assert.equal(state.installHidden, true, 'the spent install machinery must stay retired');
    assert.equal(state.rewardHidden, true);
    assert.equal(state.claimHidden, true);
  } finally {
    await context.close();
  }
});
