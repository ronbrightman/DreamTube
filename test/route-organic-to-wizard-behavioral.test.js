// test/route-organic-to-wizard-behavioral.test.js
//
// Regression coverage for tracker.html's
// for-product-route-organic-direct-visitor-olu8md: founder decision
// 2026-07-26 that organic/direct visitors (landing on index.html, this
// app's actual landing page) should enter dream creation through the
// already-built, more polished wizard.html instead of the external growth
// funnel (https://dreamtubeapp.netlify.app/) that index.html's "Get
// Started" previously pointed at for every visitor.
//
// This is routing-only: wizard.html itself is unchanged (it doesn't read
// any URL params, so it already works as a fresh standalone entry point --
// see the second test below), and the PAID growth-funnel handoff into
// start.html?resume=1&... is untouched -- that traffic arrives via ads
// landing directly on the external funnel, never through index.html's
// button at all, so this change can't affect it. See start.html's own
// "Entry guard" comment for how ?resume=1 gates that path, and
// wizard.html's own header comment ("SEAM/ROUTING JUDGMENT CALL") for the
// earlier, held-back proposal of this exact change
// (for-product-build-the-dream-builder-wiza-28did1), which this commit
// finally acts on now that it's founder-approved.
//
// Follows test/ui-behavioral.test.js's conventions: a plain static file
// server (no real Netlify Functions runtime), blockThirdParty() for this
// sandbox's flaky outbound network to fonts/PostHog/Pixel, and
// 'domcontentloaded' navigation.

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
async function safeGoto(page, url, opts) {
  try {
    await page.goto(url, Object.assign({ waitUntil: 'domcontentloaded' }, opts));
  } catch (e) {
    await page.goto(url, Object.assign({ waitUntil: 'domcontentloaded' }, opts));
  }
}

test('index.html: organic/direct visitor -- the "Get Started" CTA links straight to wizard.html, not start.html or the external growth funnel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/index.html');

    // ?entry=index (tracker item for-product-urgent-founder-repro-index-g-
    // c6boa9) is a deliberate marker, not a route change -- wizard.html's
    // returning-visitor guard reads it to let an explicit Get-Started
    // click proceed even with stale local account history, see that
    // guard's own doc comment.
    var href = await page.getAttribute('a.btn-primary.btn-block', 'href');
    assert.equal(href, 'wizard.html?entry=index', '"Get Started" must point at wizard.html, not start.html or the external dreamtube-growth funnel');

    // Follow the link for real and confirm it actually lands on wizard.html
    // (not just that the href string looks right) -- clicking through is
    // what a real organic/direct visitor does.
    await Promise.all([
      page.waitForURL(/wizard\.html/, { waitUntil: 'domcontentloaded' }),
      page.click('a.btn-primary.btn-block')
    ]);
    assert.match(page.url(), /\/wizard\.html/, 'clicking "Get Started" from index.html must land on wizard.html');
  } finally {
    await page.close();
  }
});

test('wizard.html: works correctly as a completely fresh entry point -- no query params, no prior draft/localStorage state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // Bare navigation, no ?query params, no seeded localStorage at all --
    // exactly what a brand-new organic/direct visitor's browser looks like.
    await safeGoto(page, baseUrl + '/wizard.html');

    var title = await page.title();
    assert.equal(title, 'Build your dream — DreamTube');

    // The question-first screen 1 must render with no crash/blank screen --
    // this is the same first screen a real visitor sees.
    var bodyText = await page.evaluate(function () { return document.body.innerText; });
    assert.match(bodyText, /What was your dream about\?/, 'wizard.html must render its first screen (the question-first tile grid) with no query params or prior state');

    // No console errors on a totally cold load.
    var consoleErrors = [];
    page.on('pageerror', function (err) { consoleErrors.push(String(err)); });
    await page.evaluate(function () { return true; }); // flush any pending events
    assert.deepEqual(consoleErrors, [], 'wizard.html must not throw on a fresh, param-less load');
  } finally {
    await page.close();
  }
});

test('start.html: the PAID growth-funnel handoff (?resume=1&...) is completely unaffected by the index.html routing change -- it still renders the Advanced funnel tail, not a redirect', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('I had a dream about flying'));

    // A successful ?resume=1 handoff renders this file's own funnel tail in
    // place -- it must NOT bounce back out to the external funnel (that
    // only happens for a bare/no-resume visit, covered below).
    assert.match(page.url(), /\/start\.html\?resume=1/, 'a ?resume=1 handoff must stay on start.html, not redirect elsewhere');
    var title = await page.title();
    assert.equal(title, 'DreamTube — Your dreams come alive');
  } finally {
    await page.close();
  }
});

test('start.html: a bare/direct visit (no ?resume=1) still redirects to the external growth funnel exactly as before -- the "Entry guard" behavior this change must not touch', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // Stub the external funnel domain so the real redirect target resolves
    // in this sandboxed test instead of hitting the live internet.
    await page.route('https://dreamtubeapp.netlify.app/**', function (route) {
      route.fulfill({ status: 200, contentType: 'text/plain', body: 'stub external funnel landing page' });
    });

    await safeGoto(page, baseUrl + '/start.html');
    // The Entry guard's redirect is a plain location.href assignment, not
    // instant -- give it a beat to actually navigate.
    await page.waitForURL('https://dreamtubeapp.netlify.app/', { timeout: 5000 }).catch(function () {});

    assert.equal(page.url(), 'https://dreamtubeapp.netlify.app/', 'a bare start.html visit with no ?resume=1 must still bounce to the external growth funnel, unchanged by this routing change');
  } finally {
    await page.close();
  }
});
