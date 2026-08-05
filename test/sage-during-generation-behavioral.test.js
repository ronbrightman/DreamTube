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

// ============================================================================
// 4. The reading is PERSISTED even when its own response lands AFTER the video
// ============================================================================
//
// The three tests above all sequence the race one way only: every
// interpret-dream / generate-interp-audio response resolves BEFORE the video
// lands. That ordering never exercises the actual hazard this feature
// creates, and is exactly why the bug below shipped undetected.
//
// The hazard: a reading (or its TTS track) is requested against the synthetic
// `pending:<operationName>` id, and the video finishes generating WHILE that
// request is still in flight. finalizeDream clears pendingJob in the same
// tick it creates the real dream, so by the time the response arrives the
// pending id no longer resolves to anything at all. The UI-session half of
// the swap (notifyDreamResolved/stillTargetsDream) tolerates this and still
// renders the reading — which is precisely what makes the failure invisible:
// it LOOKS fine in the live session, and is simply never written to disk.
//
// So these two tests hold the response open past the moment the video lands,
// then release it, and assert on the DURABLE record after a reload — not on
// what the still-live overlay happens to be showing.

/**
 * Like mockInterpretDream, but HOLDS the `mode:"reading"` response open
 * instead of fulfilling it. Returns a handle whose `.release(text)` fulfils
 * it on demand, and whose `.captured()` reports whether the request has
 * actually reached the route yet.
 */
function mockInterpretDreamWithHeldReading(page) {
  var held = null;
  page.route('**/.netlify/functions/interpret-dream', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    if (body.mode === 'reading') { held = route; return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [] }) });
  });
  return {
    captured: function () { return !!held; },
    release: function (text) {
      return held.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: text }) });
    }
  };
}

/** Waits for the in-flight generation to have actually landed in the store -- pendingJob cleared and the real dream written -- and resolves with the real dream's id. This is the exact moment the `pending:` id goes dead. */
function waitForRealDreamId(page) {
  return page.waitForFunction(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    if (!raw) return null;
    var s = JSON.parse(raw);
    if (s.pendingJob) return null;
    var d = (s.dreams || []).filter(function (x) { return x.videoUrl || x.imageUrl; })[0];
    return d ? d.id : null;
  }, null, { timeout: 10000 }).then(function (handle) { return handle.jsonValue(); });
}

/** Re-reads the durable record from a FRESH page load -- the only thing that proves a write actually persisted, as opposed to living in the still-open session's memory. */
async function readPersistedInterpretation(page, dreamId, personaKey) {
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
  return page.evaluate(function (a) {
    var map = window.DreamStore.getInterpretations(a.id) || {};
    return map[a.persona] || null;
  }, { id: dreamId, persona: personaKey });
}

test('a reading whose response lands AFTER the video finishes is still PERSISTED to the real dream -- the pending: id it was requested under is dead by then, and must not silently swallow the write', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await forcePlaySucceeds(page);
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    var reading = mockInterpretDreamWithHeldReading(page);
    await page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // The TTS call is deliberately left hanging forever, so this test can
    // only pass because generateInterpretationReading ITSELF persisted.
    // Without this, generateInterpAudio's write block quietly covers for a
    // lost reading -- it fabricates `map[personaKey] || { text: text, at:
    // Date.now(), qa: [] }` from the text it was handed, which resurrects a
    // reading record that was never actually saved. That masking is real
    // (it made an earlier draft of this very test pass against the unfixed
    // code), so isolating the two write paths is load-bearing here, not
    // tidiness.
    await page.route('**/.netlify/functions/generate-interp-audio', function () { /* held open, deliberately */ });

    var heldVideo = null;
    await page.route('**/.netlify/functions/video-status*', function (route) { heldVideo = route; });

    await seedPendingHome(page, { username: 'readingafter' });
    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    await page.click('#d0-sage');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
    await page.click('.itp-persona-card[data-key="talmudic"]');

    // The reading request is out and hanging, against the pending id.
    await page.waitForFunction(function () { return true; }, null, { timeout: 100 }).catch(function () {});
    var waited = 0;
    while (!reading.captured() && waited < 8000) { await new Promise(function (r) { setTimeout(r, 100); }); waited += 100; }
    assert.ok(reading.captured(), 'the reading request must be genuinely in flight before the video is allowed to land');

    // Now the video lands, WHILE that reading request is still open. This is
    // the moment `pending:<operationName>` stops resolving to anything.
    assert.ok(heldVideo, 'expected home.html to be polling video-status');
    await heldVideo.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/landed-first.mp4' }) });
    var realId = await waitForRealDreamId(page);
    assert.ok(realId && !/^pending:/.test(realId), 'sanity: the generation must have produced a real dream id (got ' + realId + ')');

    // Only NOW does the reading come back.
    var READING_TEXT = 'The golden city is the part of you that already knows the way home.';
    await reading.release(READING_TEXT);
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 8000 });
    assert.match(await page.locator('#itp-reading-text').textContent(), /golden city/, 'sanity: the live session still renders the reading (this half already worked -- it is what hid the persistence bug)');

    // The real assertion: it survived. Reopened from a fresh load, the
    // reading is on the REAL dream, not lost with the dead pending id.
    var saved = await readPersistedInterpretation(page, realId, 'talmudic');
    assert.ok(saved, 'the reading must be persisted onto the real dream -- a reading that renders once and is gone on reload is a silent data loss, and any TTS spend behind it is wasted');
    assert.equal(saved.text, READING_TEXT, 'the persisted reading must be the one the user actually saw');
    assert.ok(saved.at, 'the persisted reading must carry its own timestamp (interpret-experience sorts revisits by it)');
  } finally {
    await context.close();
  }
});

