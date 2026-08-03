// test/audio-toggle-behavioral.test.js
//
// Real browser-driven coverage, originally for tracker item for-product-
// audio-on-off-choice-at-creat-dyyr98 (founder-approved 2026-07-28) —
// style.html's audio/music toggle placed just under the existing
// image-vs-video segmented toggle. Went through two more directives since:
//   - for-product-turn-off-audio-dialogue-gene-ooeyoj (2026-08-02): server-
//     side model audio (generate_audio) forced permanently false for every
//     video path — this file briefly covered the toggle's DISABLED state.
//   - for-product-build-founder-approved-08-03-jlkjy9 (2026-08-03, THIS
//     state, Option B): the toggle is REAL again, but controls something
//     entirely different — a client-side-only, style-matched AMBIENT MUSIC
//     BED (js/music-bed.js), never server-side model audio. The old
//     audioOn/musicStyle server-request fields (and the old music-STYLE
//     chip picker that used to accompany them) stay exactly as ooeyoj left
//     them: permanently false/null/gone, completely untouched by this file's
//     new coverage below. This file now asserts:
//   1. The toggle renders ON by default (a deliberate reversal of the old
//      default-off), and is a REAL, clickable control again.
//   2. Clicking it flips musicBedOn (and the UI/sub-text) both ways.
//   3. Switching to Image still hides the whole audio section entirely
//      (capability-detect-and-hide — audio has no meaning for a still
//      image).
//   4. End to end: generating with the toggle ON persists musicBedOn:true
//      onto the finished dream; with it OFF, musicBedOn:false. Neither
//      case ever sends anything other than audioOn:false/musicStyle:null
//      to generate-video.js (musicBedOn is never sent to the server at
//      all — see js/store.js's startGeneration doc comment).
//   5. "Generate Again" (Edit Dream) preserves the pre-existing dream's own
//      musicBedOn rather than forcing a value neither the user nor any UI
//      picker actually chose (same "no picker on this flow" reasoning the
//      pre-existing audioOn:true assertion below already covers for the
//      unrelated, retired server-audio field).

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

// iPhone-ish mobile viewport — this app's real traffic is overwhelmingly
// mobile (see AGENT_POLICY.md/FOUNDER_PRINCIPLES.md's own repeated "test
// at a mobile viewport" instruction), and the tracker item's own text
// explicitly requires it ("Full-QA incl. mobile viewport").
var MOBILE_VIEWPORT = { width: 390, height: 844 };

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

async function seedLoggedInUserAt(page, username, path) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded' });
}

/** Drives create.html's "Write it" path to a real draft, landing on style.html exactly like a real user would. */
async function reachStyleScreen(page, caption) {
  await page.click('#choice-write');
  await page.fill('#dream-text', caption);
  await page.click('#write-continue');
  await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });
}

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

/** Reads the current localStorage dreams array back out of the page. */
async function readDreams(page) {
  return page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    return state.dreams || [];
  });
}

test('style.html: audio toggle renders ON by default, is a real interactive control, and the section disappears entirely on Image', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await seedLoggedInUserAt(page, 'audiodefaulttester', '/create.html');
    await reachStyleScreen(page, 'A dream about drifting through a quiet forest');

    var toggleOn = await page.locator('#audio-toggle').evaluate(function (el) { return el.classList.contains('on'); });
    var toggleDisabled = await page.locator('#audio-toggle').evaluate(function (el) { return el.classList.contains('disabled'); });
    var ariaChecked = await page.getAttribute('#audio-toggle', 'aria-checked');
    var ariaDisabled = await page.getAttribute('#audio-toggle', 'aria-disabled');
    assert.equal(toggleOn, true, 'the founder-approved default is ON, a deliberate reversal of the old default-off');
    assert.equal(toggleDisabled, false, 'this is a real, interactive control again — not the ooeyoj-era disabled state');
    assert.equal(ariaChecked, 'true');
    assert.equal(ariaDisabled, null, 'aria-disabled must not be present at all on a real, enabled control');
    assert.match(await page.textContent('#audio-toggle-sub'), /On.*ambient music/i, 'the sub-text must describe the real ON behavior, not claim unavailability');
    // The old music-STYLE chip picker (dreamy/cinematic/upbeat/ambient) is
    // gone entirely, not just hidden — the bed is chosen by the dream's own
    // visual style, no separate picker exists anymore.
    assert.equal(await page.locator('#music-style-row').count(), 0, 'the old music-style chip picker must be removed from the DOM entirely, not just hidden');

    // ----- Video -> Image: the whole audio section still disappears entirely -----
    await page.click('.media-type-btn[data-media-type="image"]');
    assert.equal(await page.isVisible('#audio-toggle-row'), false, 'audio has no meaning for a still image and must be hidden entirely');

    // ----- Back to Video: reappears, still ON (this session's own choice, untouched by the Image detour) -----
    await page.click('.media-type-btn[data-media-type="video"]');
    assert.equal(await page.isVisible('#audio-toggle-row'), true);
    var stillOn = await page.locator('#audio-toggle').evaluate(function (el) { return el.classList.contains('on'); });
    assert.equal(stillOn, true);
  } finally {
    await context.close();
  }
});

