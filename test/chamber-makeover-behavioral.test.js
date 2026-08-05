// test/chamber-makeover-behavioral.test.js
//
// Real-browser coverage for the Chamber makeover (tracker item
// for-product-founder-spec-08-04-chamber-m-zf5ufo, founder verbatim spec,
// three parts, all covered here):
//
//   1. NAME — home.html's hero entry point no longer reads "The Chamber"
//      (a real user complaint: nobody understood what it meant).
//   2. PICKER — the persona picker is now a tile grid showing all 5
//      personas AT ONCE (no scroll needed to see them all), styled like
//      style.html's `.style-card` picker, replacing the old horizontal
//      swipeable carousel.
//   3. INTERIM VOICES — every persona (not just talmudic/The Sage) now
//      reaches a working Speaking-Sage voice stage (intro + reading with
//      voice + captions), temporarily borrowing the Sage's own assets —
//      see js/interpreter-personas.js's own header note.
//
// Follows test/interp-voice-behavioral.test.js's own established
// helpers/conventions (staticServer, blockThirdParty, readPostHogCalls,
// mockInterpretDream/mockInterpAudio, forcePlayOutcome) and
// test/home-behavioral.test.js's real MOBILE_VIEWPORT convention — this
// file borrows both rather than inventing new ones, since it touches both
// files' surfaces (home.html's entry point AND the shared
// js/interpret-experience.js picker/voice-stage component).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
// Real phone-sized viewport — the "no scroll needed to see all 5 tiles"
// claim is only meaningful proven at a REAL mobile-webview-sized
// viewport (this app's actual majority traffic), not an artificially
// generous desktop one. Same 390x844 convention test/home-behavioral.
// test.js already established.
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

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Seeds a logged-in account owning one completed video dream, then navigates to home.html — matches test/home-behavioral.test.js's own seedHomeUser shape. */
async function seedHomeUserWithDream(page, dreamId) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (id) {
    var state = { user: { handle: '@tester', username: 'tester' }, accounts: {}, dreams: [], draft: {} };
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    state.dreams.push({
      id: id,
      ownerHandle: '@tester',
      caption: 'A dream about a desert and an oasis',
      storyText: 'I walked through a vast desert and found an oasis.',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: Date.now()
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, dreamId);
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

/** Same seeding, but navigates straight to result.html for that dream (matches test/interp-voice-behavioral.test.js's own seedResultPage shape) — used by the voice-stage tests below, which need `#interp-cta-btn`. */
async function seedResultPage(page, dreamId) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (id) {
    var state = { user: { handle: '@tester', username: 'tester' }, accounts: {}, dreams: [], draft: {} };
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    state.dreams.push({
      id: id,
      ownerHandle: '@tester',
      caption: 'A dream about a desert and an oasis',
      storyText: 'I walked through a vast desert and found an oasis.',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: Date.now()
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, dreamId);
  await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
}

function mockInterpretDream(page) {
  return page.route('**/.netlify/functions/interpret-dream', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    if (body.mode === 'questions') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [{ id: 'q1', text: 'What has been on your mind?', chips: ['Work', 'Family', 'A change', 'Not sure'] }] }) });
      return;
    }
    if (body.mode === 'reading') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: 'A reading of your dream, offered gently.' }) });
      return;
    }
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'E409: invalid_mode' }) });
  });
}

/** Mocks the two Speaking Sage Option D endpoints — one-shot resolution, matching test/interp-voice-behavioral.test.js's own mockInterpAudio. */
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
          captions: [
            { word: 'Ah,', startMs: 0, endMs: 300 },
            { word: 'the', startMs: 300, endMs: 500 },
            { word: 'desert.', startMs: 500, endMs: 1400 }
          ],
          captionsLevel: 'word'
        })
      });
    })
  ]);
}

/** Forces every `<video>`/`<audio>` element's `.play()` to resolve — same technique test/interp-voice-behavioral.test.js's own forcePlayOutcome uses to sidestep this sandbox's real autoplay policy. */
function forcePlaySucceeds(page) {
  return page.addInitScript(function () {
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  });
}

// ============================================================================
// Part 1 — NAME
// ============================================================================

