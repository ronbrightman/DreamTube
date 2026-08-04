// test/shop-checkout-confirmation-behavioral.test.js
//
// Real browser-driven coverage for shop.html's post-checkout confirmation
// banner (#shop-checkout-banner) — tracker item
// for-product-webhook-p0-reframed-by-found-peytt8.
//
// ---------------------------------------------------------------------
// The bug this exists to hold closed
// ---------------------------------------------------------------------
// The founder made a real $1.99/500-token purchase and reported "no
// completion". His own diagnostic run (dodo-x7q4.html) then proved the
// payment pipeline was fine: payment pay_0NkXX was credited 500 tokens
// **36 seconds** after payment, by dodo-webhook.js, exactly as designed.
// The failure was entirely in what shop.html told him on the way back:
//
//   * a 2.2-second toast ("your tokens will appear shortly") — gone long
//     before any credit could plausibly land;
//   * a re-poll of the balance that stopped after 5 attempts at 3s, i.e.
//     **15 seconds** — less than half the 36s his real credit took, so it
//     had already given up before the tokens arrived;
//   * no baseline and no expected amount, so even a credit landing inside
//     that 15s window produced no confirmation at all — the balance
//     number just quietly changed.
//
// So the tests here are about TIMING and PROOF, not about a toast string:
// the confirmation must (1) outlast a webhook slower than the old 15s
// ceiling, (2) never claim success before the credit provably landed,
// (3) report the actual credited amount and resulting balance, and
// (4) resolve into an explicit, retryable state if the window really does
// elapse — never a silent stall.
//
// Tests 10-12 hold closed a second, subtler failure of (2) that review
// found in the FIRST version of that fix: when neither pre-credit baseline
// was available (a marker with no `balanceBefore` AND a failed arrival
// read), the threshold silently fell back to a bare pack size, which any
// repeat buyer's existing balance already satisfies. See test 10's own
// header for the full mechanics.
//
// Conventions follow test/shop-behavioral.test.js and
// test/shop-purchase-conversion-behavioral.test.js (Playwright over the
// shared static server, self-skipping if Chromium isn't resolvable,
// page.route() for every Netlify Function since none run locally). The
// window.__TEST_POLL_OVERRIDES__ shrink of PurchaseSheet.pollForCredit's
// real 3s/75s window is the same override object
// test/out-of-tokens-purchase-sheet-behavioral.test.js already uses for
// home.html's copy of this poll — with ONE deliberate exception, the
// real-timing regression test below, which runs against the real
// unshrunk window precisely because the window's real length IS the bug.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settleHelpers = require('./helpers/settle');
var settle = settleHelpers.settle;
var gate = settleHelpers.gate;

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

/**
 * A get-token-status mock whose answer can change mid-test — this is the
 * whole point of these tests, since the real bug is a race between the
 * browser landing back here and dodo-webhook.js's asynchronous credit.
 *
 * Returns a handle: `.setBalance(n)` flips what every SUBSEQUENT read
 * returns (i.e. "the webhook just landed"), and `.calls` counts reads so
 * a test can prove the poll really did stop when it was supposed to.
 */
async function mockTokenStatus(page, initialBalance) {
  var state = {
    balance: initialBalance,
    calls: 0,
    setBalance: function (n) { state.balance = n; }
  };
  await page.route('**/.netlify/functions/get-token-status*', function (route) {
    state.calls++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        balance: state.balance,
        claimable: false,
        nextClaimAt: Date.now() + 3600000,
        dailyClaimAmount: 20,
        streak: 0,
        hasMadeFirstPurchase: true
      })
    });
  });
  return state;
}

/** Logs a shopper account into localStorage — same seed shape every other shop suite uses. */
async function seedAccount(page) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@shopper', username: 'shopper' };
    if (!state.accounts) state.accounts = {};
    state.accounts.shopper = { password: 'testpass1', email: 'shopper@example.com' };
    if (!state.dreams) state.dreams = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

/**
 * Shrinks PurchaseSheet.pollForCredit's real 3s/75s window for the tests
 * that aren't specifically about its real length. Must be installed on
 * the CONTEXT (addInitScript) so it exists before shop.html's own inline
 * script runs on the success load.
 */
