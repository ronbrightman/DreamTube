// test/someone-character-no-photo-behavioral.test.js
//
// Founder call 2026-08-14 (unify-all-creation-flows): the app never lets a
// "someone I know / someone-specific" (non-self) character carry an uploaded
// PHOTO — only the self ("Me") character may. This was already true at every
// layer of the shipped client (the "someone photo" path was never wired), and
// this file LOCKS THAT IN so it can't silently regress:
//
//   1. The LIVE create.html character sheets (the logged-in creator's Build
//      subject sheet — the only character sheet a real user can still open, now
//      that wizard.html's own chip-build flow is retired to a funnel-arrival
//      receiver) show the Describe/Upload-photo toggle ONLY for the self sheet,
//      never for a non-self character.
//   2. DreamStore.saveCharacter — the shared client backstop every creation
//      surface funnels through, including the funnel character stash adopted on
//      the wizard.html signup wall — strips photoDataUrl off any non-self
//      character, even when one is handed in explicitly.
//
// This is the CLIENT-side ability only. The SERVER-side anti-NCII backstop
// (contentClassifier.detectNamedOtherPersonPhoto + the fail-closed named-photo
// path in generate-video.js / check-dream-content.js) is deliberately left in
// place as a safety net and is covered by test/content-classifier.test.js /
// test/check-dream-content.test.js / test/content-gate-generation.test.js.
//
// Follows this repo's Playwright/node:test conventions (same static-server +
// blockThirdParty + Chromium-path shape as
// test/create-question-first-and-loggedin-handoff-behavioral.test.js).

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

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    return route.abort();
  });
}

async function safeGoto(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
  catch (e) { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
}

async function seedLoggedInAndOpenCreate(page, username) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var state = { user: { handle: '@' + u, username: u }, accounts: {}, dreams: [], draft: { caption: '', style: null, characterIds: [], sceneryTime: null, sceneryPlace: null, restore: false }, charactersByUser: {}, likedIds: {} };
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await safeGoto(page, baseUrl + '/create.html');
}

test('create.html Build sheet: the "Someone I know" (non-self) character sheet shows NO photo toggle and NO photo area — only Describe — while the "Me" (self) sheet DOES offer the Upload-photo toggle', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInAndOpenCreate(page, 'nophotoOther');

    await page.waitForSelector('#choice-build', { state: 'visible', timeout: 5000 });
    await page.click('#choice-build');
    await page.waitForSelector('#build-subject-chip-row', { timeout: 5000 });

    // (a) "Someone I know" -> non-self sheet: photo toggle + photo area hidden.
    await page.click('#build-subj-add-other');
    await page.waitForSelector('#build-sheet-character-overlay.open', { timeout: 5000 });
    assert.equal(await page.locator('#build-char-mode-row').isVisible(), false, 'a "Someone I know" character must NOT show the Describe/Upload-photo toggle');
    assert.equal(await page.locator('#build-char-photo-area').isVisible(), false, 'a "Someone I know" character must NOT expose the photo upload area');
    // The name field IS shown for a non-self character (name + description only).
    assert.equal(await page.locator('#build-char-name-input').isVisible(), true, 'a "Someone I know" character keeps its name field (name + description, no photo)');

    // Close the sheet (Cancel) and open the self ("Me") sheet instead.
    await page.click('#build-char-cancel');
    await page.waitForSelector('#build-subject-chip-row', { timeout: 5000 });

    // (b) "Me" -> self sheet: photo toggle IS present (self keeps its photo).
    await page.click('#build-subj-add-self');
    await page.waitForSelector('#build-char-mode-row', { timeout: 5000 });
    assert.equal(await page.locator('#build-char-mode-row').isVisible(), true, 'the "Me" (self) sheet MUST still offer the Describe/Upload-photo toggle');
    var toggleText = await page.locator('#build-char-mode-row').textContent();
    assert.match(toggleText, /photo/i, 'the self sheet toggle still includes an Upload-photo option');
  } finally {
    await context.close();
  }
});

test('DreamStore.saveCharacter (the shared client backstop) strips photoDataUrl off any non-self character, even when one is handed in explicitly — self is the only character that may carry a photo', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInAndOpenCreate(page, 'storeBackstop');
    var result = await page.evaluate(function () {
      // A tiny valid data URL — the shape a photo upload would produce.
      var fakePhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC';
      // A NAMED non-self character with a photo handed in explicitly — exactly
      // what a "someone I know" photo path would try to persist.
      var other = window.DreamStore.saveCharacter({ isSelf: false, name: 'Alex', description: 'tall, short dark hair', photoDataUrl: fakePhoto });
      // The self character CAN carry a photo.
      var self = window.DreamStore.saveCharacter({ isSelf: true, name: '', description: 'me', photoDataUrl: fakePhoto });
      return {
        otherOk: other.ok,
        otherHasPhoto: !!(other.character && other.character.photoDataUrl),
        selfOk: self.ok,
        selfHasPhoto: !!(self.character && self.character.photoDataUrl)
      };
    });
    assert.equal(result.otherOk, true, 'a named non-self character still saves (name + description)');
    assert.equal(result.otherHasPhoto, false, 'saveCharacter MUST strip photoDataUrl off a non-self character — the client-side someone-photo backstop');
    assert.equal(result.selfOk, true, 'the self character saves');
    assert.equal(result.selfHasPhoto, true, 'the self character keeps its photo — self is the only character that may carry one');
  } finally {
    await page.close();
  }
});
