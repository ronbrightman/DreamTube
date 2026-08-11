// test/signup-screen-behavioral.test.js
//
// Real browser-driven coverage for start.html's screen 13 -- the unified
// signup screen (docs/SIGNUP_FACEBOOK_LOGIN_SPEC.md, tracker items
// for-product-signup-screen-the-single-big-bkwhbe and
// for-product-priority-founder-2026-07-30--ruzc5u).
//
// FORMERLY test/signup-email-first-variant-behavioral.test.js, covering a
// live 50/50 signup_email_first_variant A/B test ('a' = email+password
// shown together, 'b' = email-first). That test CONCLUDED as part of the
// 2026-07-30 CRO rebuild -- 'b' (email-first sequencing) is now the sole,
// permanent design. Renamed (not just edited) to
// stop implying a variant choice that no longer exists; every test below
// that used to say "variant b" now just says "the signup screen" (variant
// 'a's own dedicated tests, and the assignment/persistence tests for the
// retired localStorage split, are gone -- there is nothing left to cover).
//
// Two-step interaction throughout, matching renderScreen13EmailFirst's own
// renderEmailStep <-> renderPasswordStep DOM swap: fill #fn-email, click
// #fn-s13-email-continue (reveals the password step in place, no
// navigation), fill #fn-password, click #fn-s13-continue (the real
// submission).
//
// Playwright itself is NOT a project dependency -- see CLAUDE.md's "No
// test framework is wired in..." section. Every test below skips itself
// with a clear reason if Playwright/the pinned Chromium binary isn't
// resolvable in whatever environment runs `npm test`.

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

/** Same base resume params test/record-mode-behavioral.test.js and test/funnel-signup-navigation-token-guard-behavioral.test.js use. */
function resumeUrl(caption) {
  // signup=unified: these behavioral tests were written against the legacy
  // password wall; since SIGNUP_PASSWORDLESS_LIVE went true (founder flip,
  // tracker at2fko) the default variant is passwordless, so the legacy
  // coverage pins its variant explicitly. Passwordless-default coverage:
  // see the 'default wall is passwordless' test appended at the bottom.
  return baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent(caption);
}

/** Reads every posthog call made during this page load straight out of the PostHog stub's own pending-call queue (window.posthog is the array itself until array.js loads and drains it -- blocked here by blockThirdParty). Same technique as test/first-video-created-behavioral.test.js. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

/** Intercepts DreamStore.getSharedFeed()'s underlying fetch so tests can force a resolved or failed shared feed without a real Netlify Functions runtime -- same shape as test/ui-behavioral.test.js's own mockGetFeed. */
function mockGetFeed(page, feed, opts) {
  opts = opts || {};
  return page.route('**/.netlify/functions/get-feed', function (route) {
    if (opts.fail) { route.abort('failed'); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: null }) });
  });
}

/** As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-g64gjp), start.html's former characters and "preparing" transition screens were removed outright -- a fresh ?resume=1 load lands directly on screen 13. */
async function reachScreen13(page, caption) {
  await safeGoto(page, resumeUrl(caption));
  await page.waitForSelector('#fn-email', { timeout: 5000 });
}

/** Registers the three signup-adjacent endpoints screen 13's Continue fires, all succeeding -- the "happy path" mocks shared by several tests below. Mirrors test/funnel-signup-navigation-token-guard-behavioral.test.js's own per-test route registrations. */
function mockHappyPathRoutes(page, opts) {
  opts = opts || {};
  return Promise.all([
    page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: opts.pendingId || 'pd-emailfirst-1', operationName: opts.operationName || 'fal:fake-model:req-emailfirst-1' }) });
    }),
    page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
    page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    })
  ]);
}

// ===========================================================================
// Rendering.
// ===========================================================================

test('screen 13 initially renders ONLY the email field + a Continue affordance -- no #fn-password until a valid email is confirmed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    assert.ok((await page.$('#fn-password')) === null, 'the password field must not render until the email step is confirmed');
    assert.ok(await page.$('#fn-s13-email-continue'), 'the email-step Continue button must render');
    assert.ok((await page.$('#fn-s13-continue')) === null, 'the real submit button must not exist yet -- only the email-step button does at this point');

    var bodyText = await page.textContent('#fnScreen');
    assert.match(bodyText, /free to start, no card needed/i, 'must show the "free to start, no card needed" framing');
  } finally {
    await context.close();
  }
});

test('an invalid email on the first step shows an error and does not reveal the password field', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'not-an-email');
    await page.click('#fn-s13-email-continue');

    var errText = await page.textContent('#fn-signup-error');
    assert.match(errText, /enter a valid email/i);
    assert.ok((await page.$('#fn-password')) === null, 'an invalid email must not advance to the password step');

    // An empty email must be rejected the same way.
    await page.fill('#fn-email', '');
    await page.click('#fn-s13-email-continue');
    var errText2 = await page.textContent('#fn-signup-error');
    assert.match(errText2, /enter a valid email/i);
    assert.ok((await page.$('#fn-password')) === null);
  } finally {
    await context.close();
  }
});