function shrinkPollWindow(context, intervalMs, maxMs) {
  return context.addInitScript(function (o) {
    window.__TEST_POLL_OVERRIDES__ = o;
  }, { intervalMs: intervalMs, maxMs: maxMs });
}

/** Writes the dreamtube_pending_purchase marker purchasePack() sets right before the outbound redirect to Dodo. Must run on a page already on this origin. */
function markPendingPurchase(page, info) {
  return page.evaluate(function (o) {
    sessionStorage.setItem('dreamtube_pending_purchase', JSON.stringify(o));
  }, info);
}

/** The real founder purchase this bug came from: pack199, $1.99, 500 tokens. */
function founderMarker(balanceBefore) {
  return { pack: 'pack199', tokens: 500, price: 1.99, starter: false, eventId: 'evt-confirm-test', balanceBefore: balanceBefore };
}

function bannerState(page) {
  return page.evaluate(function () {
    var el = document.getElementById('shop-checkout-banner');
    if (!el || el.style.display === 'none') return null;
    return {
      cls: el.className,
      title: document.getElementById('shop-checkout-banner-title').textContent,
      sub: document.getElementById('shop-checkout-banner-sub').textContent,
      actionVisible: document.getElementById('shop-checkout-banner-action').style.display !== 'none',
      actionLabel: document.getElementById('shop-checkout-banner-action').textContent
    };
  });
}

// ===========================================================================
// 1. THE ACTUAL RACE: the webhook lands AFTER the buyer is already back.
//    This is the founder's exact scenario, just compressed in time.
// ===========================================================================
test('the webhook landing AFTER the redirect resolves into a genuine "500 tokens added" confirmation carrying the real credited amount and resulting balance', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 150, 20000);
    var page = await context.newPage();
    await blockThirdParty(page);
    var tokens = await mockTokenStatus(page, 50);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, founderMarker(50));
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    // Phase 1 — before the webhook lands, the page must be honest: it is
    // CONFIRMING, not confirmed. This is the half the old toast+15s-poll
    // got wrong by omission (it said nothing at all after 2.2s).
    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });
    var pending = await bannerState(page);
    assert.match(pending.title, /payment received/i);
    assert.match(pending.sub, /confirming your 500 tokens/i);
    assert.doesNotMatch(pending.title + ' ' + pending.sub, /tokens added/i, 'the pending state must never claim tokens were added before the webhook has landed');
    assert.equal(pending.actionVisible, false, 'no recovery button while the poll is genuinely still running');

    // Let several poll rounds go by with the balance genuinely unchanged —
    // the credit really has not landed yet, and nothing may claim it has.
    await settle(function () { return tokens.calls >= 4; }, { timeout: 5000 });
    assert.equal((await bannerState(page)).cls.indexOf('is-pending') !== -1, true, 'still pending while the balance is genuinely unchanged');

    // Phase 2 — dodo-webhook.js credits the 500 tokens, server-side,
    // asynchronously, exactly as it really did 36s after the founder paid.
    tokens.setBalance(550);

    await page.waitForSelector('#shop-checkout-banner.is-confirmed', { state: 'visible', timeout: 10000 });
    var confirmed = await bannerState(page);
    assert.match(confirmed.title, /500 tokens added/, 'the confirmation must name the actual credited amount, not a vague "all set"');
    assert.match(confirmed.sub, /balance is now 550/, 'the confirmation must show the real resulting balance');

    // ...and the page's own balance surfaces must agree with it — the
    // founder's complaint was that his balance updated "silently", with
    // the UI never reconciling to it.
    assert.equal(await page.textContent('#shop-balance'), '550');
    assert.equal(await page.textContent('#shop-topbar-balance'), '550');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 2. REAL-TIMING REGRESSION on the exact root cause: the poll window used
