// test/interp-voice-behavioral.test.js
//
// Real-browser coverage for Speaking Sage — Option D (docs/
// SPEAKING_SAGE_SPEC.md, tracker item
// for-product-build-speaking-sage-wave-fou-8uobuh, founder GO on "Option D"
// 2026-08-02/08-03): the intro/reading voice-stage state machine mounted by
// js/interpret-experience.js's renderReading, the founder-preview gate
// (`?sagevoice=1`), and every `interp_voice_*` instrumentation event
// (docs/EVENT_TAXONOMY.md). Follows test/interp-analytics-behavioral.
// test.js's own established helpers/conventions (staticServer,
// blockThirdParty, readPostHogCalls, mockInterpretDream).
//
// ASSET STATUS: `talmudic`'s introClipUrl/introVoiceUrl on this branch are
// the REAL, founder-approved Option D handoff (main commit c0b9202) — see
// js/interpreter-personas.js's own header comment for the full "silent
// looping visual + separate paired voice track" story. These tests
// exercise the MECHANISM (does the intro play, does it crossfade, do the
// events fire, does the fallback degrade correctly) rather than asserting
// anything about the clip's actual visual/audio content, so they'd stay
// valid even if the asset were swapped again later.
//
// Real `<video>`/`<audio>` autoplay success/failure is deliberately NOT
// left to depend on this sandbox's actual Chromium autoplay policy (real-
// world autoplay behavior is inherently environment-dependent and would
// make these tests flaky) — `HTMLMediaElement.prototype.play` is
// overridden via `page.addInitScript` per-test to force a deterministic
// outcome (always resolves / always rejects), the standard technique for
// testing autoplay-dependent UI without relying on the browser's real,
// environment-specific autoplay heuristics.

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

/** Seeds a logged-in account owning one video dream, matching test/interp-analytics-behavioral.test.js's own seedResultPage shape. */
async function seedResultPage(page, dreamId, extra) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var id = args.id, extra = args.extra || {};
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.dreams) state.dreams = [];
    state.dreams.push(Object.assign({
      id: id,
      ownerHandle: '@tester',
      caption: 'A dream about a desert and an oasis',
      storyText: 'I walked through a vast desert and found an oasis.',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: new Date().toISOString()
    }, extra));
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { id: dreamId, extra: extra });
  // Deliberately NO `sagevoice` param at all — this is the "preview gate
  // off" seed helper, used by the one test that asserts the voice stage
  // never mounts without it.
  await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
}

/** Real navigation with the founder-preview query param actually in the URL (a real `&sagevoice=1`), the one moment this codebase's own `isVoicePreviewEnabled` regex is exercised end to end rather than assumed. */
async function seedResultPageWithPreviewParam(page, dreamId, extra) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var id = args.id, extra = args.extra || {};
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.dreams) state.dreams = [];
    state.dreams.push(Object.assign({
      id: id,
      ownerHandle: '@tester',
      caption: 'A dream about a desert and an oasis',
      storyText: 'I walked through a vast desert and found an oasis.',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: new Date().toISOString()
    }, extra));
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { id: dreamId, extra: extra });
  await page.goto(baseUrl + '/result.html?id=' + dreamId + '&sagevoice=1', { waitUntil: 'domcontentloaded' });
}

function mockInterpretDream(page, opts) {
  opts = opts || {};
  return page.route('**/.netlify/functions/interpret-dream', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    if (body.mode === 'questions') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: opts.questions || [{ id: 'q1', text: 'What has been on your mind?', chips: ['Work', 'Family', 'A change', 'Not sure'] }] }) });
      return;
    }
    if (body.mode === 'reading') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: opts.reading || 'Ah, the desert and the oasis — a hopeful sign that you are closer to what you seek than you know. May this dream turn toward the good.' }) });
      return;
    }
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'E409: invalid_mode' }) });
  });
}

