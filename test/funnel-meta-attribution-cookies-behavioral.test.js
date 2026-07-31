// test/funnel-meta-attribution-cookies-behavioral.test.js
//
// Real browser-driven coverage for start.html's Meta click-attribution
// cookie handoff (tracker item
// for-product-high-read-meta-fbc-fbp-fbcli-agr639): the ad click lands on
// the funnel domain (dreamtubeapp.netlify.app), so Meta's own _fbc/_fbp
// cookies never existed on THIS app domain -- every mid-funnel CAPI
// conversion fired from start.html (ReachedEmailEntry, CompleteRegistration)
// landed at Meta with no fbc/fbp match keys, unattributable to any ad.
// Growth's redirectToApp() now appends fbc/fbp/fbclid to the handoff URL;
// start.html persists them as real first-party cookies on this domain,
// right after the ?resume=1 guard and before anything can fire a
// conversion, so js/analytics-config.js's getMetaCookies() picks them up
// for every downstream event.
//
// Follows test/funnel-distinct-id-behavioral.test.js's conventions.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settle = require('./helpers/settle').settle;
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

/** Intercepts every POST to track-conversion, recording each parsed body -- used to confirm the persisted cookies actually reach a real conversion call, not just sit in document.cookie unused. */
function captureTrackConversion(page) {
  var calls = [];
  return page.route('**/.netlify/functions/track-conversion', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  }).then(function () { return calls; });
}

async function readCookie(context, name) {
  var cookies = await context.cookies();
  var match = cookies.filter(function (c) { return c.name === name; })[0];
  return match ? match.value : null;
}

var BASE_RESUME_PARAMS = 'resume=1&recall=vividly&types=flying&motivations=' + encodeURIComponent('Turn them into videos');

test('start.html: fbc and fbp handoff params are persisted as real first-party cookies on this domain', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/start.html?' + BASE_RESUME_PARAMS + '&fbc=fb.1.1700000000000.IwAR0abc&fbp=fb.1.1700000000000.999888777', { waitUntil: 'domcontentloaded' });

    assert.equal(await readCookie(context, '_fbc'), 'fb.1.1700000000000.IwAR0abc');
    assert.equal(await readCookie(context, '_fbp'), 'fb.1.1700000000000.999888777');
  } finally {
    await context.close();
  }
});

test('start.html: a bare fbclid (no fbc) is converted into Meta\'s canonical fbc format and persisted', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/start.html?' + BASE_RESUME_PARAMS + '&fbclid=IwAR0deadbeef', { waitUntil: 'domcontentloaded' });

    var fbc = await readCookie(context, '_fbc');
    assert.ok(fbc, 'a bare fbclid must still produce an _fbc cookie');
    assert.match(fbc, /^fb\.1\.\d+\.IwAR0deadbeef$/, 'must follow Meta\'s fb.<subdomain-index>.<creation-time-ms>.<fbclid> format');
  } finally {
    await context.close();
  }
});

test('start.html: fbc takes priority over fbclid -- both present does not double-construct or overwrite', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/start.html?' + BASE_RESUME_PARAMS + '&fbc=fb.1.1700000000000.realfbc&fbclid=IwAR0ignored', { waitUntil: 'domcontentloaded' });

    assert.equal(await readCookie(context, '_fbc'), 'fb.1.1700000000000.realfbc', 'the real fbc param must win over a constructed one from fbclid');
  } finally {
    await context.close();
  }
});

test('start.html: no fbc/fbp/fbclid params means no cookies are set -- purely additive, no behavior change', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/start.html?' + BASE_RESUME_PARAMS, { waitUntil: 'domcontentloaded' });

    assert.equal(await readCookie(context, '_fbc'), null);
    assert.equal(await readCookie(context, '_fbp'), null);
  } finally {
    await context.close();
  }
});

test('start.html: the persisted fbc/fbp cookies actually reach a real conversion call (CompleteRegistration), not just sit unused in document.cookie', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);

    await page.goto(baseUrl + '/start.html?' + BASE_RESUME_PARAMS + '&style=Cartoon&caption=' + encodeURIComponent('Flying over the ocean') + '&fbc=fb.1.1700000000000.attributed&fbp=fb.1.1700000000000.browserid', { waitUntil: 'domcontentloaded' });

    await signupFlow.advanceToPasswordStep(page, 'attribution-test@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForFunction(function () {
      return document.getElementById('fn-s14-continue') !== null;
    }, { timeout: 8000 });
    // Checking the SPECIFIC event, not just "any conversion call landed"
    // -- an earlier funnel step could plausibly have already POSTed a
    // different conversion event before CompleteRegistration fires.
    await settle(function () {
      return conversionCalls.filter(function (b) { return b && b.event_name === 'CompleteRegistration'; }).length >= 1;
    });

    var registrationCalls = conversionCalls.filter(function (b) { return b && b.event_name === 'CompleteRegistration'; });
    assert.ok(registrationCalls.length >= 1, 'expected at least one CompleteRegistration CAPI call');
    assert.equal(registrationCalls[0].fbc, 'fb.1.1700000000000.attributed', 'the CAPI call must carry the persisted _fbc cookie value');
    assert.equal(registrationCalls[0].fbp, 'fb.1.1700000000000.browserid', 'the CAPI call must carry the persisted _fbp cookie value');
  } finally {
    await context.close();
  }
});
