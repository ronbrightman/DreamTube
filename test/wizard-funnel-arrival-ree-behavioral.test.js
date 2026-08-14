// test/wizard-funnel-arrival-ree-behavioral.test.js
//
// Regression coverage for the REE (Reached-Email-Entry) tracking break of
// 2026-08-11. Background: on 2026-08-10 the growth funnel pinned its "flo"
// arm to 100% of traffic, and that arm routes every caption-carrying
// (Build/Write) paid handoff to wizard.html's signup wall instead of
// start.html's screen 13. wizard.html's wall was built when it only ever
// served ORGANIC traffic, so it deliberately fired none of the ad funnel's
// own funnel_step_viewed(email_capture) / ReachedEmailEntry /
// signup_email_entered / signup_email_first_variant_shown events. Result:
// on the first full day at 100% flo those four metrics read ZERO, even
// though signups kept landing (signed_up fires from js/store.js regardless
// of page). This file locks in the fix: those events fire again for
// genuine funnel arrivals (isFunnelHandoffArrival = ?resume=1 + a caption)
// on wizard.html, with the SAME names/property shapes start.html used, and
// still fire for NObody on organic wizard traffic (so the paid REE metric
// is never polluted by organic).
//
// Follows the repo's browser-driven test conventions (see
// route-organic-to-wizard-behavioral.test.js): a plain static server (no
// real Netlify Functions), third-party network blocked for this sandbox's
// flaky outbound, 'domcontentloaded' navigation. A stub window.posthog is
// installed before any page script runs so every track()/posthog.capture
// is recorded; the ReachedEmailEntry Meta CAPI call is observed via its
// POST to /.netlify/functions/track-conversion (intercepted, never real).

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

async function newInstrumentedPage() {
  var page = await browser.newPage();
  // Record every PostHog capture, and every Meta CAPI event_name POSTed.
  var meta = [];
  page.__metaEvents = meta;
  await page.addInitScript(function () {
    window.__ev = [];
    window.posthog = {
      __loaded: true,
      capture: function (n, p) { window.__ev.push([n, p || {}]); },
      register: function () {}, identify: function () {}, alias: function () {},
      get_distinct_id: function () { return 'test-did'; },
      people: { set: function () {} }, onFeatureFlags: function () {},
      isFeatureEnabled: function () { return false; }, getFeatureFlag: function () { return null; },
      setPersonProperties: function () {}, opt_in_capturing: function () {},
      has_opted_out_capturing: function () { return false; }
    };
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) { route.abort(); });
  await page.route('**/.netlify/functions/**', function (route) {
    var url = route.request().url();
    if (url.indexOf('track-conversion') !== -1) {
      try { meta.push(JSON.parse(route.request().postData() || '{}').event_name); } catch (e) { /* ignore */ }
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"feed":[],"ok":true}' });
  });
  return page;
}

