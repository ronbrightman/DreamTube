// test/create-question-first-and-loggedin-handoff-behavioral.test.js
//
// Coverage for two founder-reported app-funnel fixes:
//
//   FIX A — REVERTED 2026-08-13 (founder standing rule "keep the two
//   dream-creation entry flows identical"). create.html's question-first
//   entry (the six-tile "What was your dream about?" grid + Setting/Mood
//   trim, commit 6ae72c2) was surgically reverted after the paid funnel's
//   matching question-first screen tanked step1->2 conversion (56%->26%)
//   and was itself reverted on the growth side. create.html now once again
//   opens on its pre-Aug-10 Build/Write/Record chooser, and the Build flow
//   asks the Setting (Where) and Mood (feel) steps again — matching the
//   reverted funnel's dream-creation UX. The FIX-A tests below now assert
//   that RESTORED screen; the question-first assertions they replaced are
//   gone with the screen they covered. (FIX B, the handoff, is unchanged
//   and still fully covered below.)
//
//   FIX B — a LOGGED-IN funnel arrival (dreamtube.life/go -> redirectToApp
//   -> /start.html?resume=1&caption=..., and the wizard.html handoff leg)
//   must ADOPT the carried dream and GENERATE it directly (skip the signup
//   wall -- they already have an account -- via the signed-in generate path
//   home.html?generate=1), instead of being routed into create.html's fresh
//   builder and LOSING the dream. A NEW (logged-out) funnel arrival must
//   still go signup-wall -> generate, unchanged.
//
// Zero real fal.ai cost -- generate-video/video-status are mocked via
// page.route(), per AGENT_POLICY.md's "keep generation-testing cost low".
// Follows this repo's established Playwright/node:test convention (same
// static-server + blockThirdParty + Chromium-path shape as
// test/wizard-ui-behavioral.test.js / test/mood-music-bed-behavioral.test.js).

var test = require('node:test');
var assert = require('node:assert/strict');
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

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    return route.abort();
  });
}

async function safeGoto(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
  catch (e) { await page.goto(url, { waitUntil: 'commit' }); }
}

async function seedLoggedInUserAt(page, username, path) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var state = { user: { handle: '@' + u, username: u }, accounts: {}, dreams: [], draft: { caption: '', style: null, characterIds: [], sceneryTime: null, sceneryPlace: null, restore: false }, charactersByUser: {}, likedIds: {} };
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await safeGoto(page, baseUrl + path);
}

/** Mocks generate-video + video-status + mark-generation-completed so a real
 *  signed-in generation "kicks off" (and completes) with no fal.ai cost.
 *  Returns an array the test can read: each generate-video request's parsed
 *  body (its `caption` is the engineered prompt sent to generation). */
function mockGeneration(page) {
  var calls = [];
  page.route('**/.netlify/functions/generate-video', function (route) {
    var body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave {} */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'mock:op-123', modelUsed: 'veo-lite' }) });
  });
  page.route('**/.netlify/functions/video-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'succeeded', videoUrl: '/assets/store/dream-ocean.webp' }) });
  });
  page.route('**/.netlify/functions/mark-generation-completed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 }) });
  });
  return calls;
}

// ===========================================================================
// FIX A (REVERTED) — create.html opens on the pre-Aug-10 Build/Write/Record
// chooser again, and the Build flow asks Setting + Mood again. The
// question-first tile grid + Setting/Mood trim of commit 6ae72c2 are gone.
// ===========================================================================

test('create.html reverted entry: the default screen is the Build/Write/Record chooser (#create-select visible), NOT the question-first tile grid', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserAt(page, 'revEntry', '/create.html');

    await page.waitForSelector('#create-select', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#create-select').isVisible(), true, 'the Build/Write/Record chooser is the default entry');

    // The three original choice cards are present and readable.
    assert.equal(await page.locator('#choice-build').count(), 1, 'Build-it card present');
    assert.equal(await page.locator('#choice-write').count(), 1, 'Write-it card present');
    // Record-it card is present in the DOM (may be hidden in an in-app
    // webview by the detectInAppHost guard, but this is a normal context).
    assert.equal(await page.locator('#choice-record').count(), 1, 'Record-it card present');
    var chooserText = await page.locator('#create-select').textContent();
    assert.match(chooserText, /Build it/, 'chooser reads "Build it"');
    assert.match(chooserText, /Write it/, 'chooser reads "Write it"');

    // The question-first screen is fully gone — no tile grid, no hero, no
    // Speak-it link, no question-active screen at all.
    assert.equal(await page.locator('#create-question').count(), 0, 'no question-first screen element');
    assert.equal(await page.locator('#create-q-grid').count(), 0, 'no question-first tile grid');
    assert.equal(await page.locator('#create-q-speak').count(), 0, 'no Speak-it link');
  } finally {
    await context.close();
  }
});