test('a voice track whose TTS response lands AFTER the video finishes is still PERSISTED onto the real dream\'s reading -- generate-interp-audio has an 18s sync budget, so it is the likeliest caller to lose this race', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await forcePlaySucceeds(page);
    await blockThirdParty(page);
    await mockTokenStatus(page, { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });
    mockInterpretDream(page);
    await page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // The TTS call is held open; the reading itself resolves normally.
    var heldAudio = null;
    await page.route('**/.netlify/functions/generate-interp-audio', function (route) { heldAudio = route; });
    var heldVideo = null;
    await page.route('**/.netlify/functions/video-status*', function (route) { heldVideo = route; });

    await seedPendingHome(page, { username: 'audioafter' });
    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    await page.click('#d0-sage');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });
    await page.click('.itp-persona-card[data-key="talmudic"]');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 8000 });

    var waited = 0;
    while (!heldAudio && waited < 8000) { await new Promise(function (r) { setTimeout(r, 100); }); waited += 100; }
    assert.ok(heldAudio, 'the TTS request must be genuinely in flight before the video is allowed to land');

    assert.ok(heldVideo, 'expected home.html to be polling video-status');
    await heldVideo.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/landed-first-audio.mp4' }) });
    var realId = await waitForRealDreamId(page);
    assert.ok(realId && !/^pending:/.test(realId), 'sanity: the generation must have produced a real dream id (got ' + realId + ')');

    // Only NOW does the TTS come back (sync-first shape -- see
    // js/store.js's generateInterpAudio `data.done && data.audioUrl` path).
    var AUDIO_URL = baseUrl + '/sage-voice-x7q4.mp3';
    await heldAudio.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ done: true, audioUrl: AUDIO_URL, audioDurationMs: 1400, captions: [{ word: 'The', startMs: 0, endMs: 300 }], captionsLevel: 'word' })
    });

    await page.waitForFunction(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      if (!raw) return false;
      var s = JSON.parse(raw);
      return (s.dreams || []).some(function (d) {
        return d.interpretations && d.interpretations.talmudic && d.interpretations.talmudic.audioUrl;
      });
    }, null, { timeout: 8000 }).catch(function () { /* asserted properly below, with a real message */ });

    var saved = await readPersistedInterpretation(page, realId, 'talmudic');
    assert.ok(saved, 'the reading itself must still be on the real dream');
    assert.equal(saved.audioUrl, AUDIO_URL, 'the generated voice track must be persisted onto the real dream -- otherwise the next visit re-runs (and re-pays for) TTS that already succeeded');
    assert.equal(saved.audioDurationMs, 1400, 'the voice track\'s duration must persist alongside it');
    assert.equal(saved.captionsLevel, 'word', 'the caption level must persist alongside it');
  } finally {
    await context.close();
  }
});
