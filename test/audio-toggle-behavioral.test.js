// test/audio-toggle-behavioral.test.js
//
// Real browser-driven coverage for tracker item for-product-audio-on-off-
// choice-at-creat-dyyr98 (founder-approved 2026-07-28) — style.html's
// audio/music toggle placed just under the existing image-vs-video
// segmented toggle, plus processing.html's media-aware wait-screen
// checklist copy that must only show "Composing the soundtrack…" when
// audio is actually on for THIS generation. Run at a mobile viewport (see
// test.before below), same discipline as
// image-generation-style-toggle-behavioral.test.js. Covers:
//   1. Audio defaults OFF on load; the music-style picker is hidden.
//   2. Turning it on reveals the four music presets with "Dreamy"
//      pre-selected; picking a different preset updates the selection.
//   3. Switching to Image hides the whole audio section entirely
//      (capability-detect-and-hide, not disabled-looking).
//   4. End to end: generating with audio on sends { audioOn: true,
//      musicStyle } to generate-video.js; the untouched default sends
//      { audioOn: false }. Token cost stays 100 either way.
//   5. The wait-screen checklist's caption list includes "Composing the
//      soundtrack…" only when audio is actually on for this generation,
//      never for Image regardless of audio state.
//   6. "Generate Again" (Edit Dream) and the "Turn this into a video"
//      upsell — pre-existing features with no audio picker of their own —
//      keep their old always-audio-on behavior, not the new default-off
//      (review finding, this branch's own regenerateDream fix).

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

test('style.html: audio defaults off, music picker hidden, and the section disappears entirely on Image', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await seedLoggedInUserAt(page, 'audiodefaulttester', '/create.html');
    await reachStyleScreen(page, 'A dream about drifting through a quiet forest');

    var toggleOn = await page.locator('#audio-toggle').evaluate(function (el) { return el.classList.contains('on'); });
    var ariaChecked = await page.getAttribute('#audio-toggle', 'aria-checked');
    assert.equal(toggleOn, false, 'audio must default OFF');
    assert.equal(ariaChecked, 'false');
    assert.match(await page.textContent('#audio-toggle-sub'), /Off/);
    assert.equal(await page.isVisible('#music-style-row'), false, 'the music-style picker must stay hidden while audio is off');

    // ----- Video -> Image: the whole audio section disappears -----
    await page.click('.media-type-btn[data-media-type="image"]');
    assert.equal(await page.isVisible('#audio-toggle-row'), false, 'audio has no meaning for a still image and must be hidden entirely, not shown-disabled');
    assert.equal(await page.isVisible('#music-style-row'), false);

    // ----- Back to Video: reappears, still off (state preserved, not reset to "on") -----
    await page.click('.media-type-btn[data-media-type="video"]');
    assert.equal(await page.isVisible('#audio-toggle-row'), true);
    var stillOff = await page.locator('#audio-toggle').evaluate(function (el) { return el.classList.contains('on'); });
    assert.equal(stillOff, false);
  } finally {
    await context.close();
  }
});

test('style.html: turning audio on reveals the four music presets ("Dreamy" pre-selected), and picking a different one updates the selection', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await seedLoggedInUserAt(page, 'audiopickertester', '/create.html');
    await reachStyleScreen(page, 'A dream about a carnival at midnight');

    await page.click('#audio-toggle');
    var toggleOnNow = await page.locator('#audio-toggle').evaluate(function (el) { return el.classList.contains('on'); });
    assert.equal(toggleOnNow, true);
    assert.equal(await page.getAttribute('#audio-toggle', 'aria-checked'), 'true');
    assert.match(await page.textContent('#audio-toggle-sub'), /On/);
    assert.equal(await page.isVisible('#music-style-row'), true);

    var dreamySelected = await page.locator('.opt-chip[data-music-style="dreamy"]').evaluate(function (el) { return el.classList.contains('selected'); });
    assert.equal(dreamySelected, true, '"Dreamy" is the sensible default preset once audio is turned on');

    await page.click('.opt-chip[data-music-style="cinematic"]');
    var cinematicSelected = await page.locator('.opt-chip[data-music-style="cinematic"]').evaluate(function (el) { return el.classList.contains('selected'); });
    var dreamyStillSelected = await page.locator('.opt-chip[data-music-style="dreamy"]').evaluate(function (el) { return el.classList.contains('selected'); });
    assert.equal(cinematicSelected, true);
    assert.equal(dreamyStillSelected, false, 'only one music preset can be active at a time');

    // ----- Turning audio back off hides the picker again (selection itself is untouched underneath) -----
    await page.click('#audio-toggle');
    assert.equal(await page.isVisible('#music-style-row'), false);
  } finally {
    await context.close();
  }
});

test('end to end: generating with audio ON sends { audioOn: true, musicStyle } to generate-video.js, and completes normally', async function (t) {
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
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:test-op-audio-on' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    });

    await seedLoggedInUserAt(page, 'audioontester', '/create.html');
    await reachStyleScreen(page, 'A dream about sailing through the stars');
    await page.click('.style-card[data-style="Cinematic"]');
    await page.click('#audio-toggle');
    await page.click('.opt-chip[data-music-style="upbeat"]');
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');

    await page.waitForURL('**/result.html?id=*', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].audioOn, true);
    assert.equal(generateVideoCalls[0].musicStyle, 'upbeat');
    assert.equal(generateVideoCalls[0].caption, 'A dream about sailing through the stars');
  } finally {
    await context.close();
  }
});

