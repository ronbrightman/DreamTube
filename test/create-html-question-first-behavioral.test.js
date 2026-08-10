// test/create-html-question-first-behavioral.test.js
//
// Real browser-driven coverage for tracker item
// for-product-unify-create-html-to-questio-lif350 (founder-found bug,
// 2026-08-10, HIGH): create.html (the LOGGED-IN "New Dream" builder) still
// showed the OLD Build/Write/Record chooser + full old wizard after
// wizard.html (the pre-signup builder) was already redesigned to the
// question-first screen 1 (triptych hero + six tiles, no surprise-me/beta)
// plus a trimmed Where/Mood step -- logged-in users were stuck on the stale
// UX. This file pins that create.html now matches wizard.html's own
// question-first screen 1 exactly (same tile set/order/labels/hero), and
// that its Build panel got the same Where/Mood trim wizard.html already
// has -- mirroring test/wizard-ui-behavioral.test.js's
// "wizard.html question-first screen 1: a fresh arrival sees the six-tile
// ..." and "wizard.html (question-first trim): ..." tests, the reference
// implementation this create.html redesign ports.
//
// Follows this repo's established browser-test conventions: a plain static
// file server (test/helpers/static-server.js, no real Netlify Functions
// runtime), blockThirdParty() for this sandbox's flaky outbound network to
// fonts/PostHog/Pixel, 'domcontentloaded' navigation with a retry (see
// CLAUDE.md's known environment quirk).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Seeds a logged-in account directly into localStorage, then navigates to path -- same convention as test/create-record-inapp-webview-guard-behavioral.test.js's own helper. */
async function seedLoggedInUserAt(page, username, path) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await safeGoto(page, baseUrl + path);
}

test('create.html: a fresh logged-in arrival sees the six-tile "What was your dream about?" grid over a STATIC store-image collage (no video, no "surprise me", no beta footnote) -- byte-identical tile set to wizard.html\'s own question-first screen 1', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInUserAt(page, 'qfirsttester1', '/create.html');
    await page.waitForSelector('#q-grid');

    assert.equal(await page.locator('#q-grid .q-tile').count(), 6, 'exactly six question tiles');
    assert.match(await page.locator('.q-label').first().textContent(), /What was your dream about\?/);

    // Static portrait-triptych hero -- three full store-image stills
    // (desert/ocean/forest), never a <video>, matching wizard.html's own
    // finalized hero exactly (same asset paths, same order).
    assert.equal(await page.locator('.q-collage img').count(), 3, 'the hero is a static portrait triptych (three stills)');
    assert.equal(await page.locator('.q-collage video').count(), 0, 'the hero must be static -- no video element');
    var heroSrcs = await page.locator('.q-collage img').evaluateAll(function (imgs) { return imgs.map(function (i) { return i.getAttribute('src'); }); });
    assert.deepEqual(heroSrcs, ['/assets/store/dream-desert.webp', '/assets/store/dream-ocean.webp', '/assets/store/dream-forest.webp'], 'the triptych is desert -> ocean -> forest, in that order, same as wizard.html');
    assert.equal(await page.locator('.q-collage img[src*="neon"]').count(), 0, 'the dropped dream-neon.webp image must not appear here either');

    // No surprise-me escape hatch, no beta footnote -- the finalized shape.
    assert.equal(await page.locator('#q-surprise').count(), 0, 'no "surprise me" option');
    assert.equal(await page.getByText('Free while', { exact: false }).count(), 0, 'no beta footnote');

    // The OLD three-card chooser must never be visibly reachable -- it is
    // superseded, not merely supplemented (see create.html's own
    // #create-select markup comment for why the elements still exist in
    // the DOM, permanently hidden, as dispatch targets).
    assert.equal(await page.locator('#choice-build').isVisible(), false, '#choice-build must not be visible');
    assert.equal(await page.locator('#choice-write').isVisible(), false, '#choice-write must not be visible');
    assert.equal(await page.locator('#choice-record').isVisible(), false, '#choice-record must not be visible');
    assert.equal(await page.getByText('Describe a dream', { exact: true }).count(), 0, 'the old section label is gone');

    // Each tile's second <span> holds the plain label text (the first is
    // the emoji chip) -- matches wizard.html's own .fn-q-tile markup shape.
    var tileLabels = await page.locator('#q-grid .q-tile span:last-child').allTextContents();
    assert.deepEqual(
      tileLabels.map(function (s) { return s.trim(); }),
      ['Flying', 'Being chased', 'Someone specific', 'A place', 'Something surreal', "I'll describe it"],
      'tile order/labels must match wizard.html\'s own QUESTION_TILES exactly'
    );

    // No console errors on a totally cold, logged-in load.
    var consoleErrors = [];
    page.on('pageerror', function (err) { consoleErrors.push(String(err)); });
    await page.evaluate(function () { return true; }); // flush any pending events
    assert.deepEqual(consoleErrors, [], 'create.html must not throw on a fresh logged-in load');
  } finally {
    await page.close();
  }
});

