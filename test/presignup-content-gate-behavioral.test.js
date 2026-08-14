// test/presignup-content-gate-behavioral.test.js
//
// Real browser-driven coverage for the PRE-SIGNUP content gate
// (founder-directed 2026-08-14) wired into wizard.html's recap step. The
// gate runs the same explicit-content classification the generation-time
// gate uses (netlify/functions/check-dream-content.js) BEFORE the visitor
// reaches the signup wall, so explicit-content seekers never fire the
// CompleteRegistration conversion.
//
// Asserts the founder's requirement end-to-end: an explicit dream text on
// the recap step shows the revise message and does NOT reach the signup
// wall (no email entry possible); a clean dream text passes through to the
// wall unchanged.
//
// Follows test/wizard-ui-behavioral.test.js's conventions exactly: a plain
// static file server, page.route() intercept for the one function endpoint
// this exercises (check-dream-content — decided here by inspecting the
// POSTed caption so the REAL client wiring is tested), blockThirdParty()
// for this sandbox's flaky outbound network.

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
 * the POSTed caption — explicit (contains "sex"/"naked") is blocked, clean
 * is allowed — so the test drives the REAL client wiring (assemble text ->
 * POST -> act on { allowed, tier }) rather than a stub of it. Returns a
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

/** Enters wizard.html via the "Someone specific" build tile and walks Subject -> Action -> Style -> free text to the editable recap step. */
async function gotoWizardRecap(page) {
  await safeGoto(page, baseUrl + '/wizard.html');
  await page.click('#fn-q-grid [data-tile="2"]');
  await page.waitForSelector('#sheet-character-overlay.open');
  await page.click('#char-cancel');
  await page.waitForSelector('#subject-chip-row');
  // Subject
  await page.click('#subject-other-row [data-subj-other="stranger"]');
  await page.click('#fn-subject-continue');
  // Action (required)
  await page.waitForSelector('#action-row [data-action="flying"]');
  await page.click('#action-row [data-action="flying"]');
  await page.click('#fn-action-continue');
  // Style (auto-advances)
  await page.waitForSelector('#style-grid [data-style="Anime"]');
  await page.click('#style-grid [data-style="Anime"]');
  // Free text — skip
  await page.waitForSelector('#fn-freetext-skip');
  await page.click('#fn-freetext-skip');
  // Recap (editable)
  await page.waitForSelector('#fn-story-recap-text');
}

test('wizard.html: an EXPLICIT dream on the recap step shows the revise message and does NOT reach the signup wall', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var gate = routeContentGate(page);
  try {
    await gotoWizardRecap(page);
    // Replace the recap text with explicit content and continue.
    await page.fill('#fn-story-recap-text', 'we had sex on the beach all night');
    await page.click('#fn-recap-continue');

    // The revise message appears...
    await page.waitForSelector('#fn-recap-gate-error', { timeout: 5000 });
    var msg = await page.textContent('#fn-recap-gate-error');
    assert.match(msg, /explicit sexual content isn’t allowed/);
    assert.ok(gate.calls >= 1, 'the content-gate endpoint was actually called');

    // ...and the signup wall's email field is NOT reachable — we're still on
    // the editable recap step.
    assert.equal(await page.locator('#contact-email').count(), 0, 'must NOT advance to the signup wall on an explicit dream');
    assert.equal(await page.locator('#fn-story-recap-text').count(), 1, 'stays on the editable recap step');
  } finally {
    await page.close();
  }
});

test('wizard.html: a CLEAN dream on the recap step passes through to the signup wall unchanged', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  routeContentGate(page);
  try {
    await gotoWizardRecap(page);
    await page.fill('#fn-story-recap-text', 'I was flying peacefully over a glowing city of glass');
    await page.click('#fn-recap-continue');

    // Reaches the signup wall — the email field is present.
    await page.waitForSelector('#contact-email', { timeout: 5000 });
    assert.equal(await page.locator('#contact-email').count(), 1, 'a clean dream reaches the signup wall');
    assert.equal(await page.locator('#fn-recap-gate-error').count(), 0, 'no revise message on a clean dream');
  } finally {
    await page.close();
  }
});
