// test/daily-claim-behavioral.test.js
//
// Real-browser coverage for the daily token claim's UI (tracker item
// for-product-build-the-daily-token-claim--fngrwd): the pulsing balance
// chip, the dedicated claim sheet (open on tap, count-up + confetti on a
// real claim, events), the once-per-day auto-open, explore.html's new
// chip mount, and a copy-sweep pass confirming the old "automatic daily
// grant" promise is genuinely gone from the surfaces this build touched.
//
// The claim/streak/cooldown SERVER logic itself is covered in depth by
// test/entitlements-daily-claim.test.js and test/claim-daily-tokens.test.js
// (plain node --test, no browser needed for that part) — this file only
// exercises the client wiring: does tapping the chip/button actually call
// the real endpoint, does the UI reflect a genuine server-confirmed
// response (never optimistic), and does the claim-framed copy actually
// replace the old automatic-grant copy everywhere it used to live.

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

function mockGetFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
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

function mockClaim(page, response) {
  return page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

// ============================================================================
// Balance chip: pulsing claimable state + tap-to-open
// ============================================================================

test('create.html: the topbar chip pulses (claimable class) and shows a live +N badge when claimable, plain otherwise', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 150, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 1 });
    await seedLoggedInUserAt(page, 'chippulse', '/create.html');
    await page.waitForSelector('#topbar-token-chip', { timeout: 5000 });
    // The auto-open sheet fires on this same load -- dismiss it first so it
    // doesn't intercept the chip click below.
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });

    var isClaimable = await page.evaluate(function () {
      return document.getElementById('topbar-token-chip').classList.contains('claimable');
    });
    assert.equal(isClaimable, true);
    var plusText = await page.textContent('.token-chip-plus');
    assert.equal(plusText.trim(), '+20');
  } finally {
    await context.close();
  }
});

test('create.html: NOT claimable -> chip has no pulsing class, tapping it navigates to shop.html as normal', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 150, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 1 });
    await seedLoggedInUserAt(page, 'chipnotclaimable', '/create.html');
    await page.waitForSelector('#topbar-token-chip', { timeout: 5000 });
    await page.waitForTimeout(200);

    var isClaimable = await page.evaluate(function () {
      return document.getElementById('topbar-token-chip').classList.contains('claimable');
    });
    assert.equal(isClaimable, false);

    await page.click('#topbar-token-chip');
    await page.waitForURL('**/shop.html*', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('create.html: tapping the CLAIMABLE chip opens the claim sheet instead of navigating away', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 150, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 1 });
    await seedLoggedInUserAt(page, 'chiptapclaim', '/create.html');
    // Dismiss the auto-opened sheet first so this test cleanly exercises a
    // deliberate chip tap afterward.
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });

    // force:true -- the pulsing .claimable CSS animation (a scale transform,
    // see css/styles.css) means the chip's bounding box never stops moving,
    // so Playwright's normal actionability "element is stable" wait would
    // hang forever; a real tap on an animated element works fine in an
    // actual browser regardless.
    await page.click('#topbar-token-chip', { force: true });
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    assert.equal(page.url().indexOf('shop.html'), -1, 'must NOT have navigated to shop.html');
  } finally {
    await context.close();
  }
});

// ============================================================================
// BUG 1 fix (tracker item for-product-daily-claim-bugs-founder-rea-kei2ub,
// 2026-07-28): the claim sheet used to show a big "+0" above "Day 1" the
// instant it opened (the reward-amount element was hardcoded to '0' until
// a claim actually succeeded), even though the button correctly already
// said "Claim 20 tokens" — confusing enough that both the founder and a
// real user screenshotted it. Founder directive: match the Duolingo/
// mobile-game daily-reward pattern exactly — show the REAL reward amount
// up front the instant the sheet opens, never a 0 placeholder, and move
// the count-up ritual to the BALANCE (old -> new) after a successful
// claim instead of re-animating the reward amount a second time.
// ============================================================================

