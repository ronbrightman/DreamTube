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
// MOCK-FIRST GATE: SIGNUP_PASSWORDLESS_LIVE is false in the real,
// committed start.html — signupVariant resolves to 'unified' for every
// real visitor. Every test here exercises the 'passwordless' arm by
// REWRITING THE SERVED start.html to flip that one constant true for just
// that test's own page load — the exact same technique test/signup-
// reveal-variant-behavioral.test.js/test/facebook-login-signup-behavioral
// .test.js already use for their own currently-off flags. Nothing about
// what actually ships changes.

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

/** Same "rewrite the served file" technique as test/signup-reveal-variant-behavioral.test.js's enableRevealChallenger. */
function enablePasswordlessArm(page) {
  return page.route(/\/start\.html(\?|$)/, async function (route) {
    var response = await route.fetch();
    var body = await response.text();
    var patched = body.replace('var SIGNUP_PASSWORDLESS_LIVE = false;', 'var SIGNUP_PASSWORDLESS_LIVE = true;');
    assert.notEqual(patched, body, 'SIGNUP_PASSWORDLESS_LIVE = false must still be present verbatim in start.html for this rewrite to work');
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: patched });
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

test('passwordless arm is NOT live for a real visitor by default -- no password-free email-only screen appears without the flag', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    // Deliberately NOT calling enablePasswordlessArm here.
    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });
    // 'unified' shows a "Continue" button that reveals a password step --
    // the passwordless arm's button says "Send me my dream" and never
    // shows a password field at all. Confirm we're on the ordinary arm.
    var buttonText = await page.locator('.fn-btn-primary').first().textContent();
    assert.notEqual(buttonText.trim(), 'Send me my dream');
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