test('entering a valid email reveals the password field in place, with the confirmed email shown read-only and a real social-proof line when the feed resolves', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, [
      { id: 'a', publishedAt: new Date().toISOString() },
      { id: 'b', publishedAt: new Date().toISOString() }
    ]);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'email-first-reveal@example.com');
    await page.click('#fn-s13-email-continue');

    await page.waitForSelector('#fn-password', { timeout: 5000 });
    assert.ok(await page.$('#fn-s13-continue'), 'the real submit button must exist once the password step is shown');
    var confirmedEmail = await page.inputValue('#fn-email');
    assert.equal(confirmedEmail, 'email-first-reveal@example.com', 'the confirmed email must carry over into the password step, ready for submission');

    await page.waitForSelector('.fn-proof-strip', { timeout: 5000 });
    var proofText = await page.textContent('.fn-proof-strip');
    assert.match(proofText, /2 dreams brought to life this month/, 'expected the same real, never-fake dreams-this-month count screen 14 already uses');
  } finally {
    await context.close();
  }
});

test('a shared-feed fetch still in flight when the email step first renders, but resolved by the time the password step renders, shows the social-proof line on the password step (regression test -- the proof strip used to be computed ONCE at the email step\'s first render and cached for the rest of the visit, so it stayed permanently blank even once the fetch resolved)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // The route handler below runs in this test process (Node), not in
    // the browser -- genuinely HOLDS the response until this test calls
    // releaseFeed() (gated behind releaseFeedPromise, not fulfilled
    // synchronously), simulating a getSharedFeed() fetch still in flight
    // when screen 13's email step first renders (a realistic race -- the
    // fetch starts at script load, screens 9/11 may pass quickly) but
    // resolved by the time the visitor advances to the password step.
    var feedRequested;
    var feedRequestedPromise = new Promise(function (resolve) { feedRequested = resolve; });
    var releaseFeed;
    var releaseFeedPromise = new Promise(function (resolve) { releaseFeed = resolve; });
    await page.route('**/.netlify/functions/get-feed', function (route) {
      feedRequested();
      releaseFeedPromise.then(function () {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [{ id: 'a', publishedAt: new Date().toISOString() }], dreamOfDayId: null }) });
      });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await feedRequestedPromise;

    // Prove the pending state is real -- the email step's own first
    // render must show no proof strip while the fetch is still
    // deliberately held open. Without this assertion, the test couldn't
    // tell "fix present" apart from "fetch happened to already be
    // resolved," which is exactly the gap the round-2 review found.
    var proofStripBefore = await page.$$eval('.fn-proof-strip', function (els) { return els.length; });
    assert.equal(proofStripBefore, 0, 'expected no proof strip on the email step while the feed fetch is still deliberately unresolved');

    // Now let the response land, and wait on the actual network event
    // (not a blind sleep) before advancing -- plus one macrotask tick so
    // the page's own fetch().then() chain (JSON parsing, setting
    // dreamsThisMonthCount) has drained before the next action.
    var responsePromise = page.waitForResponse('**/.netlify/functions/get-feed');
    releaseFeed();
    await responsePromise;
    await page.evaluate(function () { return new Promise(function (resolve) { setTimeout(resolve, 0); }); });

    await page.fill('#fn-email', 'race-feed-resolve@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });

    // The password step's OWN render (triggered by the click above, well
    // after the fetch resolved) must show the proof strip -- this only
    // works if the fix recomputes it fresh on that render rather than
    // reusing whatever was cached (or absent) from the email step's
    // earlier render.
    await page.waitForSelector('.fn-proof-strip', { timeout: 5000 });
    var proofText = await page.textContent('.fn-proof-strip');
    assert.match(proofText, /1 dream brought to life this month/, 'expected the password step\'s own render to pick up the now-resolved count, not a stale value cached from the email step');
  } finally {
    await context.close();
  }
});

test('omits the social-proof line entirely (never a fake number) when the shared-feed fetch fails', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, null, { fail: true });
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'no-proof-strip@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });

    var proofStripCount = await page.$$eval('.fn-proof-strip', function (els) { return els.length; });
    assert.equal(proofStripCount, 0);
  } finally {
    await context.close();
  }
});

test('"Change email" returns to the email step with the previously entered email prefilled, and leaves Back enabled when nothing was in flight', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'change-me@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });

    var backDisabledBefore = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabledBefore, false, 'Back must not be disabled just from viewing the password step -- nothing has been submitted yet');

    await page.click('#fn-s13-change-email');
    await page.waitForSelector('#fn-s13-email-continue', { timeout: 5000 });
    assert.ok((await page.$('#fn-password')) === null, 'returning to the email step must hide the password field again');

    var prefilled = await page.inputValue('#fn-email');
    assert.equal(prefilled, 'change-me@example.com', 'the email step must be prefilled with the email already entered');

    // Change email always bumps signupAttemptToken and resets backBtn now
    // (tracker item start-html-variant-b-s-change-email-link-1kc3vs), same
    // as the topbar Back handler -- but since nothing was submitted yet in
    // this scenario, Back was never disabled to begin with, so it simply
    // stays enabled. See the "immediate Continue -> Change email" test
    // below for the mid-flight case this fix actually protects against.
    var backDisabledAfter = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabledAfter, false, 'Back must stay enabled after Change email when no attempt was in flight');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Full flow -- also covers the webview password mitigation's silent half:
// hardened autocapitalize/autocorrect/spellcheck attributes, always present
// regardless of host (see start.html's own WEBVIEW PASSWORD MITIGATION doc
// comment for why this is deliberately NOT a new on-screen explainer line --
// FOUNDER_PRINCIPLES.md's "capability-detect and HIDE, don't handhold").
// ===========================================================================

test('completing the two-step flow (email, then password) signs up successfully and reaches screen 14', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await mockHappyPathRoutes(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'email-first-full-flow@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });

    var pwAttrs = await page.evaluate(function () {
      var el = document.getElementById('fn-password');
      return { autocapitalize: el.getAttribute('autocapitalize'), autocorrect: el.getAttribute('autocorrect'), spellcheck: el.getAttribute('spellcheck'), autocomplete: el.getAttribute('autocomplete') };
    });
    assert.equal(pwAttrs.autocapitalize, 'off');
    assert.equal(pwAttrs.autocorrect, 'off');
    assert.equal(pwAttrs.spellcheck, 'false');
    assert.equal(pwAttrs.autocomplete, 'new-password');

    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    var currentUser = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.ok(currentUser, 'signup must have actually completed');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Token-guard preservation -- same repro shapes as
// test/funnel-signup-navigation-token-guard-behavioral.test.js, adapted for
// the two-step email-first interaction (the password field/submit button
// only exist once the email step has been confirmed).
// ===========================================================================

test('the topbar Back button is disabled for the duration of an in-flight attemptSignup call, and re-enabled (along with Continue) once a failed attempt settles', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-b-backdis-1', operationName: 'fal:fake-model:req-b-backdis-1' }) });
    });
    // A genuine (non-"username taken") server-side rejection -- attemptSignup
    // does not retry this one, so cb(false, ...) fires straight away and the
    // failure path (continueBtn/backBtn re-enable) is what's under test.
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'rate_limited' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await signupFlow.advanceToPasswordStep(page, 'variant-b-backdisable-test@example.com');

    var backDisabledBefore = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabledBefore, false, 'Back should not start out disabled on a fresh password step');

    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Mid-flight -- Back must now be disabled.
    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });

    await page.waitForFunction(function () {
      var errEl = document.getElementById('fn-signup-error');
      return errEl && errEl.textContent.indexOf('Too many signups') !== -1;
    }, null, { timeout: 5000 });
    var backDisabledAfter = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    var continueDisabledAfter = await page.evaluate(function () { return document.getElementById('fn-s13-continue').disabled; });
    assert.equal(backDisabledAfter, false, 'Back must be re-enabled after a failed signup attempt settles');
    assert.equal(continueDisabledAfter, false, 'Continue must be re-enabled after a failed signup attempt settles');
  } finally {
    await context.close();
  }
});

test('Signup Continue -> immediate Change-email before attemptSignup resolves -> re-enter and resubmit -- the first, abandoned attemptSignup callback must not force-navigate or adopt the wrong job once it settles late', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var claimCalls = [];
    var staleA = gate();
    var EMAIL_A = 'variant-b-race-a@example.com';
    var EMAIL_B = 'variant-b-race-b@example.com';

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      var body = JSON.parse(route.request().postData());
      var pendingId = body.email === EMAIL_A ? 'pd-b-sig-A' : 'pd-b-sig-B';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: pendingId, operationName: 'fal:fake-model:req-' + pendingId }) });
    });
    await page.route('**/.netlify/functions/register-account', async function (route) {
      var body = JSON.parse(route.request().postData());
      if (body.email === EMAIL_A) {
        // The abandoned signup attempt -- held back well past the point
        // where the user has since moved on to a second, fresh screen 13
        // for a completely different submission.
        await staleA.wait();
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    // Attempt A -- through the email step, Continue clicked, real signup
    // call fired and (deliberately) held back.
    await signupFlow.advanceToPasswordStep(page, EMAIL_A);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });

    // Abandon attempt A via screen 13's own "Change email" link -- as of
    // 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp), screen 13 is the FIRST screen in the funnel tail, so the
    // topbar Back button would exit the app entirely (a real top-level
    // navigation, destroying this page's JS heap along with A's in-flight
    // promise). Change-email carries the identical signupAttemptToken-bump/
    // invalidatePendingSignup guarantee without navigating anywhere, and
    // unlike Back it's never disabled during an in-flight attempt.
    await page.click('#fn-s13-change-email');

    // Attempt B -- a genuinely different submission -- reaches the email
    // step again while A's register-account call is still held back in
    // flight.
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var screenBefore = await page.evaluate(function () {
      if (document.getElementById('fn-s13-email-continue')) return 'screen13-email-step';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenBefore, 'screen13-email-step', 'must be sitting on the second, fresh screen 13\'s email step before A\'s stale response lands');

    // Sit idle right here -- deliberately not resubmitting -- while A's
    // held-back register-account response lands.
    // ONLY NOW release the held-back response, so it is guaranteed to
    // land against the state this test exists to cover however slow
    // getting here was (see helpers/settle.js's gate() header -- this was
    // a fixed 900ms hold the setup sequence above had to out-run). The
    // short wait after it settles the page's own continuation, measured
    // from the release rather than raced against it.
    assert.equal(staleA.released, false, 'sanity: the abandoned attempt must still have been in flight throughout the setup -- that is the race being tested');
    staleA.open();
    await settle(function () { return staleA.released; });
    await page.waitForTimeout(400);

    var screenAfter = await page.evaluate(function () {
      if (document.getElementById('fn-s13-email-continue')) return 'screen13-email-step';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenAfter, 'screen13-email-step', 'the abandoned first Signup attempt\'s late settlement must never force-navigate the user away from the second, fresh screen 13 they are actually on');
    assert.equal(claimCalls.length, 0, 'the abandoned attempt must not have claimed any pending job');

    // Finish signup for real with B's own content -- must still work
    // normally and claim B's job, never A's.
    await signupFlow.advanceToPasswordStep(page, EMAIL_B);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });

    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, for the real (B) signup');
    assert.equal(claimCalls[0].pendingId, 'pd-b-sig-B', 'must claim B\'s pendingId, never the abandoned A attempt\'s');
  } finally {
    await context.close();
  }
});