test('BUG 1 fix: the claim sheet shows the REAL reward amount the instant it opens -- never a "0" placeholder, even before any claim happens', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // A non-default amount (25, not the usual 20) so this test can't
    // accidentally pass off a hardcoded '20' fallback happening to match —
    // it must be reading the real dailyClaimAmount from tokenStatus.
    await mockTokenStatus(page, { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 25, streak: 3 });
    await seedLoggedInUserAt(page, 'bug1rewardupfront', '/create.html');

    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    // Read the amount immediately on open -- no waitForFunction/settle time
    // given, since the whole point of the fix is that this is correct the
    // instant the sheet opens, with no async count-up needed to reach it.
    var amountOnOpen = await page.textContent('#claim-sheet-amount-num');
    assert.equal(amountOnOpen, '25', 'must show the real reward amount immediately on open, never "0"');
    var btnLabel = await page.textContent('#claim-sheet-btn-label');
    assert.match(btnLabel, /Claim 25 tokens/, 'the button label and the big amount display must agree from the very first frame');

    // The balance count-up display must stay hidden until a claim actually
    // succeeds -- it has nothing to show yet.
    var balanceVisible = await page.evaluate(function () {
      var el = document.getElementById('claim-sheet-balance');
      return el && el.style.display !== 'none';
    });
    assert.equal(balanceVisible, false, 'the balance count-up line must stay hidden until a claim actually succeeds');
  } finally {
    await context.close();
  }
});

test('BUG 1 fix: a successful claim animates the BALANCE (old -> new), not the reward amount a second time', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 3 });
    await mockClaim(page, { claimed: true, balance: 120, streak: 4, nextClaimAt: Date.now() + 72000000 });

    await seedLoggedInUserAt(page, 'bug1balancecountup', '/create.html');
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });

    assert.equal(await page.textContent('#claim-sheet-amount-num'), '20', 'reward amount already correct on open');

    await page.click('#claim-sheet-btn');
    // The balance line becomes visible and counts up to the real post-claim
    // balance (100 + 20 = 120) once the server confirms the claim.
    await page.waitForFunction(function () {
      var el = document.getElementById('claim-sheet-balance');
      var numEl = document.getElementById('claim-sheet-balance-num');
      return el && el.style.display !== 'none' && numEl && numEl.textContent === '120';
    }, { timeout: 3000 });

    // The reward amount display must NOT have been re-animated/reset back
    // through 0 at any point -- it should read exactly the reward amount
    // (20) throughout, never re-counting up a second time on success.
    var amountAfter = await page.textContent('#claim-sheet-amount-num');
    assert.equal(amountAfter, '20', 'the reward amount must stay exactly as shown on open -- the count-up ritual belongs to the balance now, not this element again');
  } finally {
    await context.close();
  }
});

// ============================================================================
// Claim sheet: count-up, server-confirmed completion, streak line, events
// ============================================================================

