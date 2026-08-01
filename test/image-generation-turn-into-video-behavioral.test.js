// test/image-generation-turn-into-video-behavioral.test.js
//
// Real browser-driven coverage for result.html's "Turn this into a video"
// upsell (docs/IMAGE_GENERATION_SPEC.md §6) and js/store.js's
// turnImageIntoVideo: the CTA's visibility rule (imageUrl && !videoUrl
// only), its copy, the tap -> draft -> home.html (formerly processing.html
// before tracker item for-product-funnel-ending-v2-founder-ins-tfuu0q
// removed that page) round trip, and that the upgraded dream keeps its
// original imageUrl for provenance while videoUrl/mediaType flip over.
// Precondition (an
// image-type dream already existing) is seeded directly into localStorage
// — the cheapest way to construct it, matching
// test/first-video-created-behavioral.test.js's own seedAccount approach —
// rather than running the image-generation flow for real first.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settle = require('./helpers/settle').settle;

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

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

/** Seeds a logged-in account with one already-generated dream and navigates to it -- mirrors first-video-created-behavioral.test.js's seedAccount, generalized with an explicit dream patch (imageUrl/videoUrl/mediaType) instead of always-video. Always sets a real email (mirroring ui-behavioral.test.js's seedLoggedInUserAt) -- DreamStore.getTokenStatus() short-circuits to a hardcoded balance:0 with NO network call at all when the account has no email on file (see js/store.js), which would silently defeat mockTokenStatus() if this were left null. */
async function seedAccountWithDream(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || (o.username + '@example.com') };
    if (!state.dreams) state.dreams = [];
    state.dreams.push(Object.assign({
      ownerHandle: '@' + o.username,
      caption: 'A dream about a floating library',
      style: 'Anime',
      isPublished: false,
      likes: 0, likedByMe: false
    }, o.dream));
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

test('result.html: "Turn this into a video" CTA is shown only for an image-type dream with no video yet, and reads the right copy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });

    await seedAccountWithDream(page, {
      username: 'ctavisibility',
      dream: { id: 'dream-image-only', mediaType: 'image', imageUrl: 'https://example.com/fake-image.jpg', videoUrl: null }
    });
    await page.goto(baseUrl + '/result.html?id=dream-image-only', { waitUntil: 'domcontentloaded' });

    assert.equal(await page.locator('#turn-video-btn').isVisible(), true);
    var ctaText = await page.textContent('#turn-video-btn');
    assert.match(ctaText, /Turn this into a video/);
    assert.match(ctaText, /100 tokens/);
    assert.equal(await page.locator('#result-image').isVisible(), true);
    assert.equal(await page.locator('#result-video').isVisible(), false);
  } finally {
    await context.close();
  }
});

test('result.html: the CTA is hidden for a plain video-type dream and for a dream that already has both image and video', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });

    await seedAccountWithDream(page, {
      username: 'ctahiddenvideo',
      dream: { id: 'dream-video-only', mediaType: 'video', videoUrl: 'https://example.com/fake-video.mp4', dur: '0:08' }
    });
    await page.goto(baseUrl + '/result.html?id=dream-video-only', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#turn-video-btn').isVisible(), false, 'a plain video dream never shows the upsell');

    await seedAccountWithDream(page, {
      username: 'ctahiddenboth',
      dream: { id: 'dream-both', mediaType: 'video', imageUrl: 'https://example.com/fake-image.jpg', videoUrl: 'https://example.com/fake-video.mp4', dur: '0:08' }
    });
    await page.goto(baseUrl + '/result.html?id=dream-both', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#turn-video-btn').isVisible(), false, 'once a dream already has a video, the CTA must not show again');
    assert.equal(await page.locator('#result-video').isVisible(), true, 'video takes rendering priority once both exist');
  } finally {
    await context.close();
  }
});

test('result.html: tapping "Turn this into a video" upgrades the dream in place — videoUrl gets set, imageUrl is kept for provenance, mediaType flips to video, and generate-video.js receives the right sourceImageUrl', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateVideoCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast/image-to-video:test-op-2' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-upgraded-video.mp4' }) });
    });

    var ORIGINAL_IMAGE_URL = 'https://fal.media/files/sample/original-image.png';
    await seedAccountWithDream(page, {
      username: 'turnintovideo',
      dream: { id: 'dream-to-upgrade', mediaType: 'image', imageUrl: ORIGINAL_IMAGE_URL, videoUrl: null }
    });
    await page.goto(baseUrl + '/result.html?id=dream-to-upgrade', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#turn-video-btn', { state: 'visible', timeout: 5000 });

    await page.click('#turn-video-btn');

    // Lands directly on home.html now (?generate=1 -- tracker item
    // for-product-funnel-ending-v2-founder-ins-tfuu0q removed processing.html
    // and the old redirect straight back to result.html) -- the upgrade
    // runs in the background; the My-dreams row's generating tile flips to
    // a real finished tile in place.
    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 8000 });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].sourceImageUrl, ORIGINAL_IMAGE_URL, 'generate-video.js must receive the original imageUrl as sourceImageUrl');

    var dreamState = await page.evaluate(function () {
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === 'dream-to-upgrade'; })[0];
    });
    assert.equal(dreamState.mediaType, 'video');
    assert.equal(dreamState.videoUrl, 'https://example.com/fake-upgraded-video.mp4');
    assert.equal(dreamState.imageUrl, ORIGINAL_IMAGE_URL, 'the original image must be kept for provenance, not cleared');

    // Tapping into the upgraded dream's own room (result.html) -- no
    // longer an automatic redirect -- to confirm it now renders as a
    // normal video and the CTA does not show again (dream.videoUrl is now
    // set).
    await page.goto(baseUrl + '/result.html?id=dream-to-upgrade', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#result-video').isVisible(), true);
    assert.equal(await page.locator('#turn-video-btn').isVisible(), false);
  } finally {
    await context.close();
  }
});

