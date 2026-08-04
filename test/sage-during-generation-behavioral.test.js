// test/sage-during-generation-behavioral.test.js
//
// Real-browser coverage for the founder's 2026-08-04 ask (tracker item
// for-product-founder-ask-08-04-offer-the--rlcai3): "on processing while
// the dream generates, there is no offer to do the interpretation — there
// should be... entering the Chamber from processing must target the
// CURRENTLY-GENERATING dream (the pending one) by default — today it opens
// an existing older video... the reading can begin while the video is
// still rendering."
//
// There is no literal processing.html anymore (funnel-ending-v2 removed the
// standalone wait screen); the "processing" experience the founder means is
// home.html's embedded forming room card (#day0-card — see that page's own
// shouldShowRoomCard()/renderDay0CardForming()). Three behaviors are
// covered here, each mapping to one clause of that ask:
//
//   1. The offer EXISTS and is reachable while forming (#d0-sage), in place
//      of the old "Ready when your dream is" caption.
//   2. It — and the Chamber pill next to it — target the PENDING dream, not
//      an older completed one. Proven by the actual dream TEXT that reaches
//      interpret-dream.js, which is the only unambiguous evidence of which
//      dream a reading is really about (an assertion on the id alone would
//      pass just as happily against a stale in-memory session).
//   3. The reading survives the video landing mid-session: the finished
//      video swaps into the voice stage in place
//      (InterpretExperience.notifyDreamResolved), the reading text/audio
//      are untouched, and the session re-points at the real dream id.
//
// Follows this repo's established Playwright/node:test conventions —
// test/home-day0-dream-card-behavioral.test.js's seedDay0Pending/
// mockTokenStatus/blockThirdParty shape and test/interp-voice-behavioral.
// test.js's mockInterpretDream/mockInterpAudio/forcePlayOutcome shape,
// deliberately re-declared here rather than shared-imported, matching this
// codebase's per-file test-helper self-containment convention.

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
  if (server) await server.close();
});

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network. */
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

var PENDING_TEXT = 'I was flying over a golden city at night';
var OLDER_TEXT = 'I was lost in a library that had no doors';

/**
 * Seeds a signed-in account with an in-flight generation, and optionally
 * one ALREADY-COMPLETED older dream -- the exact shape the founder's bug
 * report needs (a pending dream competing with an older finished one).
 * `opts.olderDream: true` adds that older dream; omit it for the day-0
 * "nothing finished yet" case.
 */
async function seedPendingHome(page, opts) {
  opts = opts || {};
  var username = opts.username || 'sagegen';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var handle = '@' + o.username;
    var dreams = [];
    if (o.olderDream) {
      dreams.push({
        id: 'older-dream-1',
        ownerHandle: handle,
        caption: o.olderText,
        storyText: o.olderText,
        style: 'Cinematic',
        videoUrl: 'https://example.com/older-dream-1.mp4',
        isPublished: false,
        likes: 0,
        // Yesterday -- so it is genuinely an EARLIER dream, and today's
        // entry is unambiguously the pending one.
        createdAt: Date.now() - 26 * 60 * 60 * 1000
      });
    }
    var state = {
      user: { handle: handle, username: o.username },
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: dreams,
      pendingJob: {
        operationName: 'mock:req-' + o.username,
        startedAt: Date.now(),
        caption: o.pendingText,
        storyText: o.pendingText,
        style: 'Cinematic',
        sourceDreamId: null,
        mediaType: 'video',
        notify: false,
        ownerHandle: handle
      }
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com', noRecallDates: [] };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, olderDream: !!opts.olderDream, olderText: OLDER_TEXT, pendingText: PENDING_TEXT });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

/** Seeds the same account with the generation ALREADY finished -- the ready state, where the during-generation offer must step aside. */
async function seedCompletedHome(page, username) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var handle = '@' + o.username;
    var state = {
      user: { handle: handle, username: o.username },
      accounts: {},
      draft: {},
      dreams: [{
        id: 'ready-dream-1',
        ownerHandle: handle,
        caption: o.text,
        storyText: o.text,
        style: 'Cinematic',
        videoUrl: 'https://example.com/ready-dream-1.mp4',
        isPublished: false,
        likes: 0,
        createdAt: Date.now()
      }]
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com', noRecallDates: [] };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, text: PENDING_TEXT });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

/**
 * Mocks interpret-dream.js and RECORDS every caption it was asked about --
 * the evidence these tests actually assert on for "which dream is this
 * reading about". Returns the recording array (populated as requests land).
 */
function mockInterpretDream(page, opts) {
  opts = opts || {};
  var seenCaptions = [];
  page.route('**/.netlify/functions/interpret-dream', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    seenCaptions.push({ mode: body.mode, caption: body.caption });
    if (body.mode === 'questions') {
      // Empty question list -- js/interpret-experience.js's own documented
      // "questions are never a gate" path drops straight to the reading,
      // keeping these tests about the entry point rather than the stepper.
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [] }) });
      return;
    }
    if (body.mode === 'reading') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: opts.reading || 'A city of gold beneath you is a sign you are closer to what you seek than you know.' }) });
      return;
    }
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'E409: invalid_mode' }) });
  });
  return seenCaptions;
}