test('claim sheet: tapping Claim calls the real endpoint, shows the streak line, and fires daily_claim_completed only after the server confirms', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Stateful get-token-status mock (not the shared static mockTokenStatus
    // helper) — this test needs the SECOND read (triggered by the chip's
    // own onClaimed refresh, review finding round 2: the chip's click-to-
    // claim path never used to refresh itself at all) to reflect the
    // post-claim balance/claimable state, proving the refresh is a real
    // server round-trip, not just an assumption.
    var tokenStatusCalls = 0;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      tokenStatusCalls++;
      var status = tokenStatusCalls === 1
        ? { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 2 }
        : { balance: 120, claimable: false, nextClaimAt: Date.now() + 72000000, dailyClaimAmount: 20, streak: 3 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
    });
    var claimCalls = 0;
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      claimCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 120, streak: 3, nextClaimAt: Date.now() + 72000000 }) });
    });

    await seedLoggedInUserAt(page, 'claimsheetflow', '/create.html');
    // The sheet auto-opens on THIS load already (before a posthog spy can
    // be installed, since it fires synchronously off the page's own
    // initial tokenStatus fetch) -- dismiss it, install the spy, then
    // reopen deliberately via the chip so daily_claim_shown is observed
    // fresh, same pattern as every other page-load-then-spy test in this
    // suite.
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });

    await page.evaluate(function () {
      window.__phCalls = [];
      var orig = window.posthog.capture.bind(window.posthog);
      window.posthog.capture = function (name, props) { window.__phCalls.push({ name: name, props: props }); return orig(name, props); };
    });

    await page.click('#topbar-token-chip', { force: true });
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });

    var streakBefore = await page.textContent('#claim-sheet-streak');
    assert.match(streakBefore, /Day 3/, 'shows the NEXT streak number this claim would produce (current 2 + 1)');

    await page.click('#claim-sheet-btn');
    await page.waitForFunction(function () {
      return document.getElementById('claim-sheet-amount-num').textContent === '20';
    }, { timeout: 3000 });

    var streakAfter = await page.textContent('#claim-sheet-streak');
    assert.match(streakAfter, /Day 3/, 'reflects the real server-returned streak once claimed');

    // Sheet auto-closes shortly after a successful claim.
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });

    // Review finding (round 2): a claim triggered by tapping the CHIP
    // itself (not the auto-opened sheet) used to leave the chip stuck
    // showing the stale pre-claim balance and pulsing "claimable" — it had
    // no onClaimed refresh wired up at all, unlike the auto-open path.
    // Confirms the chip actually re-fetches and re-renders off the real
    // post-claim tokenStatus.
    await page.waitForFunction(function () {
      return document.getElementById('topbar-token-chip-balance').textContent.indexOf('120') !== -1;
    }, { timeout: 3000 });
    var chipClaimableAfter = await page.evaluate(function () {
      return document.getElementById('topbar-token-chip').classList.contains('claimable');
    });
    assert.equal(chipClaimableAfter, false, 'the chip must stop pulsing "claimable" once its own click-triggered claim actually lands');
    assert.ok(tokenStatusCalls >= 2, 'the chip must re-fetch getTokenStatus after a successful claim, not just trust the pre-claim cached value');

    assert.ok(claimCalls >= 1, 'the real claim-daily-tokens endpoint was actually called');
    var phCalls = await page.evaluate(function () { return window.__phCalls; });
    var shownCalls = phCalls.filter(function (c) { return c.name === 'daily_claim_shown'; });
    var completedCalls = phCalls.filter(function (c) { return c.name === 'daily_claim_completed'; });
    assert.ok(shownCalls.length >= 1, 'daily_claim_shown fired when the sheet opened');
    assert.equal(completedCalls.length, 1, 'daily_claim_completed fires exactly once, only on the real confirmed response');
    assert.equal(completedCalls[0].props.streak, 3);
    assert.equal(completedCalls[0].props.balance, 120);
  } finally {
    await context.close();
  }
});

