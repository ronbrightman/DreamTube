// test/start-photo-upload-sheet-token-behavioral.test.js
//
// Regression coverage for tracker item
// fix-pre-existing-photo-upload-cancel-reo-svrjyv (branch
// photo-upload-sheet-instance-token-guard): start.html's Advanced >
// Characters screen (renderScreenAdvChars) character-sheet photo-upload
// handler had the same unguarded-async shape already found and fixed
// (round 4) in profile.html/create.html via a per-sheet-instance token
// (identitySheetToken/charSheetToken) -- pick a photo, close the sheet
// before resizeImageFile resolves, reopen for a DIFFERENT character, and
// the stale resize could silently overwrite the wrong character's photo
// state once it finally resolved. Fix here mirrors that exact pattern: a
// module-level charSheetToken (declared once, outside renderScreenAdvChars
// itself so it survives that function's own re-renders/rebinding) bumped
// on every open/close, captured locally when the async resize starts, and
// re-checked before the resolve handler writes anything.
//
// Follows test/avatar-describe-behavioral.test.js's round-4 regression
// test conventions, with the same adaptation test/wizard-photo-upload-
// sheet-token-behavioral.test.js uses: start.html's whole script is
// wrapped in a `(function(){ 'use strict'; ... })()` IIFE, so
// resizeImageFile is a LOCAL binding, not a `window` property --
// reassigning window.resizeImageFile (what the profile.html/create.html
// tests do) would never be seen by start.html's own call site. This
// instead overrides the global `window.FileReader` constructor (a real
// global identifier resolved through the normal scope chain regardless of
// the IIFE) to hold the FIRST async step pending on command, while the
// real Image decode + canvas draw after it run unmodified -- see that
// test file's own header comment for the fuller rationale.
//
// Also like wizard.html, start.html stages characters in-memory (`staged`,
// local to the IIFE, unreachable from outside) until real signup, so
// persistence is verified by reopening the sheet again and reading the
// rendered photo preview, which openCharSheet always repopulates fresh
// from the (real) character object's own photoDataUrl.
//
// Reaches the characters screen the same way test/funnel-signup-
// navigation-token-guard-behavioral.test.js's resumeUrl helper does, but
// with a caption that DOES contain first-person language (captionSuggestsPeople)
// so renderScreenAdvChars is actually included in SCREEN_RENDERERS and is
// the very first screen shown -- see start.html's own SCREEN_RENDERERS
// construction comment.

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var PHOTO_FIXTURE = path.join(__dirname, '..', 'assets', 'logo-v2.png');
var PHOTO_FIXTURE_2 = path.join(__dirname, '..', 'assets', 'style-previews', 'cartoon.jpg');

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
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Same base resume params test/funnel-signup-navigation-token-guard-behavioral.test.js's resumeUrl uses, but with first-person language so the characters screen is included and shown first. */
function resumeUrlWithPeople(caption) {
  return baseUrl + '/start.html?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption);
}

/**
 * Holds the FIRST async step of the real resizeImageFile pipeline
 * (FileReader.readAsDataURL's onload) pending until the test explicitly
 * releases it via window.__releaseResize() -- see test/wizard-photo-
 * upload-sheet-token-behavioral.test.js's header comment for the full
 * rationale (identical technique, same IIFE-wrapping reason).
 */
function armControllableFileReader(page) {
  return page.evaluate(function () {
    var NativeFileReader = window.FileReader;
    window.__releaseResize = null;
    function ControllableFileReader() {
      var native = new NativeFileReader();
      var self = this;
      native.onload = function () {
        window.__releaseResize = function () {
          self.result = native.result;
          if (typeof self.onload === 'function') self.onload();
        };
      };
      native.onerror = function (e) { if (typeof self.onerror === 'function') self.onerror(e); };
      this.readAsDataURL = function (file) { native.readAsDataURL(file); };
    }
    window.FileReader = ControllableFileReader;
  });
}

test('start.html: cancelling a photo pick on the self character\'s sheet, then reopening for a DIFFERENT (non-self) character, must not let the stale resize leak into either character once it resolves', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, resumeUrlWithPeople('I was walking through a forest with my mother.'));
    await page.waitForSelector('#char-chip-row');
    await page.waitForSelector('#char-add-self');

    // Create the self character with a REAL photo (unstubbed resize) so it
    // has a real, known-good photoDataUrl to protect.
    await page.click('#char-add-self');
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.click('#char-mode-row [data-char-mode="photo"]');
    await page.setInputFiles('#char-photo-input', PHOTO_FIXTURE);
    await page.waitForSelector('#char-photo-preview img');
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // Create a second, non-self character ("Mom") -- its sheet has no
    // photo picker at all (char-mode-row/char-photo-area stay hidden for
    // isSelf:false).
    await page.click('#char-add-other');
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.fill('#char-name-input', 'Mom');
    await page.fill('#char-desc-input', 'short grey hair, warm smile');
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // Reopen the self character to read back its real, persisted photo.
    var selfCharId = await page.evaluate(function () {
      return document.querySelector('.char-chip .chip-edit-area[data-char-edit]').dataset.charEdit;
    });
    await page.click('[data-char-edit="' + selfCharId + '"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    var originalPhoto = await page.locator('#char-photo-preview img').getAttribute('src');
    assert.ok(originalPhoto && originalPhoto.indexOf('data:image') === 0, 'expected a real resized photo data URL');

    // Pick a DIFFERENT photo, held pending via the controllable FileReader.
    await armControllableFileReader(page);
    await page.setInputFiles('#char-photo-input', PHOTO_FIXTURE_2);
    await page.waitForFunction(function () { return typeof window.__releaseResize === 'function'; });

    // Back out before the pending resize ever resolves.
    await page.click('#char-cancel');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // Find Mom's id (the character that is NOT the self one) and reopen
    // HER sheet.
    var momId = await page.evaluate(function (selfId) {
      var editEls = document.querySelectorAll('.char-chip .chip-edit-area[data-char-edit]');
      for (var i = 0; i < editEls.length; i++) {
        if (editEls[i].dataset.charEdit !== selfId) return editEls[i].dataset.charEdit;
      }
      return null;
    }, selfCharId);
    assert.ok(momId, 'expected to find Mom\'s character id in the chip row');

    await page.click('[data-char-edit="' + momId + '"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-sheet-title').textContent(), 'Edit character');
    assert.equal(await page.locator('#char-mode-row').isVisible(), false, 'a non-self character sheet must never show the photo/describe toggle');
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // Reopen the self character sheet again -- openCharSheet's own
    // unconditional per-open reset must show the real original photo, not
    // the abandoned pick, and this happens BEFORE the stale resize is
    // allowed to resolve below (masking-order rule).
    await page.click('[data-char-edit="' + selfCharId + '"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), originalPhoto, 'reopened sheet must show the character\'s real photo, not the abandoned pick');

    // Only now does the stale resize resolve -- well after both the Mom
    // reopen AND this self-character reopen.
    await page.evaluate(function () { window.__releaseResize(); });
    await page.waitForTimeout(300); // real Image decode + canvas draw, not instant

    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), originalPhoto, 'the stale resize must not clobber the reopened sheet\'s preview once it resolves, even after being reopened for a different character along the way');

    // Save without re-picking a photo, then reopen ONE more time -- proves
    // the actual persisted (staged, in-memory) character object still
    // carries the real original photo, not the stale one.
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');
    await page.click('[data-char-edit="' + selfCharId + '"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), originalPhoto, 'the stale, abandoned photo pick must never be persisted onto the self character either');
  } finally {
    await page.close();
  }
});
