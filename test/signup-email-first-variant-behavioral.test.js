// test/signup-email-first-variant-behavioral.test.js
//
// Real browser-driven coverage for start.html's screen-13 email-first A/B
// test (tracker item for-product-a-b-the-email-capture-signup-nri2fn):
// research found the email_capture -> signup funnel step passes only
// ~36% (64% abandon) -- the single biggest deep-funnel leak, independent
// of ad spend/CPS. Test: email-first sequencing (collect email, THEN
// reveal the password field, instead of showing both at once), clearer
// "free to start, no card needed" framing, and a short social-proof line
// near the form -- see start.html's SIGNUP_VARIANT_KEY doc comment and
// renderScreen13EmailFirst's own doc comment for the full design.
//
// Follows two existing conventions in this repo:
//   - test/shop-palette-variant-behavioral.test.js's assignment/
//     persistence/PostHog-registration test shape, adapted for
//     'dreamtube_signup_variant' / 'signup_email_first_variant' instead
//     of shop's own 'dreamtube_shop_variant' / 'shop_palette_variant'.
//   - test/funnel-signup-navigation-token-guard-behavioral.test.js's
//     browser/route/reachScreen13 conventions, since this file's guard-
//     preservation tests below are the email-first-variant counterpart
//     of that file's control-variant coverage (that file pins itself to
//     variant 'a' -- see its own pinSignupControlVariant doc comment --
//     precisely so this file could own variant 'b's equivalent guard
//     coverage instead of splitting it awkwardly across both).
//
// Playwright itself is NOT a project dependency -- see CLAUDE.md's "No
// test framework is wired in..." section. Every test below skips itself
// with a clear reason if Playwright/the pinned Chromium binary isn't
// resolvable in whatever environment runs `npm test`.

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Same base resume params test/record-mode-behavioral.test.js and test/funnel-signup-navigation-token-guard-behavioral.test.js use -- a caption with no first-person/people-indicating language skips the characters screen, landing straight on renderScreen11 ("preparing"). */
function resumeUrl(caption) {
  return baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption);
}

/** Seeds dreamtube_signup_variant before any of start.html's own scripts run, via context.addInitScript -- same convention as test/shop-palette-variant-behavioral.test.js's presetVariant seeding for dreamtube_shop_variant. Must be called before any goto() on the same context. */
function seedVariant(context, variant) {
  return context.addInitScript(function (v) {
    localStorage.setItem('dreamtube_signup_variant', v);
  }, variant);
}

/** Reads every posthog call made during this page load straight out of the PostHog stub's own pending-call queue (window.posthog is the array itself until array.js loads and drains it -- blocked here by blockThirdParty). Same technique as test/shop-palette-variant-behavioral.test.js and test/first-video-created-behavioral.test.js. */
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

async function reachScreen13(page, caption) {
  await safeGoto(page, resumeUrl(caption));
  await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  await page.click('#fn-s11-continue');
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
// Assignment / persistence -- mirrors test/shop-palette-variant-behavioral
// .test.js's own coverage for dreamtube_shop_variant.
// ===========================================================================

test('a fresh visit (no stored variant) assigns "a" or "b" and persists it in localStorage', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var stored = await page.evaluate(function () { return localStorage.getItem('dreamtube_signup_variant'); });
    assert.ok(stored === 'a' || stored === 'b', 'expected a fresh visit to assign and persist "a" or "b", got ' + JSON.stringify(stored));
  } finally {
    await context.close();
  }
});

test('a repeat visit with an existing stored variant keeps the same variant (no reassignment)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var storedAfterFirstLoad = await page.evaluate(function () { return localStorage.getItem('dreamtube_signup_variant'); });
    assert.equal(storedAfterFirstLoad, 'b');

    // Reload the funnel from scratch several times -- a real reassignment
    // bug would show up as a coin flip on some fraction of these.
    for (var i = 0; i < 5; i++) {
      await reachScreen13(page, 'Flying over the ocean at sunset ' + i);
      var stored = await page.evaluate(function () { return localStorage.getItem('dreamtube_signup_variant'); });
      assert.equal(stored, 'b', 'variant must stay "b" across visit #' + i);
    }
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Rendering -- both variants.
// ===========================================================================

test('variant "a" (control): screen 13 renders the email AND password fields together, unchanged -- no email-first step-1 button exists', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'a');
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var passwordVisible = await page.isVisible('#fn-password');
    assert.equal(passwordVisible, true, 'control variant must show the password field immediately, same as before this A/B test existed');
    assert.equal(await page.$('#fn-s13-email-continue'), null, 'control variant must not render the treatment-only email-step button');
    assert.equal(await page.$('#fn-s13-change-email'), null, 'control variant must not render the treatment-only Change-email link');
    assert.ok(await page.$('#fn-s13-continue'), 'control variant must still render the real submit button');
  } finally {
    await context.close();
  }
});

