// test/signup-reveal-variant-behavioral.test.js
//
// Real browser-driven coverage for start.html screen 13's 'reveal'
// challenger (tracker item for-product-build-now-email-wall-fix-1-n-6qvebd)
// -- renderScreen13Reveal, formingFrameHtml, tryShowFormingPreview, and
// wireScreen13Fields' new `labels` param. See start.html's own doc comment
// right above renderScreen13Reveal for the full design rationale and the
// exact reassurance-copy verification this variant's copy is built on.
//
// MOCK-FIRST GATE: SIGNUP_REVEAL_CHALLENGER_LIVE is false in the real,
// committed start.html -- since the 2026-08-03 flip, signupVariant
// resolves to the live 'passwordless' default for every real visitor
// (see test 'the reveal challenger is NOT live' below). Every other test
// in this file exercises the 'reveal' arm via the ?signup=reveal query
// escape (resumeUrl below carries it), the same test/dev override the
// resolution chain honors for 'unified', PLUS enableRevealChallenger's
// served-file rewrite where a test needs the flag itself true. Nothing
// about what actually ships changes.
//
// Reuses test/helpers/signup-flow.js's advanceToPasswordStep/
// fillAndSubmitSignup -- both variants render the exact same field ids
// (#fn-email, #fn-s13-email-continue, #fn-password, #fn-s13-continue), so
// the helper works unchanged for 'reveal' too.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

function resumeUrl(caption) {
  return baseUrl + '/start.html?resume=1&signup=reveal&style=Cartoon&caption=' + encodeURIComponent(caption);
}

// Rewrites the served start.html to flip SIGNUP_REVEAL_CHALLENGER_LIVE true
// for this page load only -- see this file's header comment. Must be
// registered BEFORE the navigation that needs it. Regex (not a glob
// string) because the real navigation always carries a query string
// (?resume=1&...) -- a bare "star-star-slash-start.html" glob only
// matches a URL with nothing after it.
function enableRevealChallenger(page) {
  return page.route(/\/start\.html(\?|$)/, async function (route) {
    var response = await route.fetch();
    var body = await response.text();
    var patched = body.replace('var SIGNUP_REVEAL_CHALLENGER_LIVE = false;', 'var SIGNUP_REVEAL_CHALLENGER_LIVE = true;');
    assert.notEqual(patched, body, 'SIGNUP_REVEAL_CHALLENGER_LIVE = false must still be present verbatim in start.html for this rewrite to work');
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: patched });
  });
}

/** Deterministically pins the sticky localStorage assignment to 'reveal' (rather than relying on the 50/50 Math.random()) -- same pre-seed technique test/shop-palette-variant-behavioral.test.js uses for dreamtube_shop_variant. Must run before enableRevealChallenger's own navigation. */
function pinRevealVariant(context) {
  return context.addInitScript(function () {
    localStorage.setItem('dreamtube_signup_variant', 'reveal');
  });
}

function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

/** Same helper as test/signup-screen-behavioral.test.js's own captureNamed -- the PostHog stub's queue records a capture() call as ['capture', eventName, props], not [eventName, props]. */
function captureNamed(calls, name) {
  return calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === name; });
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
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: opts.pendingId || 'pd-reveal-1', operationName: opts.operationName || 'fal:fake-model:req-reveal-1' }) });
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
// Mock-first gate.
// ===========================================================================

test('the reveal challenger is NOT live: a fresh, UNMODIFIED load (no ?signup override) resolves signupVariant to "passwordless" even with dreamtube_signup_variant pre-seeded to "reveal" in localStorage', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    // Deliberately NOT calling enableRevealChallenger here -- this is the
    // real, committed start.html, unmodified -- and deliberately NOT using
    // resumeUrl(), whose ?signup=reveal escape would legitimately force the
    // reveal arm. A real visitor's URL carries no override, and since the
    // 2026-08-03 flip the live default they must land on is 'passwordless'
    // (SIGNUP_PASSWORDLESS_LIVE outranks SIGNUP_REVEAL_CHALLENGER_LIVE in
    // the resolution chain), regardless of any stored assignment.
    await safeGoto(page, baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    assert.ok((await page.$('.fn-forming-frame')) === null, 'the reveal-only forming veil must never render while the challenger is gated off');
    var calls = await readPostHogCalls(page);
    var shown = captureNamed(calls, 'signup_email_first_variant_shown');
    assert.equal(shown.length, 1);
    assert.equal(shown[0][2].variant, 'passwordless', 'signupVariant must resolve to the live passwordless default for every real visitor while SIGNUP_REVEAL_CHALLENGER_LIVE is false, regardless of any stored localStorage value');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Rendering (challenger enabled via the test-only served-file rewrite).
// ===========================================================================

test('reveal variant, email step: renders the forming veil, the proof-adjacent save-framing reassurance line, and never says "Sign up" anywhere on screen', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    assert.ok(await page.$('.fn-forming-frame'), 'the forming veil must render on the email step');
    assert.ok(await page.$('.fn-form-caption'), 'the forming caption must render');
    var captionText = await page.textContent('.fn-form-caption');
    assert.match(captionText, /forming/i);

    var bodyText = await page.textContent('#fnScreen');
    // Founder-approved copy change (tracker item
    // for-product-forming-veil-replace-the-fla-nwbe60, verdict 08-03
    // ~23:00) -- replaces the old "Your dream is saving to your email...
    // it'll be waiting..." line with his verbatim wording.
    assert.match(bodyText, /no need to wait/i, 'the save-framing reassurance line must render');
    assert.match(bodyText, /we will send your dream once it.s ready to your email/i);
    assert.doesNotMatch(bodyText, /sign up/i, 'the reveal variant must never say "Sign up" anywhere on screen');

    // Anticipation-only by default -- no video-status route was mocked, so
    // the still element must stay hidden (see tryShowFormingPreview's own
    // doc comment: silently no-ops without a pendingOperationName yet).
    var stillDisplay = await page.$eval('.fn-forming-still', function (elm) { return getComputedStyle(elm).display; });
    assert.equal(stillDisplay, 'none', 'before any email is captured there is no pendingOperationName yet, so the still frame must stay hidden');
  } finally {
    await context.close();
  }
});

