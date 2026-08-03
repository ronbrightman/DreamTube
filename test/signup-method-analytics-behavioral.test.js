// test/signup-method-analytics-behavioral.test.js
//
// Real browser-driven coverage for tracker item
// for-product-signup-method-analytics-foun-y1oqt4 (founder ask,
// 2026-08-03): "how many users choose email vs. Facebook at the signup
// wall, and how that choice affects the gap between finished entering
// dream details and first completed sign-in." This file confirms the
// actual code deliverable that item asks for -- the constituent events
// exist and carry a consistent, joinable `signup_method` property (one of
// 'email' | 'facebook' | 'passwordless_code') -- across all three real
// signup paths start.html offers:
//
//   - CompleteRegistration's CAPI custom_data (POSTed to
//     track-conversion.js, forwarded to Meta unchanged -- see
//     test/meta-capi.test.js's server-side coverage of that pass-through)
//   - the client-side PostHog 'signed_up' capture (js/store.js's
//     commitLocalSignup/commitLocalPasswordlessSignup, and start.html's
//     own direct fire for the Facebook path -- see each call site's own
//     comment for why Facebook needed a NEW fire site, not a threaded
//     parameter through js/store.js's shared commitTransferredSession)
//   - the new signup_facebook_click event, fired the instant the Facebook
//     button is tapped (before the full-page navigation to Facebook's
//     OAuth dialog) -- this is what makes "chose Facebook, never
//     completed" a real, queryable funnel leak in PostHog, independent of
//     whether the visitor ever returns.
//
// Also confirms ReachedEmailEntry (the existing "signup wall shown"
// anchor) still fires unchanged -- this build does not touch that event
// at all, just verifies it's still there so the funnel this item asks for
// is comparable against historical data.
//
// Playwright itself is NOT a project dependency -- see CLAUDE.md's "No
// test framework is wired in..." section. Every test below skips itself
// with a clear reason if Playwright/the pinned Chromium binary isn't
// resolvable in whatever environment runs `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var signupFlow = require('./helpers/signup-flow');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var FAKE_APP_ID = '1234509876';

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

/** Reads every posthog call made during this page load straight out of the PostHog stub's own pending-call queue -- same technique test/facebook-login-signup-behavioral.test.js/test/signup-screen-behavioral.test.js already use. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    return (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
  });
}

function mockGetFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
  });
}

function trackConversions(page) {
  var conversions = [];
  return page.route('**/.netlify/functions/track-conversion', function (route) {
    conversions.push(JSON.parse(route.request().postData() || '{}'));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  }).then(function () { return conversions; });
}

// ===========================================================================
// Email/password path ('unified' variant -- ?signup=unified pins it, since
// the passwordless arm is now the live default; see
// test/signup-screen-behavioral.test.js's own resumeUrl comment for why).
// ===========================================================================

function resumeUrlUnified(caption) {
  return baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent(caption);
}

function mockEmailHappyPathRoutes(page) {
  return Promise.all([
    page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-sm-email-1', operationName: 'fal:fake-model:req-sm-email-1' }) });
    }),
    page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
    page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    })
  ]);
}

test('email path: CompleteRegistration custom_data carries signup_method:"email", and the client-side signed_up capture carries it too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await mockEmailHappyPathRoutes(page);
    var conversions = await trackConversions(page);

    await safeGoto(page, resumeUrlUnified('Flying over the ocean at sunset'));

    await signupFlow.fillAndSubmitSignup(page, 'sm-email-user@example.com', 'password123');
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 1, 'exactly one CompleteRegistration');
    assert.deepEqual(registrations[0].custom_data, { signup_method: 'email' });

    var calls = await readPostHogCalls(page);
    var signedUp = calls.filter(function (c) { return c[0] === 'capture' && c[1] === 'signed_up'; });
    assert.equal(signedUp.length, 1, 'signed_up must fire exactly once for a genuinely new email signup');
    assert.equal(signedUp[0][2].signup_method, 'email');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Passwordless path -- the live default (SIGNUP_PASSWORDLESS_LIVE = true,
// founder flip 2026-08-03). A bare ?resume=1 with no signup= override
// already lands here -- see test/signup-passwordless-behavioral.test.js.
// ===========================================================================

function resumeUrlDefault(caption) {
  return baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption);
}

