// test/signup-passwordless-behavioral.test.js
//
// Real browser-driven coverage for start.html screen 13's 'passwordless'
// arm (tracker item for-product-build-passwordless-signup-fo-at2fko,
// founder-decided hybrid) — renderScreen13Passwordless: no password field
// ever shown, a single email input, DreamStore.signupPasswordless(),
// CompleteRegistration at the same depth as every other arm, and the
// "don't show the deferred-verification sheet on this same landing"
// sessionStorage handoff to home.html.
//
// LIVE SINCE 2026-08-03: SIGNUP_PASSWORDLESS_LIVE is true in the real,
// committed start.html (flipped on the founder's explicit "Flip it" after
// he walked the preview) — signupVariant resolves to 'passwordless' for
// every real visitor by default. The old serve-time rewrite gate is gone;
// enablePasswordlessArm() below is now a PIN, not a patch: it serves
// start.html untouched and asserts the live flag is still present
// verbatim, so any future un-flip or rename breaks this whole file
// loudly instead of silently testing the wrong world. The first test
// asserts the arm IS the real-visitor default.

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

function resumeUrl(caption) {
  return baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption);
}

/**
 * Post-flip PIN (was a serve-time rewrite before 2026-08-03): the arm is
 * live in the committed file, so nothing needs patching — but serving
 * still goes through this route so the file loudly fails if the flag is
 * ever flipped back off or renamed, instead of these tests quietly
 * passing against the wrong default.
 */
function enablePasswordlessArm(page) {
  return page.route(/\/start\.html(\?|$)/, async function (route) {
    var response = await route.fetch();
    var body = await response.text();
    assert.ok(body.indexOf('var SIGNUP_PASSWORDLESS_LIVE = true;') !== -1, 'SIGNUP_PASSWORDLESS_LIVE = true must be present verbatim in start.html -- the passwordless arm shipped as the live default on 2026-08-03 and this file now tests that world');
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: body });
  });
}

function mockGetFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
  });
}

function mockHappyPathRoutes(page, opts) {
  opts = opts || {};
  return Promise.all([
    page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: opts.pendingId || 'pd-pwless-1', operationName: opts.operationName || 'fal:fake-model:req-pwless-1' }) });
    }),
    page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ok: true, username: opts.username || 'pwlessuser', email: opts.email || 'pwlessuser@example.com',
          authToken: opts.authToken || 'fake-auth-token-pwless', created: opts.created !== false, emailVerified: false
        })
      });
    }),
    page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    }),
    page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    })
  ]);
}

test('passwordless arm IS the live default for a real visitor -- email-only wall, no password field, "Send me my dream" (flipped 2026-08-03)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    // Deliberately NOT calling enablePasswordlessArm here -- this test is
    // about what a completely unmodified page load resolves to.
    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });
    assert.equal(await page.locator('input[type="password"]').count(), 0, 'the live default wall must never render a password field');
    var buttonText = await page.locator('.fn-btn-primary').first().textContent();
    assert.equal(buttonText.trim(), 'Send me my dream');
  } finally {
    await context.close();
  }
});

test('passwordless arm: typing only an email, no password field ever, signs up, fires CompleteRegistration once, and reaches screen 14', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await enablePasswordlessArm(page);
    await mockGetFeed(page, []);
    await mockHappyPathRoutes(page, { username: 'pwlessuser', email: 'pwlessuser@example.com' });

    var conversions = [];
    await page.route('**/.netlify/functions/track-conversion', function (route) {
      conversions.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });

    // No password field anywhere on this screen, ever -- the whole point
    // of this arm.
    assert.equal(await page.locator('#fn-password').count(), 0);

    await page.fill('#fn-email', 'pwlessuser@example.com');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 1, 'CompleteRegistration must fire exactly once, at the same depth as every other arm');

    // DreamStore state: signed in, no password, unverified -- the whole
    // point of the deferred-verification model.
    var userState = await page.evaluate(function () {
      var user = DreamStore.getCurrentUser();
      return {
        handle: user && user.handle,
        emailVerified: DreamStore.getAccountEmailVerified(),
        rawAccountPassword: (function () {
          try {
            var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1') || '{}');
            var key = user && user.username;
            return key && raw.accounts && raw.accounts[key] ? raw.accounts[key].password : undefined;
          } catch (e) { return 'parse_error'; }
        })()
      };
    });
    assert.equal(userState.handle, '@pwlessuser');
    assert.equal(userState.emailVerified, false);
    assert.equal(userState.rawAccountPassword, null, 'a passwordless account must never have a real password stored locally, even a blank one');

    // The deferred-verification sheet's "already offered this session"
    // marker must be pre-set by signup itself, so home.html's own "next
    // visit" check stays silent on THIS exact landing (never interrupting
    // the first-session dream reveal).
    var marker = await page.evaluate(function () { return sessionStorage.getItem('dreamtube_email_verify_sheet_shown'); });
    assert.equal(marker, '1');
  } finally {
    await context.close();
  }
});