test('Signup Continue -> immediate "Change email" before attemptSignup resolves -- the stale, abandoned attempt must not force-navigate away from the email step the user navigated back to, or claim the wrong pending job (tracker item start-html-variant-b-s-change-email-link-1kc3vs)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var claimCalls = [];
    var registerCalls = [];
    var staleChangeEmail = gate();
    var EMAIL_STALE = 'variant-b-changeemail-stale@example.com';
    var EMAIL_NEW = 'variant-b-changeemail-new@example.com';

    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-b-changeemail-stale', operationName: 'fal:fake-model:req-b-changeemail-stale' }) });
    });
    await page.route('**/.netlify/functions/register-account', async function (route) {
      var body = JSON.parse(route.request().postData());
      registerCalls.push(body);
      // Deliberately delayed -- held back well past the point where the
      // user has already clicked "Change email" and moved on, mirroring
      // the other tests' abandoned-attempt shape above.
      await staleChangeEmail.wait();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    // Reach the password step, then click Continue -- fires the real
    // (deliberately delayed) signup call, continueBtn/backBtn disabled
    // for the duration.
    await signupFlow.advanceToPasswordStep(page, EMAIL_STALE);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });

    // Immediately click "Change email" mid-flight -- unlike the topbar
    // Back button, this link is never disabled by the in-flight Continue
    // click above, so it stays clickable right now. This is the exact
    // repro: the user backs out to fix their email while the abandoned
    // attempt for EMAIL_STALE is still in flight.
    await page.click('#fn-s13-change-email');
    await page.waitForSelector('#fn-s13-email-continue', { timeout: 5000 });
    assert.ok((await page.$('#fn-password')) === null, 'must genuinely be back on the email step, password field gone');

    // Back must also have been reset -- it lives outside the swapped
    // screen DOM and would otherwise stay stuck disabled from the
    // abandoned attempt.
    var backDisabledAfterChangeEmail = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabledAfterChangeEmail, false, 'Back must be reset (re-enabled) by Change email, not left stuck disabled from the abandoned attempt');

    // Sit idle right here -- deliberately not resubmitting -- while the
    // stale, abandoned register-account response for EMAIL_STALE lands.
    // ONLY NOW release the held-back response, so it is guaranteed to
    // land against the state this test exists to cover however slow
    // getting here was (see helpers/settle.js's gate() header -- this was
    // a fixed 900ms hold the setup sequence above had to out-run). The
    // short wait after it settles the page's own continuation, measured
    // from the release rather than raced against it.
    assert.equal(staleChangeEmail.released, false, 'sanity: the abandoned attempt must still have been in flight throughout the setup -- that is the race being tested');
    staleChangeEmail.open();
    await settle(function () { return staleChangeEmail.released; });
    await page.waitForTimeout(400);

    var screenAfter = await page.evaluate(function () {
      if (document.getElementById('fn-s13-email-continue')) return 'screen13-email-step';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenAfter, 'screen13-email-step', 'the stale, abandoned signup attempt\'s late settlement must never force-navigate the user away from the email step they navigated back to');
    assert.equal(claimCalls.length, 0, 'the stale, abandoned attempt must not have claimed any pending job');

    // Deliberately NOT asserting getCurrentUser() is null here. The real
    // register-account.js call for EMAIL_STALE already succeeded server-
    // side by the time its response lands, and js/store.js's own
    // commitLocalSignupIfCurrent (gated by ITS OWN store-level
    // signupCallSeq, tracker item dreamstore-signup-commits-state-user-
    // unc-vv6rio -- see that function's doc comment) commits state.user
    // as long as no NEWER DreamStore.signup() call has since started --
    // which "Change email" alone never does, since it is a pure UI
    // navigation, not a resubmission. This UI-level signupAttemptToken
    // fix (like the sibling Back-button token-guard tests above, which
    // have the same property and don't assert this either) can only gate
    // this SCREEN's own downstream side effects -- navigation and
    // claim-pending-generation -- not retroactively undo a real signup
    // call already resolved ok deeper in the stack. Asserting the two
    // things this fix actually guarantees (no force-navigation, no wrong
    // claim) above is the correct, in-scope proof.

    // Finish signup for real with the NEW email -- must still work
    // normally.
    await signupFlow.advanceToPasswordStep(page, EMAIL_NEW);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });

    var currentUserAfterReal = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.ok(currentUserAfterReal, 'the real, resubmitted signup with the new email must have actually completed');
    var accountEmailAfterReal = await page.evaluate(function () { return window.DreamStore.getAccountEmail(); });
    assert.equal(accountEmailAfterReal, EMAIL_NEW, 'the account created must use the NEW email, never the stale one');
    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, for the real (new-email) signup');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Money-leak fix (tracker item for-product-money-leak-blocked-signups-e-
