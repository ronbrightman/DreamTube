// test/audio-toggle-behavioral.test.js
//
// Real browser-driven coverage, originally for tracker item for-product-
// audio-on-off-choice-at-creat-dyyr98 (founder-approved 2026-07-28) —
// style.html's audio/music toggle placed just under the existing
// image-vs-video segmented toggle.
//
// As of tracker item for-product-turn-off-audio-dialogue-gene-ooeyoj
// (founder directive 2026-08-02), generate-video.js/start-pending-
// generation.js force generate_audio:false unconditionally server-side —
// the toggle can no longer actually turn audio on, so this file now covers
// its DISABLED state instead of its old interactive one:
//   1. The toggle renders disabled (not just visually off) and its sub-text
//      says audio is unavailable; the music-style picker never shows.
//   2. Clicking the disabled toggle has no effect (no click handler at
//      all — this is a real disabled control, not just default-off).
//   3. Switching to Image still hides the whole audio section entirely,
//      same as before this directive (capability-detect-and-hide).
//   4. End to end: generating always sends { audioOn: false } to
//      generate-video.js regardless of anything a user could attempt in
//      the UI. Token cost stays 100.
//   5. "Generate Again" (Edit Dream) and the "Turn this into a video"
//      upsell still send their own old audioOn:true on the wire (js/
//      store.js's regenerateDream — deliberately left as inert,
//      trivially-reversible plumbing per the tracker item's own
//      instruction) even though the server now silently ignores it.

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

test('style.html: audio toggle renders disabled with an unavailable note, music picker never shows, and the section disappears entirely on Image', async function (t) {
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
    assert.equal(toggleOn, false, 'audio must be off');
    assert.equal(toggleDisabled, true, 'the control must render disabled, not just default-off — it can never be turned on anymore');
    assert.equal(ariaChecked, 'false');
    assert.equal(ariaDisabled, 'true');
    assert.match(await page.textContent('#audio-toggle-sub'), /Unavailable/i, 'the sub-text must tell the user audio isn\'t available, not just say "Off"');
    assert.equal(await page.isVisible('#music-style-row'), false, 'the music-style picker must never show now that audio can never be on');

    // ----- Video -> Image: the whole audio section still disappears entirely, unchanged from before -----
    await page.click('.media-type-btn[data-media-type="image"]');
    assert.equal(await page.isVisible('#audio-toggle-row'), false, 'audio has no meaning for a still image and must be hidden entirely, not shown-disabled');
    assert.equal(await page.isVisible('#music-style-row'), false);

    // ----- Back to Video: reappears, still disabled/off -----
    await page.click('.media-type-btn[data-media-type="video"]');
    assert.equal(await page.isVisible('#audio-toggle-row'), true);
    var stillOff = await page.locator('#audio-toggle').evaluate(function (el) { return el.classList.contains('on'); });
    assert.equal(stillOff, false);
  } finally {
    await context.close();
  }
});

test('style.html: clicking the disabled audio toggle has no effect at all — it never turns on, the music picker never appears', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 });
    await seedLoggedInUserAt(page, 'audiopickertester', '/create.html');
    await reachStyleScreen(page, 'A dream about a carnival at midnight');

    // force:true bypasses Playwright's actionability check (which would
    // otherwise refuse to click a pointer-events:none element) — this is
    // deliberately simulating "what if something still dispatched a click"
    // rather than relying solely on the CSS to keep this test honest; there
    // is no click listener on #audio-toggle anymore at all (see style.html),
    // so even a forced click must be a genuine no-op.
    await page.click('#audio-toggle', { force: true });
    var toggleOnNow = await page.locator('#audio-toggle').evaluate(function (el) { return el.classList.contains('on'); });
    assert.equal(toggleOnNow, false, 'the toggle must never turn on, even if something manages to dispatch a click on it');
    assert.equal(await page.getAttribute('#audio-toggle', 'aria-checked'), 'false');
    assert.match(await page.textContent('#audio-toggle-sub'), /Unavailable/i);
    assert.equal(await page.isVisible('#music-style-row'), false, 'the music picker must never appear — there is nothing left that can reveal it');
  } finally {
    await context.close();
  }
});

test('end to end: generating always sends { audioOn: false } to generate-video.js — there is no way left in the UI to send true', async function (t) {
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
    // Attempt the old on-turning interaction anyway (force:true — see the
    // disabled-click test above) to prove even a determined attempt can't
    // get audio turned on end to end.
    await page.click('#audio-toggle', { force: true });
    await page.waitForSelector('#generate-btn:not([disabled])', { timeout: 5000 });
    await page.click('#generate-btn');

    // Lands on home.html now (?generate=1 -- tracker item for-product-
    // funnel-ending-v2-founder-ins-tfuu0q removed processing.html/the old
    // redirect to result.html).
    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].audioOn, false);
    assert.equal(generateVideoCalls[0].musicStyle, undefined, 'musicStyle should not even be sent when audioOn is false');
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

    // Lands on home.html now (?generate=1 -- tracker item for-product-
    // funnel-ending-v2-founder-ins-tfuu0q removed processing.html/the old
    // redirect to result.html).
    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].audioOn, false);
    assert.equal(generateVideoCalls[0].musicStyle, undefined, 'musicStyle should not even be sent when audio was never turned on');
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
  //
  // UPDATE 2026-08-02 (tracker item for-product-turn-off-audio-dialogue-
  // gene-ooeyoj): this assertion is now purely about the CLIENT wire
  // payload, not the real server outcome — generate-video.js ignores
  // audioOn entirely and forces generate_audio:false unconditionally
  // regardless of what's sent here (see that file's own tests). Kept
  // exactly as-is deliberately: the tracker item's own instruction is to
  // leave this plumbing intact and inert, not rip it out, so this test
  // still proves that plumbing hasn't silently changed shape.
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

    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet this test actually exercises (#edit-generate-again).
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');
    await page.click('#edit-generate-again');
    // Lands on home.html now (?generate=1 -- tracker item for-product-
    // funnel-ending-v2-founder-ins-tfuu0q removed processing.html/the old
    // redirect straight back to result.html).
    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });

    await settle(function () { return !!capturedBody; });
    assert.ok(capturedBody, 'generate-video.js must have been called');
    assert.equal(capturedBody.audioOn, true, 'regenerateDream must preserve the pre-existing always-audio-on behavior, not silently adopt the new default-off');
  } finally {
    await context.close();
  }
});
