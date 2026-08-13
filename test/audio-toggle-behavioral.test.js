// test/audio-toggle-behavioral.test.js
//
// Real browser-driven coverage, originally for tracker item for-product-
// audio-on-off-choice-at-creat-dyyr98 (founder-approved 2026-07-28) —
// style.html's audio/music toggle placed just under the existing
// image-vs-video segmented toggle. Went through several more directives
// since:
//   - for-product-turn-off-audio-dialogue-gene-ooeyoj (2026-08-02): server-
//     side model audio (generate_audio) forced permanently false for every
//     video path — this file briefly covered the toggle's DISABLED state.
//   - for-product-build-founder-approved-08-03-jlkjy9 (2026-08-03, Option
//     B): the toggle became REAL again, controlling something entirely
//     different — a client-side-only, style-matched AMBIENT MUSIC BED
//     (js/music-bed.js), never server-side model audio.
//   - SAME tracker item, founder simplification (2026-08-03, THIS state):
//     "NO TOGGLE. Since the music beds are free, music is simply ALWAYS
//     ON — every dream video plays with its style-matched bed, no user
//     choice." The toggle, its markup (#audio-toggle-row/#audio-toggle/
//     #audio-toggle-sub), and the `musicBedOn` field it used to write are
//     all removed entirely — no disabled/"unavailable" placeholder left
//     behind (see style.html's own removal comment). This file now
//     asserts:
//   1. No trace of the toggle (or its markup) exists anywhere in style.html
//      — no dead UI left behind, on either media type.
//   2. Generating a video never sends `musicBedOn` anywhere (it was always
//      client-only, never sent to the server, and now doesn't exist at
//      all) and still only ever sends the permanently-inert
//      `audioOn:false`/`musicStyle:null` pair to generate-video.js — the
//      retired server-audio fields, completely untouched by any of this.
//   3. The finished dream itself carries no `musicBedOn` field at all —
//      music-bed eligibility (js/music-bed.js's eligible(), covered in
//      test/music-bed-behavioral.test.js) is computed purely from the
//      dream's own videoUrl/style now, nothing persisted here to drive it.
//   4. "Generate Again" (Edit Dream) still preserves the pre-existing
//      always-audio-on WIRE behavior for the retired server-side field
//      (unrelated to music beds, kept exactly as-is) and does not
//      introduce a musicBedOn field on the regenerated dream either.

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

test('style.html: the Audio & music toggle is gone entirely -- no markup, no dead/disabled control, on either media type', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await seedLoggedInUserAt(page, 'notogglenoUItester', '/create.html');
    await reachStyleScreen(page, 'A dream about drifting through a quiet forest');

    assert.equal(await page.locator('#audio-toggle-row').count(), 0, 'the toggle\'s choice-card must not exist in the DOM at all, not just be hidden');
    assert.equal(await page.locator('#audio-toggle').count(), 0);
    assert.equal(await page.locator('#audio-toggle-sub').count(), 0);
    // The old music-STYLE chip picker (dreamy/cinematic/upbeat/ambient),
    // already removed a generation earlier, must still be gone too.
    assert.equal(await page.locator('#music-style-row').count(), 0);

    // Switching to Image must not surface anything either -- there was
    // never anything audio-related to hide/show for that path anymore.
    await page.click('.media-type-btn[data-media-type="image"]');
    assert.equal(await page.locator('#audio-toggle-row').count(), 0);
    await page.click('.media-type-btn[data-media-type="video"]');
    assert.equal(await page.locator('#audio-toggle-row').count(), 0);
  } finally {
    await context.close();
  }
});

test('end to end: generating a video never sends musicBedOn anywhere, still only ever sends the permanently-inert { audioOn:false, musicStyle:null } to generate-video.js, and the finished dream carries no musicBedOn field', async function (t) {
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
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/lite:test-op-alwayson' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    });

    await seedLoggedInUserAt(page, 'alwaysontester', '/create.html');
    await reachStyleScreen(page, 'A dream about sailing through the stars');
    await page.click('.style-card[data-style="Cinematic"]');
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');

    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].audioOn, false, 'the retired server-request field stays permanently false, untouched by the music-bed feature');
    assert.equal(generateVideoCalls[0].musicStyle, undefined, 'the retired musicStyle field is never sent');
    assert.equal(generateVideoCalls[0].musicBedOn, undefined, 'musicBedOn must never be sent to the server -- it no longer exists as a concept at all');

    await page.waitForFunction(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      return (state.dreams || []).length >= 1;
    }, { timeout: 5000 });
    var dreams = await readDreams(page);
    assert.equal(dreams.length, 1);
    assert.equal(dreams[0].musicBedOn, undefined, 'the finished dream record must not carry a musicBedOn field at all anymore');
    assert.equal(dreams[0].style, 'Cinematic');
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

test('result.html "Generate Again" (Edit Dream) preserves the pre-existing always-audio-on wire behavior for the unrelated retired server-side field, and never introduces a musicBedOn field on the regenerated dream', async function (t) {
  // Review finding on an earlier branch (pre-existing, unrelated to this
  // file's music-bed history): js/store.js's regenerateDream (Edit
  // Dream/Try Again, and the "Turn this into a video" upsell) has no audio
  // picker UI of its own and, before the ooeyoj directive, always
  // generated WITH server audio (gated only by the pre-existing condensing
  // rule) — kept exactly as-is, still asserted below.
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
      // Deliberately seeded with a stale musicBedOn:false from the retired
      // toggle era, to confirm the regenerate path doesn't newly resurrect
      // or otherwise care about it either way.
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
    assert.equal(capturedBody.musicBedOn, undefined, 'musicBedOn must never be sent to the server -- it does not exist as a concept at all');

    await page.waitForFunction(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      var d = (state.dreams || []).filter(function (x) { return x.id === 'dream-regen-audio'; })[0];
      return !!(d && d.updatedAt);
    }, { timeout: 5000 });
    var dreamsAfter = await readDreams(page);
    var regenerated = dreamsAfter.filter(function (x) { return x.id === 'dream-regen-audio'; })[0];
    assert.ok(regenerated, 'the regenerated dream must still exist under the same id');
    // The stale musicBedOn:false the dream was seeded with is simply left
    // untouched (finalizeDream no longer reads/writes it at all) -- not
    // asserted as any particular value here, since it's fully inert now;
    // what matters is generate-video.js never received it (checked above)
    // and js/music-bed.js's eligible() never reads it either way (see
    // test/music-bed-behavioral.test.js).
  } finally {
    await context.close();
  }
});