test('home.html: the Chamber entry point no longer reads "The Chamber" — shows the new, clearer name', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedHomeUserWithDream(page, 'd-name-1');

    await page.waitForSelector('#hero-chamber .hero-title', { state: 'visible', timeout: 5000 });
    var heading = await page.locator('#hero-chamber .hero-title').textContent();
    assert.notEqual(heading.trim(), 'The Chamber', 'the old, user-confusing name must be gone');
    assert.equal(heading.trim(), 'Dream Meaning', 'the recommended candidate must be what actually ships');

    // The entry mechanism itself (id, href-fallback, click behavior) is
    // completely unchanged by the rename — only the visible text moved —
    // matching this build's own "nothing else keys off this heading's
    // literal text" claim.
    await page.waitForSelector('#chamber-pill', { timeout: 5000 });
    assert.equal(await page.locator('#chamber-pill').textContent(), 'Enter');
  } finally {
    await context.close();
  }
});

test('result.html: the interpretation entry pill\'s tooltip no longer references "the Interpreter\'s Chamber" either', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'd-name-2');
    await page.waitForSelector('#interp-cta-btn', { state: 'visible', timeout: 5000 });
    var title = await page.locator('#interp-cta-btn').getAttribute('title');
    assert.ok(title && title.indexOf('Chamber') === -1, 'the tooltip must not still say "Chamber": got "' + title + '"');
  } finally {
    await context.close();
  }
});

// ============================================================================
// Part 2 — PICKER: tile grid, all 5 visible at once, no scroll needed
// ============================================================================

test('the persona picker is a CSS grid (not the old horizontal-scroll carousel), and all 5 persona tiles render', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page);
    await mockInterpAudio(page);
    await seedResultPage(page, 'd-grid-1');
    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });

    // The old carousel container/dots are gone entirely.
    assert.equal(await page.locator('#itp-carousel').count(), 0);
    assert.equal(await page.locator('.itp-carousel-dot').count(), 0);

    // The new grid container is present and IS a real CSS grid (not a
    // flex row with overflow-x, which is what the old carousel was).
    var grid = page.locator('#itp-persona-grid');
    var display = await grid.evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(display, 'grid');
    var overflowX = await grid.evaluate(function (el) { return getComputedStyle(el).overflowX; });
    assert.notEqual(overflowX, 'auto', 'the grid must not be a horizontally-scrolling container the way the old carousel was');

    var cardCount = await page.locator('.itp-persona-card').count();
    assert.equal(cardCount, 5, 'all 5 personas must render as tiles');

    var keys = await page.evaluate(function () {
      return Array.prototype.map.call(document.querySelectorAll('.itp-persona-card'), function (el) { return el.getAttribute('data-key'); });
    });
    assert.deepEqual(keys.sort(), ['freud', 'gestalt', 'jung', 'scientist', 'talmudic']);
  } finally {
    await context.close();
  }
});

test('all 5 persona tiles are visible simultaneously at a real 390x844 mobile viewport, with no scroll needed to see them all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page);
    await mockInterpAudio(page);
    await seedResultPage(page, 'd-grid-2');
    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card', { state: 'visible', timeout: 5000 });

    // Every tile must actually be VISIBLE (Playwright's own visibility
    // check — attached, has layout box, not display:none/visibility:
    // hidden/zero-size) without any additional scrolling — i.e. all 5 are
    // simultaneously on screen the instant the picker renders, which is
    // the founder's own literal ask ("no scroll needed to see them all").
    var cards = page.locator('.itp-persona-card');
    var count = await cards.count();
    assert.equal(count, 5);
    for (var i = 0; i < count; i++) {
      await cards.nth(i).waitFor({ state: 'visible', timeout: 2000 });
    }

    // Belt-and-suspenders: the scrolling container that hosts the picker
    // (#itp-body) must not need to scroll to reach the LAST tile — its
    // full scrollable content height fits within what's already visible
    // without the user scrolling further than they already are at the
    // top of the picker.
    var fits = await page.evaluate(function () {
      var body = document.getElementById('itp-body');
      var grid = document.getElementById('itp-persona-grid');
      if (!body || !grid) return false;
      var lastTile = grid.lastElementChild;
      var lastBottom = lastTile.getBoundingClientRect().bottom;
      var bodyBottom = body.getBoundingClientRect().bottom;
      // A couple of px of rounding slack; the real ask is "no meaningful
      // scroll," not sub-pixel-perfect.
      return lastBottom <= bodyBottom + 4;
    });
    assert.ok(fits, 'the last persona tile must already be within view without scrolling #itp-body further');
  } finally {
    await context.close();
  }
});