function mockPasswordlessHappyPathRoutes(page, opts) {
  opts = opts || {};
  return Promise.all([
    page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-sm-pwless-1', operationName: 'fal:fake-model:req-sm-pwless-1' }) });
    }),
    page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, username: opts.username || 'smpwlessuser', email: opts.email || 'sm-pwless-user@example.com', authToken: 'fake-auth-token-sm-pwless', created: true, emailVerified: false })
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

test('passwordless path (live default): CompleteRegistration custom_data carries signup_method:"passwordless_code", and the client-side signed_up capture carries it too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await mockPasswordlessHappyPathRoutes(page, { email: 'sm-pwless-user@example.com' });
    var conversions = await trackConversions(page);

    await safeGoto(page, resumeUrlDefault('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });
    await page.fill('#fn-email', 'sm-pwless-user@example.com');
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 1, 'exactly one CompleteRegistration');
    assert.deepEqual(registrations[0].custom_data, { signup_method: 'passwordless_code' });

    var calls = await readPostHogCalls(page);
    var signedUp = calls.filter(function (c) { return c[0] === 'capture' && c[1] === 'signed_up'; });
    assert.equal(signedUp.length, 1, 'signed_up must fire exactly once for a genuinely new passwordless signup');
    assert.equal(signedUp[0][2].signup_method, 'passwordless_code');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Facebook path -- ?signup=unified/reveal are the only two arms that render
// the Facebook button (see facebookSignupButtonHtml's call sites); the
// passwordless arm does not offer it. Mirrors
// test/facebook-login-signup-behavioral.test.js's own setup helpers.
// ===========================================================================

function resumeUrlFacebook(caption, extra) {
  return baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent(caption) + (extra || '');
}

function configureFacebookApp(page, appId) {
  return page.route('**/js/facebook-config.js', async function (route) {
    var response = await route.fetch();
    var body = await response.text();
    route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: body.replace("'REPLACE_WITH_REAL_FACEBOOK_APP_ID'", JSON.stringify(appId || FAKE_APP_ID))
    });
  });
}

function mockSessionTransfer(page, result) {
  return page.route('**/.netlify/functions/verify-session-transfer', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
}

function mockFacebookPostSignupRoutes(page) {
  return Promise.all([
    page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-sm-fb-1', operationName: 'fal:fake-model:req-sm-fb-1' }) });
    }),
    page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    }),
    page.route('**/.netlify/functions/get-feed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
    })
  ]);
}

test('signup_facebook_click fires the instant the Facebook button is tapped, before the OAuth navigation, tagged signup_method:"facebook"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockGetFeed(page, []);
    // startFacebookLogin does a REAL full-page navigation (`location.href =
    // ...`) as part of the click handler. Root-caused via a minimal repro
    // during this build (a hung `node --test` run traced back to this
    // exact line): in this environment's headless Chromium, a
    // cross-origin `location.href` navigation invalidates the page's
    // execution context the instant it *starts* (not when it commits) --
    // true whether the route is fulfilled, aborted, or (as originally
    // written here) left permanently unresolved. A separate post-click
    // `page.click()` + `page.evaluate()` round trip therefore either
    // throws "Execution context was destroyed" (fulfill/abort) or, worse,
    // hangs forever waiting on a replacement context that a stalled,
    // never-resolving navigation will never produce (fulfill/abort at
    // least fail fast; never-resolving does not). Route disposition no
    // longer matters -- plain abort() is enough, since nothing below
    // depends on the navigation's outcome.
    await page.route('https://www.facebook.com/**', function (route) { route.abort(); });

    await safeGoto(page, resumeUrlFacebook('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-fb-continue', { timeout: 8000 });

    // Click the button AND read window.posthog's pending-call queue in one
    // single synchronous page.evaluate() -- both the click handler's
    // track() call and the queue read complete synchronously before the
    // navigation the click triggers gets a chance to invalidate the
    // context (see comment above). A separate page.click() call here
    // would reintroduce that race.
    var calls = await page.evaluate(function () {
      document.getElementById('fn-fb-continue').click();
      return (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    });
    var clicks = calls.filter(function (c) { return c[0] === 'capture' && c[1] === 'signup_facebook_click'; });
    assert.equal(clicks.length, 1, 'signup_facebook_click must fire exactly once on tap');
    assert.equal(clicks[0][2].signup_method, 'facebook');

    // And critically -- this is the whole point of the event -- no
    // CompleteRegistration/signed_up have fired yet: a visitor who taps
    // this and never completes the Facebook round trip is a real,
    // measurable "chosen Facebook, never completed" funnel leak.
    var completions = calls.filter(function (c) { return c[0] === 'capture' && c[1] === 'signed_up'; });
    assert.equal(completions.length, 0, 'signed_up must not have fired yet -- only the click was recorded');
  } finally {
    await context.close();
  }
});

