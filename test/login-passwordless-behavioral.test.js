// test/login-passwordless-behavioral.test.js
//
// Real browser-driven coverage for login.html's PASSWORDLESS EMAIL-CODE
// login option (tracker: return-on-new-device for passwordless funnel/ad
// signups — founder iOS cross-device repro).
//
// THE BUG THIS COVERS: a passwordless account (created at the funnel wall
// via register-account-passwordless.js, password:null, no password ever
// set) that returns on a DIFFERENT browser/device could not log back in.
// login.html was username + password + "Forgot password?" only — none of
// which help an account that never had a password. That hard dead-ended
// the entire "return via email on a new device" route (a real founder
// test failed here).
//
// THE FIX UNDER TEST: login.html now offers a first-class "Email me a
// login code" recovery path that drives the EXACT funnel-wall server flow
// (DreamStore.signupPasswordless -> login-with-email-code.js, the ?bt=
// session-transfer mechanism) — no new/weaker auth path, same verified-code
// server check. This file drives the real login.html over http:// in
// Chromium and stubs the netlify functions via page.route() (the static
// server deliberately does not serve netlify/functions/* — see
// test/helpers/static-server.js).
//
// It also pins the emailed-LINK auto-login leg: home.html consumes a ?bt=
// session-transfer token BEFORE its "no user -> login.html" guard runs, so
// a passwordless user who clicks the mailed verify-email-link (which 302s
// to /home.html?bt=...) is signed in and never sees login.html at all.

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

// ===========================================================================
// 1. The option is a first-class LOGIN-mode affordance, hidden in signup mode.
// ===========================================================================
test('login.html: the passwordless "Email me a login code" option is shown in login mode and hidden in signup mode', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await page.waitForSelector('#passwordless-open');

    assert.equal(await page.isVisible('#passwordless-entry'), true, 'passwordless entry must be visible in the default login mode');
    assert.equal(await page.isVisible('#passwordless-open'), true, 'the "Email me a login code" button must be visible in login mode');

    // Toggle to signup mode — the option is scoped OUT (signup already
    // collects an email and creates the account directly).
    await page.click('#auth-toggle');
    assert.equal(await page.isVisible('#passwordless-entry'), false, 'passwordless entry must be hidden in signup mode');

    // Toggle back to login — it returns.
    await page.click('#auth-toggle');
    assert.equal(await page.isVisible('#passwordless-entry'), true, 'passwordless entry must return when back in login mode');
  } finally {
    await page.close();
  }
});

// ===========================================================================
// 2. THE FULL CROSS-DEVICE CHAIN (the founder repro, end to end):
//    passwordless account exists (device A signup) + its dream completed ->
//    on device B (FRESH context, empty localStorage) the user logs in via the
//    emailed code -> the recovered dream (returned by dream-sync, which the
//    server attaches by email at login via lib/pending-dream-recovery.js) is
//    in the journal.
// ===========================================================================
test('login.html: a passwordless returning user with NO password logs in end-to-end via the email code, and the recovered dream is visible in the journal on landing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // Fresh context == device B: no prior localStorage/account history at all.
  var context = await browser.newContext();
  var page = await context.newPage();
  await blockThirdParty(page);
  try {
    var codeLoginBody = null;

    // Catch-all so the REAL home.html we land on (session is set, so it does
    // not bounce) never hangs on its many best-effort function calls.
    // Registered FIRST — the specific routes below win via Playwright's
    // most-recently-added-first matching.
    await page.route('**/.netlify/functions/**', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // register-account-passwordless: an EXISTING (returning) passwordless
    // account -> RESOLVE branch. No session; a fresh code + auto-login link
    // are mailed. (Server-side security fix — see that function's header.)
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: false, pendingVerification: true }) });
    });

    // login-with-email-code: the real, code-gated login. Mints the session.
    // (In production this is where the server also attaches, by email, any
    // completed pending dream via lib/pending-dream-recovery.js — represented
    // here by dream-sync returning it below.)
    await page.route('**/.netlify/functions/login-with-email-code', function (route) {
      try { codeLoginBody = JSON.parse(route.request().postData() || '{}'); } catch (e) { codeLoginBody = null; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'dreamer123', email: 'returning@example.com', authToken: 'tok-login-123' }) });
    });

    // dream-sync: device B's post-login reconcile pulls the account's dreams,
    // including the one the funnel finished on device A. loginWithEmailCode
    // AWAITS this reconcile before it resolves, so the journal is populated
    // before login.html redirects.
    await page.route('**/.netlify/functions/dream-sync**', function (route) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          dreams: [{
            id: 'srv-recovered-1',
            ownerHandle: '@dreamer123',
            sourceOperationName: 'fal:veo:req-recovered-1',
            description: 'a lighthouse made of glass',
            videoUrl: 'https://example.com/recovered.mp4',
            imageUrl: 'https://example.com/recovered.png',
            createdAt: Date.now() - 60000,
            updatedAt: Date.now() - 60000
          }]
        })
      });
    });

    await safeGoto(page, baseUrl + '/login.html');
    await page.waitForSelector('#passwordless-open');

    // Sanity: this is device B — no local account history, and the password
    // field is the ONLY thing the classic path offers (and this user has no
    // password). The passwordless option is their way in.
    await page.click('#passwordless-open');
    await page.waitForSelector('#pl-email-step');
    await page.fill('#pl-email', 'returning@example.com');
    await page.click('#pl-email-submit');

    // Existing account -> the code step appears (no session yet).
    await page.waitForSelector('#pl-code-step:not([style*="display: none"])', { timeout: 5000 });
    assert.equal(await page.isVisible('#pl-code-step'), true, 'the code-entry step must appear for an existing passwordless account');

    await page.fill('#pl-code', '123456');
    await page.click('#pl-code-submit');

    // Success -> redirect to nextUrl (the real home.html). Session is set, so
    // home.html does NOT bounce back to login.
    await page.waitForURL('**/home.html', { timeout: 8000 });
    await page.waitForFunction(function () { return typeof DreamStore !== 'undefined'; }, null, { timeout: 8000 });

    // The correct code was actually sent to the code-gated login endpoint.
    assert.ok(codeLoginBody, 'login-with-email-code must have been called');
    assert.equal(codeLoginBody.email, 'returning@example.com');
    assert.equal(codeLoginBody.code, '123456', 'the typed code must be POSTed to the server for the real verified check');

    // Signed in on device B.
    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.ok(user && user.username === 'dreamer123', 'the user must be signed in after the email-code login');
    assert.equal(user.authToken, 'tok-login-123', 'the minted session authToken must be held locally');

    // The recovered dream is in the journal, watchable (has a real videoUrl).
    var dreams = await page.evaluate(function () { return DreamStore.getMyDreams(); });
    assert.ok(Array.isArray(dreams) && dreams.length >= 1, 'the recovered dream must appear in the journal');
    var recovered = dreams.filter(function (d) { return d.description === 'a lighthouse made of glass'; })[0];
    assert.ok(recovered, 'the specific recovered dream must be present');
    assert.equal(recovered.videoUrl, 'https://example.com/recovered.mp4', 'the recovered dream video must be watchable');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 3. A wrong code does NOT sign the user in and does NOT navigate — the real