test('create.html Build flow is the 3-question trim (Subject -> Action -> Free text); Setting and Mood are inferred, NOT shown — kept identical to the paid funnel + wizard.html (founder directive 08-13: unify always, shorter version)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserAt(page, 'revBuild', '/create.html');

    await page.waitForSelector('#choice-build', { state: 'visible', timeout: 5000 });
    await page.click('#choice-build');

    // 3-question order: Subject -> Action -> Free text. Setting (Where) and
    // Mood (feel) are PARKED — Setting is inferred from the action by the
    // shared WizardChips.buildDeterministicStory, Mood defaults to 'dreamy'
    // — exactly as the funnel and wizard.html do it. Founder directive 08-13:
    // "I want them unified always. Obviously the shorter version as it
    // converts better."
    // Step 1: Subject. Skip it.
    await page.waitForSelector('#build-subject-chip-row', { timeout: 5000 });
    await page.click('#build-subject-skip');

    // Step 2 is Action directly — NO Setting step in between.
    await page.waitForSelector('#build-action-row', { timeout: 5000 });
    assert.equal(await page.locator('#build-place-row').count(), 0, 'the Setting (Where) step must NOT render — it is inferred, per the 3-question trim');
    await page.click('#build-action-continue');

    // Step 3 is the Free-text step directly — NO Mood step in between.
    await page.waitForSelector('#build-freetext-input', { timeout: 5000 });
    assert.equal(await page.locator('#build-mood-row').count(), 0, 'the Mood (feel) step must NOT render — it defaults to dreamy, per the 3-question trim');

    // Exactly 3 progress dots.
    var dots = await page.locator('#build-dots i').count();
    assert.equal(dots, 3, 'the Build-it wizard shows 3 progress dots');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// FIX B — logged-in funnel handoff GENERATES the dream (never loses it)
//   UNCHANGED by the FIX-A revert above — the handoff lives in start.html /
//   wizard.html, not create.html, and must stay green.
// ===========================================================================

var FUNNEL_CAPTION = 'a lucid dream of flying over a city made of glass, dreamlike.';

test('start.html: a SIGNED-IN funnel arrival (?resume=1 + caption) adopts the carried dream and GENERATES it directly (home.html?generate=1) -- it must NOT land on create.html and must NOT lose the caption', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var genCalls = mockGeneration(page);

    await seedLoggedInUserAt(page, 'funnelmember', '/start.html?resume=1&caption=' + encodeURIComponent(FUNNEL_CAPTION) + '&style=Cinematic');

    // Lands on home.html (the signed-in generate path), NEVER create.html.
    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.doesNotMatch(page.url(), /create\.html/, 'a signed-in funnel arrival must not be dropped into create.html');

    // The carried dream survives onto the draft (caption not lost)...
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.equal(draft.caption, FUNNEL_CAPTION, 'the funnel caption must survive onto the draft, verbatim');
    assert.equal(draft.style, 'Cinematic', 'the funnel style survives too');

    // ...and generation actually kicks off with that caption.
    await page.waitForFunction(function () { return true; }, null, { timeout: 500 }).catch(function () {});
    await page.waitForFunction(function () { return window.DreamStore && window.DreamStore.getPendingJob && window.DreamStore.getPendingJob(); }, null, { timeout: 8000 });
    assert.ok(genCalls.length >= 1, 'generate-video must have been called -- the dream is generated, not lost');
    assert.equal(genCalls[0].caption, FUNNEL_CAPTION, 'the generation request carries the funnel caption');
  } finally {
    await context.close();
  }
});

test('wizard.html: a SIGNED-IN funnel handoff (?resume=1 + caption) also generates the dream directly (home.html?generate=1) instead of bouncing to create.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var genCalls = mockGeneration(page);

    await seedLoggedInUserAt(page, 'funnelmember2', '/wizard.html?resume=1&caption=' + encodeURIComponent(FUNNEL_CAPTION) + '&style=Cinematic');

    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.doesNotMatch(page.url(), /create\.html/, 'the wizard.html signed-in handoff must not bounce to create.html');

    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.equal(draft.caption, FUNNEL_CAPTION, 'the funnel caption survives onto the draft');

    await page.waitForFunction(function () { return window.DreamStore && window.DreamStore.getPendingJob && window.DreamStore.getPendingJob(); }, null, { timeout: 8000 });
    assert.ok(genCalls.length >= 1, 'generate-video must have been called');
    assert.equal(genCalls[0].caption, FUNNEL_CAPTION, 'the generation request carries the funnel caption');
  } finally {
    await context.close();
  }
});

test('wizard.html: a NEW (logged-out) funnel arrival is UNCHANGED -- it lands on the signup wall and does NOT auto-generate (signup-wall -> generate stays intact)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var genCalls = mockGeneration(page);

    // No signed-in user seeded -- a genuine logged-out funnel arrival.
    await safeGoto(page, baseUrl + '/wizard.html?resume=1&caption=' + encodeURIComponent(FUNNEL_CAPTION) + '&style=Cinematic');
    // Give any (incorrect) redirect a chance to fire.
    await page.waitForTimeout(1200);

    assert.match(page.url(), /wizard\.html/, 'a logged-out funnel arrival must stay on the wizard signup-wall flow, not redirect to home/create');
    assert.equal(genCalls.length, 0, 'a logged-out arrival must NOT auto-generate -- generation happens after the signup wall, unchanged');
  } finally {
    await context.close();
  }
});