//    to stop at 15 seconds, and the founder's real credit took 36. This
//    test deliberately does NOT shrink the window — the window's real
//    length is the thing under test — and credits at 20 seconds, past the
//    old ceiling and well inside the real 75s one.
// ===========================================================================
test('a webhook slower than the OLD 15-second poll ceiling (credited at ~20s) is still confirmed — the regression that produced the founder\'s "no completion"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  t.diagnostic('runs against the REAL 3s/75s poll window on purpose — takes ~20s');
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var tokens = await mockTokenStatus(page, 50);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, founderMarker(50));
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });

    // Still looking well past where the old implementation stopped.
    await page.waitForTimeout(20000);
    var callsAt20s = tokens.calls;
    assert.equal((await bannerState(page)).cls.indexOf('is-pending') !== -1, true, 'the banner must still be actively confirming 20s in — the old 5-attempt/15s poll had already stopped by here');

    tokens.setBalance(550);
    await page.waitForSelector('#shop-checkout-banner.is-confirmed', { state: 'visible', timeout: 15000 });
    assert.ok(tokens.calls > callsAt20s, 'the poll must genuinely still have been reading get-token-status past 20s, not confirming off a stale value');
    assert.match((await bannerState(page)).title, /500 tokens added/);
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 3. The OPPOSITE race — the webhook wins, crediting before the browser
//    even gets back. A naive "wait for the balance to increase from what I
//    see now" would stall here forever on a purchase that was already fine.
// ===========================================================================
test('a webhook that already credited BEFORE the buyer landed back confirms immediately off the pre-checkout baseline, instead of waiting for an increase that can never come', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 150, 4000);
    var page = await context.newPage();
    await blockThirdParty(page);
    // Already 550 on arrival: the credit landed while the buyer was still
    // on Dodo's checkout page.
    var tokens = await mockTokenStatus(page, 550);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, founderMarker(50));
    // Counted from the success navigation onward — the plain shop.html
    // visit above does its own ordinary balance read, which has nothing to
    // do with the confirmation path under test.
    var callsBeforeReturn = tokens.calls;
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-confirmed', { state: 'visible', timeout: 5000 });
    var confirmed = await bannerState(page);
    assert.match(confirmed.title, /500 tokens added/);
    assert.match(confirmed.sub, /balance is now 550/);
    // The success load makes exactly three reads on this path — the page's
    // own loadBalance(), the confirmation's arrival read, and
    // pollForCredit's first (immediately satisfied) poll. Grinding the
    // whole shrunk window here would be ~26.
    var returnCalls = tokens.calls - callsBeforeReturn;
    assert.ok(returnCalls <= 3, 'this must resolve on the arrival read, not grind through the whole poll window (observed ' + returnCalls + ' reads on the return load)');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 4. A stale-high pre-checkout baseline (tokens spent from another device
//    since this page last refreshed) must not push the confirmation target
//    out of reach — the arrival read is the second, independent baseline
//    that keeps this honest. This is what the Math.min() of the two is for.
// ===========================================================================
test('a stale-high balanceBefore in the marker does not create an unreachable target — the arrival read keeps the confirmation honest', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 150, 20000);
    var page = await context.newPage();
    await blockThirdParty(page);
    // True pre-purchase balance is 50; the marker's own stashed value is
    // stale-high at 200 (tokens were spent elsewhere after this page's
    // last refresh). Naively targeting 200 + 500 = 700 would never be
    // reached by a real 500-token credit landing on 50.
    var tokens = await mockTokenStatus(page, 50);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, founderMarker(200));
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });
    tokens.setBalance(550);

    await page.waitForSelector('#shop-checkout-banner.is-confirmed', { state: 'visible', timeout: 10000 });
    assert.match((await bannerState(page)).sub, /balance is now 550/);
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 5. FALSE-POSITIVE GUARD: an unrelated balance change must not be mistaken
//    for the purchase landing. The largest possible daily claim is 100
//    (lib/entitlements.js's FIRST_CLAIM_BONUS_AMOUNT) and the smallest pack
//    is 300, so no claim can satisfy a pack-sized threshold on its own.
// ===========================================================================
test('a daily claim landing mid-window (+100) never fakes a purchase confirmation — only a full pack-sized credit counts', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 3000);
    var page = await context.newPage();
    await blockThirdParty(page);
    var tokens = await mockTokenStatus(page, 50);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, founderMarker(50));
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });
    // A first-ever daily claim lands in another tab: +100, not the pack.
    tokens.setBalance(150);

    // Ride the whole (shrunk) window out — this must NOT confirm.
    await page.waitForSelector('#shop-checkout-banner.is-unconfirmed', { state: 'visible', timeout: 10000 });
    var state = await bannerState(page);
    assert.equal(state.cls.indexOf('is-confirmed'), -1, 'a +100 claim must never be reported as the 500-token purchase landing');
    assert.doesNotMatch(state.title + ' ' + state.sub, /tokens added/i);
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 6. The timeout must be an explicit, RETRYABLE resolution — not the silent
//    give-up the old 5-attempt setInterval was.
// ===========================================================================
test('a genuinely elapsed poll window resolves into a visible, retryable "still confirming" state, and Check again re-runs it to a real confirmation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 2500);
    var page = await context.newPage();
    await blockThirdParty(page);
    var tokens = await mockTokenStatus(page, 50);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, founderMarker(50));
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-unconfirmed', { state: 'visible', timeout: 10000 });
    var timedOut = await bannerState(page);
    assert.notEqual(timedOut, null, 'the banner must still be on screen after the window elapses — never silently gone');
    assert.match(timedOut.title, /still confirming/i);
    assert.match(timedOut.sub, /payment went through/i, 'the buyer must be told their money is fine, not left guessing');
    assert.equal(timedOut.actionVisible, true, 'the timeout state must offer a real next step');
    assert.match(timedOut.actionLabel, /check again/i);

    // The webhook finally lands (a genuinely slow one, or a Dodo retry) —
    // the offered next step must actually work, not be decorative.
    tokens.setBalance(550);
    await page.click('#shop-checkout-banner-action');
    await page.waitForSelector('#shop-checkout-banner.is-confirmed', { state: 'visible', timeout: 10000 });
    assert.match((await bannerState(page)).title, /500 tokens added/);
    assert.equal(await page.textContent('#shop-balance'), '550');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 7. Analytics: the two events that make real webhook latency measurable
