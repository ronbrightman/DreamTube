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

test('index.html: organic/direct visitor -- the "Get Started" CTA routes into the /go/ funnel (unify-all-creation-flows, founder 2026-08-14), not wizard.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/index.html');

    // Founder decision 2026-08-14 (unify-all-creation-flows): organic now
    // enters the SAME creation funnel as paid ads via the /go/ same-origin
    // proxy (see netlify.toml's /go/* rewrite), REVERSING the 2026-07-26
    // organic->wizard.html routing so there is ONE creation flow. The
    // link is a markup-level assertion here (not a click-through) because
    // /go/ is a Netlify CDN proxy to the separate dreamtube-growth funnel
    // site, which the local static test server does not serve.
    var href = await page.getAttribute('a.btn-primary.btn-block', 'href');
    assert.match(href, /^\/go\/(\?|$)/, '"Get Started" must route organic visitors into the /go/ funnel, not wizard.html/start.html');
    assert.match(href, /utm_source=organic/, 'organic funnel entries must be tagged utm_source=organic so they stay out of paid CPS/creative attribution');
  } finally {
    await page.close();
  }
});

test('wizard.html: a bare/direct hit (no ?resume=1) REDIRECTS to the /go/ funnel -- its own chip-build creation UI is retired (unify-all-creation-flows, founder 2026-08-14), never shown to a real user again', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // /go/ is a Netlify same-origin proxy to the separate growth funnel site,
    // which the local static test server does not serve -- stub it so the
    // retirement redirect resolves in this sandbox.
    await page.route(/\/go\//, function (route) {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stub /go/ funnel</body></html>' });
    });

    // Bare navigation, no ?query params, no seeded localStorage at all --
    // exactly what a brand-new organic/direct visitor's browser looks like.
    // wizard.html's creation flow is retired to a funnel-arrival receiver, so
    // this must bounce to the unified /go/ funnel instead of ever painting the
    // old six-tile chooser.
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.waitForFunction(function () { return /\/go\//.test(location.href); }, null, { timeout: 5000 }).catch(function () {});

    assert.match(page.url(), /\/go\//, 'a bare wizard.html hit must redirect to the /go/ funnel');
    assert.match(page.url(), /utm_source=organic/, 'the retirement redirect tags itself utm_source=organic so a direct wizard hit stays out of paid attribution');

    // The old chooser is never painted.
    var bodyText = await page.evaluate(function () { return document.body.innerText; });
    assert.doesNotMatch(bodyText, /What was your dream about\?/, 'the retired six-tile chooser must never be shown');
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