/** Mocks the two Speaking Sage Option D endpoints — one-shot resolution (no real polling delay) so these tests stay fast. `opts.captionsLevel` defaults 'word'; `opts.failGeneration`/`opts.failStatus` simulate the two soft-failure paths. */
function mockInterpAudio(page, opts) {
  opts = opts || {};
  var routes = [
    page.route('**/.netlify/functions/generate-interp-audio', function (route) {
      if (opts.failGeneration) {
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E506: tts_request_failed' }) });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/kokoro/american-english:test-req-1' }) });
    }),
    page.route('**/.netlify/functions/interp-audio-status*', function (route) {
      if (opts.failStatus) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'failed', error: 'E506: tts_request_failed: status_test' }) });
        return;
      }
      var captionsLevel = opts.captionsLevel || 'word';
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'done',
          audioUrl: baseUrl + '/sage-voice-x7q4.mp3',
          audioDurationMs: 1400,
          captions: captionsLevel === 'word' ? [
            { word: 'Ah,', startMs: 0, endMs: 300 },
            { word: 'the', startMs: 300, endMs: 500 },
            { word: 'desert.', startMs: 500, endMs: 1400 }
          ] : [],
          captionsLevel: captionsLevel
        })
      });
    })
  ];
  return Promise.all(routes);
}

/** Forces every `<video>`/`<audio>` element's `.play()` to deterministically resolve or reject — sidesteps this sandbox's real, environment-specific autoplay policy entirely (see this file's own header comment). */
function forcePlayOutcome(page, succeeds) {
  return page.addInitScript(function (succeeds) {
    HTMLMediaElement.prototype.play = function () {
      if (succeeds) { return Promise.resolve(); }
      return Promise.reject(new DOMException('forced-block-for-test', 'NotAllowedError'));
    };
  }, succeeds);
}

/**
 * js/interpret-experience.js's reading-phase voice track is a bare
 * `new Audio(url)` — never attached to the DOM, so it can't be reached by
 * a CSS selector the way the markup-rendered `<video>` elements can. This
 * wraps the global `Audio` constructor (test-only, via addInitScript —
 * nothing in production code changes) purely so a test can reach the
 * MOST RECENTLY constructed instance at `window.__lastAudio` and dispatch
 * a real 'ended'/'pause' event on it, the standard technique for testing
 * a completion/pause handler without waiting for a real timed playback.
 */
function trackLastAudioInstance(page) {
  return page.addInitScript(function () {
    var RealAudio = window.Audio;
    window.Audio = function (url) {
      var instance = new RealAudio(url);
      window.__lastAudio = instance;
      return instance;
    };
    window.Audio.prototype = RealAudio.prototype;
  });
}

function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function captures(phCalls, eventName) {
  return phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === eventName; });
}

/** Drives the Chamber from the pill through the picker to talmudic's reading, using mockInterpretDream's canned questions/reading. */
async function openAndPickSage(page) {
  await page.click('#interp-cta-btn');
  await page.waitForSelector('.itp-persona-card[data-key="talmudic"]', { state: 'visible', timeout: 5000 });
  await page.click('.itp-persona-card[data-key="talmudic"]');
  await page.waitForSelector('.itp-chip', { timeout: 5000 });
  await page.click('.itp-chip >> nth=0');
  await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
}

// ── Tracker item for-product-p1-bug-founder-repro-sage-re-cbdj3d ──
// (founder walk 2026-08-03 23:31: the dream video looped silently ~3 times
// with zero indication a voice reading was coming, then only a bare,
// unlabeled play-triangle appeared once audio was finally ready). Below:
// a held (never-resolving-until-released) interp-audio-status mock so a
// test can observe the "preparing" window deterministically, plus a
// gesture-priming-specific play() override that only affects the tiny
// silent priming clip (leaving every other element's forced outcome
// exactly as set by forcePlayOutcome above, so priming's own robustness
// is isolated from the rest of the flow's already-covered behavior).

/**
 * Same shape as mockInterpAudio above, except interp-audio-status never
 * resolves until the caller calls the returned `release()` — the standard
 * technique for deterministically observing an in-flight loading state
 * (here: the "preparing" caption) without a real, slow TTS backend or a
 * real POLL_INTERVAL_MS-paced (10s) wait.
 */
function mockInterpAudioHeld(page) {
  var releaseHold;
  var held = new Promise(function (resolve) { releaseHold = resolve; });
  var routes = [
    page.route('**/.netlify/functions/generate-interp-audio', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/kokoro/american-english:test-req-held' }) });
    }),
    page.route('**/.netlify/functions/interp-audio-status*', function (route) {
      held.then(function () {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'done',
            audioUrl: baseUrl + '/sage-voice-x7q4.mp3',
            audioDurationMs: 1400,
            captions: [{ word: 'Ah,', startMs: 0, endMs: 300 }],
            captionsLevel: 'word'
          })
        });
      });
    })
  ];
  return Promise.all(routes).then(function () { return { release: releaseHold }; });
}

