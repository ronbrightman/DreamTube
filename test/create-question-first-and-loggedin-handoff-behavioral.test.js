// test/create-question-first-and-loggedin-handoff-behavioral.test.js
//
// Coverage for two founder-reported app-funnel fixes:
//
//   FIX A — create.html (the logged-in "New Dream" builder) was unified to
//   the question-first entry + trimmed flow that wizard.html already uses:
//   it opens with the six-tile "What was your dream about?" grid (replacing
//   the old Build/Write/Record chooser), each build tile seeds the chip
//   wizard and jumps to the first unanswered step, and the standalone
//   Setting (Where) and Mood (feel) steps are gone -- inferred now
//   (inferFallbackPlaceKey per action; default 'dreamy' mood). Every build
//   tile path must still reach generation (style.html) with a valid,
//   non-empty caption, and neither Setting nor Mood must ever render.
//
//   FIX B — a LOGGED-IN funnel arrival (dreamtube.life/go -> redirectToApp
//   -> /start.html?resume=1&caption=..., and the wizard.html handoff leg)
//   must ADOPT the carried dream and GENERATE it directly (skip the signup
//   wall -- they already have an account -- via the signed-in generate path
//   home.html?generate=1), instead of being routed into create.html's fresh
//   builder and LOSING the dream. A NEW (logged-out) funnel arrival must
//   still go signup-wall -> generate, unchanged.
//
// Zero real fal.ai cost -- generate-video/video-status are mocked via
// page.route(), per AGENT_POLICY.md's "keep generation-testing cost low".
// Follows this repo's established Playwright/node:test convention (same
// static-server + blockThirdParty + Chromium-path shape as
// test/wizard-ui-behavioral.test.js / test/mood-music-bed-behavioral.test.js).

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
});

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    return route.abort();
  });
}

async function safeGoto(page, url) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
  catch (e) { await page.goto(url, { waitUntil: 'commit' }); }
}

async function seedLoggedInUserAt(page, username, path) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var state = { user: { handle: '@' + u, username: u }, accounts: {}, dreams: [], draft: { caption: '', style: null, characterIds: [], sceneryTime: null, sceneryPlace: null, restore: false }, charactersByUser: {}, likedIds: {} };
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await safeGoto(page, baseUrl + path);
}

/** Mocks generate-video + video-status + mark-generation-completed so a real
 *  signed-in generation "kicks off" (and completes) with no fal.ai cost.
 *  Returns an array the test can read: each generate-video request's parsed
 *  body (its `caption` is the engineered prompt sent to generation). */
function mockGeneration(page) {
  var calls = [];
  page.route('**/.netlify/functions/generate-video', function (route) {
    var body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave {} */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'mock:op-123', modelUsed: 'veo-lite' }) });
  });
  page.route('**/.netlify/functions/video-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'succeeded', videoUrl: '/assets/store/dream-ocean.webp' }) });
  });
  page.route('**/.netlify/functions/mark-generation-completed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 0 }) });
  });
  return calls;
}

// ===========================================================================
// FIX A — create.html question-first entry + trim
// ===========================================================================

// [tileIndex, needsAction] for the five build tiles. A scenario tile seeds
// the Action beat and skips that step; "Someone specific" (index 2) opens the
// character sheet and DOES ask the Action step.
var BUILD_TILES = [
  { i: 0, label: 'Flying', someone: false },
  { i: 1, label: 'Being chased', someone: false },
  { i: 2, label: 'Someone specific', someone: true },
  { i: 3, label: 'A place', someone: false },
  { i: 4, label: 'Something surreal', someone: false }
];

test('create.html question-first entry: the default screen is the six-tile grid over a static portrait triptych (no "surprise me", no beta footnote), with the old Build/Write/Record chooser hidden', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserAt(page, 'qfentry', '/create.html');

    await page.waitForSelector('#create-q-grid', { timeout: 5000 });
    assert.equal(await page.locator('#create-question').isVisible(), true, 'the question-first screen is the default entry');
    assert.equal(await page.locator('#create-select').isVisible(), false, 'the old Build/Write/Record chooser must be hidden');

    var tiles = await page.locator('#create-q-grid .fn-q-tile').allTextContents();
    assert.equal(tiles.length, 6, 'exactly six tiles');
    var joined = tiles.join(' | ');
    assert.match(joined, /Flying/);
    assert.match(joined, /Being chased/);
    assert.match(joined, /Someone specific/);
    assert.match(joined, /A place/);
    assert.match(joined, /Something surreal/);
    assert.match(joined, /I'll describe it/);
    assert.doesNotMatch(joined, /surprise me/i, 'no "surprise me" tile');

    // Static portrait triptych hero -- three <img> stills, never a <video>.
    assert.equal(await page.locator('#create-question .fn-q-collage img').count(), 3, 'three portrait store-image stills in the hero');
    assert.equal(await page.locator('#create-question video').count(), 0, 'the hero is static -- no <video>');
    // No beta/no-card footnote.
    assert.equal(await page.locator('#create-question').evaluate(function (el) { return /no card|beta|free/i.test(el.textContent); }), false, 'no beta/no-card footnote');
  } finally {
    await context.close();
  }
});