test('result.html: an insufficient balance opens the out-of-tokens purchase sheet instead of proceeding, and never calls generate-video.js', async function (t) {
  // The old #modal-quota this replaced (tracker item
  // for-product-build-out-of-tokens-purchase-2y8hyw) is now
  // #purchase-sheet-overlay (js/purchase-sheet.js) — see
  // test/out-of-tokens-purchase-sheet-behavioral.test.js for the full
  // arithmetic + draft-persistence coverage of this exact call site; this
  // test just keeps its original narrower scope (blocked = no navigation,
  // no generate-video.js call).
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 5, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:x:y' }) });
    });

    await seedAccountWithDream(page, {
      username: 'ctainsufficient',
      dream: { id: 'dream-broke', mediaType: 'image', imageUrl: 'https://example.com/fake-image.jpg', videoUrl: null }
    });
    await page.goto(baseUrl + '/result.html?id=dream-broke', { waitUntil: 'domcontentloaded' });
    // Let the async getTokenStatus() pre-check actually resolve before tapping.
    await page.waitForTimeout(200);
    await page.click('#turn-video-btn');

    await page.waitForSelector('#purchase-sheet-overlay.open', { timeout: 5000 });
    var sheetText = await page.textContent('#purchase-sheet-overlay');
    assert.match(sheetText, /100 tokens/);
    assert.ok(page.url().indexOf('result.html') !== -1, 'must not navigate away when tokens are insufficient -- stays on result.html');
    assert.equal(generateVideoCalls.length, 0);
  } finally {
    await context.close();
  }
});

// ===== Ownership guard (review finding, tracker item for-product-terms-
// republish-license-per--fhpcxk, SECOND review round) =====
//
// Second round found DreamStore.turnImageIntoVideo had no ownership check
// at all: result.html?id=<id> is legitimately reachable for another
// account's published dream (viewing another user's public dream is a
// real, intended use case), and a second account sharing the same browser
// could spend its own tokens to turn someone ELSE's image-only dream into
// a video, silently overwriting that dream's own record via
// finalizeDream's sourceDreamId branch. Same two-account-sharing-one-
// browser pattern as channel-republish-license-behavioral.test.js's own
// ownership-guard tests.
test('DreamStore.turnImageIntoVideo refuses to act on another account\'s image-only dream shared in the same browser\'s state.dreams, and the CTA is hidden for it -- both work normally for the real owner', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });

    var ORIGINAL_IMAGE_URL = 'https://fal.media/files/sample/not-mine-image.png';
    // Account A: an image-only dream (nothing to turn into a video yet).
    await seedAccountWithDream(page, {
      username: 'turnOwnerA',
      dream: { id: 'not-mine-image-dream', mediaType: 'image', imageUrl: ORIGINAL_IMAGE_URL, videoUrl: null }
    });

    // Account B (same browser) signs in and opens the same dream via a
    // direct link -- state.dreams (shared across every account that's
    // used this browser, per CLAUDE.md) still has account A's dream sitting
    // there.
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@turnViewerB', username: 'turnViewerB' };
      if (!state.accounts) state.accounts = {};
      state.accounts.turnViewerB = { password: 'testpass1', email: 'turnViewerB@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=not-mine-image-dream', { waitUntil: 'domcontentloaded' });

    // The CTA must never even appear for a dream that isn't this account's own.
    assert.equal(await page.locator('#turn-video-btn').isVisible(), false, 'the CTA must be hidden for a dream that is not the viewer\'s own');

    // Defense in depth: even if the hidden button were invoked directly,
    // js/store.js's own ownership guard must refuse it and leave the
    // dream's own record untouched.
    var blockedResult = await page.evaluate(function () {
      var returned = window.DreamStore.turnImageIntoVideo('not-mine-image-dream');
      var draft = window.DreamStore.getDraft();
      var dream = window.DreamStore.getDream('not-mine-image-dream');
      return { returned: returned, draftSourceDreamId: draft.sourceDreamId, dreamVideoUrl: dream.videoUrl, dreamImageUrl: dream.imageUrl };
    });
    assert.equal(blockedResult.returned, false, 'turnImageIntoVideo must return false for another account\'s dream');
    assert.notEqual(blockedResult.draftSourceDreamId, 'not-mine-image-dream', 'no draft must be staged against another account\'s dream');
    assert.equal(blockedResult.dreamVideoUrl, null, 'the dream must stay untouched -- no videoUrl granted by a non-owner');
    assert.equal(blockedResult.dreamImageUrl, ORIGINAL_IMAGE_URL, 'the dream\'s own imageUrl must be unchanged');

    // Now sign back in as the real owner -- both the CTA and the store
    // function must work normally again, proving this is a real ownership
    // comparison and not just "always blocked".
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@turnOwnerA', username: 'turnOwnerA' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=not-mine-image-dream', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#turn-video-btn').isVisible(), true, 'the CTA must be visible again for the actual owner');

    var allowedResult = await page.evaluate(function () {
      return { returned: window.DreamStore.turnImageIntoVideo('not-mine-image-dream'), draft: window.DreamStore.getDraft() };
    });
    assert.equal(allowedResult.returned, true, 'the real owner must still be able to turn their own image into a video');
    assert.equal(allowedResult.draft.sourceDreamId, 'not-mine-image-dream');
    assert.equal(allowedResult.draft.mediaType, 'video');
  } finally {
    await context.close();
  }
});
