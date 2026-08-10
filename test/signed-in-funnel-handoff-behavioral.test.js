// test/signed-in-funnel-handoff-behavioral.test.js
//
// Real browser-driven coverage for tracker item
// for-product-unify-create-html-to-questio-lif350's second half (founder
// repro, 2026-08-10, HIGH): a LOGGED-IN user completing the marketing
// funnel and arriving at start.html via ?resume=1&caption=...&style=...
// (the same params a signed-OUT arrival carries) appeared to LOSE the
// funnel dream -- start.html's own "Returning-visitor-with-a-live-session
// guard" (tracker item for-product-urgent-forensic-find-the-pro-fzgghg,
// item 3) redirected this visitor straight to a bare `home.html`
// UNCONDITIONALLY, before captionText/chosenStyle were ever even read, so
// the built dream was silently dropped on the floor. The founder-described
// destination was "routed to create.html" -- verified against the real
// code, that's not what start.html's own guard actually does today (it has
// always targeted home.html, never create.html, for this exact case); this
// suite pins the REAL behavior found by reading start.html end to end (see
// that guard's own doc comment for the fix and its full reasoning) rather
// than the guessed one.
//
// Fix: the guard now reads the same caption/style/mode params the ordinary
// (signed-out) funnel tail reads further down, and routes a signed-in
// arrival through the SAME "hand off a built dream and generate" seam every
// other in-app creation path in this codebase already uses --
// style.html's own Generate button sets the draft and redirects to
// `home.html?generate=1`, which home.html's own handleFreshInAppGeneration
// already picks up and submits generation for, unmodified. A record-mode
// arrival (no caption -- nothing was recorded funnel-side) instead lands on
// create.html's own record UI, mirroring exactly what completeFunnel
// already does for a BRAND-NEW signup in record mode. A bare ?resume=1 with
// neither (a stale/odd link) still falls through to the original plain
// `home.html`, unchanged.
//
// Follows this repo's established browser-test conventions: a plain static
// file server (test/helpers/static-server.js, no real Netlify Functions
// runtime), page.route() interception for every function endpoint actually
// touched, blockThirdParty() for this sandbox's flaky outbound network,
// GENERATION_MOCK_MODE-equivalent local mocking (no real fal.ai cost --
// see AGENT_POLICY.md's "Keep generation-testing cost low" section).

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 }) });
  });
}

/** Mocks generate-video.js + video-status.js so a fresh ?generate=1 submission from home.html completes without any real fal.ai call -- same shape as test/split-prompttext-storytext-behavioral.test.js's own mockGenerateAndPoll. Returns the array of decoded POST bodies generate-video.js actually received, so a test can assert the carried caption/style genuinely reached generation (proving the dream was NOT dropped, not just that routing looked right). */
function mockGenerateAndPoll(page) {
  var generateVideoCalls = [];
  page.route('**/.netlify/functions/generate-video', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    generateVideoCalls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fake-model:test-op-' + generateVideoCalls.length }) });
  });
  page.route('**/.netlify/functions/video-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
  });
  page.route('https://example.com/fake-video.mp4', function (route) {
    route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
  });
  return generateVideoCalls;
}

/** Seeds a real, already-logged-in account directly into localStorage (no signup flow involved) -- this suite's whole point is the ALREADY-SIGNED-IN arrival path, not a fresh one. */
async function seedLoggedInUser(page, username) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
}

test('start.html: an already-signed-in visitor arriving with ?resume=1&caption=...&style=... actually GENERATES the carried dream -- it is not dropped into an empty state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var generateVideoCalls = mockGenerateAndPoll(page);

    await seedLoggedInUser(page, 'signedinfunnel1');

    var caption = 'A whale swimming through a starry night sky';
    await safeGoto(page, baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent(caption));

    // Routes through the SAME seam style.html's own Generate button uses --
    // home.html?generate=1 -- never a bare, empty home.html. Asserted via
    // waitForFunction (not waitForURL matching the literal ?generate=1
    // querystring): home.html's own handleFreshInAppGeneration strips that
    // param via history.replaceState in the SAME tick it reads it (so a
    // refresh never re-submits -- see that IIFE's own doc comment), so the
    // param is gone from the address bar again before a polling
    // waitForURL could ever reliably observe it.
    await page.waitForURL(/\/home\.html/, { timeout: 8000, waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#fn-email').count(), 0, 'the signup screen must never render for an already-signed-in visitor');

    // The real proof the dream was not dropped: generate-video.js actually
    // gets called, carrying the exact caption/style the funnel handed off.
    // Polled with a short retry loop (home.html's own submission chain --
    // getTurnstileToken (no-op, no real site key configured) then the
    // actual fetch -- is async and not tied to any DOM change to wait on).
    for (var tries = 0; tries < 40 && generateVideoCalls.length < 1; tries++) {
      await page.waitForTimeout(250);
    }
    assert.equal(generateVideoCalls.length, 1, 'generate-video.js must be called exactly once -- the carried dream must actually generate, not sit dropped');
    assert.equal(generateVideoCalls[0].caption, caption, 'the exact funnel-built caption must reach generation, unmodified');
    assert.equal(generateVideoCalls[0].style, 'Cartoon', 'the funnel-chosen style must reach generation too');
  } finally {
    await context.close();
  }
});

