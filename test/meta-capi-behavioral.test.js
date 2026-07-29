// test/meta-capi-behavioral.test.js
//
// Real browser-driven coverage for the client-side half of the Meta CAPI
// wiring (js/analytics-config.js's fireMetaConversion, called from
// start.html's funnel signup and login.html's ?mode=signup path) — the
// server-side handler (netlify/functions/track-conversion.js) and the
// shared CAPI helper (lib/meta-capi.js) already have unit coverage in
// test/meta-capi.test.js, but nothing previously exercised the real pages
// to confirm the client actually fires the right event at the right
// moment, with the Pixel and CAPI calls correctly paired by event_id, and
// — just as important — that ordinary login (no signup) fires nothing at
// all. Follows this repo's test/ui-behavioral.test.js convention (added
// in a sibling branch; not yet on this one) for driving a real Chromium
// via Playwright against a local static server, using the same
// node:test/assert convention as the rest of test/*.test.js.
//
// Playwright itself is NOT a project dependency — it's resolved from this
// sandbox's global install (see CLAUDE.md's "No test framework is wired
// in..." section). If Playwright or the pinned Chromium binary isn't
// resolvable in whatever environment runs `npm test`, every test in this
// file skips itself with a clear reason instead of failing the whole
// suite.
//
// What this suite confirms:
//   - start.html: completing the funnel's signup screen (13) fires
//     exactly one CompleteRegistration POST to track-conversion, whose
//     event_id matches the eventID the page's own fbq('track', ...) Pixel
//     call used for the same CompleteRegistration event — the whole point
//     of fireMetaConversion() pairing them (see js/analytics-config.js).
//   - login.html opened WITHOUT ?mode=signup (plain login): logging in
//     fires zero track-conversion POSTs and zero fbq('track', ...) calls
//     for any of the four tracked conversion event names — logging in is
//     not a conversion event, and isSignup gates fireMetaConversion
//     entirely on that file's own signup branch.

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel's real CDN script) -- none are needed for what these tests check, and this sandbox's outbound network can intermittently stall on them (see CLAUDE.md). fbq itself still works after this: the inline base-code snippet defines fbq as a synchronous stub that queues calls when the real fbevents.js script (blocked here) hasn't loaded yet, so fbq('track', ...) never throws. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/**
 * Records every call made to window.fbq into a Node-side array that
 * survives page navigation (login.html's own flow redirects to
 * explore.html on success, which would silently wipe any in-page
 * window.__fbqCalls-style array the moment that navigation lands).
 *
 * Installed via context.exposeBinding + context.addInitScript rather than
 * a plain page.evaluate wrap, specifically so it keeps working across
 * that navigation: exposeBinding's callback lives in this Node process,
 * and addInitScript re-runs on every new document in the context. Each
 * page's own inline Pixel-init script (see any page's <head>) does
 * `f.fbq = n` to install the real fbq function -- our addInitScript
 * installs an accessor property on window.fbq *before* that runs, so the
 * assignment is transparently wrapped: reading window.fbq afterwards
 * returns the wrapped version, and calling it both records the call here
 * and forwards to the real one, so fbq's actual (stubbed/queued, since
 * blockThirdParty aborts the real fbevents.js load) behavior is
 * unaffected.
 *
 * Must be installed on the context before any page.goto() call.
 */
async function installFbqRecorder(context) {
  var calls = [];
  await context.exposeBinding('__recordFbqCall', function (source, args) {
    calls.push(args);
  });
  await context.addInitScript(function () {
    var wrapped = null;
    Object.defineProperty(window, 'fbq', {
      configurable: true,
      get: function () { return wrapped; },
      set: function (fn) {
        wrapped = function () {
          try { window.__recordFbqCall(Array.prototype.slice.call(arguments)); } catch (e) { /* recording must never break the real fbq call below */ }
          return fn.apply(this, arguments);
        };
      }
    });
  });
  return calls;
}

/** Intercepts every POST to track-conversion, recording each parsed body and fulfilling with a 200 success response so the app's fire-and-forget fetch resolves normally. */
function captureTrackConversion(page) {
  var calls = [];
  return page.route('**/.netlify/functions/track-conversion', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  }).then(function () { return calls; });
}

/**
 * start.html's screen 13 continue handler now also fires
 * start-pending-generation.js in parallel with signup (see that file's
 * own comment) -- without a route registered for it here, the request
 * would hit the plain static file server and 404, which the app's own
 * code already treats as a safe failure (see startPendingGeneration's
 * .catch()), so this is optional for correctness. Registered anyway for
 * determinism, matching test/wizard-ui-behavioral.test.js's convention of
 * explicit routes over incidental 404 fallthrough. Deliberately fulfills
 * as a failure (no pendingId) -- these CAPI tests care about signup/
 * conversion-tracking timing, not the generate-during-signup mechanism
 * itself (see test/ui-behavioral.test.js for that coverage).
 */
function stubPendingGenerationAsUnavailable(page) {
  return page.route('**/.netlify/functions/start-pending-generation', function (route) {
    route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E7: insufficient_tokens' }) });
  });
}

/** Pins start.html's screen-13 signup_email_first_variant A/B test (see that file's SIGNUP_VARIANT_KEY doc comment) to the control variant ('a' -- email + password shown together, unchanged), so a single fill-both-fields-then-click-once interaction stays deterministic instead of a 50/50 chance of landing on the email-first treatment variant, which hides #fn-password until a valid email is confirmed. Must be called on the context before any page.goto(). */
function pinSignupControlVariant(context) {
  return context.addInitScript(function () {
    localStorage.setItem('dreamtube_signup_variant', 'a');
  });
}