//    server check is the boundary (no client-side bypass).
// ===========================================================================
test('login.html: a wrong email code shows an inline error, does not sign in, and does not navigate away', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  var page = await context.newPage();
  await blockThirdParty(page);
  try {
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: false, pendingVerification: true }) });
    });
    // Server rejects the code (login-with-email-code.js's E4 collapse).
    await page.route('**/.netlify/functions/login-with-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E4: invalid_code' }) });
    });

    await safeGoto(page, baseUrl + '/login.html');
    await page.waitForSelector('#passwordless-open');
    await page.click('#passwordless-open');
    await page.fill('#pl-email', 'returning@example.com');
    await page.click('#pl-email-submit');
    await page.waitForSelector('#pl-code-step:not([style*="display: none"])');
    await page.fill('#pl-code', '000000');
    await page.click('#pl-code-submit');

    await page.waitForSelector('#pl-code-error');
    await page.waitForFunction(function () {
      var el = document.getElementById('pl-code-error');
      return el && el.textContent.trim().length > 0;
    }, null, { timeout: 5000 });

    assert.match(await page.textContent('#pl-code-error'), /code/i, 'a wrong code must surface an inline error');
    assert.ok(/\/login\.html$/.test(new URL(page.url()).pathname), 'must still be on login.html — no navigation on a failed code');
    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.equal(user, null, 'a rejected code must not establish any session');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 4. THE EMAILED-LINK AUTO-LOGIN LEG: the mailed verify-email-link 302s to
//    /home.html?bt=<session-transfer-token>. home.html consumes ?bt=
//    (verify-session-transfer) BEFORE its "no user -> login.html" guard, so a
//    passwordless user who clicks the link is signed in and NEVER sees
//    login.html. This pins that the token is consumed and no bounce occurs.
// ===========================================================================
test('home.html: a ?bt= session-transfer token (from the emailed verify-email-link) auto-logs-in and does NOT bounce to login.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  var page = await context.newPage();
  await blockThirdParty(page);
  try {
    // Catch-all so home.html's many best-effort function calls never hang the
    // test (registered FIRST; the specific verify-session-transfer below wins
    // via Playwright's most-recently-added-first matching).
    await page.route('**/.netlify/functions/**', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    var transferBody = null;
    await page.route('**/.netlify/functions/verify-session-transfer', function (route) {
      try { transferBody = JSON.parse(route.request().postData() || '{}'); } catch (e) { transferBody = null; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'dreamer123', email: 'returning@example.com', authToken: 'tok-bt-1' }) });
    });

    await safeGoto(page, baseUrl + '/home.html?bt=fake-transfer-token');

    // Give home.html's synchronous consume + guard a beat to settle.
    await page.waitForFunction(function () { return typeof DreamStore !== 'undefined'; }, null, { timeout: 5000 });

    assert.ok(transferBody && transferBody.token === 'fake-transfer-token', 'home.html must POST the ?bt= token to verify-session-transfer');
    assert.ok(/\/home\.html$/.test(new URL(page.url()).pathname), 'must remain on home.html — a consumed ?bt= must NOT bounce to login.html');
    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.ok(user && user.username === 'dreamer123', 'the ?bt= token must establish a real local session (emailed-link auto-login)');
    assert.ok(!/[?&]bt=/.test(page.url()), 'the ?bt= param must be stripped from the address bar after consumption');
  } finally {
    await context.close();
  }
});