test('start.html: an already-signed-in visitor arriving with ?resume=1&mode=record (no caption -- nothing recorded funnel-side) lands on create.html\'s own record UI, mirroring completeFunnel\'s existing signed-out record-mode destination', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await context.addInitScript(function () {
      var fakeStream = { getTracks: function () { return []; } };
      if (!navigator.mediaDevices) navigator.mediaDevices = {};
      navigator.mediaDevices.getUserMedia = function () { return Promise.resolve(fakeStream); };
      function FakeMediaRecorder(stream) { this.stream = stream; this.state = 'inactive'; this._listeners = {}; }
      FakeMediaRecorder.prototype.addEventListener = function (evt, cb) { this._listeners[evt] = this._listeners[evt] || []; this._listeners[evt].push(cb); };
      FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
      FakeMediaRecorder.prototype.stop = function () { this.state = 'inactive'; (this._listeners.stop || []).forEach(function (cb) { cb(); }); };
      FakeMediaRecorder.isTypeSupported = function () { return true; };
      window.MediaRecorder = FakeMediaRecorder;
    });
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    await seedLoggedInUser(page, 'signedinfunnel2');
    await safeGoto(page, baseUrl + '/start.html?resume=1&signup=unified&mode=record&recall=vividly&types=flying');

    await page.waitForURL(/create\.html\?record=1/, { timeout: 8000, waitUntil: 'domcontentloaded' });
    // create.html's own ?record=1 auto-trigger takes it from here -- already
    // covered end to end by test/record-mode-behavioral.test.js; this test's
    // job is only proving the signed-in arrival reaches this exact URL.
    await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('start.html: an already-signed-in visitor arriving with a bare ?resume=1 (no caption, no mode=record -- a stale/odd link with nothing to generate) still lands on a plain home.html, unchanged', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var generateVideoCalls = mockGenerateAndPoll(page);

    await seedLoggedInUser(page, 'signedinfunnel3');
    await safeGoto(page, baseUrl + '/start.html?resume=1');

    await page.waitForURL(/home\.html/, { timeout: 8000, waitUntil: 'domcontentloaded' });
    assert.doesNotMatch(page.url(), /generate=1/, 'with nothing to generate, this must be the plain home.html, not the ?generate=1 seam');
    await page.waitForTimeout(500);
    assert.equal(generateVideoCalls.length, 0, 'nothing should ever be submitted for generation when the funnel handed off no dream at all');
  } finally {
    await context.close();
  }
});

test('start.html: an already-signed-in visitor\'s funnel-stashed character (same-origin /go/ handoff, js/funnel-character-stash.js) is adopted straight into a REAL DreamStore character and rides characterIds into the generated dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var generateVideoCalls = mockGenerateAndPoll(page);

    await seedLoggedInUser(page, 'signedinfunnel4');
    // Stash a funnel character the same way redirectToApp() does on a
    // same-origin /go/ deployment (see js/funnel-character-stash.js's own
    // doc comment for the exact shape) -- must exist BEFORE start.html
    // loads, since consume() is one-shot.
    await page.evaluate(function () {
      localStorage.setItem('dreamtube_funnel_character_stash', JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        characters: [{ isSelf: true, name: '', description: 'a woman in her 30s, curly brown hair' }]
      }));
    });

    var caption = 'Flying above a glowing city at night';
    await safeGoto(page, baseUrl + '/start.html?resume=1&signup=unified&style=Cinematic&caption=' + encodeURIComponent(caption));
    // See the previous test's own comment on why this matches /home\.html/
    // rather than the transient ?generate=1 querystring.
    await page.waitForURL(/\/home\.html/, { timeout: 8000, waitUntil: 'domcontentloaded' });

    for (var tries = 0; tries < 40 && generateVideoCalls.length < 1; tries++) {
      await page.waitForTimeout(250);
    }
    assert.equal(generateVideoCalls.length, 1);
    // The wire body carries resolved character OBJECTS under `characters`
    // (js/store.js's generateVideo: resolveCharacters(opts.characterIds)),
    // not a characterIds array -- see that call site's own field list.
    assert.equal(generateVideoCalls[0].characters && generateVideoCalls[0].characters.length, 1, 'the stashed character must ride into the real generation call');
    assert.equal(generateVideoCalls[0].characters[0].isSelf, true);

    var characters = await page.evaluate(function () { return window.DreamStore.getCharacters(); });
    assert.equal(characters.length, 1, 'the stashed character must be adopted as a REAL DreamStore character, not left staged nowhere');
    assert.equal(characters[0].isSelf, true);
    assert.equal(characters[0].description, 'a woman in her 30s, curly brown hair');

    // One-shot: the stash key must be consumed, not left behind for a later, unrelated run to pick up.
    var stashLeft = await page.evaluate(function () { return localStorage.getItem('dreamtube_funnel_character_stash'); });
    assert.equal(stashLeft, null, 'the stash must be consumed (removed) once adopted');
  } finally {
    await context.close();
  }
});