/** One-shot mock of the two Speaking Sage endpoints (no real polling delay), matching test/interp-voice-behavioral.test.js's own shape. */
function mockInterpAudio(page) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-interp-audio', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/kokoro/american-english:test-req-1' }) });
    }),
    page.route('**/.netlify/functions/interp-audio-status*', function (route) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'done',
          audioUrl: baseUrl + '/sage-voice-x7q4.mp3',
          audioDurationMs: 1400,
          captions: [{ word: 'A', startMs: 0, endMs: 300 }, { word: 'city.', startMs: 300, endMs: 1400 }],
          captionsLevel: 'word'
        })
      });
    })
  ]);
}

/** Forces every `<video>`/`<audio>` .play() to resolve -- sidesteps this sandbox's real, environment-specific autoplay policy (same technique test/interp-voice-behavioral.test.js documents). */
function forcePlaySucceeds(page) {
  return page.addInitScript(function () {
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  });
}

// ============================================================================
// 1. The offer exists while the dream is still generating
// ============================================================================

test('home.html forming card: the interpretation offer is visible and tappable WHILE the dream generates, in place of the old "Ready when your dream is" line -- founder ask for-product-founder-ask-08-04-offer-the--rlcai3', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    // Never resolves -- keeps this job forming for the whole test.
    await page.route('**/.netlify/functions/video-status*', function () { /* stalled, deliberately */ });
    await seedPendingHome(page, { username: 'formingoffer' });

    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#d0-forming-veil').isVisible(), true, 'sanity: this must be the forming state');

    var sage = page.locator('#d0-sage');
    assert.equal(await sage.isVisible(), true, 'the interpretation offer must be on screen while the dream is still generating');
    var label = (await sage.textContent()).trim();
    assert.match(label, /what does this dream mean/i, 'same offer wording result.html\'s own completed-dream hero uses -- one offer, one name for it');

    // A real, thumb-sized tap target on a real mobile viewport -- this app
    // has a documented history of tap-target regressions that only showed
    // up under real interaction.
    var box = await sage.boundingBox();
    assert.ok(box.height >= 44, 'the offer must be a real, thumb-sized tap target, not a text link (got ' + box.height + 'px tall)');
    assert.ok(box.width > 200, 'the offer must span the card, matching its other primary actions (got ' + box.width + 'px wide)');

    // The founder's own placement instruction: the "ready when you are"
    // line is gone so this comes into view.
    var cardText = await page.locator('#day0-card').innerText();
    assert.doesNotMatch(cardText, /ready when your dream is/i, 'the old bottom caption must be replaced, not merely pushed further down');
  } finally {
    await context.close();
  }
});

test('home.html ready card: the during-generation interpretation offer steps aside once the video has landed (the ready state keeps its own existing entry points)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    await seedCompletedHome(page, 'readyoffer');

    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('#d0-video.ready', { timeout: 5000 });
    assert.equal(await page.locator('#d0-sage').isVisible(), false, 'the forming-only offer must not linger into the ready state');
    assert.equal(await page.locator('#d0-watch').isVisible(), true, 'sanity: the ready state\'s own affordances are unchanged');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. It targets the CURRENTLY-GENERATING dream, not an older completed one
// ============================================================================

test('home.html forming card: tapping the interpretation offer opens a reading about the CURRENTLY-GENERATING dream\'s text, even when an older completed dream exists -- the founder-reported bug ("today it opens an existing older video")', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    await page.route('**/.netlify/functions/video-status*', function () { /* stalled, deliberately */ });
    var seen = mockInterpretDream(page);
    await seedPendingHome(page, { username: 'pendingtarget', olderDream: true });

    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    await page.click('#d0-sage');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
    assert.equal(page.url(), baseUrl + '/home.html', 'must open the overlay in place, never navigate away mid-generation');

    // A fresh picker (not a saved reading) -- then a persona pick drives the
    // real questions -> reading network path.
    await page.click('.itp-persona-card[data-key="talmudic"]');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 8000 });

    assert.ok(seen.length >= 1, 'the reading flow must have actually called interpret-dream');
    seen.forEach(function (call) {
      assert.equal(call.caption, PENDING_TEXT, 'every interpret-dream call must be about the still-generating dream (' + call.mode + ' asked about: ' + call.caption + ')');
      assert.notEqual(call.caption, OLDER_TEXT, 'must never fall back to the older completed dream');
    });
  } finally {
    await context.close();
  }
});