//    from production, instead of only discoverable by a founder hitting it.
// ===========================================================================
test('purchase_credit_confirmed fires once with the real waited_ms, and purchase_credit_unconfirmed fires on a genuinely elapsed window', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 2500);
    var page = await context.newPage();
    await blockThirdParty(page);
    var tokens = await mockTokenStatus(page, 50);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, founderMarker(50));
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    // Window elapses first — the unconfirmed event must carry how long we
    // actually waited before giving the buyer the retry affordance.
    await page.waitForSelector('#shop-checkout-banner.is-unconfirmed', { state: 'visible', timeout: 10000 });
    var unconfirmed = await page.evaluate(function () {
      var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
      return queue.filter(function (e) { return e[0] === 'capture' && e[1] === 'purchase_credit_unconfirmed'; });
    });
    assert.equal(unconfirmed.length, 1, 'exactly one purchase_credit_unconfirmed for one elapsed window');
    assert.equal(unconfirmed[0][2].pack, 'pack199');
    assert.equal(unconfirmed[0][2].tokens, 500);
    assert.ok(unconfirmed[0][2].waited_ms >= 2000, 'waited_ms must be the real elapsed wait, got ' + unconfirmed[0][2].waited_ms);
    assert.equal(unconfirmed[0][2].reason, 'timeout', 'the ordinary case — a real baseline existed, the credit just never cleared it — must be distinguishable from the no-baseline one (see test 12)');

    tokens.setBalance(550);
    await page.click('#shop-checkout-banner-action');
    await page.waitForSelector('#shop-checkout-banner.is-confirmed', { state: 'visible', timeout: 10000 });

    var confirmed = await page.evaluate(function () {
      var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
      return queue.filter(function (e) { return e[0] === 'capture' && e[1] === 'purchase_credit_confirmed'; });
    });
    assert.equal(confirmed.length, 1, 'purchase_credit_confirmed must fire exactly once per purchase, not once per retry attempt');
    assert.equal(confirmed[0][2].pack, 'pack199');
    assert.equal(confirmed[0][2].tokens, 500);
    assert.equal(confirmed[0][2].balance, 550);
    assert.equal(confirmed[0][2].attempt, 2, 'the confirming attempt number is carried so a retry-heavy webhook is visible in the data');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 8. Scope hygiene — the recurring bug class this repo has been bitten by