// v2g1vi), now checked at the EMAIL step itself (tracker item
// for-product-signup-email-micro-step-foun-ns8uve's "verify -> capture ->
// reveal" ordering moved the check-email.js gate BEFORE the password field
// is ever revealed, not just before submission) -- a blocked email never
// fires the real, billed pending-generation call or an already-doomed
// register-account attempt.
//
// Seamless already-registered handoff (tracker item
// for-product-urgent-forensic-find-the-pro-fzgghg, item 1): a blocked email
// used to dead-end here with only a "sign in instead" link off to a whole
// separate page. Forensic finding: of the only two genuine returning users
// this product has ever had, both hit exactly this dead end via this exact
// funnel, and only one of them ever found their way back in (by manually
// discovering /login on their own). It now swaps this screen, in place,
// into a lightweight login prompt instead -- see renderInPlaceLoginStep's
// own doc comment in start.html.
// ===========================================================================

test('screen 13 email step with an email that already has an account never fires start-pending-generation or register-account, and swaps in place into a login prompt instead of a dead end', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var startPendingCalls = [];
    var registerCalls = [];
    var checkEmailCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      checkEmailCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-b-taken-1', operationName: 'fal:fake-model:req-b-taken-1' }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      registerCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E8: email_taken' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'variant-b-already-taken@example.com');
    await page.click('#fn-s13-email-continue');

    // The in-place login prompt, not the old dead-end error message.
    await page.waitForSelector('#fn-login-password', { timeout: 5000 });
    var headline = await page.locator('.fn-headline').first().textContent();
    assert.equal(headline, 'Welcome back');
    var emailValue = await page.locator('#fn-email').inputValue();
    assert.equal(emailValue, 'variant-b-already-taken@example.com', 'the already-confirmed email stays prefilled, not re-asked');

    await settle(function () { return checkEmailCalls.length >= 1; });
    assert.equal(checkEmailCalls.length, 1, 'check-email must have been called exactly once');
    assert.equal(checkEmailCalls[0].email, 'variant-b-already-taken@example.com');
    assert.equal(startPendingCalls.length, 0, 'a blocked (already-taken) email must never trigger a real, billed start-pending-generation call BEFORE login succeeds');
    assert.equal(registerCalls.length, 0, 'a blocked (already-taken) email must never attempt a signup already known to be rejected');
    assert.equal(await page.locator('#fn-password').count(), 0, 'the CREATE-a-password field must never be revealed for a blocked email -- this is a login prompt, not a signup form');
    assert.equal(await page.locator('#fn-s14-continue').count(), 0, 'must never have advanced to screen 14 without actually logging in');

    // A genuine escape hatch to the full login.html flow must still exist
    // (forgot password, or any other reason the in-place prompt doesn't work).
    assert.equal(await page.locator('a[href="login.html"]').count(), 1, 'a real escape hatch to login.html must still be present');
  } finally {
    await context.close();
  }
});

test('the in-place login prompt: a correct password logs the visitor in, kicks off the real pending generation for their now-confirmed account, and lands on screen 14 -- exactly where a fresh signup would have', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var startPendingCalls = [];
    var loginCalls = [];
    var claimCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-returning-1', operationName: 'fal:fake-model:req-returning-1' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    await page.route('**/.netlify/functions/account-login', function (route) {
      loginCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'returninguser', email: 'returning-user@example.com', authToken: 'tok-returning-1' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await page.fill('#fn-email', 'returning-user@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-login-password', { timeout: 5000 });

    await page.fill('#fn-login-password', 'theirrealpassword');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });

    assert.equal(loginCalls.length, 1, 'DreamStore.login must have been called exactly once');
    assert.equal(loginCalls[0].usernameOrEmail, 'returning-user@example.com');
    assert.equal(loginCalls[0].password, 'theirrealpassword');

    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'a real pending generation must fire once identity is actually confirmed via login -- this is the "create a second video" step the forensic survivor proved works');
    assert.equal(startPendingCalls[0].email, 'returning-user@example.com');
    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'the newly-started pending job must be claimed under the now-logged-in account');

    var currentUser = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.ok(currentUser, 'a real session must exist after a successful in-place login');
    assert.equal(currentUser.username, 'returninguser');
  } finally {
    await context.close();
  }
});

