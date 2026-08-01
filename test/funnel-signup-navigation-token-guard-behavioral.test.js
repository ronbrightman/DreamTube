// test/funnel-signup-navigation-token-guard-behavioral.test.js
//
// Real browser-driven coverage for start.html's screen 13 (email/password
// signup — the funnel-tail equivalent of wizard.html's separate Contact +
// Signup steps combined into one screen) and its own Signup-step
// navigation-token guard fix (tracker item
// wizard-html-start-html-signup-step-force-8wtk8h) — the 3rd confirmed
// instance of this codebase's recurring "async callback side effects not
// scoped to the attempt that started them" bug class, this time in
// attemptSignup's callback. Confirmed pre-existing on main: the callback
// unconditionally wrote pendingId/pendingOperationName/captionText/
// chosenStyle state AND advanced to screen 14, with no check that a NEWER
// attempt (reached via Back -> re-fill -> resubmit -> a second, fresh
// screen 13) hadn't since superseded it, and the topbar Back button was
// never disabled during the in-flight call.
//
// Fix (same shape as wizard.html's own renderSignup fix, see that file's
// signupAttemptToken doc comment): a per-attempt signupAttemptToken gates
// the ENTIRE attemptSignup callback body -- both the writes AND the
// navigation -- bumped on (1) every screen-13 Continue click, AND (2)
// every Back click (so simply navigating away without starting a new
// attempt also invalidates whatever's still in flight -- a first version
// of this fix only bumped on (1) and a regression test below caught that
// gap). backBtn.disabled is also toggled alongside continueBtn.disabled as
// a second, defense-in-depth layer.
//
// Follows test/wizard-ui-behavioral.test.js's and
// test/record-mode-behavioral.test.js's conventions: a plain static file
// server (no real Netlify Functions runtime), page.route() intercepts for
// the handful of function endpoints each test actually needs,
// blockThirdParty() for this sandbox's flaky outbound network. Reaches
// screen 13 directly: as of 2026-07-31 (tracker item
// for-product-urgent-founder-screenshots-i-g64gjp), start.html's former
// characters screen and "preparing" transition screen (renderScreen11)
// were both removed outright, so a fresh ?resume=1 load lands straight on
// screen 13 with nothing left to click through first. This also means
// screen 13 is now the FIRST screen, so the topbar Back button has no
// in-app screen left to step back to (prev() exits to the real marketing
// site instead) -- the tests below that used to click Back mid-signup to
// abandon an in-flight attempt and reach "a second, fresh screen 13" now
// use screen 13's own "Change email" link instead (#fn-s13-change-email),
// which carries the identical signupAttemptToken-bump/
// invalidatePendingSignup guarantee without navigating anywhere -- see
// each test's own comment.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settleMod = require('./helpers/settle');
var settle = settleMod.settle;
var gate = settleMod.gate;
var signupFlow = require('./helpers/signup-flow');

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Same base resume params test/record-mode-behavioral.test.js uses. */
function resumeUrl(caption) {
  return baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption);
}

async function reachScreen13(page, caption) {
  await safeGoto(page, resumeUrl(caption));
  await page.waitForSelector('#fn-email', { timeout: 5000 });
}

test('start.html: the topbar Back button is disabled for the duration of an in-flight attemptSignup call, and re-enabled (along with Continue) once a failed attempt settles', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-backdis-1', operationName: 'fal:fake-model:req-backdis-1' }) });
    });
    // A genuine (non-"username taken") server-side rejection -- attemptSignup
    // does not retry this one, so cb(false, ...) fires straight away and the
    // failure path (continueBtn/backBtn re-enable) is what's under test.
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'rate_limited' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    var backDisabledBefore = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabledBefore, false, 'Back should not start out disabled on a fresh screen 13');

    await signupFlow.advanceToPasswordStep(page, 'signup-backdisable-test@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Mid-flight -- Back must now be disabled.
    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });

    // The mocked rejection resolves quickly (no artificial delay) -- both
    // controls must come back once it lands, so the visitor isn't stuck.
    await page.waitForFunction(function () {
      var errEl = document.getElementById('fn-signup-error');
      return errEl && errEl.textContent.indexOf('Too many signups') !== -1;
    }, null, { timeout: 5000 });
    var backDisabledAfter = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    var continueDisabledAfter = await page.evaluate(function () { return document.getElementById('fn-s13-continue').disabled; });
    assert.equal(backDisabledAfter, false, 'Back must be re-enabled after a failed signup attempt settles');
    assert.equal(continueDisabledAfter, false, 'Continue must be re-enabled after a failed signup attempt settles');
  } finally {
    await page.close();
  }
});