test('claim sheet: dismissing while a claim is in flight, then reopening BEFORE the original request resolves, does not corrupt the reopened sheet', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // Review finding (round 3): capturing the triggering opts into a local
  // (round 1's fix) stops a null-deref crash on dismiss-during-flight, but
  // a stale-but-non-null capture could still run its whole success ritual
  // (count-up, confetti, streak text) against — and forcibly auto-close —
  // a DIFFERENT sheet instance the user reopened before the original
  // request settled. This test dismisses while claiming, reopens via the
  // chip (still showing claimable, since nothing has refreshed it yet),
  // lets the ORIGINAL delayed request resolve, and confirms the REOPENED
  // sheet stays open and untouched by it.
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 2 });
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      // Deliberately delayed so the test can dismiss + reopen WHILE this
      // original request is still in flight -- the exact race the fix closes.
      return new Promise(function (resolve) {
        setTimeout(function () {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 120, streak: 3, nextClaimAt: Date.now() + 72000000 }) });
          resolve();
        }, 500);
      });
    });

    await seedLoggedInUserAt(page, 'claimreopen', '/create.html');
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });

    // Tap Claim (kicks off the delayed request), then immediately dismiss.
    await page.click('#claim-sheet-btn');
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });

    // Reopen via the chip (still shows claimable -- nothing has refreshed
    // it yet) BEFORE the original 500ms-delayed request resolves.
    await page.click('#topbar-token-chip', { force: true });
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    var streakOnReopen = await page.textContent('#claim-sheet-streak');
    assert.match(streakOnReopen, /Day 3/, 'reopened sheet starts fresh, showing the next-streak-number for THIS session');

    // Let the ORIGINAL request's delayed response land while the REOPENED
    // sheet is what's actually on screen.
    await page.waitForTimeout(900);

    // The reopened sheet must still be open -- the stale original request
    // must not have force-closed it.
    var stillOpen = await page.evaluate(function () {
      return document.getElementById('claim-sheet-overlay').classList.contains('open');
    });
    assert.ok(stillOpen, 'the REOPENED sheet must still be open -- a stale resolved request from the dismissed instance must not auto-close it');

    // The reopened sheet's own button must still read its normal idle
    // label -- the stale request's "Claimed!"/ritual must not have
    // overwritten it.
    var labelAfter = await page.textContent('#claim-sheet-btn-label');
    assert.match(labelAfter, /Claim \d+ tokens/, 'the reopened sheet\'s button label must not be overwritten by the stale dismissed instance\'s "Claimed!" text');
  } finally {
    await context.close();
  }
});

test('claim sheet: dismissing without claiming fires daily_claim_dismissed, never daily_claim_completed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 0 });
    var claimCalls = 0;
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      claimCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 120, streak: 1, nextClaimAt: Date.now() + 72000000 }) });
    });

    await seedLoggedInUserAt(page, 'claimsheetdismiss', '/create.html');
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });

    await page.evaluate(function () {
      window.__phCalls = [];
      var orig = window.posthog.capture.bind(window.posthog);
      window.posthog.capture = function (name, props) { window.__phCalls.push({ name: name, props: props }); return orig(name, props); };
    });

    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });
    await page.waitForSelector('#claim-sheet-overlay:not(.open)', { timeout: 3000 });

    assert.equal(claimCalls, 0, 'dismissing must never itself trigger a claim -- the real cooldown/guard is server-side only');
    var phCalls = await page.evaluate(function () { return window.__phCalls; });
    var dismissedCalls = phCalls.filter(function (c) { return c.name === 'daily_claim_dismissed'; });
    var completedCalls = phCalls.filter(function (c) { return c.name === 'daily_claim_completed'; });
    assert.equal(dismissedCalls.length, 1);
    assert.equal(completedCalls.length, 0, 'daily_claim_completed must never fire optimistically / on dismiss');
  } finally {
    await context.close();
  }
});

test('claim sheet: a "not yet claimable" server response (lost a race) shows an honest message, no false completion', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 0 });
    await mockClaim(page, { claimed: false, nextClaimAt: Date.now() + 72000000 });

    await seedLoggedInUserAt(page, 'claimsheetrace', '/create.html');
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-btn');

    await page.waitForFunction(function () {
      var el = document.getElementById('claim-sheet-error');
      return el && el.style.display !== 'none' && el.textContent.length > 0;
    }, { timeout: 3000 });
    var errorText = await page.textContent('#claim-sheet-error');
    assert.match(errorText, /already claimed/i);
  } finally {
    await context.close();
  }
});