/** Every real element's `.play()` resolves (matches `forcePlayOutcome(page, true)`) EXCEPT the gesture-priming attempt's own tiny embedded silent-WAV data-URI element, which throws SYNCHRONOUSLY — the one failure mode `attemptPlay`'s own promise-based handling can't absorb, and exactly what createPrimedAudioElement's own try/catch exists to guard against. Isolated to only that one element (matched by its known `data:audio/wav;base64,` src prefix) so this test exercises gesture-priming's own robustness specifically, not a blanket "everything throws" scenario the intro/reading playback code was never meant to survive either. */
function forcePlayWithPrimingThrow(page) {
  return page.addInitScript(function () {
    HTMLMediaElement.prototype.play = function () {
      if (typeof this.src === 'string' && this.src.indexOf('data:audio/wav;base64,') === 0) {
        throw new DOMException('synchronous-throw-for-test', 'NotSupportedError');
      }
      return Promise.resolve();
    };
  });
}

test('GO-WIDE (founder, 2026-08-04): with NO preview param at all, talmudic\'s reading mounts the voice stage for every visitor — the ?sagevoice gate no longer exists', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    // seedResultPage's own URL deliberately does NOT carry any `sagevoice`
    // param (see its own comment) — post-go-wide this is the everyday
    // real-visitor case, and the voice stage must mount regardless.
    await seedResultPage(page, 'd-voice-gate-off');
    await openAndPickSage(page);
    var stage = await page.locator('#itp-voice-stage').count();
    assert.equal(stage, 1, 'the voice stage must render for a plain visitor with no preview param — the gate was removed on the founder\'s go-wide call');
  } finally {
    await context.close();
  }
});

test('?sagevoice=1: talmudic\'s reading mounts the voice stage, plays the intro clip, and fires interp_voice_intro_shown', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-intro-shown');
    await openAndPickSage(page);

    await page.waitForSelector('#itp-voice-intro', { state: 'attached', timeout: 5000 });
    await page.waitForFunction(function () {
      var q = window.posthog && window.posthog.slice ? window.posthog.slice() : [];
      return q.some(function (e) { return e[0] === 'capture' && e[1] === 'interp_voice_intro_shown'; });
    }, null, { timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    assert.deepEqual(captures(phCalls, 'interp_voice_intro_shown')[0][2], { persona: 'talmudic' });
  } finally {
    await context.close();
  }
});

test('preview link persists to localStorage — a later navigation to the SAME page with no query param still has the gate on', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-sticky');
    // The persistence side effect (isVoicePreviewEnabled's localStorage
    // write) only fires the first time it's actually CHECKED — which only
    // happens once the reading phase actually renders — so this first
    // visit has to reach the reading phase at least once before the param
    // can be dropped on a later visit.
    await openAndPickSage(page);
    await page.click('#itp-close-btn');
    // Re-navigate WITHOUT the query param — the gate should still be on,
    // sticky per this browser (js/interpret-experience.js's own
    // isVoicePreviewEnabled, same "?param=1, sticky in localStorage"
    // convention as start.html's `signup` override).
    await page.goto(baseUrl + '/result.html?id=d-voice-sticky', { waitUntil: 'domcontentloaded' });
    await page.click('#interp-cta-btn');
    // This dream already has a saved talmudic reading from the first
    // visit above, so it opens straight on the reading phase (spec §3.0) —
    // no picker tap needed.
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    var stage = await page.locator('#itp-voice-stage').count();
    assert.equal(stage, 1);
  } finally {
    await context.close();
  }
});

test('Skip during the intro fires interp_voice_intro_skipped{via:"skip_link"}, marks the intro shown, and crossfades to the reading phase', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-skip');
    await openAndPickSage(page);

    await page.waitForSelector('#itp-voice-skip', { state: 'visible', timeout: 5000 });
    await page.click('#itp-voice-skip');

    var phCalls = await readPostHogCalls(page);
    var skipped = captures(phCalls, 'interp_voice_intro_skipped');
    assert.equal(skipped.length, 1);
    assert.deepEqual(skipped[0][2], { persona: 'talmudic', via: 'skip_link' });

    var introShownPersisted = await page.evaluate(function () {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      var dream = state.dreams.filter(function (d) { return d.id === 'd-voice-skip'; })[0];
      return dream && dream.introShownPersonas && dream.introShownPersonas.talmudic;
    });
    assert.ok(introShownPersisted, 'markIntroShown must persist a real timestamp onto the dream record');
  } finally {
    await context.close();
  }
});