test('variant "b" (treatment): screen 13 initially renders ONLY the email field + a Continue affordance -- no #fn-password until a valid email is confirmed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    assert.equal(await page.$('#fn-password'), null, 'treatment variant must not render the password field until the email step is confirmed');
    assert.ok(await page.$('#fn-s13-email-continue'), 'treatment variant must render its own email-step Continue button');
    assert.equal(await page.$('#fn-s13-continue'), null, 'the real submit button must not exist yet -- only the email-step button does at this point');

    var bodyText = await page.textContent('#fnScreen');
    assert.match(bodyText, /free to start, no card needed/i, 'treatment variant must show the clearer "free to start, no card needed" framing');
  } finally {
    await context.close();
  }
});

test('variant "b": an invalid email on the first step shows an error and does not reveal the password field', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'not-an-email');
    await page.click('#fn-s13-email-continue');

    var errText = await page.textContent('#fn-signup-error');
    assert.match(errText, /enter a valid email/i);
    assert.equal(await page.$('#fn-password'), null, 'an invalid email must not advance to the password step');

    // An empty email must be rejected the same way.
    await page.fill('#fn-email', '');
    await page.click('#fn-s13-email-continue');
    var errText2 = await page.textContent('#fn-signup-error');
    assert.match(errText2, /enter a valid email/i);
    assert.equal(await page.$('#fn-password'), null);
  } finally {
    await context.close();
  }
});

test('variant "b": entering a valid email reveals the password field in place, with the confirmed email shown read-only and a real social-proof line when the feed resolves', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
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

test('variant "b": a shared-feed fetch still in flight when the email step first renders, but resolved by the time the password step renders, shows the social-proof line on the password step (regression test -- the proof strip used to be computed ONCE at the email step\'s first render and cached for the rest of the visit, so it stayed permanently blank even once the fetch resolved)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
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

test('variant "b": omits the social-proof line entirely (never a fake number) when the shared-feed fetch fails', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
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

test('variant "b": "Change email" returns to the email step with the previously entered email prefilled, and does not touch signupAttemptToken/backBtn', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
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
    assert.equal(await page.$('#fn-password'), null, 'returning to the email step must hide the password field again');

    var prefilled = await page.inputValue('#fn-email');
    assert.equal(prefilled, 'change-me@example.com', 'the email step must be prefilled with the email already entered');

    var backDisabledAfter = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabledAfter, false, 'Change email must not disable Back -- it is an in-screen state change, not a real Back navigation');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Full flow -- variant "b" must sign up successfully, same end result as
// control, just via the two-step interaction.
// ===========================================================================

test('variant "b": completing the two-step flow (email, then password) signs up successfully and reaches screen 14, same as control', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await mockHappyPathRoutes(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await page.fill('#fn-email', 'email-first-full-flow@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });
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
// Token-guard preservation -- variant "b"'s own equivalent of
// test/funnel-signup-navigation-token-guard-behavioral.test.js's control-
// variant coverage (that file now pins itself to variant 'a' -- see its
// own pinSignupControlVariant doc comment). Same repro shapes, adapted
// for the two-step email-first interaction: the password field/submit
// button only exist once the email step has been confirmed.
// ===========================================================================

test('variant "b": the topbar Back button is disabled for the duration of an in-flight attemptSignup call, and re-enabled (along with Continue) once a failed attempt settles', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
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
    await page.fill('#fn-email', 'variant-b-backdisable-test@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });

    var backDisabledBefore = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabledBefore, false, 'Back should not start out disabled on a fresh password step');

    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Mid-flight -- Back must now be disabled, same as control.
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

test('variant "b": Signup Continue -> immediate Back before attemptSignup resolves -> re-enter through a second, fresh screen 13 -- the first, abandoned attemptSignup callback must not force-navigate or adopt the wrong job once it settles late', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
    var page = await context.newPage();
    await blockThirdParty(page);
    var claimCalls = [];
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
        await new Promise(function (r) { setTimeout(r, 900); });
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
    await page.fill('#fn-email', EMAIL_A);
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });
    await page.evaluate(function () { document.getElementById('fnBack').disabled = false; });
    await page.click('#fnBack');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });

    // Attempt B -- a genuinely different submission -- reaches a second,
    // fresh screen 13 (email step again) while A's register-account call
    // is still held back in flight.
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var screenBefore = await page.evaluate(function () {
      if (document.getElementById('fn-s13-email-continue')) return 'screen13-email-step';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenBefore, 'screen13-email-step', 'must be sitting on the second, fresh screen 13\'s email step before A\'s stale response lands');

    // Sit idle right here -- deliberately not resubmitting -- while A's
    // held-back register-account response lands.
    await new Promise(function (r) { setTimeout(r, 1100); });

    var screenAfter = await page.evaluate(function () {
      if (document.getElementById('fn-s13-email-continue')) return 'screen13-email-step';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenAfter, 'screen13-email-step', 'the abandoned first Signup attempt\'s late settlement must never force-navigate the user away from the second, fresh screen 13 they are actually on');
    assert.equal(claimCalls.length, 0, 'the abandoned attempt must not have claimed any pending job');

    // Finish signup for real with B's own content -- must still work
    // normally and claim B's job, never A's.
    await page.fill('#fn-email', EMAIL_B);
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });

    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, for the real (B) signup');
    assert.equal(claimCalls[0].pendingId, 'pd-b-sig-B', 'must claim B\'s pendingId, never the abandoned A attempt\'s');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Money-leak fix (tracker item for-product-money-leak-blocked-signups-e-
// v2g1vi) -- variant "b"'s own equivalent of
// test/funnel-signup-navigation-token-guard-behavioral.test.js's
// control-variant coverage for the same fix (that file pins itself to
// variant 'a' -- see its own pinSignupControlVariant doc comment -- and
// explicitly defers variant b's coverage to this file). checkEmailAvailable()
// lives inside wireScreen13Fields' #fn-s13-continue handler (see that
// function's own doc comment above -- it is the exact same function both
// variants call), which for variant b only exists once the email step has
// been confirmed and the password step has rendered -- so these tests drive
// the full two-step interaction (email step, then password step) rather
// than filling both fields at once like the control-variant tests do.
// ===========================================================================

test('variant "b": screen 13 submission with an email that already has an account never fires start-pending-generation or register-account, shows the you-already-have-an-account message inline, and stays on the password step', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
    var page = await context.newPage();
    await blockThirdParty(page);
    var startPendingCalls = [];
    var registerCalls = [];
    var checkEmailCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      checkEmailCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false }) });
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
    await page.waitForSelector('#fn-password', { timeout: 5000 });
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForFunction(function () {
      var errEl = document.getElementById('fn-signup-error');
      return errEl && errEl.textContent.indexOf('already have an account') !== -1;
    }, null, { timeout: 5000 });

    assert.equal(checkEmailCalls.length, 1, 'check-email must have been called exactly once');
    assert.equal(checkEmailCalls[0].email, 'variant-b-already-taken@example.com');
    assert.equal(startPendingCalls.length, 0, 'a blocked (already-taken) email must never trigger a real, billed start-pending-generation call');
    assert.equal(registerCalls.length, 0, 'a blocked (already-taken) email must not even attempt a signup already known to be rejected');
    assert.equal(await page.locator('#fn-password').count(), 1, 'must still be sitting on the password step');
    assert.equal(await page.locator('#fn-s14-continue').count(), 0, 'must never have advanced to screen 14');

    var continueDisabled = await page.evaluate(function () { return document.getElementById('fn-s13-continue').disabled; });
    var backDisabled = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(continueDisabled, false, 'Continue must be re-enabled after the blocked-email response, not left stuck disabled');
    assert.equal(backDisabled, false, 'Back must be re-enabled after the blocked-email response');

    var loginLinkHref = await page.locator('#fn-signup-error a').getAttribute('href');
    assert.equal(loginLinkHref, 'login.html');
  } finally {
    await context.close();
  }
});