test('style.html: clicking the toggle flips it both ways, updating the sub-text each time', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await seedLoggedInUserAt(page, 'audiopickertester', '/create.html');
    await reachStyleScreen(page, 'A dream about a carnival at midnight');

    // ON -> OFF
    await page.click('#audio-toggle');
    var offState = await page.locator('#audio-toggle').evaluate(function (el) { return { on: el.classList.contains('on'), ariaChecked: el.getAttribute('aria-checked') }; });
    assert.equal(offState.on, false);
    assert.equal(offState.ariaChecked, 'false');
    assert.match(await page.textContent('#audio-toggle-sub'), /Off.*silent/i);

    // OFF -> ON again
    await page.click('#audio-toggle');
    var onState = await page.locator('#audio-toggle').evaluate(function (el) { return { on: el.classList.contains('on'), ariaChecked: el.getAttribute('aria-checked') }; });
    assert.equal(onState.on, true);
    assert.equal(onState.ariaChecked, 'true');
    assert.match(await page.textContent('#audio-toggle-sub'), /On.*ambient music/i);
  } finally {
    await context.close();
  }
});

test('end to end: generating with the toggle left ON persists musicBedOn:true onto the finished dream, and still only ever sends the permanently-inert { audioOn:false, musicStyle:null } to generate-video.js', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateVideoCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/lite:test-op-bed-on' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    });

    await seedLoggedInUserAt(page, 'audioontester', '/create.html');
    await reachStyleScreen(page, 'A dream about sailing through the stars');
    await page.click('.style-card[data-style="Cinematic"]');
    // Toggle left at its ON default — no click.
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');

    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].audioOn, false, 'the retired server-request field stays permanently false, untouched by this feature');
    assert.equal(generateVideoCalls[0].musicStyle, undefined, 'the retired musicStyle field is never sent');
    assert.equal(generateVideoCalls[0].musicBedOn, undefined, 'musicBedOn must never be sent to the server at all — it is a client-only playback preference (see js/music-bed.js)');

    // Page-side observation (localStorage) -- Playwright's own waitForFunction,
    // not settle() (settle is only for node-side observations, e.g. a
    // page.route() handler's own call count -- see that helper's own header
    // comment for exactly why the distinction matters).
    await page.waitForFunction(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      return (state.dreams || []).length >= 1;
    }, { timeout: 5000 });
    var dreams = await readDreams(page);
    assert.equal(dreams.length, 1);
    assert.equal(dreams[0].musicBedOn, true, 'the finished dream record must carry musicBedOn:true');
    assert.equal(dreams[0].style, 'Cinematic');
  } finally {
    await context.close();
  }
});

test('end to end: turning the toggle OFF before generating persists musicBedOn:false onto the finished dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });

    var generateVideoCalls = [];
    await page.route('**/.netlify/functions/generate-video', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      generateVideoCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/lite:test-op-bed-off' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video-2.mp4' }) });
    });

    await seedLoggedInUserAt(page, 'audiodefaultsubmit', '/create.html');
    await reachStyleScreen(page, 'A dream about walking through a quiet library');
    await page.click('.style-card[data-style="Realistic"]');
    await page.click('#audio-toggle'); // ON -> OFF
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');

    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].audioOn, false);
    assert.equal(generateVideoCalls[0].musicStyle, undefined);

    await page.waitForFunction(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      return (state.dreams || []).length >= 1;
    }, { timeout: 5000 });
    var dreams = await readDreams(page);
    assert.equal(dreams.length, 1);
    assert.equal(dreams[0].musicBedOn, false, 'the finished dream record must carry musicBedOn:false when the toggle was switched off before generating');
  } finally {
    await context.close();
  }
});