test('reopening the Chamber for the same dream+persona after the intro already played does NOT replay it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-no-replay', {
      interpretations: { talmudic: { text: 'An existing reading.', at: Date.now(), qa: [] } },
      introShownPersonas: { talmudic: Date.now() - 1000 }
    });
    await page.goto(baseUrl + '/result.html?id=d-voice-no-replay&sagevoice=1', { waitUntil: 'domcontentloaded' });
    await page.click('#interp-cta-btn');
    // Opens straight on the reading (spec §3.0's revisit fast path) — no
    // picker tap needed at all.
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    var introPresent = await page.locator('#itp-voice-intro').count();
    assert.equal(introPresent, 0, 'the intro element must not even be mounted once it has already played for this dream+persona');
  } finally {
    await context.close();
  }
});

test('closing the Chamber mid-intro fires interp_voice_intro_skipped{via:"closed"}', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-close-mid-intro');
    await openAndPickSage(page);
    await page.waitForSelector('#itp-voice-intro', { state: 'attached', timeout: 5000 });

    await page.click('#itp-close-btn');

    var phCalls = await readPostHogCalls(page);
    var skipped = captures(phCalls, 'interp_voice_intro_skipped');
    assert.equal(skipped.length, 1);
    assert.deepEqual(skipped[0][2], { persona: 'talmudic', via: 'closed' });
  } finally {
    await context.close();
  }
});

test('reading-phase autoplay blocked shows the tap-to-play overlay and fires interp_voice_autoplay_blocked{surface:"reading"}; tapping it fires interp_voice_play{source:"tap_unlock"}', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    // Forced to reject BEFORE the navigation that loads result.html —
    // addInitScript only hooks documents created AFTER it's registered,
    // it has no retroactive effect on an already-loaded page. This
    // deliberately also blocks the INTRO's own autoplay (same
    // attemptPlay() helper, same capability-detection code path) — that's
    // fine, this test skips past the intro immediately either way, and
    // the intro's own autoplay_blocked case doesn't need a second,
    // separate assertion here.
    await forcePlayOutcome(page, false);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-blocked');
    await openAndPickSage(page);

    // Skip the intro (its own tap-to-play overlay would otherwise sit in
    // front of the one this test cares about) straight into the reading phase.
    await page.click('#itp-voice-skip');

    await page.waitForFunction(function () {
      var q = window.posthog && window.posthog.slice ? window.posthog.slice() : [];
      return q.some(function (e) { return e[0] === 'capture' && e[1] === 'interp_voice_autoplay_blocked' && e[2].surface === 'reading'; });
    }, null, { timeout: 5000 });

    var overlayVisible = await page.locator('#itp-voice-tap-overlay').evaluate(function (el) { return !el.classList.contains('off'); });
    assert.equal(overlayVisible, true);

    // Now force play() to succeed (simulating the tap's own real user
    // gesture unlocking it) and tap the overlay.
    await page.evaluate(function () {
      HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    });
    await page.click('#itp-voice-tap-overlay');

    var phCalls = await readPostHogCalls(page);
    var played = captures(phCalls, 'interp_voice_play');
    assert.equal(played.length, 1);
    assert.deepEqual(played[0][2], { persona: 'talmudic', source: 'tap_unlock' });
  } finally {
    await context.close();
  }
});

