// test/processing-preview-carousel-windowing-behavioral.test.js
//
// Regression coverage for tracker.html's
// for-product-regression-founder-live-test-t911te: the founder's own live
// test (real Safari, 2026-07-29) showed processing.html's "While you wait,
// explore other dreams" carousel rendering EVERY tile as a gradient
// placeholder -- zero real video thumbnails -- even though get-feed's
// media URLs were confirmed alive (HTTP 206) and reachable.
//
// Root cause: the previous fix for a *different*, narrower bug (tracker:
// for-product-blank-grey-tile-in-the-wait--9p1xwu, see
// processing-preview-video-blank-tile-fallback-behavioral.test.js) gave
// every rendered tile (up to 10 at once, see renderPreview()'s
// `.slice(0, 10)`) a real `autoplay` <video> plus a load-timeout self-heal
// that swaps to a gradient if neither `loadeddata` nor `playing` fires
// within PREVIEW_LOAD_TIMEOUT_MS. That fix was validated against a single
// stalled video -- it never accounted for what happens when all ten tiles
// try to autoplay/preload SIMULTANEOUSLY. Real dream videos are
// multi-megabyte 8-second clips (a real, live fal.media URL fetched
// directly during this investigation was ~10.8MB for one recent dream) --
// ten of those competing for bandwidth at once means none of them
// reliably buffers enough to fire loadeddata/playing before any fixed
// timeout elapses, so EVERY tile hit the self-heal and fell back to
// gradient -- universally, not occasionally, on real networks (confirmed
// directly: a Playwright run against real fal.media URLs showed zero
// loadeddata/playing events firing across 9 concurrent videos even after
// 6+ seconds).
//
// Fix: windowing, the same principle already shipped for explore.html's
// feed cards (tracker: feed-pages-explore-html-home-html-render-6t7udd) --
// applied here for the first time. previewThumbHTML() no longer sets
// `autoplay`/`preload=metadata` on render; wirePreviewErrorFallback() now
// uses an IntersectionObserver (rooted on the horizontal scroll strip
// itself) so only tiles actually scrolled into view ever attempt a real
// playback load. Off-screen tiles issue no network request at all until
// scrolled into view, so at most a handful compete for bandwidth instead
// of all ten -- and the load-timeout backstop only starts counting once a
// tile's playback attempt actually begins, not from initial render.
//
// Follows processing-preview-video-blank-tile-fallback-behavioral.test.js's
// seedOwnVideoDreamAt-style localStorage seeding (extended here to seed
// MANY owned video dreams with distinct, individually-trackable stalled
// URLs) and its page.clock pattern for deterministically advancing the
// per-tile load-timeout.

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

/** Intercepts every distinct mock preview video URL (each dream below gets its own ?i=N query string) and records which ones were actually requested, without ever fulfilling them -- a stalled request that never fires loadeddata/playing/error, matching a real (slow/contended) network. */
function stallAndTrackVideoRequests(page) {
  var requested = [];
  page.route(/\/mock-preview-video\.mp4\?i=\d+$/, function (route) {
    requested.push(route.request().url());
    // deliberately never fulfilled -- request stays in flight
  });
  return requested;
}

/** Mocks a generation that never completes for the lifetime of the test (video-status always reports done:false) -- keeps processing.html parked on its live wait screen (#proc-live visible, carrying #proc-preview) instead of racing to a fail/redirect state a few hundred ms in, same convention as wait-screen-reassurance-and-inapp-nudge-behavioral.test.js's mockNeverFinishingGeneration. */
function mockNeverFinishingGeneration(page) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast/test-op' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    })
  ]);
}

/** Seeds a logged-in account with N published, owned video dreams (the "mine" branch of renderPreview -- reaches previewThumbHTML directly, one real videoUrl per dream, distinctly trackable via its own ?i=N query string) and navigates to processing.html. */
async function seedManyOwnVideoDreamsAt(page, username, count) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
    var dreams = [];
    for (var i = 0; i < o.count; i++) {
      dreams.push({
        id: 'mine-video-' + i,
        ownerHandle: '@' + o.username,
        caption: 'Dream #' + i,
        style: 'Cinematic',
        videoUrl: o.baseUrl + '/mock-preview-video.mp4?i=' + i,
        isPublished: true,
        likes: 0
      });
    }
    state.dreams = dreams;
    // mediaType: 'video' + no pendingJob -- processing.html's normal fresh-
    // generation path (see wait-screen-reassurance-and-inapp-nudge-
    // behavioral.test.js's seedAccountWithDraft), kept alive on the live
    // wait screen by mockNeverFinishingGeneration() rather than racing to a
    // fail/redirect state a few hundred ms in.
    state.draft = { caption: 'Another dream', style: 'Cinematic', mediaType: 'video', sourceImageUrl: null };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, count: count, baseUrl: baseUrl });
  await mockNeverFinishingGeneration(page);
  await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });
}