// Tracker item for-product-bug-founder-repro-high-brand-1dtzdc (founder
// repro, 2026-08-01): a brand-new account's very first claim attempt --
// fired seconds after signup by home.html's auto-open flow -- failed with
// no visible completion and no way to recover; the founder "saw NOTHING"
// and just dismissed the sheet. Root cause (server side): see
// test/entitlements-daily-claim.test.js's own regression test for the
// Blobs read-your-own-write race that silently dropped the signup grant.
// This is the CLIENT-side half of the fix: even a genuinely honest
// `{claimed:false}` response (which is exactly what a client sees on any
// lost race, including a transient one worth retrying) used to leave the
// claim button permanently disabled with only a static "Already claimed"
// message and no way to act on it short of dismissing the whole sheet --
// itself indistinguishable from "nothing happened". This test proves the
// button now re-enables with a real "Try again" retry affordance, and that
// tapping it actually re-fires the claim request (and can still succeed).
test('claim sheet: a "not yet claimable" response re-enables the button with a real "Try again" retry affordance, and retrying can still succeed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 100, streak: 0 });
    var claimCalls = 0;
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      claimCalls++;
      if (claimCalls === 1) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: false, nextClaimAt: Date.now() + 72000000 }) });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claimed: true, balance: 320, streak: 1, nextClaimAt: Date.now() + 72000000, amountClaimed: 100 }) });
      }
    });

    await seedLoggedInUserAt(page, 'claimretryaffordance', '/create.html');
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-btn');

    await page.waitForFunction(function () {
      var el = document.getElementById('claim-sheet-error');
      return el && el.style.display !== 'none' && el.textContent.length > 0;
    }, { timeout: 3000 });

    // The button must be a real, clickable retry affordance now -- not
    // stuck disabled with a dead-end message.
    var afterFirstAttempt = await page.evaluate(function () {
      return {
        disabled: document.getElementById('claim-sheet-btn').disabled,
        label: document.getElementById('claim-sheet-btn-label').textContent
      };
    });
    assert.equal(afterFirstAttempt.disabled, false, 'the button must be re-enabled, not left permanently disabled');
    assert.match(afterFirstAttempt.label, /try again/i);

    // Tapping it again must genuinely retry -- calling the real endpoint a
    // second time -- and a claim that now succeeds must complete normally.
    await page.click('#claim-sheet-btn');
    await page.waitForFunction(function () {
      var numEl = document.getElementById('claim-sheet-balance-num');
      return numEl && numEl.textContent === '320';
    }, { timeout: 3000 });
    assert.equal(claimCalls, 2, 'the retry tap must have fired a genuine second request to the claim endpoint');
  } finally {
    await context.close();
  }
});

// ============================================================================
// Auto-open once per day (localStorage presentation throttle only)
// ============================================================================

test('claim sheet auto-opens on first eligible page load when claimable, but not again on a second load the same day', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 0 });
    await seedLoggedInUserAt(page, 'autoopenonce', '/create.html');

    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } }); // dismiss without claiming

    // A second navigation to a page that also mounts the chip, same
    // browser/localStorage -- must NOT auto-open again today. The chip
    // remains the fallback entry point.
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' }).catch(function () {});
    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#topbar-token-chip', { timeout: 5000 });
    await page.waitForTimeout(400);

    var sheetOpenAgain = await page.evaluate(function () {
      var el = document.getElementById('claim-sheet-overlay');
      return !!(el && el.classList.contains('open'));
    });
    assert.equal(sheetOpenAgain, false, 'must not auto-open a second time the same day -- the chip is the fallback now');
  } finally {
    await context.close();
  }
});

test('the auto-open marker is a PURE presentation throttle -- claimable state (and the ability to actually claim) survives even when auto-open is suppressed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 0 });
    await seedLoggedInUserAt(page, 'presentationonly', '/create.html');
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-overlay', { position: { x: 5, y: 5 } });

    // Simulate "already auto-shown today" directly, then reload -- the
    // sheet must not auto-open, but the CHIP must still show the claimable
    // pulsing state and still work as a manual entry point.
    await page.evaluate(function () {
      localStorage.setItem('dreamtube_claim_sheet_shown_date', new Date().toDateString());
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#topbar-token-chip', { timeout: 5000 });
    await page.waitForTimeout(300);

    var autoOpened = await page.evaluate(function () {
      var el = document.getElementById('claim-sheet-overlay');
      return !!(el && el.classList.contains('open'));
    });
    assert.equal(autoOpened, false);

    var isClaimable = await page.evaluate(function () {
      return document.getElementById('topbar-token-chip').classList.contains('claimable');
    });
    assert.equal(isClaimable, true, 'the presentation throttle must never affect the real claimable state');

    await page.click('#topbar-token-chip', { force: true }); // see the identical force:true note above -- the pulsing animation never "stabilizes"
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
  } finally {
    await context.close();
  }
});