test('reading audio "ended" fires interp_voice_complete with a duration, and closing afterward fires interp_voice_listen_time{completed:true}', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await trackLastAudioInstance(page);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-complete');
    await openAndPickSage(page);
    await page.click('#itp-voice-skip'); // straight to the reading phase

    await page.waitForFunction(function () {
      var q = window.posthog && window.posthog.slice ? window.posthog.slice() : [];
      return q.some(function (e) { return e[0] === 'capture' && e[1] === 'interp_voice_play'; });
    }, null, { timeout: 5000 });

    // Simulate the reading audio finishing naturally — dispatched directly
    // on the real `new Audio(...)` instance (tracked via trackLastAudioInstance
    // above) rather than waiting on a real network-fetched MP3 to actually
    // play to completion, the standard technique for testing a completion
    // handler without a real timed wait.
    await page.evaluate(function () {
      window.__lastAudio.dispatchEvent(new Event('ended'));
    });

    var phCalls = await readPostHogCalls(page);
    var completed = captures(phCalls, 'interp_voice_complete');
    assert.equal(completed.length, 1);
    assert.equal(completed[0][2].persona, 'talmudic');
    assert.equal(typeof completed[0][2].duration_ms, 'number');

    // Tap-to-play overlay reappears as the "replay" affordance once complete.
    var overlayVisible = await page.locator('#itp-voice-tap-overlay').evaluate(function (el) { return !el.classList.contains('off'); });
    assert.equal(overlayVisible, true);

    await page.click('#itp-close-btn');
    var phCallsAfterClose = await readPostHogCalls(page);
    var listenTime = captures(phCallsAfterClose, 'interp_voice_listen_time');
    assert.equal(listenTime.length, 1);
    assert.equal(listenTime[0][2].persona, 'talmudic');
    assert.equal(listenTime[0][2].completed, true);
    assert.equal(typeof listenTime[0][2].listened_ms, 'number');
  } finally {
    await context.close();
  }
});

test('caption fallback: when interp-audio-status resolves captionsLevel:"sentence", interp_voice_caption_fallback fires and the caption strip still renders text (client-computed sentence schedule)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await trackLastAudioInstance(page);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, { captionsLevel: 'sentence' });
    await seedResultPageWithPreviewParam(page, 'd-voice-caption-fallback');
    await openAndPickSage(page);
    await page.click('#itp-voice-skip');

    await page.waitForFunction(function () {
      var q = window.posthog && window.posthog.slice ? window.posthog.slice() : [];
      return q.some(function (e) { return e[0] === 'capture' && e[1] === 'interp_voice_caption_fallback'; });
    }, null, { timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    assert.deepEqual(captures(phCalls, 'interp_voice_caption_fallback')[0][2], { persona: 'talmudic' });

    // Fire loadedmetadata so the client-side sentence schedule actually
    // computes (js/interpret-experience.js's beginAudioPlayback reads
    // audio.duration off this real event, not a guessed server field).
    await page.evaluate(function () {
      Object.defineProperty(window.__lastAudio, 'duration', { value: 5, configurable: true });
      window.__lastAudio.dispatchEvent(new Event('loadedmetadata'));
      Object.defineProperty(window.__lastAudio, 'currentTime', { value: 0.1, configurable: true });
      window.__lastAudio.dispatchEvent(new Event('timeupdate'));
    });
    var captionText = await page.locator('#itp-voice-caption').textContent();
    assert.ok(captionText && captionText.length > 0, 'the sentence-level fallback schedule should still render SOME caption text once the real duration is known');
  } finally {
    await context.close();
  }
});

test('a hard TTS failure hides the whole voice stage and fires interp_voice_tts_failed — the reading falls back to the plain Wave 1 text card', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, { failGeneration: true });
    await seedResultPageWithPreviewParam(page, 'd-voice-tts-failed');
    await openAndPickSage(page);

    await page.waitForFunction(function () {
      var q = window.posthog && window.posthog.slice ? window.posthog.slice() : [];
      return q.some(function (e) { return e[0] === 'capture' && e[1] === 'interp_voice_tts_failed'; });
    }, null, { timeout: 5000 });

    // The failure lands while the intro (still playing) is up — the
    // teardown itself only happens once the reading phase is actually
    // entered (js/interpret-experience.js's enterReadingPhase checks
    // `audioFailed` at that point) — Skip advances past the intro
    // deterministically so this assertion doesn't depend on the real
    // placeholder clip's own runtime.
    await page.click('#itp-voice-skip');
    await page.waitForFunction(function () {
      var el = document.getElementById('itp-voice-stage');
      return el && getComputedStyle(el).display === 'none';
    }, null, { timeout: 5000 });

    // The plain text reading card is still there regardless (Wave 1's own
    // behavior, never blocked by a voice failure).
    var text = await page.locator('#itp-reading-text').textContent();
    assert.ok(text && text.length > 0);

    var stageDisplay = await page.locator('#itp-voice-stage').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(stageDisplay, 'none');
  } finally {
    await context.close();
  }
});