test('passwordless arm: a genuinely undeliverable email is rejected inline, matching every other arm\'s deliverability check', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await enablePasswordlessArm(page);
    await mockGetFeed(page, []);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: false }) });
    });
    var passwordlessSignupCalled = false;
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      passwordlessSignupCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });
    await page.fill('#fn-email', 'typo@notreal');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-signup-error:not(:empty)', { timeout: 5000 });
    var errText = await page.locator('#fn-signup-error').textContent();
    assert.match(errText, /doesn.t look right/);
    assert.equal(passwordlessSignupCalled, false, 'an undeliverable email must never even reach the signup call');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// SECURITY FIX regression (round-2 review finding): an already-registered
// email must NEVER grant instant access -- it must show a code-entry step,
// and only a correct code (via login-with-email-code.js) actually signs
// the visitor in. This is the real end-to-end proof the client-side half
// of the fix works, not just the server-side unit tests in
// test/passwordless-signup.test.js.
// ===========================================================================

test('passwordless arm SECURITY FIX: an already-registered email shows a code step instead of instantly signing in -- no username/authToken ever reaches the page for that response', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await enablePasswordlessArm(page);
    await mockGetFeed(page, []);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-x', operationName: 'fal:fake-model:req-x' }) });
    });
    // The server response an ALREADY-REGISTERED email actually gets, post-fix
    // -- no authToken, no username, ever.
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: false, pendingVerification: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });
    await page.fill('#fn-email', 'existingowner@example.com');
    await page.click('#fn-s13-continue');

    // Must land on the code step, never advance to screen 14.
    await page.waitForSelector('#fn-login-code', { timeout: 8000 });
    assert.equal(await page.locator('#fn-s14-continue').count(), 0, 'must never reach the pricing screen off a bare, unproven email match');

    // Confirm this browser genuinely has no session at all yet.
    var loggedIn = await page.evaluate(function () { return !!DreamStore.getCurrentUser(); });
    assert.equal(loggedIn, false, 'SECURITY: a bare email match must never sign the visitor in');
  } finally {
    await context.close();
  }
});

test('passwordless arm SECURITY FIX: entering the CORRECT mailed code (via login-with-email-code.js) completes the login, does NOT fire CompleteRegistration (this is a login, not a new signup), and reaches screen 14', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await enablePasswordlessArm(page);
    await mockGetFeed(page, []);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-y', operationName: 'fal:fake-model:req-y' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: false, pendingVerification: true }) });
    });
    var loginCalls = [];
    await page.route('**/.netlify/functions/login-with-email-code', function (route) {
      loginCalls.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'realowner', email: 'existingowner@example.com', authToken: 'fake-login-token' }) });
    });
    var conversions = [];
    await page.route('**/.netlify/functions/track-conversion', function (route) {
      conversions.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });
    await page.fill('#fn-email', 'existingowner@example.com');
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-login-code', { timeout: 8000 });

    await page.fill('#fn-login-code', '482913');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0].code, '482913');
    assert.equal(loginCalls[0].email, 'existingowner@example.com');

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 0, 'a code-completed LOGIN must never fire CompleteRegistration -- same rule every other login path in this file already follows');

    var handle = await page.evaluate(function () { var u = DreamStore.getCurrentUser(); return u && u.handle; });
    assert.equal(handle, '@realowner');
  } finally {
    await context.close();
  }
});

test('passwordless arm SECURITY FIX: a WRONG code shows an inline error and does not sign in or advance', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await enablePasswordlessArm(page);
    await mockGetFeed(page, []);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-z', operationName: 'fal:fake-model:req-z' }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: false, pendingVerification: true }) });
    });
    await page.route('**/.netlify/functions/login-with-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E4: invalid_code' }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });
    await page.fill('#fn-email', 'existingowner@example.com');
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-login-code', { timeout: 8000 });

    await page.fill('#fn-login-code', '000000');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-signup-error:not(:empty)', { timeout: 5000 });
    assert.equal(await page.locator('#fn-s14-continue').count(), 0);
    var loggedIn = await page.evaluate(function () { return !!DreamStore.getCurrentUser(); });
    assert.equal(loggedIn, false);
  } finally {
    await context.close();
  }
});