// ============================================================================
// explore.html: the one page that was missing the chip entirely
// ============================================================================

test('explore.html: the token chip is mounted in the topbar for a signed-in visitor, and pulses when claimable', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await mockTokenStatus(page, { balance: 100, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 20, streak: 0 });
    await seedLoggedInUserAt(page, 'exploretokenchip', '/explore.html');
    await page.waitForSelector('#explore-token-chip-slot .token-chip-compact', { timeout: 5000 });

    var isClaimable = await page.evaluate(function () {
      var chip = document.querySelector('#explore-token-chip-slot .token-chip-compact');
      return chip && chip.classList.contains('claimable');
    });
    assert.equal(isClaimable, true);
  } finally {
    await context.close();
  }
});

test('explore.html: no chip is mounted at all for a logged-out visitor (no account balance to show)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    var chipHtml = await page.evaluate(function () {
      var slot = document.getElementById('explore-token-chip-slot');
      return slot ? slot.innerHTML.trim() : null;
    });
    assert.equal(chipHtml, '', 'the slot must stay empty for a logged-out visitor');
  } finally {
    await context.close();
  }
});

// ============================================================================
// Copy sweep: the old "automatic daily grant" promise must be gone
// ============================================================================

test('copy sweep: shop.html no longer promises tokens "refill" automatically or mentions a banked ceiling anywhere on the page', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 100, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedLoggedInUserAt(page, 'shopcopysweep', '/shop.html');
    await page.waitForSelector('#shop-cap-note:not(:empty)', { timeout: 5000 });

    var bodyText = await page.textContent('body');
    assert.doesNotMatch(bodyText, /refill(s|ed|ing)? daily/i, 'the old "refill daily" automatic-grant framing must be gone');
    assert.doesNotMatch(bodyText, /banked/i, 'the retired ceiling concept ("up to N banked") must be gone');
    assert.doesNotMatch(bodyText, /capped/i, 'the retired "tokens are capped" framing must be gone');
  } finally {
    await context.close();
  }
});

// The token-meta half of this sweep went away with the meta line itself:
// profile.html's chip is js/purchase-sheet.js's PLAIN variant now (balance
// + Shop link, no daily-token copy of any kind), per the founder-approved
// night restyle -- tracker item
// for-product-build-founder-approved-2026--to6ew2. The FAQ half below is
// unchanged and is the longest-lived piece of daily-token copy in the app,
// so it stays exactly as it was.
test('copy sweep: profile.html\'s FAQ never says tokens arrive "automatically"/"every day" in the daily-token context', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 500, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await seedLoggedInUserAt(page, 'profilecopysweep', '/profile.html');
    await page.waitForSelector('#account-btn', { timeout: 5000 });

    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open', { timeout: 5000 });
    var faqQuestion = page.locator('.faq-question', { hasText: 'How do tokens work?' });
    await faqQuestion.click();
    await page.waitForTimeout(150);
    var faqAnswer = await page.locator('.faq-answer').nth(1).textContent();
    assert.doesNotMatch(faqAnswer, /every day automatically/i);
    assert.match(faqAnswer, /claim/i);
  } finally {
    await context.close();
  }
});