test('start.html: Signup Continue -> immediate Change-email before attemptSignup resolves -> edit + resubmit -- the first, abandoned attemptSignup callback must not force-navigate or adopt the wrong job once it settles late', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var claimCalls = [];
    var staleA = gate();
    var EMAIL_A = 'start-signup-race-a@example.com';
    var EMAIL_B = 'start-signup-race-b@example.com';

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      var body = JSON.parse(route.request().postData());
      var pendingId = body.email === EMAIL_A ? 'pd-start-sig-A' : 'pd-start-sig-B';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: pendingId, operationName: 'fal:fake-model:req-' + pendingId }) });
    });
    await page.route('**/.netlify/functions/register-account', async function (route) {
      var body = JSON.parse(route.request().postData());
      if (body.email === EMAIL_A) {
        // The abandoned signup attempt -- held back well past the point
        // where the user has since moved on to a second, fresh submission.
        await staleA.wait();
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    // Attempt A -- Continue clicked, real signup call fired and
    // (deliberately) held back.
    await signupFlow.advanceToPasswordStep(page, EMAIL_A);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Confirm we're genuinely mid-flight (Back disabled) before abandoning
    // this attempt -- this is the literal repro's "immediate navigate away"
    // moment.
    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });

    // Abandon attempt A via screen 13's own "Change email" link -- as of
    // 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), screen 13 is the FIRST screen in the funnel tail, so the
    // topbar Back button has nothing left to step back to and would exit
    // the app entirely (a real top-level navigation, which destroys this
    // page's JS heap along with A's in-flight promise -- impossible to
    // keep testing against once that happens). Change-email is a real,
    // separate escape hatch with the identical signupAttemptToken-bump/
    // invalidatePendingSignup guarantee (see its own click handler comment,
    // same tracker item start-html-variant-b-s-change-email-link-1kc3vs
    // that added it) -- and, unlike Back, it's never disabled during an
    // in-flight attempt, so no force-past-disable step is needed here.
    await page.click('#fn-s13-change-email');

    // Attempt B -- a genuinely different submission, reached via screen
    // 13's own "Change email" escape hatch (the only in-page way left to
    // start a fresh submission without a real page reload -- a reload
    // would destroy A's in-flight promise along with it, which is exactly
    // what this test needs to keep alive to prove the guard).
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var screenBefore = await page.evaluate(function () {
      if (document.getElementById('fn-email')) return 'screen13';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenBefore, 'screen13', 'must be sitting back on screen 13\'s email step before A\'s stale response lands');

    // Sit idle right here -- deliberately not resubmitting -- while A's
    // held-back register-account response lands (900ms artificial delay
    // above). This is the exact gap an earlier version of this fix
    // missed: bumping the token only on Continue clicks left an
    // abandoned attempt "current" for as long as nothing NEW was
    // submitted, even though the visitor had already navigated away.
    // ONLY NOW release the held-back response, guaranteeing it lands
    // against the state this test exists to cover however slow getting
    // here was. The short wait after it is a settle for the page's own
    // continuation, measured from the release -- not a race against it.
    assert.equal(staleA.released, false, 'sanity: the abandoned attempt must still have been in flight throughout the setup -- that is the race being tested');
    staleA.open();
    await settle(function () { return staleA.released; });
    await page.waitForTimeout(400);

    var screenAfter = await page.evaluate(function () {
      if (document.getElementById('fn-email')) return 'screen13';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenAfter, 'screen13', 'the abandoned first Signup attempt\'s late settlement must never force-navigate the user away from screen 13, where they are mid-way through attempt B');
    assert.equal(claimCalls.length, 0, 'the abandoned attempt must not have claimed any pending job');

    // Finish signup for real with B's own content -- must still work
    // normally and claim B's job, never A's.
    await signupFlow.advanceToPasswordStep(page, EMAIL_B);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });

    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, for the real (B) signup');
    assert.equal(claimCalls[0].pendingId, 'pd-start-sig-B', 'must claim B\'s pendingId, never the abandoned A attempt\'s');
  } finally {
    await page.close();
  }
});