test('facebook return leg: CompleteRegistration custom_data carries signup_method:"facebook", and the client-side signed_up capture now also fires for the Facebook path (a real pre-existing gap this build closes)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockFacebookPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'smfbuser', email: 'sm-fb-user@example.com', authToken: 'auth-sm-fb-1' });
    var conversions = await trackConversions(page);

    await safeGoto(page, resumeUrlFacebook('Flying over the ocean at sunset', '&bt=transfer-token-sm-fb-1&fb=signup'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 1, 'exactly one CompleteRegistration');
    assert.deepEqual(registrations[0].custom_data, { signup_method: 'facebook' });

    var calls = await readPostHogCalls(page);
    var signedUp = calls.filter(function (c) { return c[0] === 'capture' && c[1] === 'signed_up'; });
    assert.equal(signedUp.length, 1, 'signed_up must fire exactly once for a genuinely new Facebook signup -- before this build it never fired at all for this path');
    assert.equal(signedUp[0][2].signup_method, 'facebook');
  } finally {
    await context.close();
  }
});

test('facebook return leg with fb=login (an existing account, not a new signup): neither CompleteRegistration nor signed_up fire -- same "never on a login" rule every other path already follows', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockFacebookPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'smfbreturning', email: 'sm-fb-returning@example.com', authToken: 'auth-sm-fb-2' });
    var conversions = await trackConversions(page);

    await safeGoto(page, resumeUrlFacebook('Flying over the ocean at sunset', '&bt=transfer-token-sm-fb-2&fb=login'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 0, 'a returning Facebook login must never fire CompleteRegistration');

    var calls = await readPostHogCalls(page);
    var signedUp = calls.filter(function (c) { return c[0] === 'capture' && c[1] === 'signed_up'; });
    assert.equal(signedUp.length, 0, 'a returning Facebook login must never fire signed_up either');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// ReachedEmailEntry -- the existing "signup wall shown" anchor this item's
// funnel needs to stay comparable against historical data. This build does
// not touch its fire site at all; this is a verification test, not new
// behavior.
// ===========================================================================

test('ReachedEmailEntry still fires on reaching the signup wall, unaffected by this build\'s signup_method changes', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    var conversions = await trackConversions(page);

    await safeGoto(page, resumeUrlUnified('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });

    var reached = conversions.filter(function (c) { return c.event_name === 'ReachedEmailEntry'; });
    assert.equal(reached.length, 1, 'ReachedEmailEntry must still fire exactly once on reaching the signup wall');

    var calls = await readPostHogCalls(page);
    var stepViews = calls.filter(function (c) { return c[0] === 'capture' && c[1] === 'funnel_step_viewed' && c[2].screen === 'email_capture'; });
    assert.equal(stepViews.length, 1, 'the paired funnel_step_viewed(screen: "email_capture") must still fire too');
  } finally {
    await context.close();
  }
});