test('the in-place login prompt: a wrong password shows an inline error, refocuses the field, and never advances or fires a real generation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(1);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-wrongpw-1', operationName: 'fal:fake-model:req-wrongpw-1' }) });
    });
    await page.route('**/.netlify/functions/account-login', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'incorrect_password' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await page.fill('#fn-email', 'returning-wrongpw@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-login-password', { timeout: 5000 });

    await page.fill('#fn-login-password', 'notmyrealpassword');
    await page.click('#fn-s13-continue');

    await page.waitForFunction(function () {
      var errEl = document.getElementById('fn-signup-error');
      return errEl && errEl.textContent.length > 0;
    }, null, { timeout: 5000 });

    assert.equal(await page.locator('#fn-s14-continue').count(), 0, 'a wrong password must never advance past this screen');
    assert.equal(startPendingCalls.length, 0, 'a wrong password must never fire a real, billed generation');

    var continueDisabled = await page.evaluate(function () { return document.getElementById('fn-s13-continue').disabled; });
    assert.equal(continueDisabled, false, 'Continue must be re-enabled after a rejected login, not left stuck disabled');
  } finally {
    await context.close();
  }
});

test('the in-place login prompt: "Not you? Change email" returns to the email step, with the email prefilled', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await page.fill('#fn-email', 'change-email-from-login@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-login-password', { timeout: 5000 });

    await page.click('#fn-s13-change-email');

    await page.waitForSelector('#fn-s13-email-continue', { timeout: 5000 });
    assert.equal(await page.locator('#fn-login-password').count(), 0, 'must genuinely be back on the email step');
    var emailValue = await page.locator('#fn-email').inputValue();
    assert.equal(emailValue, 'change-email-from-login@example.com');
  } finally {
    await context.close();
  }
});

test('check-email.js failing outright (rate-limited/5xx) fails OPEN -- a legitimate new-email visitor still signs up normally and start-pending-generation still fires', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E4: rate_limited' }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-b-failopen-1', operationName: 'fal:fake-model:req-b-failopen-1' }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    await signupFlow.advanceToPasswordStep(page, 'variant-b-legit-new-user@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'a legitimate new-email visitor must still get their real generation started even when check-email itself errors out');
    assert.equal(startPendingCalls[0].email, 'variant-b-legit-new-user@example.com');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// PostHog registration/tracking -- confirms the internal email-step ->
// password-step DOM swap doesn't double-fire the screen's own impression
// event, now sent with the fixed signupVariant: 'unified' value (see
// start.html's own doc comment on why it's 'unified' and not the old 'b').
// ===========================================================================

test('signup_email_first_variant_shown fires once on reaching screen 13 with variant: "unified", and posthog.register carries it too -- the later email-step -> password-step swap does NOT re-fire either', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var calls = await readPostHogCalls(page);
    var captureCalls = calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'signup_email_first_variant_shown'; });
    assert.equal(captureCalls.length, 1, 'expected exactly one signup_email_first_variant_shown capture call');
    assert.deepEqual(captureCalls[0][2], { variant: 'unified' });

    var registerCalls = calls.filter(function (entry) { return entry[0] === 'register'; });
    await settle(function () { return registerCalls.length >= 1; });
    assert.equal(registerCalls.length, 1, 'expected exactly one posthog.register call');
    assert.deepEqual(registerCalls[0][1], { signup_email_first_variant: 'unified' });

    // Advance from the email step to the password step -- an in-screen DOM
    // swap, not a goToStep()/render() navigation -- and confirm neither
    // call fired a second time because of it.
    await page.fill('#fn-email', 'no-double-fire@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });

    var callsAfter = await readPostHogCalls(page);
    var captureCallsAfter = callsAfter.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'signup_email_first_variant_shown'; });
    var registerCallsAfter = callsAfter.filter(function (entry) { return entry[0] === 'register'; });
    assert.equal(captureCallsAfter.length, 1, 'the email-step -> password-step swap must not re-fire signup_email_first_variant_shown');
    assert.equal(registerCallsAfter.length, 1, 'the email-step -> password-step swap must not re-fire posthog.register');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// signup_email_entered / signup_error_shown -- tracker item
// for-product-instrument-entered-email-mic-k1fux1. Between
// ReachedEmailEntry (fires at render, above) and signed_up there was
// previously no signal for "actually typed/submitted an email" at all --
// these two events decide whether the 98->36 signup leak's story is
// trust-at-first-glance (nobody types anything) or the password field
// itself (people enter an email fine, then bail once asked for a
// password). See emailEnteredTracked's own doc comment in start.html for
// the full reasoning on why this lives as a single, once-per-visit flag.
// ===========================================================================

function captureNamed(calls, name) {
  return calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === name; });
}

test('signup_email_entered fires once at the email step\'s own Continue tap, and the later email-step -> password-step swap does not re-fire it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'entered-b@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var entered = captureNamed(calls, 'signup_email_entered');
    assert.equal(entered.length, 1, 'expected exactly one signup_email_entered capture call');
    assert.deepEqual(entered[0][2], { variant: 'unified' });

    // The password step re-renders #fn-email read-only -- must not
    // re-trigger the flag via its own (harmless, no-op) blur listener.
    await page.locator('#fn-password').focus();
    var callsAfter = await readPostHogCalls(page);
    assert.equal(captureNamed(callsAfter, 'signup_email_entered').length, 1, 'the password step must not re-fire signup_email_entered a second time');
  } finally {
    await context.close();
  }
});