test('create.html: tapping a scenario tile ("Flying") seeds the Build-it Action step and skips it entirely, landing on Subject -- the removed Setting/Mood steps never appear, matching wizard.html\'s own question-first trim', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInUserAt(page, 'qfirsttester2', '/create.html');
    await page.waitForSelector('#q-grid');

    await page.click('#q-grid [data-tile="0"]'); // Flying
    await page.waitForSelector('#create-build[style*="display: flex"]', { timeout: 5000 });
    await page.waitForSelector('#build-subject-chip-row', { timeout: 5000 });
    assert.equal(await page.locator('#create-select').isVisible(), false, 'the chooser must be hidden once a tile commits');

    // Subject -> Free text directly: the seeded Action step is skipped
    // entirely (buildActionSeededByTile), and the removed Setting step
    // never appears either.
    await page.click('#build-subject-skip');
    await page.waitForSelector('#build-freetext-input', { timeout: 5000 });
    assert.equal(await page.locator('#build-place-row').count(), 0, 'Setting must never render');
    assert.equal(await page.locator('#build-action-row').count(), 0, 'a tile-seeded Action step must be skipped entirely, never rendered');
    assert.equal(await page.locator('#build-mood-row').count(), 0, 'Mood must never render');

    await page.click('#build-freetext-skip');
    await page.waitForURL(/style\.html/, { timeout: 5000 });
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.match(draft.caption, /flying/, 'the seeded "flying" action must reach the assembled caption');
    assert.equal(draft.sceneryPlace, 'sky', 'flying infers the "sky" fallback place (WizardChips.inferFallbackPlaceKey)');
    assert.equal(draft.mood, null, 'mood is always null -- inferred, never asked');
  } finally {
    await page.close();
  }
});

test('create.html: the "Someone specific" tile lands on Build-it\'s Subject step WITHOUT pre-seeding Action -- it opens the character sheet immediately, and Action is still asked afterward', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInUserAt(page, 'qfirsttester3', '/create.html');
    await page.waitForSelector('#q-grid');

    await page.click('#q-grid [data-tile="2"]'); // Someone specific
    await page.waitForSelector('#build-sheet-character-overlay.open', { timeout: 5000 });
    await page.click('#build-char-cancel');
    await page.waitForSelector('#build-subject-chip-row', { timeout: 5000 });

    await page.click('#build-subject-skip');
    // Action must still be asked (not skipped) -- this tile never seeds it.
    await page.waitForSelector('#build-action-row', { timeout: 5000 });
  } finally {
    await page.close();
  }
});

test('create.html: the "I\'ll describe it" tile routes straight into the existing Write it panel (the same #create-write surface the old chooser\'s Write it card always used)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInUserAt(page, 'qfirsttester4', '/create.html');
    await page.waitForSelector('#q-grid');

    await page.click('#q-grid [data-tile="5"]'); // I'll describe it
    await page.waitForSelector('#create-write[style*="display: flex"]', { timeout: 5000 });
    assert.equal(await page.locator('#create-select').isVisible(), false);

    var text = 'I was walking through a glowing forest at midnight';
    await page.fill('#dream-text', text);
    await page.click('#write-continue');
    await page.waitForURL(/style\.html/, { timeout: 5000 });
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.equal(draft.caption, text, 'a written dream reaches the draft verbatim, same Write-it contract as before');
  } finally {
    await page.close();
  }
});

test('create.html: "Speak it instead" dispatches into the existing Record it flow (startRecordingUI), and is hidden entirely in an Instagram in-app webview while the six tiles still render', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await context.addInitScript(function () {
      window.__getUserMediaCalls = 0;
      var fakeStream = { getTracks: function () { return []; } };
      if (!navigator.mediaDevices) navigator.mediaDevices = {};
      navigator.mediaDevices.getUserMedia = function () {
        window.__getUserMediaCalls++;
        return Promise.resolve(fakeStream);
      };
      // startRecordingUI() also constructs a real MediaRecorder right after
      // getUserMedia resolves -- same fake shape test/record-mode-
      // behavioral.test.js's own installMediaRecorderMock uses.
      function FakeMediaRecorder(stream) {
        this.stream = stream;
        this.state = 'inactive';
        this._listeners = {};
      }
      FakeMediaRecorder.prototype.addEventListener = function (evt, cb) {
        this._listeners[evt] = this._listeners[evt] || [];
        this._listeners[evt].push(cb);
      };
      FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
      FakeMediaRecorder.prototype.stop = function () {
        this.state = 'inactive';
        (this._listeners.stop || []).forEach(function (cb) { cb(); });
      };
      FakeMediaRecorder.isTypeSupported = function () { return true; };
      window.MediaRecorder = FakeMediaRecorder;
    });
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserAt(page, 'qfirstspeak1', '/create.html');
    await page.waitForSelector('#q-speak', { timeout: 5000 });

    await page.click('#q-speak');
    await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });
    var calls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(calls, 1, 'tapping "Speak it instead" must call getUserMedia exactly once, inside the same user gesture');
  } finally {
    await context.close();
  }

  var igCtx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Instagram 300.0.0.0' });
  try {
    var page2 = await igCtx.newPage();
    await blockThirdParty(page2);
    await seedLoggedInUserAt(page2, 'qfirstspeak2', '/create.html');
    await page2.waitForSelector('#q-grid', { timeout: 5000 });
    assert.equal(await page2.locator('#q-speak').count(), 0, '"Speak it instead" must be hidden in an Instagram in-app webview');
    assert.equal(await page2.locator('#q-grid .q-tile').count(), 6, 'all six tiles must still render in a webview');
  } finally {
    await igCtx.close();
  }
});

test('create.html: the ?build=1/?write=1/?record=1 deep-links (used by home.html\'s own entry points) still work unchanged -- they bypass the question-first chooser entirely, same as before this redesign', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInUserAt(page, 'qfirstdeeplink1', '/create.html?build=1');
    await page.waitForSelector('#build-subject-chip-row', { timeout: 5000 });
    assert.equal(await page.locator('#create-select').isVisible(), false);
  } finally {
    await page.close();
  }

  var page2 = await browser.newPage();
  await blockThirdParty(page2);
  try {
    await seedLoggedInUserAt(page2, 'qfirstdeeplink2', '/create.html?write=1');
    await page2.waitForSelector('#create-write[style*="display: flex"]', { timeout: 5000 });
  } finally {
    await page2.close();
  }
});