test('home.html Chamber pill: with a generation in flight AND an older completed dream, entering the Chamber targets the PENDING dream -- regression test for the priority inversion in chamberTargetDreamId()', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    await page.route('**/.netlify/functions/video-status*', function () { /* stalled, deliberately */ });
    var seen = mockInterpretDream(page);
    await seedPendingHome(page, { username: 'chamberpending', olderDream: true });

    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    await page.click('#chamber-pill');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
    await page.click('.itp-persona-card[data-key="talmudic"]');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 8000 });

    assert.ok(seen.length >= 1);
    seen.forEach(function (call) {
      assert.equal(call.caption, PENDING_TEXT, 'the Chamber must open on the currently-generating dream, not the older completed one');
    });
  } finally {
    await context.close();
  }
});

test('home.html Chamber pill: with NO generation in flight, an existing completed dream is still what the Chamber opens (the priority flip must not have broken the ordinary case)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    var seen = mockInterpretDream(page);
    await seedCompletedHome(page, 'chambernopending');

    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    assert.equal(await page.locator('#chamber-pill').getAttribute('href'), 'result.html?id=ready-dream-1', 'the completed-dream fallback href is unchanged');
    await page.click('#chamber-pill');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
    await page.click('.itp-persona-card[data-key="talmudic"]');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 8000 });

    assert.ok(seen.length >= 1);
    seen.forEach(function (call) {
      assert.equal(call.caption, PENDING_TEXT, 'sanity: the completed dream\'s own text');
    });
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3. The video swaps in when it lands, mid-reading
// ============================================================================

test('the reading started during generation survives the video landing: it mounts with NO video, then the finished video swaps into the voice stage in place and the session re-points at the real dream id -- the reading text itself never reloads', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await forcePlaySucceeds(page);
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    mockInterpretDream(page);
    await mockInterpAudio(page);

    // Hold the first video-status poll open, deferred, so the generation is
    // genuinely still in flight while the reading mounts -- then fulfil it
    // on demand, at the exact moment this test wants the video to land.
    var heldRoute = null;
    await page.route('**/.netlify/functions/video-status*', function (route) { heldRoute = route; });
    await page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await seedPendingHome(page, { username: 'swapin' });
    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    await page.click('#d0-sage');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
    // talmudic is the one voice-eligible persona -- the only path that
    // mounts the dream-video stage this test is about.
    await page.click('.itp-persona-card[data-key="talmudic"]');
    await page.waitForSelector('#itp-voice-stage', { state: 'attached', timeout: 8000 });
    // Skip the one-time persona intro deterministically rather than waiting
    // out a real clip's duration.
    await page.waitForSelector('#itp-voice-skip', { state: 'visible', timeout: 5000 });
    await page.click('#itp-voice-skip');

    var readingBefore = await page.locator('#itp-reading-text').textContent();
    var srcBefore = await page.locator('#itp-voice-dream-video').getAttribute('src');
    assert.equal(srcBefore, null, 'the reading must mount on the existing no-video path while the dream is still rendering');

    // The video lands.
    assert.ok(heldRoute, 'expected home.html to be polling video-status');
    await heldRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/swapped-in.mp4' }) });

    await page.waitForFunction(function () {
      var el = document.getElementById('itp-voice-dream-video');
      return el && el.getAttribute('src');
    }, null, { timeout: 8000 });
    var srcAfter = await page.locator('#itp-voice-dream-video').getAttribute('src');
    assert.equal(srcAfter, 'https://example.com/swapped-in.mp4', 'the real video must swap into the SAME voice stage once it lands');

    // The reading itself is untouched -- same text, same overlay, no reload.
    assert.equal(await page.locator('#itp-reading-text').textContent(), readingBefore, 'the reading text must not have been re-fetched or re-rendered by the swap');
    assert.equal(await page.locator('#itp-root').isVisible(), true, 'the overlay must still be open');
    assert.equal(page.url(), baseUrl + '/home.html');

    // The session now names the REAL dream: its strip tile is the real
    // dream's, and re-opening a reading targets that id.
    var selectedId = await page.locator('#itp-dream-strip .dream-row-tile.is-selected').getAttribute('data-dream-id');
    assert.ok(selectedId, 'the dream strip must still have a selected tile after the swap');
    assert.doesNotMatch(selectedId, /^pending:/, 'the session must re-point at the real dream id, not the now-dead pending: id (got ' + selectedId + ')');
  } finally {
    await context.close();
  }
});