test('create.html question-first entry: EVERY build tile path reaches generation (style.html) with a valid non-empty caption, and neither the Setting nor the Mood step ever renders', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  for (var k = 0; k < BUILD_TILES.length; k++) {
    var tile = BUILD_TILES[k];
    var context = await newMobileContext();
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await seedLoggedInUserAt(page, 'qftile' + tile.i, '/create.html');

      await page.waitForSelector('#create-q-grid', { timeout: 5000 });
      await page.click('#create-q-grid [data-tile="' + tile.i + '"]');

      if (tile.someone) {
        // "Someone specific" opens the character sheet on the Subject step.
        await page.waitForSelector('#build-sheet-character-overlay.open', { timeout: 5000 });
        await page.click('#build-char-cancel');
      }
      await page.waitForSelector('#build-subject-chip-row', { timeout: 5000 });

      // Setting/Mood must never render, on any step of the walk.
      assert.equal(await page.locator('#build-place-row').count(), 0, tile.label + ': no Setting step on Subject');
      assert.equal(await page.locator('#build-mood-row').count(), 0, tile.label + ': no Mood step on Subject');

      await page.click('#build-subject-skip');

      if (tile.someone) {
        // Action IS asked for this tile (not pre-seeded) -- answer it.
        await page.waitForSelector('#build-action-row', { timeout: 5000 });
        assert.equal(await page.locator('#build-place-row').count(), 0, tile.label + ': no Setting step on Action');
        assert.equal(await page.locator('#build-mood-row').count(), 0, tile.label + ': no Mood step on Action');
        await page.click('#build-action-continue');
      }

      // Free text follows directly (no Setting/Mood in between).
      await page.waitForSelector('#build-freetext-input', { timeout: 5000 });
      assert.equal(await page.locator('#build-mood-row').count(), 0, tile.label + ': no Mood step before free text');
      await page.click('#build-freetext-skip');

      await page.waitForURL(/style\.html/, { timeout: 5000 });
      await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
      var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
      assert.ok(draft.caption && draft.caption.trim().length > 0, tile.label + ': reaches style.html with a non-empty caption');
      assert.match(draft.caption, /dreamlike\.$/, tile.label + ': the assembled caption ends with the inferred dreamlike clause');
      // Mood is inferred (never asked) -> persisted null (visual-style bed).
      assert.equal(draft.mood, null, tile.label + ': mood is inferred, so persisted null');
    } finally {
      await context.close();
    }
  }
});

test('create.html question-first entry: the "I\'ll describe it" tile routes to Write mode, and the Speak-it link routes to the Record flow', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserAt(page, 'qfwrite', '/create.html');
    await page.waitForSelector('#create-q-grid', { timeout: 5000 });
    await page.click('#create-q-grid [data-tile="5"]');
    await page.waitForSelector('#create-write[style*="display: flex"]', { timeout: 5000 });
    assert.equal(await page.locator('#dream-text').isVisible(), true, 'the "I\'ll describe it" tile lands in Write mode');
  } finally {
    await context.close();
  }

  // Speak-it -> record flow (mock getUserMedia so startRecordingUI runs).
  var context2 = await newMobileContext();
  try {
    await context2.addInitScript(function () {
      var fakeStream = { getTracks: function () { return []; } };
      if (!navigator.mediaDevices) navigator.mediaDevices = {};
      navigator.mediaDevices.getUserMedia = function () { return Promise.resolve(fakeStream); };
      function FakeMediaRecorder(stream, opts) { this.stream = stream; this.state = 'inactive'; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; this._l = {}; }
      FakeMediaRecorder.prototype.addEventListener = function (e, cb) { (this._l[e] = this._l[e] || []).push(cb); };
      FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
      FakeMediaRecorder.prototype.stop = function () { this.state = 'inactive'; (this._l.stop || []).forEach(function (cb) { cb(); }); };
      FakeMediaRecorder.isTypeSupported = function () { return true; };
      window.MediaRecorder = FakeMediaRecorder;
    });
    var page2 = await context2.newPage();
    await blockThirdParty(page2);
    await seedLoggedInUserAt(page2, 'qfspeak', '/create.html');
    await page2.waitForSelector('#create-q-speak', { timeout: 5000 });
    await page2.click('#create-q-speak');
    await page2.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });
    assert.equal(await page2.locator('#create-record').isVisible(), true, 'the Speak-it link lands in the Record flow');
  } finally {
    await context2.close();
  }
});