test('start.html: the token guard also protects the NESTED pendingPromise.then() continuation, not just entry to attemptSignup\'s outer callback -- the outer check can pass, then go stale WHILE this inner promise is still unsettled', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var claimCalls = [];
    var staleInnerA = gate();
    var EMAIL_A = 'start-signup-inner-race-a@example.com';
    var EMAIL_B = 'start-signup-inner-race-b@example.com';

    // Unlike the outer-check test above (which held back register-account),
    // this test holds back start-pending-generation for A -- the fetch the
    // INNER pendingPromise.then(...) continuation actually waits on --
    // while register-account resolves fast, so the OUTER check passes
    // quickly and execution reaches the inner continuation while it's
    // still unsettled. Both fire in parallel from the same Continue click
    // here (unlike wizard.html's separate Contact/Signup steps -- see
    // screen 13's own "Generate-during-signup" comment), so this needs
    // register-account to win that race, not just fire first.
    await page.route('**/.netlify/functions/start-pending-generation', async function (route) {
      var body = JSON.parse(route.request().postData());
      if (body.email === EMAIL_A) {
        await staleInnerA.wait();
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-start-inner-A', operationName: 'fal:fake-model:req-start-inner-A' }) });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-start-inner-B', operationName: 'fal:fake-model:req-start-inner-B' }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    // Attempt A -- Continue fires both the slow start-pending-generation
    // AND the fast register-account in parallel. register-account wins,
    // so the OUTER check passes almost immediately, landing inside
    // pendingPromise.then(...) while A's own start-pending-generation call
    // is still the 900ms delay away from settling.
    await signupFlow.advanceToPasswordStep(page, EMAIL_A);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Confirm we're mid-flight (Back disabled) -- stays true through the
    // inner continuation too, since nothing re-enables Back on the
    // success path until pendingPromise itself settles.
    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });

    // Abandon attempt A via screen 13's own "Change email" link -- same
    // reasoning as the outer-check test above: screen 13 is the first
    // screen now, so the topbar Back button would exit the app entirely
    // (destroying this page's JS heap, and A's still-unsettled inner
    // promise, along with it). Change-email invalidates via the identical
    // signupAttemptToken bump WHILE the inner pendingPromise.then(...) is
    // still pending, without navigating anywhere.
    await page.click('#fn-s13-change-email');

    // Attempt B -- reached via screen 13's own "Change email" escape hatch,
    // deliberately NOT submitted -- this test only needs to prove the inner
    // continuation discards A's stale settlement, not exercise B's own
    // full flow (the outer-check test above already covers that).
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var screenBefore = await page.evaluate(function () {
      if (document.getElementById('fn-email')) return 'screen13';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenBefore, 'screen13', 'must be sitting back on screen 13\'s email step before A\'s stale inner settlement lands');

    // Sit idle here while A's held-back start-pending-generation response
    // lands and its pendingPromise.then(...) continuation runs.
    // ONLY NOW release the held-back response, guaranteeing it lands
    // against the state this test exists to cover however slow getting
    // here was. The short wait after it is a settle for the page's own
    // continuation, measured from the release -- not a race against it.
    assert.equal(staleInnerA.released, false, 'sanity: the abandoned attempt must still have been in flight throughout the setup -- that is the race being tested');
    staleInnerA.open();
    await settle(function () { return staleInnerA.released; });
    await page.waitForTimeout(400);

    var screenAfter = await page.evaluate(function () {
      if (document.getElementById('fn-email')) return 'screen13';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenAfter, 'screen13', 'A\'s stale inner continuation must never force-navigate the user away from screen 13, where they are mid-way through attempt B');
    assert.equal(claimCalls.length, 0, 'A\'s stale inner continuation must not have claimed any pending job (it must discard itself via the inner re-check, not just rely on the outer one)');
  } finally {
    await page.close();
  }
});