// processing.html's media-aware wait-screen checklist (three tests that
// used to live here, asserting on window.__TEST_ACTIVE_CAPTIONS__) was
// removed along with the whole page (tracker item for-product-funnel-
// ending-v2-founder-ins-tfuu0q, founder GO 2026-07-31 evening) -- home.html
// shows a static "Your dream is forming…" caption on the generating tile
// instead of a rotating reassurance checklist, since the user is never
// stuck staring at a dedicated wait screen anymore (they're on a fully
// usable Home the whole time). This is a genuine elimination, not a move:
// there is no home.html equivalent of "the checklist's caption list" to
// test media-awareness against.

test('result.html "Generate Again" (Edit Dream) preserves the pre-existing always-audio-on wire behavior, and preserves the source dream\'s own musicBedOn rather than forcing a value', async function (t) {
  // Review finding on this branch (pre-existing, unrelated to this file's
  // new coverage): js/store.js's regenerateDream (Edit Dream/Try Again, and
  // the "Turn this into a video" upsell) has no audio picker UI of its own
  // and, before the ooeyoj directive, always generated WITH server audio
  // (gated only by the pre-existing condensing rule) — kept exactly as-is,
  // still asserted below.
  //
  // NEW coverage (tracker item for-product-build-founder-approved-08-03-
  // jlkjy9): regenerateDream/startDreamEdit likewise have no music-bed
  // picker of their own, and never pass an explicit musicBedOn — js/
  // store.js's finalizeDream treats that as "preserve whatever this dream
  // already had" (same "undefined means don't touch it" contract as
  // modelUsed), not "silently reset to some default." This seeds a dream
  // with musicBedOn:false and asserts it survives a regenerate untouched.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20 });
    var capturedBody = null;
    await page.route('**/.netlify/functions/generate-video', function (route) {
      capturedBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:test-op-regenerate' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    });

    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@regenaudiokeep', username: 'regenaudiokeep' };
      if (!state.accounts) state.accounts = {};
      state.accounts.regenaudiokeep = { password: 'testpass1', email: 'regenaudiokeep@example.com' };
      if (!state.dreams) state.dreams = [];
      state.dreams.push({ id: 'dream-regen-audio', ownerHandle: '@regenaudiokeep', caption: 'A dream about the sea', style: 'Cinematic', mediaType: 'video', videoUrl: 'https://example.com/fake-video.mp4', musicBedOn: false, dur: '0:08', isPublished: false, likes: 0, likedByMe: false });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=dream-regen-audio', { waitUntil: 'domcontentloaded' });

    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet this test actually exercises (#edit-generate-again).
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');
    await page.click('#edit-generate-again');
    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return !!capturedBody; });
    assert.ok(capturedBody, 'generate-video.js must have been called');
    assert.equal(capturedBody.audioOn, true, 'regenerateDream must preserve the pre-existing always-audio-on wire behavior, not silently adopt anything new');
    assert.equal(capturedBody.musicBedOn, undefined, 'musicBedOn must never be sent to the server at all');

    await page.waitForFunction(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      var d = (state.dreams || []).filter(function (x) { return x.id === 'dream-regen-audio'; })[0];
      return !!(d && d.updatedAt);
    }, { timeout: 5000 });
    var dreamsAfter = await readDreams(page);
    var regenerated = dreamsAfter.filter(function (x) { return x.id === 'dream-regen-audio'; })[0];
    assert.ok(regenerated, 'the regenerated dream must still exist under the same id');
    assert.equal(regenerated.musicBedOn, false, 'a regenerate with no music-bed picker of its own must preserve the SOURCE dream\'s own musicBedOn, not reset it');
  } finally {
    await context.close();
  }
});