// ===========================================================================
// FIX B — logged-in funnel handoff GENERATES the dream (never loses it)
// ===========================================================================

var FUNNEL_CAPTION = 'a lucid dream of flying over a city made of glass, dreamlike.';

test('start.html: a SIGNED-IN funnel arrival (?resume=1 + caption) adopts the carried dream and GENERATES it directly (home.html?generate=1) -- it must NOT land on create.html and must NOT lose the caption', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var genCalls = mockGeneration(page);

    await seedLoggedInUserAt(page, 'funnelmember', '/start.html?resume=1&caption=' + encodeURIComponent(FUNNEL_CAPTION) + '&style=Cinematic');

    // Lands on home.html (the signed-in generate path), NEVER create.html.
    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.doesNotMatch(page.url(), /create\.html/, 'a signed-in funnel arrival must not be dropped into create.html');

    // The carried dream survives onto the draft (caption not lost)...
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.equal(draft.caption, FUNNEL_CAPTION, 'the funnel caption must survive onto the draft, verbatim');
    assert.equal(draft.style, 'Cinematic', 'the funnel style survives too');

    // ...and generation actually kicks off with that caption.
    await page.waitForFunction(function () { return true; }, null, { timeout: 500 }).catch(function () {});
    await page.waitForFunction(function () { return window.DreamStore && window.DreamStore.getPendingJob && window.DreamStore.getPendingJob(); }, null, { timeout: 8000 });
    assert.ok(genCalls.length >= 1, 'generate-video must have been called -- the dream is generated, not lost');
    assert.equal(genCalls[0].caption, FUNNEL_CAPTION, 'the generation request carries the funnel caption');
  } finally {
    await context.close();
  }
});

test('wizard.html: a SIGNED-IN funnel handoff (?resume=1 + caption) also generates the dream directly (home.html?generate=1) instead of bouncing to create.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var genCalls = mockGeneration(page);

    await seedLoggedInUserAt(page, 'funnelmember2', '/wizard.html?resume=1&caption=' + encodeURIComponent(FUNNEL_CAPTION) + '&style=Cinematic');

    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.doesNotMatch(page.url(), /create\.html/, 'the wizard.html signed-in handoff must not bounce to create.html');

    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.equal(draft.caption, FUNNEL_CAPTION, 'the funnel caption survives onto the draft');

    await page.waitForFunction(function () { return window.DreamStore && window.DreamStore.getPendingJob && window.DreamStore.getPendingJob(); }, null, { timeout: 8000 });
    assert.ok(genCalls.length >= 1, 'generate-video must have been called');
    assert.equal(genCalls[0].caption, FUNNEL_CAPTION, 'the generation request carries the funnel caption');
  } finally {
    await context.close();
  }
});

test('wizard.html: a NEW (logged-out) funnel arrival is UNCHANGED -- it lands on the signup wall and does NOT auto-generate (signup-wall -> generate stays intact)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var genCalls = mockGeneration(page);

    // No signed-in user seeded -- a genuine logged-out funnel arrival.
    await safeGoto(page, baseUrl + '/wizard.html?resume=1&caption=' + encodeURIComponent(FUNNEL_CAPTION) + '&style=Cinematic');
    // Give any (incorrect) redirect a chance to fire.
    await page.waitForTimeout(1200);

    assert.match(page.url(), /wizard\.html/, 'a logged-out funnel arrival must stay on the wizard signup-wall flow, not redirect to home/create');
    assert.equal(genCalls.length, 0, 'a logged-out arrival must NOT auto-generate -- generation happens after the signup wall, unchanged');
  } finally {
    await context.close();
  }
});
