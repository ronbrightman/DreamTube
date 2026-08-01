// test/prod-smoke/journey1-funnel-render.test.js
//
// Lightweight LIVE render check for docs/JOURNEY_MANIFEST.md's Journey 1
// (the paid ad funnel's handoff into this repo, start.html?resume=1&...).
// This is deliberately NOT a re-implementation of the repo's existing
// test/journey-manifest.test.js (which already pins the exact, ordered
// SCREEN_RENDERERS array at the source-code level, and runs against every
// branch/PR) — it's a much shallower, complementary confidence check that
// the CURRENTLY DEPLOYED build of start.html on the target origin actually
// SERVES that documented first screen, catching a class of bug the
// source-level test structurally cannot: a deploy that silently didn't
// ship the latest start.html, a CDN/edge caching an old bundle, a runtime
// error that keeps the screen from ever rendering in a real browser, etc.
//
// Deliberately does NOT complete a full second signup/account (this
// suite's session.test.js already creates and cleans up exactly one probe
// account, via the organic Journey 2) — advancing from the email step to
// the password step is enough to prove screen 13 itself is alive and
// wired correctly, without a second real account to manage/delete.
// start-pending-generation.js still fires for real at that email step
// (see docs/JOURNEY_MANIFEST.md) -- mocked here for the same zero-cost
// reason as session.test.js's own generation-mocks.

var test = require('node:test');
var assert = require('node:assert/strict');
var config = require('./helpers/config');
var genMocksModule = require('./helpers/generation-mocks');
var signupFlow = require('../helpers/signup-flow');

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

var origin = config.origin;
var browser = null;

test.before(async function () {
  if (unavailableReason) return;
  try {
    browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
  } catch (e) {
    unavailableReason = 'Could not launch Chromium at ' + CHROMIUM_PATH + ': ' + e.message;
  }
});

test.after(async function () {
  if (browser) await browser.close();
});

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

function resumeUrl(caption) {
  return origin + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption);
}

test('journey 1 (paid ad funnel): start.html?resume=1 serves the documented screen 13 (email -> password)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext(playwright.devices['iPhone 13']);
  try {
    var page = await context.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
      route.abort();
    });
    genMocksModule.installGenerationMocks(page); // zero-cost: see this file's own header comment

    await signupFlow.reachScreen13(page, safeGoto, resumeUrl, 'Flying over the ocean at sunset');
    assert.equal(await page.locator('#fn-email').count(), 1, 'screen 13\'s email step must render');

    await signupFlow.advanceToPasswordStep(page, 'prod-smoke-journey1-render-check@example.com');
    assert.equal(await page.locator('#fn-password').count(), 1, 'screen 13\'s password step must render after the email step advances -- the documented single-screen renderScreen13');
  } finally {
    await context.close();
  }
});