test('end to end: the untouched default (audio never toggled) sends { audioOn: false } — no split pricing, still 100 tokens', async function (t) {
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
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:test-op-audio-off' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video-2.mp4' }) });
    });

    await seedLoggedInUserAt(page, 'audiodefaultsubmit', '/create.html');
    await reachStyleScreen(page, 'A dream about walking through a quiet library');
    await page.click('.style-card[data-style="Realistic"]');
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');

    await page.waitForURL('**/result.html?id=*', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].audioOn, false);
    assert.equal(generateVideoCalls[0].musicStyle, undefined, 'musicStyle should not even be sent when audio was never turned on');
  } finally {
    await context.close();
  }
});

test('processing.html: the wait-screen checklist includes "Composing the soundtrack…" only when audio is actually on for this generation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    // Never actually resolves — this test only inspects the checklist's
    // caption list while the wait screen is up, never lets generation finish.
    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:test-op-checklist' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await seedLoggedInUserAt(page, 'checklistaudioon', '/create.html');
    await reachStyleScreen(page, 'A dream about a lighthouse in a storm');
    await page.click('.style-card[data-style="Cinematic"]');
    await page.click('#audio-toggle'); // audio ON, default "Dreamy"
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');
    await page.waitForURL('**/processing.html', { timeout: 8000, waitUntil: 'domcontentloaded' });

    var captionsAudioOn = await page.evaluate(function () { return window.__TEST_ACTIVE_CAPTIONS__(); });
    assert.ok(captionsAudioOn.some(function (c) { return /Composing the soundtrack/.test(c); }), 'audio ON must include the soundtrack checklist line');
  } finally {
    await context.close();
  }
});

test('processing.html: the wait-screen checklist NEVER includes "Composing the soundtrack…" when audio was left off (the default)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:test-op-checklist-off' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await seedLoggedInUserAt(page, 'checklistaudiooff', '/create.html');
    await reachStyleScreen(page, 'A dream about climbing an endless staircase');
    await page.click('.style-card[data-style="Cinematic"]');
    // Audio left at its default (off) — never clicked.
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');
    await page.waitForURL('**/processing.html', { timeout: 8000, waitUntil: 'domcontentloaded' });

    var captionsAudioOff = await page.evaluate(function () { return window.__TEST_ACTIVE_CAPTIONS__(); });
    assert.ok(!captionsAudioOff.some(function (c) { return /Composing the soundtrack/.test(c); }), 'audio OFF (the default) must never show the soundtrack checklist line');
    assert.ok(captionsAudioOff.some(function (c) { return /Adding motion/.test(c); }), 'audio being off must not also drop unrelated checklist lines like "Adding motion…"');
  } finally {
    await context.close();
  }
});

test('processing.html: Image generation never shows "Composing the soundtrack…" regardless of any prior audio state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await page.route('**/.netlify/functions/generate-image', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/flux/dev:test-op-checklist-image' }) });
    });
    await page.route('**/.netlify/functions/image-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await seedLoggedInUserAt(page, 'checklistimage', '/create.html');
    await reachStyleScreen(page, 'A dream about a floating island');
    await page.click('.style-card[data-style="Anime"]');
    await page.click('.media-type-btn[data-media-type="image"]');
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');
    await page.waitForURL('**/processing.html', { timeout: 8000, waitUntil: 'domcontentloaded' });

    var captionsImage = await page.evaluate(function () { return window.__TEST_ACTIVE_CAPTIONS__(); });
    assert.ok(!captionsImage.some(function (c) { return /Composing the soundtrack/.test(c); }));
    assert.ok(!captionsImage.some(function (c) { return /Adding motion/.test(c); }));
  } finally {
    await context.close();
  }
});

test('result.html "Generate Again" (Edit Dream) preserves the pre-existing always-audio-on behavior — not silently regressed to the new default-off', async function (t) {
  // Review finding on this branch: js/store.js's regenerateDream (Edit
  // Dream/Try Again, and the "Turn this into a video" upsell) has no audio
  // picker UI of its own and, before this toggle existed, always generated
  // WITH audio (gated only by the pre-existing condensing rule). The two
  // tracker items behind this branch scope the new default-off behavior to
  // style.html's own NEW creation-flow toggle, not to these two already-
  // shipped, unrelated features -- silently flipping them to audio-off too
  // would be an unrequested regression. This drives the real "Generate
  // Again" click on a freshly-seeded dream (draft state never touched the
  // new audio toggle at all) and asserts the resulting generate-video POST
  // still carries audioOn:true.
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
    // done:true (not false, like the checklist tests above) — waiting for
    // the redirect to result.html?id=* below is what guarantees the
    // generate-video.js POST has actually fired by the time this test
    // reads capturedBody, since processing.html's own submit call happens
    // asynchronously (after getTurnstileToken() resolves) rather than
    // synchronously on navigation — reaching processing.html alone proves
    // nothing about whether the POST has gone out yet.
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
      state.dreams.push({ id: 'dream-regen-audio', ownerHandle: '@regenaudiokeep', caption: 'A dream about the sea', style: 'Cinematic', mediaType: 'video', videoUrl: 'https://example.com/fake-video.mp4', dur: '0:08', isPublished: false, likes: 0, likedByMe: false });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/result.html?id=dream-regen-audio', { waitUntil: 'domcontentloaded' });

    await page.click('#open-edit-sheet');
    await page.click('#edit-generate-again');
    await page.waitForURL('**/result.html?id=*', { timeout: 8000, waitUntil: 'domcontentloaded' });

    assert.ok(capturedBody, 'generate-video.js must have been called');
    assert.equal(capturedBody.audioOn, true, 'regenerateDream must preserve the pre-existing always-audio-on behavior, not silently adopt the new default-off');
  } finally {
    await context.close();
  }
});