// ── Tracker item for-product-p1-bug-founder-repro-sage-re-cbdj3d's fix set ──

test('the silent bounce-loop window (reading phase, audio not ready yet) shows persona-named "preparing" copy, cleared the instant real playback is attempted', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayOutcome(page, true);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    var heldMock = await mockInterpAudioHeld(page);
    await seedResultPageWithPreviewParam(page, 'd-voice-preparing');
    await openAndPickSage(page);

    // Skip past the intro -- lands on the reading phase's own 'loading'
    // sub-state (dream video bounce-looping, audio still not ready since
    // interp-audio-status is held open).
    await page.waitForSelector('#itp-voice-skip', { state: 'visible', timeout: 5000 });
    await page.click('#itp-voice-skip');

    await page.waitForFunction(function () {
      var el = document.getElementById('itp-voice-caption');
      return el && el.textContent === 'The Sage is preparing to read your dream…';
    }, null, { timeout: 5000 });

    // Release the held status poll -- audio becomes ready and real
    // playback is attempted, which must clear the preparing copy right away.
    heldMock.release();

    await page.waitForFunction(function () {
      var el = document.getElementById('itp-voice-caption');
      return el && el.textContent !== 'The Sage is preparing to read your dream…';
    }, null, { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('tap overlay label is explicit and persona-name-driven for the pre-first-play state, and reads differently once it reappears as "replay"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    // Forced to reject BEFORE navigation -- see the existing "autoplay
    // blocked" test's own comment on why addInitScript has to be
    // registered ahead of the page load it applies to.
    await forcePlayOutcome(page, false);
    await trackLastAudioInstance(page);
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-tap-label');
    await openAndPickSage(page);
    await page.click('#itp-voice-skip'); // straight to the reading phase

    await page.waitForFunction(function () {
      var el = document.getElementById('itp-voice-tap-overlay');
      return el && !el.classList.contains('off');
    }, null, { timeout: 5000 });
    var firstPlayLabel = await page.locator('#itp-voice-tap-label').textContent();
    assert.equal(firstPlayLabel, 'Hear The Sage read your dream', 'pre-first-play label must be explicit and name the actual persona, not a bare icon');

    // Force play() to succeed (a real tap is itself a user gesture) and
    // unlock playback via the tap overlay, same as the existing autoplay-
    // blocked test.
    await page.evaluate(function () { HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; });
    await page.click('#itp-voice-tap-overlay');
    await page.waitForFunction(function () {
      var el = document.getElementById('itp-voice-tap-overlay');
      return el && el.classList.contains('off');
    }, null, { timeout: 5000 });

    // Simulate the reading finishing naturally -- the SAME overlay
    // reappears as the "replay" affordance, and must carry a DIFFERENT,
    // non-persona-play label rather than repeating the first-play copy.
    await page.evaluate(function () { window.__lastAudio.dispatchEvent(new Event('ended')); });
    await page.waitForFunction(function () {
      var el = document.getElementById('itp-voice-tap-overlay');
      return el && !el.classList.contains('off');
    }, null, { timeout: 5000 });
    var replayLabel = await page.locator('#itp-voice-tap-label').textContent();
    assert.equal(replayLabel, 'Hear it again');
    assert.notEqual(replayLabel, firstPlayLabel, 'the replay state must not reuse the exact same pre-first-play copy');
  } finally {
    await context.close();
  }
});

test('gesture-priming is best-effort: a synchronously-throwing priming play() never breaks the persona pick or the reading flow', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await forcePlayWithPrimingThrow(page);
    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(err); });
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await mockInterpAudio(page, {});
    await seedResultPageWithPreviewParam(page, 'd-voice-prime-throws');
    // openAndPickSage's own persona-card tap IS the gesture-priming call
    // site (onPersonaPicked) -- the synchronous throw happens right there,
    // inside createPrimedAudioElement's try/catch, and must never surface.
    await openAndPickSage(page);

    var text = await page.locator('#itp-reading-text').textContent();
    assert.ok(text && text.length > 0, 'the reading still renders normally despite the priming attempt throwing');
    assert.equal(pageErrors.length, 0, 'a synchronously-throwing priming play() must never surface as an uncaught page error');
  } finally {
    await context.close();
  }
});
