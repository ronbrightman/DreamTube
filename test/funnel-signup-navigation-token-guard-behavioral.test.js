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
// screen 13 the same fast way test/record-mode-behavioral.test.js does:
// ?resume=1 with a caption containing no first-person/people-indicating
// language, which skips the (unrelated) characters screen and the chip
// steps entirely, landing straight on renderScreen11 ("preparing") ->
// #fn-s11-continue -> screen 13.

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

/** Same base resume params test/record-mode-behavioral.test.js uses -- a caption with no first-person/people-indicating language skips the characters screen, landing straight on renderScreen11 ("preparing"). */
function resumeUrl(caption) {
  return baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption);
}

async function reachScreen13(page, caption) {
  await safeGoto(page, resumeUrl(caption));
  await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
  await page.click('#fn-s11-continue');
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

    await page.fill('#fn-email', 'signup-backdisable-test@example.com');
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

test('start.html: Signup Continue -> immediate Back before attemptSignup resolves (forced past the new Back-disable, isolating the deeper token-guard fix) -> edit + resubmit -> reach a second, fresh screen 13 -- the first, abandoned attemptSignup callback must not force-navigate or adopt the wrong job once it settles late', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var claimCalls = [];
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

    // Attempt A -- Continue clicked, real signup call fired and
    // (deliberately) held back.
    await page.fill('#fn-email', EMAIL_A);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Confirm we're genuinely mid-flight (Back disabled) before forcing
    // past it -- this is the literal repro's "immediate Back" moment,
    // just routed through a deliberate bypass of the new UI-level guard
    // so the assertions below can attribute the outcome to the token
    // guard itself, not merely to Back being unclickable.
    await page.waitForFunction(function () {
      var b = document.getElementById('fnBack');
      return !!(b && b.disabled);
    }, null, { timeout: 5000 });
    await page.evaluate(function () { document.getElementById('fnBack').disabled = false; });
    await page.click('#fnBack');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });

    // Attempt B -- a genuinely different submission -- reaches a second,
    // fresh screen 13 while A's register-account call is still held back
    // in flight.
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var screenBefore = await page.evaluate(function () {
      if (document.getElementById('fn-email')) return 'screen13';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenBefore, 'screen13', 'must be sitting on the second, fresh screen 13 before A\'s stale response lands');

    // Sit idle right here -- deliberately not resubmitting -- while A's
    // held-back register-account response lands (900ms artificial delay
    // above). This is the exact gap an earlier version of this fix
    // missed: bumping the token only on Continue clicks left an
    // abandoned attempt "current" for as long as nothing NEW was
    // submitted, even though the visitor had already navigated away.
    await new Promise(function (r) { setTimeout(r, 1100); });

    var screenAfter = await page.evaluate(function () {
      if (document.getElementById('fn-email')) return 'screen13';
      if (document.getElementById('fn-s14-continue')) return 'screen14';
      return 'other';
    });
    assert.equal(screenAfter, 'screen13', 'the abandoned first Signup attempt\'s late settlement must never force-navigate the user away from the second, fresh screen 13 they are actually on');
    assert.equal(claimCalls.length, 0, 'the abandoned attempt must not have claimed any pending job');

    // Finish signup for real with B's own content -- must still work
    // normally and claim B's job, never A's.
    await page.fill('#fn-email', EMAIL_B);
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 10000 });

    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, for the real (B) signup');
    assert.equal(claimCalls[0].pendingId, 'pd-start-sig-B', 'must claim B\'s pendingId, never the abandoned A attempt\'s');
  } finally {
    await page.close();
  }
});