test('copy sweep: the out-of-tokens sheet\'s wait line never says "wait" (the old grant-framed escape line) -- always "claim"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 5, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 });
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@waitlinesweep', username: 'waitlinesweep' };
      if (!state.accounts) state.accounts = {};
      state.accounts.waitlinesweep = { password: 'testpass1', email: 'waitlinesweep@example.com' };
      state.draft = Object.assign({}, state.draft, { caption: 'A dream about flying', style: null, mediaType: null, sourceImageUrl: null });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/style.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });
    await page.waitForTimeout(200);
    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');
    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });

    var waitLine = await page.textContent('#ps-wait-line');
    assert.doesNotMatch(waitLine, /\bwait\b/i, 'the old "Or wait —" grant-framed phrasing must be entirely gone');
    assert.match(waitLine, /claim/i);
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2026-07-28 first-claim-bonus amendment (founder-approved, tracker item
// for-product-daily-claim-bugs-founder-rea-kei2ub): a first-ever claimer's
// dailyClaimAmount is 100, not 20. These prove the claim sheet's big
// number, its button label, its error-recovery label, and the topbar
// chip's "+N" pill all show the REAL server-reported 100 -- never a
// hardcoded 20 -- confirming js/purchase-sheet.js's existing
// `!= null ? amount : 20` fallback pattern is genuinely reading the live
// field, not coincidentally matching a stale literal.
// ============================================================================

test('first-claim bonus: the claim sheet shows 100 (not 20) up front, and the topbar chip pill also shows +100, when the server reports dailyClaimAmount: 100', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 100, streak: 0 });
    await seedLoggedInUserAt(page, 'firstclaimbonusui', '/create.html');

    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    assert.equal(await page.textContent('#claim-sheet-amount-num'), '100', 'the claim sheet\'s big reward number must show the real 100 first-claim bonus, never a hardcoded 20');
    assert.match(await page.textContent('#claim-sheet-btn-label'), /Claim 100 tokens/);

    var plusText = await page.textContent('.token-chip-plus');
    assert.equal(plusText.trim(), '+100', 'the topbar chip pill must also show the real +100, not +20');
  } finally {
    await context.close();
  }
});

test('first-claim bonus: a successful 100-token claim animates the balance from 220 to 320', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 100, streak: 0 });
    await mockClaim(page, { claimed: true, balance: 320, streak: 1, nextClaimAt: Date.now() + 72000000, amountClaimed: 100 });

    await seedLoggedInUserAt(page, 'firstclaimbonusclaim', '/create.html');
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-btn');

    await page.waitForFunction(function () {
      var el = document.getElementById('claim-sheet-balance');
      var numEl = document.getElementById('claim-sheet-balance-num');
      return el && el.style.display !== 'none' && numEl && numEl.textContent === '320';
    }, { timeout: 3000 });
  } finally {
    await context.close();
  }
});

test('first-claim bonus: a failed claim restores the button label to "Claim 100 tokens", not a stale hardcoded 20', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: true, nextClaimAt: Date.now() - 1000, dailyClaimAmount: 100, streak: 0 });
    // A malformed/error response (data.error present) is what js/store.js's
    // claimDailyTokens throws on, driving purchase-sheet.js's runClaim()
    // into its .catch() branch -- see that function's own doc comment.
    await page.route('**/.netlify/functions/claim-daily-tokens', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E5: claim_write_failed' }) });
    });

    await seedLoggedInUserAt(page, 'firstclaimbonuserror', '/create.html');
    await page.waitForSelector('#claim-sheet-overlay.open', { timeout: 3000 });
    await page.click('#claim-sheet-btn');

    await page.waitForFunction(function () {
      var el = document.getElementById('claim-sheet-error');
      return el && el.style.display !== 'none' && el.textContent.length > 0;
    }, { timeout: 3000 });
    var label = await page.textContent('#claim-sheet-btn-label');
    assert.match(label, /Claim 100 tokens/, 'the error-recovery label must restore the real 100 amount, never fall back to a hardcoded 20');
  } finally {
    await context.close();
  }
});