test('signup_email_entered fires on blur alone when the visitor types an email then abandons without ever tapping Continue', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'blur-only-a@example.com');
    await page.locator('#fn-email').blur();
    await page.waitForFunction(function () {
      return (window.posthog && typeof window.posthog.slice === 'function' ? window.posthog.slice() : []).some(function (e) { return e[0] === 'capture' && e[1] === 'signup_email_entered'; });
    }, null, { timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var entered = captureNamed(calls, 'signup_email_entered');
    assert.equal(entered.length, 1, 'a blur with a non-empty email must fire signup_email_entered even with no submit attempt');
  } finally {
    await context.close();
  }
});

test('signup_email_entered never fires on a blur or a rejected submit attempt while the email field is still empty', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.locator('#fn-email').focus();
    await page.locator('#fn-email').blur();
    await page.click('#fn-s13-email-continue'); // empty email -- rejected by the format check, never advances to the password step

    var calls = await readPostHogCalls(page);
    assert.equal(captureNamed(calls, 'signup_email_entered').length, 0, 'an empty field must never fire signup_email_entered, on blur or on a rejected submit attempt');
  } finally {
    await context.close();
  }
});

test('signup_error_shown: fires with reason invalid_email on a malformed address at the email step', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'still-not-an-email');
    await page.click('#fn-s13-email-continue');
    await page.waitForFunction(function () {
      var errEl = document.getElementById('fn-signup-error');
      return errEl && errEl.textContent.indexOf('valid email') !== -1;
    }, null, { timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var errors = captureNamed(calls, 'signup_error_shown');
    assert.equal(errors.length, 1, 'expected exactly one signup_error_shown capture call');
    assert.deepEqual(errors[0][2], { reason: 'invalid_email', variant: 'unified' });
    assert.ok((await page.$('#fn-password')) === null, 'must not have advanced to the password step');
  } finally {
    await context.close();
  }
});

test('signup_error_shown: fires with reason missing_password when the password field is left empty on the password step', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await signupFlow.advanceToPasswordStep(page, 'valid-no-password@example.com');
    await page.click('#fn-s13-continue');
    await page.waitForFunction(function () {
      var errEl = document.getElementById('fn-signup-error');
      return errEl && errEl.textContent.indexOf('Enter a password') !== -1;
    }, null, { timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var errors = captureNamed(calls, 'signup_error_shown');
    assert.equal(errors.length, 1, 'expected exactly one signup_error_shown capture call');
    assert.deepEqual(errors[0][2], { reason: 'missing_password', variant: 'unified' });
  } finally {
    await context.close();
  }
});

// Regression test for the forensic 17x-rageclick trap (tracker item
// for-product-urgent-forensic-find-the-pro-fzgghg, item 2). Root cause:
// renderPasswordStep's own pwInput.focus() call fires from inside an async
// Promise .then() (after a real network round trip), not synchronously
// inside a user gesture -- WebKit/mobile browsers commonly refuse to raise
// the on-screen keyboard for a focus() call outside that gesture's call
// stack, so the field can end up genuinely un-typable the moment the
// password step first appears. This can't be proven by literally checking
// whether a virtual keyboard opened (Playwright doesn't render one), but
// the actual code fix is: the missing_password click handler is itself a
// real, fresh user gesture, and it must refocus the field synchronously,
// right there, every single time -- that's the one thing that reliably
// works regardless of platform, and it's exactly what this asserts.
test('missing_password trap fix: the password field is synchronously refocused after the "Enter a password" error, every time, so the loop cannot persist', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockHappyPathRoutes(page, { pendingId: 'pd-rageclick-1', operationName: 'fal:fake-model:req-rageclick-1' });
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await signupFlow.advanceToPasswordStep(page, 'rageclick-repro@example.com');

    // Deliberately blur the field first (simulating the keyboard having
    // failed to appear/stay open after the async email->password swap,
    // the actual root cause) before rageclicking Continue several times in
    // a row with nothing typed -- exactly the forensic user's own repro.
    await page.locator('#fn-password').blur();
    for (var i = 0; i < 5; i++) {
      await page.click('#fn-s13-continue');
      // eslint-disable-next-line no-await-in-loop
      await page.waitForFunction(function () {
        var errEl = document.getElementById('fn-signup-error');
        return errEl && errEl.textContent.indexOf('Enter a password') !== -1;
      }, null, { timeout: 5000 });
      // eslint-disable-next-line no-await-in-loop
      var activeIsPassword = await page.evaluate(function () {
        return document.activeElement && document.activeElement.id === 'fn-password';
      });
      assert.equal(activeIsPassword, true, 'the password field must be refocused after every single missing_password error, attempt #' + (i + 1));
    }

    // Now actually type a password and confirm the field genuinely still
    // accepts input and submits normally -- the loop is not a permanent trap.
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });
  } finally {
    await context.close();
  }
});