//    repeatedly (an async callback's side effects outliving the thing that
//    started it). Dismissing the banner must stop the poll behind it.
// ===========================================================================
test('dismissing the banner cancels the poll behind it — no background reads, and no repaint of a banner the user closed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 30000);
    var page = await context.newPage();
    await blockThirdParty(page);
    var tokens = await mockTokenStatus(page, 50);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, founderMarker(50));
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });
    await settle(function () { return tokens.calls >= 3; }, { timeout: 5000 });

    await page.click('#shop-checkout-banner-close');
    assert.equal(await page.isVisible('#shop-checkout-banner'), false);

    var callsAtDismiss = tokens.calls;
    // Even if the credit lands right after the dismiss, nothing may come
    // back on screen or keep polling.
    tokens.setBalance(550);
    await page.waitForTimeout(1200);

    assert.equal(tokens.calls, callsAtDismiss, 'the poll must stop on dismiss, not keep reading get-token-status in the background (was ' + callsAtDismiss + ', now ' + tokens.calls + ')');
    assert.equal(await page.isVisible('#shop-checkout-banner'), false, 'a dismissed banner must never repaint itself from a poll callback');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 8b. The same scope-hygiene question one step earlier in the sequence, in
//     the one window where cancelling the poll is not enough to be safe:
//     the arrival read is still in flight, so there IS no poll to cancel
//     yet — and the read's own continuation is what would go on to start
//     one. Guarded by attempt id, not by cancelling.
// ===========================================================================
test('dismissing while the arrival read is still in flight leaves nothing behind — the superseded attempt never starts a poll or repaints', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 30000);
    var page = await context.newPage();
    await blockThirdParty(page);

    var held = gate();
    var requests = 0;
    var balance = 50;
    await page.route('**/.netlify/functions/get-token-status*', async function (route) {
      requests++;
      await held.wait(); // every read hangs until the test says otherwise
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ balance: balance, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0, hasMadeFirstPurchase: true })
      });
    });

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      sessionStorage.setItem('dreamtube_pending_purchase', JSON.stringify({ pack: 'pack199', tokens: 500, price: 1.99, starter: false, eventId: 'e', balanceBefore: 50 }));
    });
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    // The pending banner is rendered synchronously, before the arrival
    // read has resolved -- which is exactly the window under test.
    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });
    await page.click('#shop-checkout-banner-close');
    assert.equal(await page.isVisible('#shop-checkout-banner'), false);

    var requestsAtDismiss = requests;
    // Now let the in-flight reads land, with the credit having arrived --
    // the most tempting possible moment for a superseded attempt to
    // "helpfully" resume.
    balance = 550;
    held.open();
    await page.waitForTimeout(1500);

    assert.equal(requests, requestsAtDismiss, 'the superseded attempt must not start a poll after the dismiss (was ' + requestsAtDismiss + ', now ' + requests + ')');
    assert.equal(await page.isVisible('#shop-checkout-banner'), false, 'a dismissed banner must never be repainted by a read that was already in flight');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 9. The marker-less return (private-mode sessionStorage, cross-device, or
//    a hand-typed URL): the page must not invent a payment it cannot prove,
//    and must still resolve rather than stall.
// ===========================================================================
test('a marker-less ?checkout=success neither claims a payment happened nor stalls — it resolves into an honest, retryable state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 2000);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, 50);

    await seedAccount(page);
    // Deliberately no markPendingPurchase — nothing here can prove a real
    // checkout ever happened in this browser.
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });
    var pending = await bannerState(page);
    assert.match(pending.title, /checking for your tokens/i);
    assert.doesNotMatch(pending.title + ' ' + pending.sub, /payment received/i, 'with no marker the page must not assert a payment it cannot support');

    await page.waitForSelector('#shop-checkout-banner.is-unconfirmed', { state: 'visible', timeout: 10000 });
    var timedOut = await bannerState(page);
    assert.match(timedOut.title, /no new tokens yet/i);
    assert.doesNotMatch(timedOut.sub, /payment went through/i, 'a return with no evidence of a purchase must not tell someone their payment went through');
    assert.equal(timedOut.actionVisible, true);
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 10. THE DOUBLE-NULL BASELINE — the false positive round-1 review found in
//     the first version of this fix.
//
//     Both pre-credit reference points can be missing at once, for real:
//
//       * `balanceBefore` is null whenever the buy button is clicked before
//         the page's own loadBalance() has resolved — the buttons are wired
//         at load and never gated on that read, so a fast tap stashes a
//         marker with no baseline in it;
//       * `arrivalBalance` is null when the return-trip get-token-status
//         read fails (a transient blip is exactly the kind of thing that
//         happens on a redirect back from an external checkout host).
//
//     The first version of this fix answered "no baseline" with "baseline
//     = 0", collapsing the threshold to a bare `packTokens` — which asks
//     only "is this balance at least one pack big?". Any REPEAT buyer (the
//     precise population buying a second pack) already answers yes, so the
//     very next poll tick painted an unearned "✦ 500 tokens added" for a
//     purchase nothing had credited. This test holds that closed.
// ===========================================================================
test('a double-null baseline (no balanceBefore in the marker AND a failed arrival read) never confirms off the pack size alone — a repeat buyer already holding 800 tokens gets no unearned confirmation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 6000);
    var page = await context.newPage();
    await blockThirdParty(page);

    // A repeat buyer sitting on 800 tokens — comfortably MORE than the
    // 500-token pack they just bought, which is the whole trap: a bare
    // `packTokens` threshold is already satisfied before anything lands.
    // Nothing in this test ever credits them; the balance stays 800.
    var reads = 0;
    var failing = true;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      reads++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // js/store.js's getTokenStatus rejects on an `error` payload — the
        // same shape a real get-token-status failure surfaces as.
        body: failing
          ? JSON.stringify({ error: 'E-transient-test' })
          : JSON.stringify({ balance: 800, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0, hasMadeFirstPurchase: true })
      });
    });

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });
    // The fast-click marker: a real pack, but NO balanceBefore, because
    // purchasePack() stashed it before this page's first balance read had
    // resolved.
    await page.evaluate(function () {
      sessionStorage.setItem('dreamtube_pending_purchase', JSON.stringify({ pack: 'pack199', tokens: 500, price: 1.99, starter: false, eventId: 'evt-double-null', balanceBefore: null }));
    });
    reads = 0;
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });
    // Three reads on this load means the page's own loadBalance AND the
    // confirmation's arrival read have both genuinely failed, and the
    // confirmation has moved on to whatever it does next — i.e. we are
    // provably inside the double-null case, not merely near it.
    await settle(function () { return reads >= 3; }, { timeout: 5000 });

    // The network recovers, reporting this buyer's real, UNCHANGED 800.
    // Under the pre-fix threshold (0 + 500) this single read is enough to
    // paint "✦ 500 tokens added" on the spot.
    failing = false;

    // Deliberately waits for EITHER terminal state, not just the correct
    // one — so the pre-fix code fails this test by loudly reporting the
    // false "500 tokens added" it painted, rather than by timing out on a
    // selector that never appears.
    await page.waitForSelector('#shop-checkout-banner.is-confirmed, #shop-checkout-banner.is-unconfirmed', { state: 'visible', timeout: 20000 });
    var resolved = await bannerState(page);
    assert.equal(resolved.cls.indexOf('is-confirmed'), -1, 'a balance that merely happens to exceed the pack size must never be read as this purchase landing — banner resolved as: ' + resolved.cls + ' / "' + resolved.title + '"');
    assert.doesNotMatch(resolved.title + ' ' + resolved.sub, /tokens added/i, 'no unearned "tokens added" claim with no baseline to prove it against');
    assert.match(resolved.title, /still confirming/i, 'the honest posture is "we cannot show you it landed yet", with a way to look again');
    assert.equal(resolved.actionVisible, true, 'and it must stay retryable, not a dead end');

    var events = await page.evaluate(function () {
      var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
      return queue.filter(function (e) { return e[0] === 'capture' && (e[1] === 'purchase_credit_confirmed' || e[1] === 'purchase_credit_unconfirmed'); }).map(function (e) { return { name: e[1], props: e[2] }; });
    });
    assert.equal(events.filter(function (e) { return e.name === 'purchase_credit_confirmed'; }).length, 0, 'purchase_credit_confirmed must never fire for a credit that was never observed — this event feeds the webhook-latency read, and a false one poisons it');
    assert.ok(events.some(function (e) { return e.name === 'purchase_credit_unconfirmed'; }), 'the unconfirmed outcome must still be reported, not silently swallowed');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 11. The other half of #10: refusing to guess must not mean refusing to