test('start.html: completing funnel signup fires exactly one CompleteRegistration track-conversion call, sharing event_id with the fbq Pixel call', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinSignupControlVariant(context);
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);
    await stubPendingGenerationAsUnavailable(page);

    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await page.fill('#fn-email', 'signup-behavioral@example.com');
    await page.fill('#fn-password', 'longenoughpassword1'); // past DreamStore.signup's 3-char minimum
    await page.click('#fn-s13-continue');
    // Screen 14 (pricing) renders right after a successful signup -- its
    // own render fires a *different* conversion event (InitiateCheckout),
    // so waiting for it confirms signup fully completed without assuming
    // CompleteRegistration was the only track-conversion call ever made
    // on this page (it deliberately isn't -- see the filter below).
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });

    var fbqCompleteRegistration = fbqCalls.filter(function (args) {
      return args[0] === 'track' && args[1] === 'CompleteRegistration';
    });
    assert.equal(fbqCompleteRegistration.length, 1, 'expected exactly one fbq CompleteRegistration call');
    var fbqEventId = fbqCompleteRegistration[0][3] && fbqCompleteRegistration[0][3].eventID;
    assert.ok(fbqEventId, 'fbq CompleteRegistration call should carry an eventID');

    var completeRegistrationConversions = conversionCalls.filter(function (body) {
      return body && body.event_name === 'CompleteRegistration';
    });
    assert.equal(completeRegistrationConversions.length, 1, 'expected exactly one CompleteRegistration POST to track-conversion');
    assert.equal(completeRegistrationConversions[0].event_id, fbqEventId, 'track-conversion event_id must match the fbq Pixel call\'s eventID, so Meta can dedupe them');
    assert.equal(completeRegistrationConversions[0].email, 'signup-behavioral@example.com');
  } finally {
    await context.close();
  }
});

test('start.html: reaching the email-entry screen (13) fires exactly one ReachedEmailEntry custom event, sharing event_id between fbq and track-conversion, before signup completes', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);

    await page.goto(baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'), { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#fn-adv-chars-skip', { timeout: 5000 });
    await page.click('#fn-adv-chars-skip');
    await page.waitForSelector('#fn-s11-continue', { timeout: 5000 });
    await page.click('#fn-s11-continue');
    // This lands on screen 13 (email_capture) WITHOUT submitting the
    // signup form -- confirms ReachedEmailEntry fires on reaching the
    // screen, independent of and prior to CompleteRegistration.
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var fbqReachedEmailEntry = fbqCalls.filter(function (args) {
      return args[0] === 'trackCustom' && args[1] === 'ReachedEmailEntry';
    });
    assert.equal(fbqReachedEmailEntry.length, 1, 'expected exactly one fbq trackCustom ReachedEmailEntry call');
    var fbqEventId = fbqReachedEmailEntry[0][3] && fbqReachedEmailEntry[0][3].eventID;
    assert.ok(fbqEventId, 'fbq ReachedEmailEntry call should carry an eventID');

    var reachedEmailEntryConversions = conversionCalls.filter(function (body) {
      return body && body.event_name === 'ReachedEmailEntry';
    });
    assert.equal(reachedEmailEntryConversions.length, 1, 'expected exactly one ReachedEmailEntry POST to track-conversion');
    assert.equal(reachedEmailEntryConversions[0].event_id, fbqEventId, 'track-conversion event_id must match the fbq trackCustom call\'s eventID, so Meta can dedupe them');

    var fbqCompleteRegistration = fbqCalls.filter(function (args) {
      return args[0] === 'track' && args[1] === 'CompleteRegistration';
    });
    assert.equal(fbqCompleteRegistration.length, 0, 'CompleteRegistration must not have fired yet -- signup was never submitted');
  } finally {
    await context.close();
  }
});

test('login.html without ?mode=signup: logging in fires zero conversion events (no track-conversion POST, no fbq conversion call)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);

    // First load seeds js/store.js's localStorage state with a pre-existing account.
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    assert.doesNotMatch(page.url(), /mode=signup/, 'sanity check: this must be the plain login URL, not signup');
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      if (!state.accounts) state.accounts = {};
      state.accounts.behavioralloginuser = { password: 'longenoughpassword1', email: 'behavioral-login@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.fill('#login-username', 'behavioralloginuser');
    await page.fill('#login-password', 'longenoughpassword1');
    await page.click('#login-submit');
    // login.html's default post-login landing page changed from
    // explore.html to home.html (tracker item
    // for-product-build-homepage-wave-1-the-ri-xr8mir) -- explore.html
    // itself is unchanged and still reachable one tap away from home.html's
    // own bottom nav, this test just needed to follow the new default.
    await page.waitForURL(/home\.html/, { timeout: 5000 });
    assert.match(page.url(), /home\.html/);

    var TRACKED_EVENT_NAMES = ['CompleteRegistration', 'InitiateCheckout', 'Purchase', 'Subscribe'];
    var fbqConversionCalls = fbqCalls.filter(function (args) {
      return args[0] === 'track' && TRACKED_EVENT_NAMES.indexOf(args[1]) !== -1;
    });
    assert.equal(fbqConversionCalls.length, 0, 'plain login must never fire any of the four tracked conversion events via fbq');
    assert.equal(conversionCalls.length, 0, 'plain login must never POST to track-conversion at all');
  } finally {
    await context.close();
  }
});