test('signup_error_shown: fires with reason already_registered when check-email.js reports the address is taken, at the email step itself', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await page.fill('#fn-email', 'error-shown-taken@example.com');
    await page.click('#fn-s13-email-continue');
    // The already_registered reason is still tracked, even though the
    // outcome is now the in-place login prompt rather than a dead-end
    // error message -- see renderInPlaceLoginStep's own doc comment.
    await page.waitForSelector('#fn-login-password', { timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var errors = captureNamed(calls, 'signup_error_shown');
    assert.equal(errors.length, 1, 'expected exactly one signup_error_shown capture call');
    assert.deepEqual(errors[0][2], { reason: 'already_registered', variant: 'unified' });

    var loginShown = captureNamed(calls, 'returning_user_login_shown');
    assert.equal(loginShown.length, 1, 'the new in-place login prompt must also be tracked on its own');
    assert.deepEqual(loginShown[0][2], { variant: 'unified' });
  } finally {
    await context.close();
  }
});

test('signup_error_shown: fires with reason email_undeliverable when check-email.js reports the domain has no MX/A/AAAA records, at the email step', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: false }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await page.fill('#fn-email', 'typo@gmial-typo-domain-xyz.invalid');
    await page.click('#fn-s13-email-continue');
    await page.waitForFunction(function () {
      var errEl = document.getElementById('fn-signup-error');
      return errEl && errEl.textContent.indexOf('check for a typo') !== -1;
    }, null, { timeout: 5000 });

    assert.equal(await page.locator('#fn-password').count(), 0, 'an undeliverable email must never reveal the password field');

    var calls = await readPostHogCalls(page);
    var errors = captureNamed(calls, 'signup_error_shown');
    assert.equal(errors.length, 1, 'expected exactly one signup_error_shown capture call');
    assert.deepEqual(errors[0][2], { reason: 'email_undeliverable', variant: 'unified' });
  } finally {
    await context.close();
  }
});

test('screen 13 email step: a deliverable, available email captures (fires start-pending-generation) BEFORE the password field is revealed, not just at final submission', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-capture-early-1', operationName: 'fal:fake-model:req-capture-early-1' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await page.fill('#fn-email', 'capture-before-password@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });

    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'the real, billed pending-generation call must fire the moment the email is verified -- before the password field appears, not just at final submission');
    assert.equal(startPendingCalls[0].email, 'capture-before-password@example.com');
  } finally {
    await context.close();
  }
});

test('signup_error_shown: fires with reason signup_failed when register-account.js rejects the attempt outright', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-signupfail-1', operationName: 'fal:fake-model:req-signupfail-1' }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E7: registration_failed' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await signupFlow.advanceToPasswordStep(page, 'server-reject-a@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');
    await page.waitForFunction(function () {
      var errEl = document.getElementById('fn-signup-error');
      return errEl && errEl.textContent.length > 0;
    }, null, { timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var errors = captureNamed(calls, 'signup_error_shown');
    assert.equal(errors.length, 1, 'expected exactly one signup_error_shown capture call');
    assert.deepEqual(errors[0][2], { reason: 'signup_failed', variant: 'unified' });
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Returning-visitor-with-a-live-session guard (tracker item
// for-product-urgent-forensic-find-the-pro-fzgghg, item 3). Forensic
// finding: the only two genuine returning users this product has ever had
// BOTH re-entered through this exact funnel and were walked through the
// whole quiz/signup tail again -- even for the one who already held a real,
// logged-in session on that device. There is no reason to ever repeat the
// funnel for an already-signed-in visitor; they belong at home.html.
// ===========================================================================

test('an already-signed-in visitor hitting screen 13 via ?resume=1 is redirected straight to home.html, never re-shown the signup screen', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // Establish a real signed-in session first (an ordinary signup --
    // nothing funnel/pending-generation-related involved).
    await reachScreen13(page, 'Flying over the ocean at sunset');
    var signupResult = await page.evaluate(function () {
      return window.DreamStore.signup('alreadyloggedin', 'password123', 'alreadyloggedin@example.com');
    });
    assert.equal(signupResult.ok, true, 'sanity: the real signup this test relies on must have actually succeeded');

    // Now simulate the exact forensic scenario: this same, already-signed-in
    // browser re-enters the ad funnel from scratch (a second ad click).
    await safeGoto(page, resumeUrl('A different dream this time'));
    await page.waitForURL(/home\.html/, { timeout: 5000 });

    assert.equal(await page.locator('#fn-email').count(), 0, 'the signup screen must never have rendered for an already-signed-in visitor');
  } finally {
    await context.close();
  }
});

test('default wall (no variant param) is PASSWORDLESS: email field + Send-me-my-dream, no password input (founder flip, tracker at2fko)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('a test dream'));
    await page.waitForSelector('#fn-email', { timeout: 15000 });
    assert.ok((await page.$('input[type="password"]')) === null, 'no password field on the default (passwordless) wall');
    var btnText = (await page.textContent('#fn-s13-continue')).trim();
    assert.equal(btnText, 'Send me my dream');
  } finally {
    await context.close();
  }
});
