// test/processing-preview-video-blank-tile-fallback-behavioral.test.js
//
// Regression coverage for tracker.html's
// for-product-blank-grey-tile-in-the-wait--9p1xwu: the founder saw
// processing.html's "while you wait" carousel (.proc-preview /
// #proc-preview-row, see processing-preview-empty-sparse-fallback-
// behavioral.test.js for the empty/sparse-feed variant of this same
// section) render its first tile as a blank grey square.
//
// Investigation (documented in the tracker item's own comment history)
// ruled out the item's own prime suspect -- fal.ai's ~7-day media
// retention expiring old dreams -- get-feed.js returns the feed
// newest-first and the carousel only takes the first 10 entries, so the
// "first tile" is always one of the NEWEST dreams, and the 6 actual
// oldest published dreams' fal.media URLs still HEAD 200. The real root
// cause: processing.html's previewThumbHTML() rendered a video dream as a
// bare <video autoplay preload="metadata"> with no `poster` at all, so
// until the video painted a real frame, the tile's own container
// background (--surface, a dark near-black grey, css/styles.css) showed
// through -- and the pre-existing wirePreviewErrorFallback() only
// listened for a genuine `error` event, doing nothing for a video that's
// simply slow to start or has autoplay silently blocked (no error ever
// fires for either case).
//
// The fix (both in previewThumbHTML/wirePreviewErrorFallback):
//   1. The <video> element itself now gets an inline `background` style
//      set to the same DreamStore.gradientFor() gradient image dreams
//      already use -- present from the very first render, before any
//      network byte has arrived, no wrapper element or new asset needed.
//   2. A ~2.5s load-timeout: if neither `loadeddata` nor `playing` fires
//      by then, the video is swapped out for the same gradient fallback
//      div a genuine `error` already triggers (shared swapPreviewToGradient
//      helper) -- this is the self-heal for the "silently never started"
//      case that no error event would ever catch.
//
// Follows test/processing-preview-empty-sparse-fallback-behavioral.test.js's
// seedFirstTimerAt-style localStorage seeding (adapted here to seed the
// user's OWN published video dreams, the "mine" branch of renderPreview,
// so the exact videoUrl is controllable) and
// test/wait-screen-reassurance-and-inapp-nudge-behavioral.test.js's
// page.clock pattern for deterministically advancing the load-timeout
// setTimeout without a real wall-clock wait.

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

/** Intercepts the fake video URL used below and simply never fulfills the request -- the video request stays permanently in flight, so no `loadeddata`/`playing`/`error` event for it can ever fire, matching a real stalled-network or blocked-autoplay case. */
function stallVideoRequest(page) {
  return page.route('**/mock-preview-video.mp4', function () { /* deliberately never fulfilled */ });
}

/** Seeds a logged-in account with one published video dream of its own (the "mine" branch of processing.html's renderPreview -- the branch that actually reaches previewThumbHTML for a real videoUrl) and navigates to processing.html. Mirrors processing-preview-empty-sparse-fallback-behavioral.test.js's seedFirstTimerAt, adapted to seed an owned video dream with a controllable URL instead of an empty/shared-feed scenario. */
async function seedOwnVideoDreamAt(page, username) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
    state.dreams = [
      { id: 'mine-video-1', ownerHandle: '@' + o.username, caption: 'A flying dream', style: 'Cinematic', videoUrl: o.videoUrl, isPublished: true, likes: 0 }
    ];
    state.draft = Object.assign({}, state.draft, { caption: 'Another dream', style: 'Cinematic', mediaType: null, sourceImageUrl: null });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, videoUrl: baseUrl + '/mock-preview-video.mp4' });
  await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });
}

test('processing.html: a video preview tile has a real (non-grey) gradient background from the moment it is rendered, before the video has loaded anything', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stallVideoRequest(page);

    await seedOwnVideoDreamAt(page, 'blanktileuser');

    await page.waitForFunction(function () {
      var row = document.getElementById('proc-preview-row');
      return row && row.querySelector('video.ppt-bg');
    }, { timeout: 5000 });

    // The video request is stalled (never fulfilled) for the whole test up
    // to this point, so this check happens strictly before the video has
    // loaded any bytes at all -- if a real grey gap existed before a poster/
    // background applied, this is exactly where it would show up.
    var videoBg = await page.locator('#proc-preview-row video.ppt-bg').evaluate(function (el) {
      return { inlineStyle: el.getAttribute('style') || '', computedBg: getComputedStyle(el).backgroundImage };
    });
    assert.match(videoBg.inlineStyle, /linear-gradient/, 'the <video> element itself must carry a gradient background inline, set at render time');
    assert.match(videoBg.computedBg, /gradient/i, 'computed backgroundImage must actually be a gradient, not the container\'s plain grey falling through');
    // Cinematic is this seeded dream's style -- confirms it is really
    // DreamStore.gradientFor's style-specific treatment, not a generic
    // placeholder color unrelated to the existing image-dream gradients.
    assert.match(videoBg.inlineStyle, /#3E6E8E/i, 'must be the same style-specific gradient DreamStore.gradientFor already gives image dreams (Cinematic here), not an unrelated placeholder');
  } finally {
    await context.close();
  }
});

test('processing.html: REGRESSION -- a video that never fires loadeddata/playing gets swapped to the gradient fallback after the load-timeout window, not left stuck', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await stallVideoRequest(page);
    await page.clock.install({ time: Date.now() });

    await seedOwnVideoDreamAt(page, 'timeoutfallbackuser');

    await page.waitForFunction(function () {
      var row = document.getElementById('proc-preview-row');
      return row && row.querySelector('video.ppt-bg');
    }, { timeout: 5000 });

    // Well past this whole request lifetime, the video must still be a
    // real <video> element (no premature swap) since the load-timeout
    // hasn't been reached yet.
    var stillVideo = await page.locator('#proc-preview-row .proc-preview-thumb *').first().evaluate(function (el) { return el.tagName; });
    assert.equal(stillVideo, 'VIDEO', 'must not swap to the fallback before the load-timeout window has actually elapsed');

    // Advance well past the ~2.5s load-timeout window -- the stalled
    // request still hasn't produced loadeddata/playing/error by now, so the
    // self-heal swap must have fired.
    await page.clock.fastForward(4000);

    await page.waitForFunction(function () {
      var thumb = document.querySelector('#proc-preview-row .proc-preview-thumb');
      return thumb && thumb.querySelector('video.ppt-bg') === null && thumb.querySelector('div.ppt-bg') !== null;
    }, { timeout: 5000 });

    var afterTimeout = await page.locator('#proc-preview-row .proc-preview-thumb *').first().evaluate(function (el) {
      return { tag: el.tagName, bg: getComputedStyle(el).backgroundImage };
    });
    assert.equal(afterTimeout.tag, 'DIV', 'the stalled <video> must be replaced by a plain gradient div once the load-timeout elapses');
    assert.match(afterTimeout.bg, /gradient/i, 'the swapped-in fallback must still be the same gradient treatment (never a bare grey box)');
  } finally {
    await context.close();
  }
});
