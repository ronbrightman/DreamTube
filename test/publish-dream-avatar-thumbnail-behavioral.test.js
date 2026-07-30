// test/publish-dream-avatar-thumbnail-behavioral.test.js
//
// Real browser-driven coverage for js/store.js's actual avatar-thumbnail
// pipeline (tracker item for-product-ui-founder-directed-2026-07--djgjn0):
// resizeDataUrlForAvatarThumb/currentUserAvatarThumbnail, wired into
// syncPublishedDreamToFeed's `avatar` field. The other test files here
// cover the RENDERING half (explore-avatar-fallback-behavioral.test.js)
// and the SERVER validation half (publish-dream-avatar-validation.test.js)
// against synthetic/pre-made small data URLs — this file is the one that
// actually drives a REAL, large (1254x1254, >1MB) photo through
// profile.html's real upload/resize UI and confirms what gets sent over
// the wire to publish-dream.js is genuinely "aggressively resized, few
// KB" (the tracker item's own words), not just a synthetic stand-in.

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var PHOTO_FIXTURE = path.join(__dirname, '..', 'assets', 'logo-v2.png'); // real 1254x1254, >1MB source photo

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

async function seedUser(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = [];
    if (!state.dreams) state.dreams = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

test('a real, large uploaded Me photo produces a small ("few KB") avatar thumbnail sent to publish-dream.js', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page);

    // Real upload through profile.html's own UI — same identity-photo
    // path test/profile-me-character-behavioral.test.js exercises. This
    // produces a REAL 768px/0.82-quality photoDataUrl on the Me character,
    // easily tens of KB, the size the avatar thumbnail step must shrink
    // much further down from.
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#profile-avatar-edit');
    await page.waitForSelector('#sheet-identity-overlay.open');
    await page.click('#identity-mode-row [data-identity-mode="photo"]');
    await page.setInputFiles('#identity-photo-input', PHOTO_FIXTURE);
    await page.waitForSelector('#identity-photo-preview img');
    await page.click('#identity-save-btn');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');

    var mePhotoSize = await page.evaluate(function () {
      var me = DreamStore.getCharacters().filter(function (c) { return c.isSelf; })[0];
      return me.photoDataUrl.length;
    });
    assert.ok(mePhotoSize > 20 * 1024, 'sanity check: the full Me photo itself should be well over 20KB of data-URL text (got ' + mePhotoSize + ' chars), otherwise this test proves nothing about "aggressive" resizing');

    // Now push a real, owned, publishable dream directly into local state
    // (same shortcut every other behavioral test here uses to avoid
    // driving a full fal.ai generation) and publish it -- intercepting the
    // real network call publish-dream.js would receive, so this test never
    // needs a live Netlify Functions runtime.
    var captured = null;
    await page.route('**/.netlify/functions/publish-dream', function (route) {
      captured = JSON.parse(route.request().postData());
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dream: captured }) });
    });

    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = JSON.parse(raw);
      state.dreams.push({
        id: 'd-avatar-thumb-test', ownerHandle: '@tester', caption: 'A dream to publish',
        style: 'Cinematic', mediaType: 'video', videoUrl: 'https://example.com/fake-video.mp4',
        dur: '0:08', isPublished: false, likes: 0, likedByMe: false
      });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    // js/store.js only reads localStorage into its in-memory `state` once,
    // at script load — writing directly to localStorage from an
    // already-loaded page (as just done above) leaves that in-memory copy
    // stale, so DreamStore.publishDream below wouldn't find the pushed
    // dream at all without this reload picking the fresh write back up.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(function () { DreamStore.publishDream('d-avatar-thumb-test'); });

    // syncPublishedDreamToFeed's avatar thumbnail step is itself async
    // (canvas decode) -- give it a moment to resolve and fire the request.
    await page.waitForFunction(function () { return true; }, {}, { timeout: 100 }).catch(function () {});
    for (var i = 0; i < 20 && !captured; i++) {
      await page.waitForTimeout(100);
    }

    assert.ok(captured, 'expected publish-dream.js to have been called');
    assert.ok(captured.avatar, 'expected a real avatar thumbnail to be attached to the publish payload');
    assert.equal(captured.avatar.indexOf('data:image/'), 0, 'avatar must be an image data URL');

    // "Few KB" per the tracker item -- the approximate DECODED byte size
    // (matching publish-dream.js's own validateAvatar arithmetic), not the
    // base64 text length, must land comfortably under both the server's
    // 20KB cap and, more importantly, well below the ~1MB+ source photo
    // and even the tens-of-KB full Me photo.
    var base64Body = captured.avatar.split(',')[1];
    var approxBytes = Math.floor(base64Body.length * 3 / 4);
    assert.ok(approxBytes < 10 * 1024, 'expected an aggressively resized ("few KB") avatar thumbnail, got approximately ' + approxBytes + ' bytes');
    assert.ok(approxBytes < mePhotoSize, 'the avatar thumbnail must be meaningfully smaller than the full Me photo it was derived from');
  } finally {
    await page.close();
  }
});