// ===========================================================================
// Money-leak fix (tracker item for-product-money-leak-blocked-signups-e-
// v2g1vi), checked at the EMAIL step (tracker item
// for-product-signup-email-micro-step-foun-ns8uve moved the "verify then
// capture then reveal password" sequence earlier -- check-email.js is now
// called BEFORE the password field is ever revealed, not just before
// getOrStartPendingGeneration/attemptSignup fire at final submission), so a
// screen-13 email step for an email that already has an account never
// burns a real, billed fal.ai generation (and never even attempts a signup
// already known to be rejected).
// ===========================================================================

test('start.html: screen 13 email step with an email that already has an account never fires start-pending-generation or register-account, and swaps in place into a login prompt instead of a dead end (tracker item for-product-urgent-forensic-find-the-pro-fzgghg)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    var registerCalls = [];
    var checkEmailCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      checkEmailCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-start-taken-1', operationName: 'fal:fake-model:req-start-taken-1' }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      registerCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E8: email_taken' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'already-taken@example.com');
    await page.click('#fn-s13-email-continue');

    // The in-place login prompt, not the old dead-end error message --
    // see start.html's renderInPlaceLoginStep own doc comment.
    await page.waitForSelector('#fn-login-password', { timeout: 5000 });

    await settle(function () { return checkEmailCalls.length >= 1; });
    assert.equal(checkEmailCalls.length, 1, 'check-email must have been called exactly once');
    assert.equal(checkEmailCalls[0].email, 'already-taken@example.com');
    assert.equal(startPendingCalls.length, 0, 'a blocked (already-taken) email must never trigger a real, billed start-pending-generation call BEFORE login succeeds');
    assert.equal(registerCalls.length, 0, 'a blocked (already-taken) email must not even attempt a signup already known to be rejected');
    assert.equal(await page.locator('#fn-email').count(), 1, 'the confirmed email stays visible, prefilled, on the login prompt');
    assert.equal(await page.locator('#fn-password').count(), 0, 'the CREATE-a-password field must never have been revealed for a blocked email');
    assert.equal(await page.locator('#fn-s14-continue').count(), 0, 'must never have advanced to screen 14 without actually logging in');

    var backDisabled = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabled, false, 'Back must be re-enabled on the login prompt, not left stuck disabled');

    assert.equal(await page.locator('a[href="login.html"]').count(), 1, 'a real escape hatch to login.html must still be present');
  } finally {
    await page.close();
  }
});

test('start.html: check-email.js failing outright (rate-limited/5xx) fails OPEN -- a legitimate new-email visitor still signs up normally and start-pending-generation still fires', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E4: rate_limited' }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-start-failopen-1', operationName: 'fal:fake-model:req-start-failopen-1' }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    await signupFlow.advanceToPasswordStep(page, 'legit-new-user@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'a legitimate new-email visitor must still get their real generation started even when check-email itself errors out');
    assert.equal(startPendingCalls[0].email, 'legit-new-user@example.com');
  } finally {
    await page.close();
  }
});

// ===========================================================================
// signupCallSeq navigation-away invalidation (tracker item
// js-store-js-signupcallseq-only-invalidat-ijwpht) -- the 4th confirmed
// instance of this codebase's recurring "async callback side effects not
// scoped to the attempt that started them" bug class, this time one layer
// BELOW the signupAttemptToken guard the tests above cover. Even with
// signupAttemptToken correctly stopping this page's own callback from
// reacting to a stale response, js/store.js's commitLocalSignupIfCurrent
// (gated by its own module-private signupCallSeq) used to keep committing
// state.user/state.accounts in the background regardless, because
// signupCallSeq only ever bumped when a NEWER signup() call actually
// started -- never on a plain "the visitor navigated away and abandoned
// the funnel" with no second attempt ever fired. Fix: backBtn's click
// handler now also calls DreamStore.invalidatePendingSignup() (js/store.js)
// alongside its existing signupAttemptToken bump. Unlike the tests above
// (which prove the UI never force-navigates/re-renders), these two prove
// the deeper claim: the store itself never silently signs the browser in.
// ===========================================================================

