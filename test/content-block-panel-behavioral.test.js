// test/content-block-panel-behavioral.test.js
//
// Behavioral coverage for js/content-block-panel.js — the PERSISTENT recovery
// panel shown when the content-tier gate blocks a dream as explicit (founder
// upgrade 2026-08-08). Drives ContentBlockPanel.show() directly in a real
// browser (loaded via home.html, which includes the component) with the
// /.netlify/functions/soften-dream-text endpoint stubbed via page.route, so
// the panel's soften -> re-gate branch is exercised without any real call.
//
// Asserts the founder's requirements: the panel RENDERS and PERSISTS (no
// auto-dismiss, unlike the old toast); the message WRAPS (no white-space:
// nowrap, readable multi-line on a phone); "Soften it for me" on success
// hands the softened text to the page's editable field; a still-explicit
// soften re-shows the panel with a can't-soften note; the named-other-person
// case HIDES "Soften it for me"; and Discard does nothing but close.

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };

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

/** Stubs the soften endpoint to return a fixed JSON payload. */
function stubSoften(page, payload) {
  return page.route(/\/\.netlify\/functions\/soften-dream-text/, function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

/**
 * Loads a minimal page and injects js/content-block-panel.js (the same file
 * home.html/result.html include) as a real <script> from the static server —
 * a true isolation test of the component, without a full app page's own auth
 * redirects (home.html sends a logged-out visitor to login.html) getting in
 * the way. This is the production file served over HTTP, not a copy.
 */
async function pageWithPanel(context) {
  var page = await context.newPage();
  await blockThirdParty(page);
  await page.goto(baseUrl + '/offline.html', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: baseUrl + '/js/content-block-panel.js' });
  await page.waitForFunction(function () { return !!window.ContentBlockPanel; }, { timeout: 5000 });
  return page;
}

/** Calls ContentBlockPanel.show with callbacks that record their invocation on window. */
function showPanel(page, opts) {
  return page.evaluate(function (o) {
    window.__cbp = { applied: null, appliedCount: 0, discarded: 0 };
    window.ContentBlockPanel.show({
      message: o.message,
      namedPerson: o.namedPerson,
      originalText: o.originalText,
      onApplyText: function (t) { window.__cbp.applied = t; window.__cbp.appliedCount++; },
      onDiscard: function () { window.__cbp.discarded++; }
    });
  }, opts);
}

var EXPLICIT_MSG = "We can't turn explicit sexual content into a video — try describing the scene without it.";
var NAMED_MSG = "For safety, we can't create romantic or intimate videos featuring a real person you've named and added a photo of.";

test('panel renders, PERSISTS (no auto-dismiss), and the message wraps', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);
    await showPanel(page, { message: EXPLICIT_MSG, namedPerson: false, originalText: 'blocked text' });

    assert.equal(await page.locator('#cbp-root').count(), 1, 'panel is shown');
    // The message text is present and readable.
    var msg = await page.locator('.cbp-msg').innerText();
    assert.match(msg, /explicit sexual content/);
    // MUST wrap — never white-space:nowrap.
    var ws = await page.locator('.cbp-msg').evaluate(function (el) { return getComputedStyle(el).whiteSpace; });
    assert.notEqual(ws, 'nowrap', 'the block message must be allowed to wrap, never single-line nowrap');

    // Persists well past the old 2200ms toast auto-dismiss.
    await page.waitForTimeout(2600);
    assert.equal(await page.locator('#cbp-root').count(), 1, 'panel must still be present — it never auto-dismisses');
  } finally {
    await context.close();
  }
});

test('non-named block offers Soften; Soften SUCCESS hands the softened text to the editable field', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);
    await stubSoften(page, { softenedText: 'I danced closely with someone I loved.', allowed: true, tier: 'romantic', message: null });
    await showPanel(page, { message: EXPLICIT_MSG, namedPerson: false, originalText: 'having sex' });

    // Soften is offered for the normal explicit case.
    var softenBtn = page.locator('.cbp-btn', { hasText: 'Soften it for me' });
    assert.equal(await softenBtn.count(), 1, 'Soften is offered for a non-named explicit block');

    await softenBtn.click();
    await page.waitForFunction(function () { return window.__cbp && window.__cbp.appliedCount > 0; }, { timeout: 5000 });
    var applied = await page.evaluate(function () { return window.__cbp.applied; });
    assert.equal(applied, 'I danced closely with someone I loved.', 'the softened text is handed to the editable field');
    assert.equal(await page.locator('#cbp-root').count(), 0, 'panel closes once the softened text is applied');
  } finally {
    await context.close();
  }
});

test('Soften that is STILL explicit re-shows the panel with a can\'t-soften note and no re-soften option', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);
    await stubSoften(page, { softenedText: 'we had sex again', allowed: false, tier: 'explicit', message: EXPLICIT_MSG });
    await showPanel(page, { message: EXPLICIT_MSG, namedPerson: false, originalText: 'having sex' });

    await page.locator('.cbp-btn', { hasText: 'Soften it for me' }).click();
    // The note appears and onApplyText is NOT called.
    await page.waitForSelector('.cbp-note', { timeout: 5000 });
    var note = await page.locator('.cbp-note').innerText();
    assert.match(note, /couldn.t soften it enough/i);
    assert.equal(await page.locator('#cbp-root').count(), 1, 'panel stays open on a failed soften');
    assert.equal(await page.locator('.cbp-btn', { hasText: 'Soften it for me' }).count(), 0, 'no re-soften loop after it already failed');
    var appliedCount = await page.evaluate(function () { return window.__cbp.appliedCount; });
    assert.equal(appliedCount, 0, 'a still-explicit soften never applies text / never generates');
  } finally {
    await context.close();
  }
});

test('named-other-person block HIDES Soften and offers only Edit / Discard', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);
    await showPanel(page, { message: NAMED_MSG, namedPerson: true, originalText: 'a romantic scene with Alex' });

    assert.equal(await page.locator('.cbp-btn', { hasText: 'Soften it for me' }).count(), 0, 'Soften is hidden for the named-person case (softening can\'t help)');
    assert.equal(await page.locator('.cbp-btn', { hasText: 'Edit it myself' }).count(), 1);
    assert.equal(await page.locator('.cbp-btn', { hasText: 'Discard' }).count(), 1);
  } finally {
    await context.close();
  }
});

test('Edit hands the ORIGINAL text back; Discard closes and applies nothing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);

    // Edit
    await showPanel(page, { message: EXPLICIT_MSG, namedPerson: false, originalText: 'my original dream text' });
    await page.locator('.cbp-btn', { hasText: 'Edit it myself' }).click();
    await page.waitForFunction(function () { return window.__cbp && window.__cbp.appliedCount > 0; }, { timeout: 5000 });
    assert.equal(await page.evaluate(function () { return window.__cbp.applied; }), 'my original dream text');
    assert.equal(await page.locator('#cbp-root').count(), 0, 'panel closes on Edit');

    // Discard
    await showPanel(page, { message: EXPLICIT_MSG, namedPerson: false, originalText: 'whatever' });
    await page.locator('.cbp-btn', { hasText: 'Discard' }).click();
    await page.waitForFunction(function () { return document.getElementById('cbp-root') === null; }, { timeout: 5000 });
    var state = await page.evaluate(function () { return window.__cbp; });
    assert.equal(state.discarded, 1, 'Discard fires onDiscard');
    assert.equal(state.appliedCount, 0, 'Discard applies no text / generates nothing');
  } finally {
    await context.close();
  }
});
