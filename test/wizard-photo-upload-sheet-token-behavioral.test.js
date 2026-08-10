// test/wizard-photo-upload-sheet-token-behavioral.test.js
//
// Regression coverage for tracker item
// wizard-html-character-photo-upload-has-t-wqnubp (branch
// photo-upload-sheet-instance-token-guard): wizard.html's Step 1 (Subject)
// character-sheet photo-upload handler had the same unguarded-async shape
// already found and fixed (round 4) in profile.html/create.html via a
// per-sheet-instance token (identitySheetToken/charSheetToken) -- pick a
// photo, close the sheet before resizeImageFile resolves, reopen for a
// DIFFERENT character, and the stale resize could silently overwrite the
// wrong character's photo state once it finally resolved. Fix here mirrors
// that exact pattern: a module-level charSheetToken bumped on every
// open/close, captured locally when the async resize starts, and
// re-checked before the resolve handler writes anything.
//
// Follows test/avatar-describe-behavioral.test.js's round-4 regression
// test conventions, with one adaptation: wizard.html's whole script is
// wrapped in a `(function(){ 'use strict'; ... })()` IIFE (unlike
// profile.html/create.html/result.html, which declare their script at the
// top level), so resizeImageFile is a LOCAL binding inside that closure,
// not a `window` property -- reassigning window.resizeImageFile (the
// technique those other tests use) would not be seen by wizard.html's own
// call site at all. Instead this controls timing one layer down, by
// overriding the global `window.FileReader` constructor (a genuinely
// global identifier the local resizeImageFile resolves through the normal
// scope chain regardless of the IIFE) so the FIRST async step
// (readAsDataURL) can be held pending on command, while everything after
// it (the real Image decode + canvas draw) still runs for real -- this
// also sidesteps needing to fake an Image/canvas pipeline, and produces a
// genuinely different resized data URL per source file, which is exactly
// what's needed to prove the stale one never applied.
//
// Also unlike profile.html/create.html, wizard.html stages characters
// in-memory (`staged`, local to the IIFE, not reachable from outside)
// until real signup -- so persistence is verified the same way this bug
// would actually surface to a user: by reopening the sheet again after
// the questionable moment and reading the rendered photo preview, which
// openCharSheet always repopulates fresh from the (real) character
// object's own photoDataUrl, never from stale in-flight state.

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var PHOTO_FIXTURE = path.join(__dirname, '..', 'assets', 'logo-v4.png');
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

/**
 * Holds the FIRST async step of the real resizeImageFile pipeline
 * (FileReader.readAsDataURL's onload) pending until the test explicitly
 * releases it via window.__releaseResize() -- see this file's header
 * comment for why this targets FileReader rather than resizeImageFile
 * itself. Everything after that (real Image decode, real canvas draw) runs
 * unmodified, so the eventual resolved value is a real, distinct resized
 * data URL for whichever file was picked.
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

test('wizard.html: cancelling a photo pick on the self character\'s sheet, then reopening for a DIFFERENT (non-self) character, must not let the stale resize leak into either character once it resolves', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.click('#fn-q-grid [data-tile="0"]'); // question-first: Flying tile -> build, clean Subject (no auto-sheet)
    await page.waitForSelector('#subject-chip-row');

    // Create the self character with a REAL photo (unstubbed resize) so it
    // has a real, known-good photoDataUrl to protect. Round 8: tapping the
    // Me row selects it AND opens the sheet directly, photo option included.
    await page.click('#subj-me-row');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-mode-row [data-char-mode="photo"]').evaluate(function (el) { return el.classList.contains('active'); }), false, 'brand-new self sheet defaults to Describe');
    await page.click('#char-mode-row [data-char-mode="photo"]');
    await page.setInputFiles('#char-photo-input', PHOTO_FIXTURE);
    await page.waitForSelector('#char-photo-preview img');
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // Create a second, non-self character ("Mom") -- its sheet has no
    // photo picker at all (char-mode-row/char-photo-area stay hidden for
    // isSelf:false).
    await page.click('#subj-add-other');
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
    // HER sheet -- a realistic flow via the chip row, unlike profile.html
    // which only ever has one identity sheet.
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
    // the abandoned pick, and critically this happens BEFORE the stale
    // resize is allowed to resolve below (masking-order rule -- resolving
    // first would prove nothing about the token guard itself).
    await page.click('[data-char-edit="' + selfCharId + '"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), originalPhoto, 'reopened sheet must show the character\'s real photo, not the abandoned pick');

    // Only now does the stale resize resolve -- well after both the Mom
    // reopen AND this self-character reopen.
    await page.evaluate(function () { window.__releaseResize(); });
    await page.waitForTimeout(300); // real Image decode + canvas draw, not instant like the stubbed-Promise pattern

    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), originalPhoto, 'the stale resize must not clobber the reopened sheet\'s preview once it resolves, even after being reopened for a different character along the way');

    // Save without re-picking a photo, then reopen ONE more time -- proves
    // the actual persisted (staged, in-memory) character object still
    // carries the real original photo, not the stale one, read fresh from
    // the character record itself (not just the still-lingering preview).
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');
    await page.click('[data-char-edit="' + selfCharId + '"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), originalPhoto, 'the stale, abandoned photo pick must never be persisted onto the self character either');
  } finally {
    await page.close();
  }
});
