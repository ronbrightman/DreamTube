// test/presignup-content-gate-behavioral.test.js
//
// Real browser-driven coverage for the PRE-SIGNUP content gate
// (founder-directed 2026-08-14). The gate runs the same explicit-content
// classification the generation-time gate uses
// (netlify/functions/check-dream-content.js) BEFORE the visitor's signup /
// CompleteRegistration conversion, so explicit-content seekers never sign up.
//
// RETARGETED 2026-08-14 (unify-all-creation-flows, founder): the gate used to
// run on wizard.html's own editable recap step (the organic chip flow). That
// creation flow is retired to a funnel-arrival receiver — a bare wizard.html
// hit now redirects to /go/, and the ONLY live path onto the page is the
// growth-funnel handoff (?resume=1&caption=...), which lands DIRECTLY on the
// signup wall. So the gate now runs at the WALL SUBMIT (checkDreamContentAllowed
// in wizard.html's trySubmit, funnelArrival-gated): the funnel-carried dream
// text is classified when the visitor submits their email, BEFORE any
// start-pending-generation / signup / CompleteRegistration fires. This suite
// asserts that live behavior end to end.
//
// Follows test/wizard-ui-behavioral.test.js's conventions exactly: a plain
// static file server, page.route() intercept for the endpoints this exercises
// (check-dream-content — decided here by inspecting the POSTed caption so the
// REAL client wiring is tested), blockThirdParty() for the sandbox's flaky
// outbound network.

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

/**
 * Intercepts the pre-signup content-gate endpoint and answers by inspecting
 * the POSTed caption — explicit (contains "sex"/"naked"/"nude") is blocked,
 * clean is allowed — so the test drives the REAL client wiring (assemble text
 * -> POST -> act on { allowed, tier }) rather than a stub of it. Returns a
 * counter of how many times the endpoint was actually hit.
 */
function routeContentGate(page) {
  var state = { calls: 0 };
  page.route('**/.netlify/functions/check-dream-content', function (route) {
    state.calls++;
    var body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    var caption = (body.caption || '').toLowerCase();
    var explicit = /\bsex\b|naked|nude/.test(caption);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(explicit ? { allowed: false, tier: 'explicit' } : { allowed: true, tier: 'clean' })
    });
  });
  return state;
}

async function safeGoto(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
  catch (e) { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
}

/** Lands on wizard.html's signup wall as a growth-funnel arrival carrying `caption` (the live path onto the wall). */
async function reachWallWithCaption(page, caption) {
  await safeGoto(page, baseUrl + '/wizard.html?resume=1&caption=' + encodeURIComponent(caption) + '&style=Anime');
  await page.waitForSelector('#contact-email');
}

test('wizard.html funnel-arrival wall: an EXPLICIT funnel-carried dream is BLOCKED at the email submit — the revise message shows, and NO generation, signup, or navigation fires (the pre-signup gate runs before CompleteRegistration)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var gate = routeContentGate(page);
  var startPendingCalls = 0;
  var signupCalls = 0;
  await page.route('**/.netlify/functions/start-pending-generation', function (route) {
    startPendingCalls++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-x', operationName: 'op-x' }) });
  });
  await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
    signupCalls++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: true }) });
  });
  await page.route('**/.netlify/functions/check-email', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
  });
  try {
    await reachWallWithCaption(page, 'we had sex on the beach all night');
    await page.fill('#contact-email', 'explicit-seeker@example.com');
    await page.click('#fn-contact-continue');

    // The revise message appears in the wall's own error slot...
    await page.waitForFunction(function () {
      var e = document.getElementById('contact-error');
      return e && /explicit sexual content isn’t allowed/.test(e.textContent);
    }, null, { timeout: 5000 });
    assert.ok(gate.calls >= 1, 'the content-gate endpoint was actually called at the wall submit');

    // ...and NOTHING downstream of the gate fired: no billed generation, no
    // account, and the visitor is still sitting on the wall (no navigation).
    await page.waitForTimeout(300);
    assert.equal(startPendingCalls, 0, 'an explicit dream must NOT fire the real, billed pending generation');
    assert.equal(signupCalls, 0, 'an explicit dream must NOT create an account / fire CompleteRegistration');
    assert.match(page.url(), /wizard\.html/, 'must stay on the wall, not navigate');
    assert.equal(await page.locator('#contact-email').count(), 1, 'still on the signup wall (email field present)');
  } finally {
    await page.close();
  }
});

test('wizard.html funnel-arrival wall: a CLEAN funnel-carried dream passes the gate at submit and proceeds to the real pending generation, with no revise message', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var gate = routeContentGate(page);
  await page.route('**/.netlify/functions/check-email', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
  });
  var startPendingRequested = false;
  await page.route('**/.netlify/functions/start-pending-generation', function (route) {
    startPendingRequested = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-clean', operationName: 'op-clean' }) });
  });
  await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: true, username: 'cleanuser' }) });
  });
  try {
    await reachWallWithCaption(page, 'I was flying peacefully over a glowing city of glass');
    await page.fill('#contact-email', 'clean-dreamer@example.com');
    await page.click('#fn-contact-continue');

    // The gate passes, so the flow proceeds to the real pending generation
    // (which fires BEFORE signup — see wizard.html's trySubmit ordering).
    var start = Date.now();
    while (!startPendingRequested && Date.now() - start < 6000) {
      await page.waitForTimeout(150);
    }
    assert.ok(gate.calls >= 1, 'the content-gate endpoint was called at the wall submit');
    assert.ok(startPendingRequested, 'a clean dream passes the gate and fires the real pending generation');
    var errText = await page.evaluate(function () { var e = document.getElementById('contact-error'); return e ? e.textContent : ''; });
    assert.doesNotMatch(errText, /explicit sexual content/, 'no revise message on a clean dream');
  } finally {
    await page.close();
  }
});