test('variant "b": check-email.js failing outright (rate-limited/5xx) fails OPEN -- a legitimate new-email visitor still signs up normally and start-pending-generation still fires', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
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

    await page.fill('#fn-email', 'variant-b-legit-new-user@example.com');
    await page.click('#fn-s13-email-continue');
    await page.waitForSelector('#fn-password', { timeout: 5000 });
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    assert.equal(startPendingCalls.length, 1, 'a legitimate new-email visitor must still get their real generation started even when check-email itself errors out');
    assert.equal(startPendingCalls[0].email, 'variant-b-legit-new-user@example.com');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// PostHog registration/tracking -- both variants, plus confirming the
// internal email-step -> password-step DOM swap doesn't double-fire.
// ===========================================================================

test('signup_email_first_variant_shown fires once on reaching screen 13, and posthog.register carries the variant too -- variant "a"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'a');
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var calls = await readPostHogCalls(page);
    var captureCalls = calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'signup_email_first_variant_shown'; });
    assert.equal(captureCalls.length, 1, 'expected exactly one signup_email_first_variant_shown capture call');
    assert.deepEqual(captureCalls[0][2], { variant: 'a' });

    var registerCalls = calls.filter(function (entry) { return entry[0] === 'register'; });
    assert.equal(registerCalls.length, 1, 'expected exactly one posthog.register call');
    assert.deepEqual(registerCalls[0][1], { signup_email_first_variant: 'a' });
  } finally {
    await context.close();
  }
});

test('signup_email_first_variant_shown fires once on reaching screen 13, and posthog.register carries the variant too -- variant "b", and the later email-step -> password-step swap does NOT re-fire it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await seedVariant(context, 'b');
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var calls = await readPostHogCalls(page);
    var captureCalls = calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'signup_email_first_variant_shown'; });
    assert.equal(captureCalls.length, 1, 'expected exactly one signup_email_first_variant_shown capture call');
    assert.deepEqual(captureCalls[0][2], { variant: 'b' });

    var registerCalls = calls.filter(function (entry) { return entry[0] === 'register'; });
    assert.equal(registerCalls.length, 1, 'expected exactly one posthog.register call');
    assert.deepEqual(registerCalls[0][1], { signup_email_first_variant: 'b' });

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
