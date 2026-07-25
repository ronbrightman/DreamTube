// test/funnel-distinct-id-behavioral.test.js
//
// Real browser-driven coverage for start.html's PostHog identity-linking
// fix (tracker item for-product-pass-distinct-id-on-funnel-a-9nfxd8): the
// growth funnel (dreamtubeapp.netlify.app) and this app run as separate
// PostHog anonymous sessions today -- every post-handoff pageview here was
// starting a brand-new distinct_id, so growth couldn't see one joined
// funnel from welcome through signup/video. Fix: if the funnel's
// redirectToApp() appends its own posthog.get_distinct_id() as a
// distinct_id URL param, start.html calls posthog.identify() with it right
// after the ?resume=1 entry guard passes, merging this browser's app-side
// events into the same PostHog person the funnel side already created.
// Purely additive -- absent the param, behavior is unchanged from before
// this fix (no identify call, no functional difference).
//
// Follows test/shop-palette-variant-behavioral.test.js's approach of
// reading PostHog calls straight out of the stub's own pending-call queue
// (window.posthog stays the pre-init stub array the whole test, since
// blockThirdParty aborts the real array.js bundle load) -- more reliable
// here than a monkeypatch, see that file's header comment for why.

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

/** Reads every posthog call made during this page load straight out of the PostHog stub's own pending-call queue. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function identifyCalls(calls) {
  return calls.filter(function (entry) { return entry[0] === 'identify'; });
}

var BASE_RESUME_PARAMS = 'resume=1&recall=vividly&types=flying&motivations=' + encodeURIComponent('Turn them into videos') + '&style=Cartoon&caption=' + encodeURIComponent('Flying over the ocean');

test('start.html: a funnel handoff carrying distinct_id calls posthog.identify() with that exact id, once', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/start.html?' + BASE_RESUME_PARAMS + '&distinct_id=ph-abc123', { waitUntil: 'domcontentloaded' });

    var calls = await readPostHogCalls(page);
    var idCalls = identifyCalls(calls);
    assert.equal(idCalls.length, 1, 'expected exactly one posthog.identify() call');
    assert.equal(idCalls[0][1], 'ph-abc123', 'identify() must be called with the exact distinct_id the funnel passed');
  } finally {
    await context.close();
  }
});

test('start.html: a funnel handoff WITHOUT distinct_id never calls posthog.identify() -- purely additive, no behavior change', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/start.html?' + BASE_RESUME_PARAMS, { waitUntil: 'domcontentloaded' });

    var calls = await readPostHogCalls(page);
    assert.equal(identifyCalls(calls).length, 0, 'no distinct_id param must mean no identify() call at all');

    // Sanity: the page still works normally otherwise -- the pre-existing
    // funnel_resumed_from_marketing capture still fires.
    var captures = calls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'funnel_resumed_from_marketing'; });
    assert.equal(captures.length, 1, 'the rest of start.html\'s own analytics must be completely unaffected');
  } finally {
    await context.close();
  }
});

test('start.html: a bare visit (no ?resume=1) never calls posthog.identify(), even with a distinct_id param present', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Block the actual off-app redirect this entry guard triggers so the
    // navigation doesn't leave this test's own static server.
    await page.route('https://dreamtubeapp.netlify.app/*', function (route) { route.fulfill({ status: 200, body: 'stub' }); });

    await page.goto(baseUrl + '/start.html?distinct_id=ph-should-not-fire', { waitUntil: 'domcontentloaded' });

    var calls = await readPostHogCalls(page);
    assert.equal(identifyCalls(calls).length, 0, 'the identify() call sits after the resume guard, so a bare/invalid visit must never reach it');
  } finally {
    await context.close();
  }
});