test('reveal variant, password step: the submit button reads "Send me my dream" (never "Sign up" or bare "Continue"), and the forming veil + reassurance persist across the in-place DOM swap', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    await mockHappyPathRoutes(page);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await signupFlow.advanceToPasswordStep(page, 'dreamer@example.com');

    assert.ok(await page.$('.fn-forming-frame'), 'the forming veil must still render on the password step');
    var btnText = await page.textContent('#fn-s13-continue');
    assert.equal(btnText.trim(), 'Send me my dream');
    var bodyText = await page.textContent('#fnScreen');
    assert.doesNotMatch(bodyText, /sign up/i, 'still never "Sign up" once the password field is revealed');
    assert.match(bodyText, /no need to wait/i);
  } finally {
    await context.close();
  }
});

test('reveal variant: signup_email_first_variant_shown fires with variant:"reveal", and posthog.register carries it too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var calls = await readPostHogCalls(page);
    var shown = captureNamed(calls, 'signup_email_first_variant_shown');
    assert.equal(shown.length, 1);
    assert.equal(shown[0][2].variant, 'reveal');
    // posthog.register is called via posthog.register({...}) -- the stub
    // queue records it as a ['register', {...}] pair, same shape
    // test/shop-palette-variant-behavioral.test.js already relies on.
    var registers = calls.filter(function (c) { return c[0] === 'register'; });
    assert.ok(registers.length >= 1, 'posthog.register must be called');
    assert.equal(registers[registers.length - 1][1].signup_email_first_variant, 'reveal');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Real submission still works end to end -- same form mechanics as
// 'unified', only the framing changed.
// ===========================================================================

test('reveal variant: a full email+password submission still signs up, fires start-pending-generation + register-account + claim-pending-generation, and reaches screen 14 -- same mechanics as unified, only the framing changed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    await mockHappyPathRoutes(page);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });

    var conversions = [];
    await page.route('**/.netlify/functions/track-conversion', function (route) {
      conversions.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await signupFlow.fillAndSubmitSignup(page, 'revealuser@example.com', 'testpass1');
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 1, 'CompleteRegistration must fire exactly once, at the same depth as unified -- only the framing changed');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Graceful degradation of the "blurred still frame" preview.
// ===========================================================================

test('reveal variant: when video-status.js reports the generation already done, the blurred still frame swaps in on the password step (best-effort, never blocking)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    await mockHappyPathRoutes(page, { operationName: 'fal:fake-model:req-ready-1' });
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-dream.mp4' }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await signupFlow.advanceToPasswordStep(page, 'previewuser@example.com');

    await page.waitForFunction(function () {
      var elm = document.querySelector('.fn-forming-still');
      return elm && getComputedStyle(elm).display === 'block';
    }, { timeout: 5000 });

    var src = await page.$eval('.fn-forming-still', function (elm) { return elm.src; });
    assert.match(src, /fake-dream\.mp4/);
  } finally {
    await context.close();
  }
});

test('reveal variant: when video-status.js is unreachable (or still in progress), the veil stays anticipation-only and the screen is never blocked', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    await mockHappyPathRoutes(page);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.abort('failed');
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await signupFlow.advanceToPasswordStep(page, 'stillformingnuser@example.com');

    // The password step (and its Continue button) must be immediately
    // interactive -- never gated on the best-effort preview check.
    assert.ok(await page.$('#fn-s13-continue'), 'the real submit button must render immediately, not wait on video-status.js');
    var stillDisplay = await page.$eval('.fn-forming-still', function (elm) { return getComputedStyle(elm).display; });
    assert.equal(stillDisplay, 'none', 'a failed/never-done status check must leave the anticipation-only veil exactly as it was');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// isRecordMode: no pending generation exists yet, so the copy must not
// claim otherwise.
// ===========================================================================

test('reveal variant, Record-it mode: the reassurance line does not claim the dream is already saving (nothing has been recorded yet), and start-pending-generation is never fired', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    var pendingCalls = 0;
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      pendingCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-record-1', operationName: 'fal:fake-model:req-record-1' }) });
    });
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });

    await safeGoto(page, baseUrl + '/start.html?resume=1&signup=reveal&mode=record');
    await signupFlow.advanceToPasswordStep(page, 'recorduser@example.com');

    var bodyText = await page.textContent('#fnScreen');
    assert.doesNotMatch(bodyText, /is saving to your email/i, 'must not claim the dream is already saving before anything has been recorded');
    assert.match(bodyText, /record it/i);
    assert.equal(pendingCalls, 0, 'Record-it must never fire a real, billed generation off an empty caption -- same as unified');
  } finally {
    await context.close();
  }
});