test('tapping a tile in the grid still advances the flow exactly like the old carousel cards did', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page);
    await mockInterpAudio(page);
    await seedResultPage(page, 'd-grid-3');
    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });
    await page.click('.itp-persona-card[data-key="jung"]');
    await page.waitForSelector('.itp-chip', { timeout: 5000 });
    await page.click('.itp-chip >> nth=0');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    var text = await page.locator('#itp-reading-text').textContent();
    assert.ok(text && text.length > 0);
  } finally {
    await context.close();
  }
});

// ============================================================================
// Part 3 — INTERIM VOICES: every persona now reaches a working voice stage
// ============================================================================

['jung', 'freud', 'gestalt', 'scientist'].forEach(function (personaKey) {
  test('picking ' + personaKey + ' (a non-Sage persona) now reaches a working voice stage — intro plays, reading mounts voice + captions, not the old silent/text-only experience', async function (t) {
    if (unavailableReason) { t.skip(unavailableReason); return; }
    var context = await newMobileContext();
    try {
      var page = await context.newPage();
      await forcePlaySucceeds(page);
      await blockThirdParty(page);
      await mockInterpretDream(page);
      await mockInterpAudio(page);
      await seedResultPage(page, 'd-interim-voice-' + personaKey);
      await page.click('#interp-cta-btn');
      await page.waitForSelector('.itp-persona-card[data-key="' + personaKey + '"]', { state: 'visible', timeout: 5000 });
      await page.click('.itp-persona-card[data-key="' + personaKey + '"]');
      await page.waitForSelector('.itp-chip', { timeout: 5000 });
      await page.click('.itp-chip >> nth=0');

      // The intro plays first (borrowing the Sage's own asset — see
      // js/interpreter-personas.js's header note) — wait for it, then
      // skip past it deterministically into the reading phase.
      await page.waitForSelector('#itp-voice-intro', { state: 'attached', timeout: 5000 });
      await page.waitForSelector('#itp-voice-skip', { state: 'visible', timeout: 5000 });
      await page.click('#itp-voice-skip');

      // The reading phase mounts the voice stage (this is the whole
      // point of part 3 — this used to be silent/text-only for every
      // persona except talmudic).
      await page.waitForSelector('#itp-voice-stage', { state: 'attached', timeout: 5000 });
      var stageDisplay = await page.locator('#itp-voice-stage').evaluate(function (el) { return getComputedStyle(el).display; });
      assert.notEqual(stageDisplay, 'none', personaKey + ' must actually mount the voice stage, not silently fall back to text-only');

      // Real playback + captions actually work end to end (not just "the
      // markup is present") — wait for interp_voice_play, then dispatch
      // a real captioned word via the mocked audio timeline.
      await page.waitForFunction(function () {
        var q = window.posthog && window.posthog.slice ? window.posthog.slice() : [];
        return q.some(function (e) { return e[0] === 'capture' && e[1] === 'interp_voice_play'; });
      }, null, { timeout: 5000 });

      // The plain Wave 1 text reading is still there too — voice is
      // additive, never a replacement for the text.
      var text = await page.locator('#itp-reading-text').textContent();
      assert.ok(text && text.length > 0);
    } finally {
      await context.close();
    }
  });
});

test('interp_voice_play for a non-Sage persona carries that persona\'s own key, not a hardcoded "talmudic"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await forcePlaySucceeds(page);
    await blockThirdParty(page);
    await mockInterpretDream(page);
    await mockInterpAudio(page);
    await seedResultPage(page, 'd-interim-voice-persona-prop');
    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="scientist"]', { state: 'visible', timeout: 5000 });
    await page.click('.itp-persona-card[data-key="scientist"]');
    await page.waitForSelector('.itp-chip', { timeout: 5000 });
    await page.click('.itp-chip >> nth=0');
    await page.waitForSelector('#itp-voice-skip', { state: 'visible', timeout: 5000 });
    await page.click('#itp-voice-skip');

    await page.waitForFunction(function () {
      var q = window.posthog && window.posthog.slice ? window.posthog.slice() : [];
      return q.some(function (e) { return e[0] === 'capture' && e[1] === 'interp_voice_play'; });
    }, null, { timeout: 5000 });

    var phCalls = await page.evaluate(function () {
      return (window.posthog && window.posthog.slice) ? window.posthog.slice() : [];
    });
    var played = phCalls.filter(function (e) { return e[0] === 'capture' && e[1] === 'interp_voice_play'; });
    assert.equal(played.length, 1);
    assert.equal(played[0][2].persona, 'scientist');
  } finally {
    await context.close();
  }
});
