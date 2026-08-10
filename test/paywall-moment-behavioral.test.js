// test/paywall-moment-behavioral.test.js
//
// Real browser-driven coverage for the post-signup monetization moment wired
// into wizard.html (showMonetizationMoment): the overlay renders for a fresh
// signup on the organic wizard wall, the founder ?paywall=/?trialarm=
// overrides force each arm/variant, the CTA POSTs the correct passVariant to
// create-checkout-session-dodo, trial50 is gated off for real users, and
// DISMISS goes straight to home.html.
//
// Same conventions as test/wizard-ui-behavioral.test.js: a plain static file
// server, page.route() intercepts for the endpoints each test needs,
// signupPasswordless left UNMOCKED (register-account-passwordless 404s -> the
// store degrades to a local-only signup with created:true, which is exactly a
// fresh signup — the moment's trigger).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settleMod = require('./helpers/settle');
var settle = settleMod.settle;

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
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
  catch (e) { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
}

/** Stubs the generation/claim/email endpoints a wall signup touches, and captures every create-checkout-session-dodo POST body. Returns the captured-calls array. */
async function stubBackend(page) {
  await page.route('**/.netlify/functions/check-email', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
  });
  await page.route('**/.netlify/functions/start-pending-generation', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-mm-1', operationName: 'fal:fake-model:req-mm-1' }) });
  });
  await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
  });
  await page.route('**/.netlify/functions/video-status**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
  });
  var checkoutCalls = [];
  await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
    checkoutCalls.push(JSON.parse(route.request().postData() || '{}'));
    // Return to home.html so the CTA's location.href stays on the test server.
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: baseUrl + '/home.html', eventId: 'evt-mm-test' }) });
  });
  return checkoutCalls;
}

/** Drives a fresh organic wizard arrival to the signup wall (Flying tile -> Subject -> Style -> free text -> recap -> wall), then submits an email to trigger the moment. `search` carries founder overrides (?paywall=/?trialarm=). */
async function signupToMoment(page, search, email) {
  await safeGoto(page, baseUrl + '/wizard.html' + (search || ''));
  await page.click('#fn-q-grid [data-tile="0"]'); // Flying -> build, Action seeded + skipped
  await page.waitForSelector('#subject-chip-row');
  await page.click('[data-subj-other="none"]');
  await page.click('#fn-subject-continue');
  await page.waitForSelector('#fn-style-skip');
  await page.click('#fn-style-skip');
  await page.click('#fn-freetext-skip');
  await page.click('#fn-recap-continue');
  await page.waitForSelector('#contact-email');
  await page.fill('#contact-email', email || ('mm-' + Date.now() + '@example.com'));
  await page.click('#fn-contact-continue');
  await page.waitForSelector('.mm-overlay', { timeout: 8000 });
}

test('SUBSCRIPTION arm (forced): the Dreamer Pass paywall renders with the toggle DEFAULT OFF ($7.99 no-trial CTA)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'sub-default@example.com');
    assert.equal(await page.locator('.mm-hero').count(), 1, 'the Dreamer Pass hero renders');
    assert.match(await page.locator('.mm-name').textContent(), /Dreamer Pass/);
    // Toggle default OFF -> no-trial $7.99 CTA + SAVE badge visible.
    assert.match(await page.locator('#mm-cta').textContent(), /\$7\.99/);
    assert.equal(await page.locator('#mm-sw.on').count(), 0, 'toggle starts OFF');
  } finally { await page.close(); }
});

test('SUBSCRIPTION arm: toggle OFF -> CTA POSTs passVariant "notrial"; DISMISS then goes straight to home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'sub-notrial@example.com');
    await page.click('#mm-cta'); // toggle OFF
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].plan, 'dreamer_pass');
    assert.equal(checkoutCalls[0].passVariant, 'notrial', 'toggle OFF maps to notrial');
    assert.equal(checkoutCalls[0].email, 'sub-notrial@example.com');
  } finally { await page.close(); }
});

test('SUBSCRIPTION arm: toggle ON + trial-arm free -> passVariant "freetrial"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'sub-freetrial@example.com');
    await page.click('#mm-sw'); // toggle ON
    await page.waitForSelector('#mm-sw.on');
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].passVariant, 'freetrial', 'toggle ON + free arm maps to freetrial');
  } finally { await page.close(); }
});

test('GATE: with NO founder override, a real user toggling ON always checks out as "freetrial", NEVER "trial50"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    // Force the subscription arm but leave the trial arm to real assignment
    // (no ?trialarm). Whatever the raw 50/50 lands on, the gate collapses a
    // raw 'fifty' to 'free', so the effective checkout is always freetrial.
    await signupToMoment(page, '?paywall=subscription', 'gate-real-user@example.com');
    await page.click('#mm-sw');
    await page.waitForSelector('#mm-sw.on');
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].passVariant, 'freetrial', 'a real user can never reach trial50 while the gate is closed');
  } finally { await page.close(); }
});

test('FOUNDER OVERRIDE: ?trialarm=fifty force-reveals trial50 — toggle ON POSTs passVariant "trial50"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=fifty', 'founder-trial50@example.com');
    // The toggle-ON copy must always say "one-time" for the 50c.
    await page.click('#mm-sw');
    await page.waitForSelector('#mm-sw.on');
    assert.match(await page.locator('#mm-cue').textContent(), /one-time 50/, 'the 50c is always written as one-time');
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].passVariant, 'trial50', 'the founder override reaches trial50');
  } finally { await page.close(); }
});

test('TOKENS arm (forced): the 99c/300-token starter renders and its CTA POSTs pack "pack099"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=tokens', 'tokens-arm@example.com');
    assert.match(await page.locator('#mm-cta').textContent(), /\$0\.99|300 tokens/);
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].pack, 'pack099', 'the tokens arm reuses the pack099 starter checkout path');
    assert.ok(!checkoutCalls[0].plan, 'the tokens arm is a pack checkout, not a subscription');
  } finally { await page.close(); }
});

test('DISMISS ("Not now") goes straight to home.html with no checkout POST', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'dismiss-home@example.com');
    await page.click('.mm-notnow');
    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.match(page.url(), /home\.html/, 'dismiss lands on home.html');
    assert.equal(checkoutCalls.length, 0, 'dismiss fires no checkout');
  } finally { await page.close(); }
});

test('DISMISS via the big X also goes straight to home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await stubBackend(page);
    await signupToMoment(page, '?paywall=tokens', 'dismiss-x@example.com');
    await page.click('.mm-x');
    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.match(page.url(), /home\.html/);
  } finally { await page.close(); }
});