async function safeGoto(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
  catch (e) { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
}

function evNames(ev) { return ev.map(function (e) { return e[0]; }); }
function countScreen(ev, screen) {
  return ev.filter(function (e) { return e[0] === 'funnel_step_viewed' && e[1] && e[1].screen === screen; }).length;
}
function count(ev, name) { return ev.filter(function (e) { return e[0] === name; }).length; }

test('wizard.html funnel arrival (resume=1 + caption): REE + entered-email + first-variant fire once each, with start.html-identical shapes', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await newInstrumentedPage();
  try {
    var cap = encodeURIComponent('a giant whale flying over the city');
    await safeGoto(page, baseUrl + '/wizard.html?resume=1&caption=' + cap + '&style=dreamlike');
    await page.waitForSelector('#contact-email', { timeout: 5000 });

    var evAtWall = await page.evaluate(function () { return window.__ev; });

    // REE — the metric this whole fix restores. Exactly one, screen tag
    // and step byte-identical to start.html's own emission.
    assert.equal(countScreen(evAtWall, 'email_capture'), 1,
      "funnel_step_viewed(screen:'email_capture') must fire exactly once at the wall");
    var reeEvent = evAtWall.filter(function (e) { return e[0] === 'funnel_step_viewed' && e[1].screen === 'email_capture'; })[0];
    assert.equal(reeEvent[1].step, 1, 'REE step property stays 1, identical to start.html');

    // The "wall shown" anchor (dashboard continuity), variant marks the wall.
    assert.equal(count(evAtWall, 'signup_email_first_variant_shown'), 1,
      'signup_email_first_variant_shown must fire exactly once');
    assert.equal(evAtWall.filter(function (e) { return e[0] === 'signup_email_first_variant_shown'; })[0][1].variant, 'wizard');

    // signup_email_entered has NOT fired yet (no email typed).
    assert.equal(count(evAtWall, 'signup_email_entered'), 0,
      'signup_email_entered must not fire before an email is entered');

    // Meta CAPI ReachedEmailEntry fired for the paid arrival.
    assert.equal(page.__metaEvents.filter(function (m) { return m === 'ReachedEmailEntry'; }).length, 1,
      'ReachedEmailEntry Meta CAPI conversion must fire once for the paid arrival');

    // Enter an email + blur -> signup_email_entered fires exactly once.
    await page.fill('#contact-email', 'dreamer@example.com');
    await page.evaluate(function () { document.querySelector('#contact-email').blur(); });
    await page.waitForTimeout(200);
    var evAfterBlur = await page.evaluate(function () { return window.__ev; });
    assert.equal(count(evAfterBlur, 'signup_email_entered'), 1,
      'signup_email_entered must fire exactly once on first non-empty email blur');
    assert.equal(evAfterBlur.filter(function (e) { return e[0] === 'signup_email_entered'; })[0][1].variant, 'wizard');

    // A second blur must NOT re-fire it (once per arrival).
    await page.evaluate(function () { document.querySelector('#contact-email').blur(); });
    await page.waitForTimeout(150);
    var evAfterSecondBlur = await page.evaluate(function () { return window.__ev; });
    assert.equal(count(evAfterSecondBlur, 'signup_email_entered'), 1,
      'signup_email_entered must not re-fire on a second blur within the same arrival');
  } finally {
    await page.close();
  }
});

test('wizard.html organic/direct entry (no caption): the wall is never reached (bare hit redirects to /go/), so none of the ad-funnel REE events fire', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await newInstrumentedPage();
  try {
    // Stub the /go/ funnel (a same-origin CDN proxy the static server doesn't
    // serve) so the retirement redirect lands on a real HTML page here.
    await page.route(/\/go\//, function (route) {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stub /go/ funnel</body></html>' });
    });
    // Organic/direct entry — no ?caption, so isFunnelHandoffArrival is false.
    // Since unify-all-creation-flows (founder 2026-08-14) this bounces to the
    // /go/ funnel BEFORE the wall renders, so none of the wall's ad-funnel REE
    // events can fire — the paid REE metric stays uncontaminated by organic.
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.waitForFunction(function () { return /\/go\//.test(location.href); }, null, { timeout: 5000 }).catch(function () {});
    assert.match(page.url(), /\/go\//, 'a bare wizard.html hit must redirect to the /go/ funnel, never reaching the wall');

    var ev = await page.evaluate(function () { return window.__ev || []; });
    assert.equal(countScreen(ev, 'email_capture'), 0, 'no email_capture REE event on organic traffic');
    assert.equal(count(ev, 'signup_email_first_variant_shown'), 0, 'no first-variant event on organic traffic');
    assert.equal(count(ev, 'signup_email_entered'), 0, 'no entered-email event on organic traffic');
    assert.equal(page.__metaEvents.filter(function (m) { return m === 'ReachedEmailEntry'; }).length, 0,
      'no ReachedEmailEntry CAPI on organic traffic');
  } finally {
    await page.close();
  }
});