//     confirm. A transient arrival-read failure is usually just a blip, so
//     the baseline read is retried inside the same window — and once a real
//     baseline lands, a real credit on top of it still confirms normally.
//     Without this, "never a false positive" could be trivially satisfied
//     by never confirming anything.
// ===========================================================================
test('a transient arrival-read failure recovers: the retried read becomes the real baseline, and a genuine credit on top of it still confirms', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 20000);
    var page = await context.newPage();
    await blockThirdParty(page);

    var reads = 0;
    var failing = true;
    var balance = 800;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      reads++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: failing
          ? JSON.stringify({ error: 'E-transient-test' })
          : JSON.stringify({ balance: balance, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0, hasMadeFirstPurchase: true })
      });
    });

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      sessionStorage.setItem('dreamtube_pending_purchase', JSON.stringify({ pack: 'pack199', tokens: 500, price: 1.99, starter: false, eventId: 'evt-recover', balanceBefore: null }));
    });
    reads = 0;
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-pending', { state: 'visible', timeout: 5000 });
    await settle(function () { return reads >= 3; }, { timeout: 5000 });

    // Network back; the pre-credit balance (800) is now readable and
    // becomes the baseline this purchase is measured against.
    failing = false;
    var readsAtRecovery = reads;
    await settle(function () { return reads >= readsAtRecovery + 2; }, { timeout: 5000 });
    assert.equal((await bannerState(page)).cls.indexOf('is-pending') !== -1, true, 'still honestly pending on a recovered-but-uncredited balance');

    // dodo-webhook.js credits the 500 tokens on top of that real baseline.
    balance = 1300;

    await page.waitForSelector('#shop-checkout-banner.is-confirmed', { state: 'visible', timeout: 20000 });
    var confirmed = await bannerState(page);
    assert.match(confirmed.title, /500 tokens added/, 'a real credit above a recovered baseline still confirms with the real amount');
    assert.match(confirmed.sub, /balance is now 1300/);
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 12. The terminal case of #10: get-token-status is unreachable for the
//     WHOLE window, so no baseline ever becomes establishable. There is
//     nothing honest to confirm against, so the page must resolve into the
//     same explicit retryable state a timeout produces — and say so in the
//     data, since "the balance endpoint was down" is a different production
//     signal from "the webhook was slow".
// ===========================================================================
test('a window that never yields any baseline at all resolves into the retryable state and reports reason:no_baseline, never a confirmation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await shrinkPollWindow(context, 120, 1500);
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'E-down-test' }) });
    });

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      sessionStorage.setItem('dreamtube_pending_purchase', JSON.stringify({ pack: 'pack199', tokens: 500, price: 1.99, starter: false, eventId: 'evt-no-baseline', balanceBefore: null }));
    });
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#shop-checkout-banner.is-unconfirmed', { state: 'visible', timeout: 15000 });
    var resolved = await bannerState(page);
    assert.equal(resolved.cls.indexOf('is-confirmed'), -1);
    assert.match(resolved.title, /still confirming/i);
    assert.match(resolved.sub, /payment went through/i, 'the buyer still paid — that part is knowable from the marker and must be said');
    assert.equal(resolved.actionVisible, true);
    assert.match(resolved.actionLabel, /check again/i);

    var unconfirmed = await page.evaluate(function () {
      var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
      return queue.filter(function (e) { return e[0] === 'capture' && e[1] === 'purchase_credit_unconfirmed'; });
    });
    assert.equal(unconfirmed.length, 1);
    assert.equal(unconfirmed[0][2].reason, 'no_baseline', 'a never-established baseline must be distinguishable in production from an ordinary slow-webhook timeout');
    assert.equal(unconfirmed[0][2].pack, 'pack199');
  } finally {
    await context.close();
  }
});
