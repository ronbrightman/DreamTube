// test/result-photo-upload-sheet-token-behavioral.test.js
//
// Regression coverage for tracker item
// fix-pre-existing-photo-upload-cancel-reo-svrjyv (branch
// photo-upload-sheet-instance-token-guard): result.html's character-sheet
// photo-upload handler (inside the Edit-dream sheet's Advanced >
// Characters section) had the same unguarded-async shape already found and
// fixed (round 4) in profile.html/create.html via a per-sheet-instance
// token (identitySheetToken/charSheetToken) -- pick a photo, close the
// sheet before resizeImageFile resolves, reopen for a DIFFERENT character,
// and the stale resize could silently overwrite the wrong character's
// photo state once it finally resolved. Fix here mirrors that exact
// pattern: a module-level charSheetToken bumped on every open/close,
// captured locally when the async resize starts, and re-checked before the
// resolve handler writes anything.
//
// Follows test/avatar-describe-behavioral.test.js's round-4 regression
// test conventions exactly (armControllableResize stands in for the real
// FileReader -> Image decode -> canvas draw pipeline, since there's no
// network call for page.route() to intercept -- and the exact same
// "reopen for character B, THEN let the stale resize resolve, THEN also
// reopen A again" ordering, so the assertions can't be masked by
// openCharSheet's own unconditional per-open reset alone), and
// test/ui-behavioral.test.js's seedResultPage for the shortest path to an
// authenticated result.html render.

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var PHOTO_FIXTURE = path.join(__dirname, '..', 'assets', 'logo-v2.png');

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

function readState(page) {
  return page.evaluate(function () {
    return JSON.parse(localStorage.getItem('dreamtube_state_v1'));
  });
}

/**
 * Stands in for the page's real resizeImageFile (FileReader -> Image decode
 * -> canvas draw) with a promise this test controls the resolution of --
 * same helper as test/avatar-describe-behavioral.test.js's own copy. Safe
 * to install any time after the page's <script> has run: resizeImageFile is
 * a plain top-level function declaration in a non-module classical script,
 * so it's a `window` property every call site looks up by name at call
 * time, same as `fetch`.
 */
function armControllableResize(page) {
  return page.evaluate(function () {
    window.resizeImageFile = function () {
      return new Promise(function (resolve) { window.__resolveResize = resolve; });
    };
  });
}

test('result.html: cancelling a photo pick on the self character\'s sheet, then reopening for a DIFFERENT (non-self) character, must not let the stale resize leak into either character once it resolves', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var ORIGINAL_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAA=';
  var STALE_PHOTO = 'data:image/jpeg;base64,ZmFrZS1zdGFsZS1waG90by1kYXRh';
  try {
    // Seed a logged-in user with one dream (needed to reach result.html at
    // all) plus a self character with an existing photo, and a second,
    // non-self character -- mirrors test/ui-behavioral.test.js's
    // seedResultPage, extended with charactersByUser like test/avatar-
    // describe-behavioral.test.js's create.html round-4 test does.
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function (photo) {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      if (!state.dreams) state.dreams = [];
      state.dreams.push({
        id: 'd-photo-token-1',
        ownerHandle: '@tester',
        caption: 'A test dream about flying over mountains',
        style: 'Cinematic',
        videoUrl: 'https://example.com/fake-video.mp4',
        isPublished: false,
        createdAt: new Date().toISOString()
      });
      state.charactersByUser = {
        tester: [
          { id: 'self-1', isSelf: true, name: 'Ron', description: '', photoDataUrl: photo },
          { id: 'mom-1', isSelf: false, name: 'Mom', description: 'short grey hair, warm smile' }
        ]
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    }, ORIGINAL_PHOTO);
    await safeGoto(page, baseUrl + '/result.html?id=d-photo-token-1');

    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet this test's Advanced character editing lives in.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');
    await page.click('#adv-toggle');
    await page.waitForSelector('#char-chip-row [data-char-edit="self-1"]');

    // Open the self character's sheet -- has an existing photo, so it opens
    // straight into Photo mode -- and pick a new photo.
    await page.click('[data-char-edit="self-1"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO);

    await armControllableResize(page);
    await page.setInputFiles('#char-photo-input', PHOTO_FIXTURE);
    await page.waitForFunction(function () { return typeof window.__resolveResize === 'function'; });

    // Back out before the pending resize ever resolves.
    await page.click('#char-cancel');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // Reopen for a DIFFERENT, non-self character. Its sheet has no photo
    // picker at all (char-mode-row stays hidden for isSelf:false), so
    // saving it must never pick up the stale self-sheet photo either.
    await page.click('[data-char-edit="mom-1"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-sheet-title').textContent(), 'Edit character');
    assert.equal(await page.locator('#char-mode-row').isVisible(), false);
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    var stateAfterMomSave = await readState(page);
    var mom = stateAfterMomSave.charactersByUser.tester.filter(function (c) { return c.id === 'mom-1'; })[0];
    assert.equal(mom.photoDataUrl, undefined, 'a non-self character must never pick up the stale self-sheet photo');

    // Reopen the self character sheet -- its own onOpen reset shows the
    // real existing photo immediately, not anything from the abandoned pick.
    await page.click('[data-char-edit="self-1"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO, 'reopened sheet must show the character\'s real photo, not the abandoned pick');

    // Only now does the stale resize resolve -- well after both the Mom
    // reopen AND this self-character reopen. This ordering is the actual
    // regression: resolving it earlier would be masked by openCharSheet's
    // own unconditional per-open reset regardless of any token gating.
    await page.evaluate(function (staleUrl) { window.__resolveResize(staleUrl); }, STALE_PHOTO);
    await page.waitForTimeout(100);

    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO, 'the stale resize must not clobber the reopened sheet\'s preview once it resolves, even after being reopened for a different character along the way');

    // Save without re-picking a photo -- must persist the real photo, never the stale one.
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');
    var finalState = await readState(page);
    var self_ = finalState.charactersByUser.tester.filter(function (c) { return c.id === 'self-1'; })[0];
    assert.equal(self_.photoDataUrl, ORIGINAL_PHOTO, 'the stale, abandoned photo pick must never be persisted onto the self character either');
  } finally {
    await page.close();
  }
});