test('start.html: Signup Continue -> immediate Change-email (never resubmit) -- once the delayed register-account response finally lands, DreamStore.getCurrentUser() must show NOT signed in', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var abandoned = gate();
    var ABANDONED_EMAIL = 'start-signup-abandon@example.com';

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-start-abandon-1', operationName: 'fal:fake-model:req-start-abandon-1' }) });
    });
    await page.route('**/.netlify/functions/register-account', async function (route) {
      // Held back well past the point the visitor has abandoned the
      // attempt -- the exact repro: Continue is clicked, then Change email
      // is clicked before this ever resolves, and the visitor never comes
      // back to resubmit.
      await abandoned.wait();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    await signupFlow.advanceToPasswordStep(page, ABANDONED_EMAIL);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Confirm genuinely mid-flight (Back disabled) before abandoning it --
    // this test attributes the outcome to the token/store guards
    // themselves, not merely to some control being unclickable.
    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });

    // Abandon via screen 13's own "Change email" link -- as of 2026-07-31
    // (tracker item for-product-urgent-founder-screenshots-i-g64gjp),
    // screen 13 is the FIRST screen in the funnel tail, so the topbar Back
    // button would exit the app entirely (a real top-level navigation,
    // destroying this page's JS heap along with the in-flight promise this
    // test needs to keep alive). Change-email carries the identical
    // signupAttemptToken-bump/invalidatePendingSignup guarantee (see its
    // own click handler comment) without navigating anywhere, and unlike
    // Back it's never disabled during an in-flight attempt.
    await page.click('#fn-s13-change-email');

    // Abandon the attempt entirely from here -- deliberately never
    // resubmit, never start a second signup() call. Just sit idle while
    // the delayed register-account response (900ms above) lands.
    // ONLY NOW release the held-back response, guaranteeing it lands
    // against the state this test exists to cover however slow getting
    // here was. The short wait after it is a settle for the page's own
    // continuation, measured from the release -- not a race against it.
    assert.equal(abandoned.released, false, 'sanity: the abandoned attempt must still have been in flight throughout the setup -- that is the race being tested');
    abandoned.open();
    await settle(function () { return abandoned.released; });
    await page.waitForTimeout(400);

    var state = await page.evaluate(function () {
      var accounts = JSON.parse(localStorage.getItem('dreamtube_state_v1') || '{}').accounts || {};
      var accountEmails = Object.keys(accounts).map(function (k) { return accounts[k].email; });
      return {
        currentUser: window.DreamStore.getCurrentUser(),
        accountEmails: accountEmails
      };
    });

    assert.equal(state.currentUser, null, 'DreamStore.getCurrentUser() must show NOT signed in -- the abandoned attempt\'s late response must never silently sign this browser in after the visitor navigated away and never resubmitted');
    assert.equal(state.accountEmails.indexOf(ABANDONED_EMAIL), -1, 'the abandoned attempt must not have written a state.accounts entry for the email the visitor abandoned mid-signup');
  } finally {
    await page.close();
  }
});

test('start.html: control case -- a NORMAL, non-abandoned signup (Back never clicked) still signs the visitor in and reaches screen 14 correctly', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var COMPLETED_EMAIL = 'start-signup-completed@example.com';

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-start-completed-1', operationName: 'fal:fake-model:req-start-completed-1' }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    await signupFlow.advanceToPasswordStep(page, COMPLETED_EMAIL);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });

    var state = await page.evaluate(function () {
      var accounts = JSON.parse(localStorage.getItem('dreamtube_state_v1') || '{}').accounts || {};
      var accountEmails = Object.keys(accounts).map(function (k) { return accounts[k].email; });
      return {
        currentUser: window.DreamStore.getCurrentUser(),
        accountEmails: accountEmails
      };
    });

    assert.ok(state.currentUser, 'a normal, non-abandoned signup must still sign the visitor in -- the navigation-away fix must not be so aggressive it breaks the happy path');
    assert.notEqual(state.accountEmails.indexOf(COMPLETED_EMAIL), -1, 'a normal, non-abandoned signup must still write its state.accounts entry');
  } finally {
    await page.close();
  }
});