test('processing.html: the wait-screen carousel does not eagerly autoplay every tile at once -- only tiles scrolled into view attempt real playback', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var requested = stallAndTrackVideoRequests(page);

    await seedManyOwnVideoDreamsAt(page, 'windowinguser', 10);

    await page.waitForFunction(function () {
      var row = document.getElementById('proc-preview-row');
      return row && row.querySelectorAll('video.ppt-bg').length === 10;
    }, { timeout: 5000 });

    // Give the IntersectionObserver a moment to fire for whatever is
    // actually visible in the initial viewport, then check how many of the
    // ten tiles actually issued a network request. The old (regressed)
    // behavior fired all ten immediately; the fix should only fire for
    // however many tiles genuinely fit in the visible strip (the ppt row
    // sits inside #app's 480px-max-width mobile card) -- nowhere near all
    // ten.
    await page.waitForTimeout(500);
    assert.ok(requested.length > 0, 'at least the initially-visible tile(s) must still attempt real playback');
    assert.ok(requested.length < 10, 'must NOT eagerly start every tile at once -- got ' + requested.length + '/10 requests immediately, expected only the tiles actually visible in the strip');

    // Off-screen tiles must genuinely be reachable, not permanently
    // stranded -- scrolling the strip all the way to the end should bring
    // the remaining, previously-untouched tiles into view and trigger
    // their own playback attempt too.
    await page.locator('#proc-preview-row').evaluate(function (row) { row.scrollLeft = row.scrollWidth; });
    await page.waitForTimeout(500);
    await settle(function () { return requested.length >= 10; });
    assert.equal(requested.length, 10, 'scrolling to the end must eventually bring every tile into view and trigger its own (real) playback attempt -- got ' + requested.length + '/10 after scrolling');
  } finally {
    await context.close();
  }
});

test('processing.html: REGRESSION -- a visible tile whose video never fires loadeddata/playing still self-heals to the gradient fallback after the load-timeout', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    stallAndTrackVideoRequests(page);
    await page.clock.install({ time: Date.now() });

    await seedManyOwnVideoDreamsAt(page, 'windowingtimeoutuser', 3);

    await page.waitForFunction(function () {
      var row = document.getElementById('proc-preview-row');
      return row && row.querySelectorAll('video.ppt-bg').length === 3;
    }, { timeout: 5000 });

    // The very first tile is visible on render (well within the strip's
    // viewport), so it should already be a real, still-video element right
    // after render -- the self-heal must not have swapped it prematurely.
    var firstTag = await page.locator('#proc-preview-row .proc-preview-thumb').first().locator('*').first().evaluate(function (el) { return el.tagName; });
    assert.equal(firstTag, 'VIDEO', 'must not swap to the fallback before the load-timeout window has actually elapsed');

    // Advance well past the load-timeout window (PREVIEW_LOAD_TIMEOUT_MS,
    // currently 6000ms) -- the stalled request still hasn't produced
    // loadeddata/playing/error, so the self-heal swap must have fired for
    // the visible (loading) tile.
    await page.clock.fastForward(8000);

    await page.waitForFunction(function () {
      var thumb = document.querySelector('#proc-preview-row .proc-preview-thumb');
      return thumb && thumb.querySelector('video.ppt-bg') === null && thumb.querySelector('div.ppt-bg') !== null;
    }, { timeout: 5000 });

    var afterTimeout = await page.locator('#proc-preview-row .proc-preview-thumb').first().locator('*').first().evaluate(function (el) {
      return { tag: el.tagName, bg: getComputedStyle(el).backgroundImage };
    });
    assert.equal(afterTimeout.tag, 'DIV', 'the stalled visible <video> must still be replaced by a plain gradient div once its own load-timeout elapses');
    assert.match(afterTimeout.bg, /gradient/i, 'the swapped-in fallback must still be the same gradient treatment (never a bare grey box)');
  } finally {
    await context.close();
  }
});
