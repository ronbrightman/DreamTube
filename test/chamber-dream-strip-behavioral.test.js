// test/chamber-dream-strip-behavioral.test.js
//
// Real-browser coverage for the Interpreter's Chamber's dream-picker
// strip (tracker item for-product-chamber-dream-linkage-is-unc-00s2dr,
// founder verdict 2026-07-31 evening — overriding both directions
// docs/CHAMBER_DREAM_LINKAGE_SPEC.md had proposed): "the Chamber's dream
// picker is the EXACT same videos-preview area as the homepage's
// My-dreams row - the horizontal thumbnail swipe strip - shown at the
// top of the Chamber; user slides and taps a dream, the reading targets
// it." Covers js/interpret-experience.js's new renderDreamStrip()/
// switchDream(), which reuse js/dream-cards.js's shared
// dreamRowTileHTML() verbatim — same markup/class names as home.html's
// own My Dreams row.
//
// Follows test/interp-analytics-behavioral.test.js's own established
// helpers/conventions (staticServer, blockThirdParty, readPostHogCalls),
// extended here to seed MULTIPLE dreams for one account (that file's own
// seedResultPage seeds exactly one).

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

/**
 * Seeds a logged-in account owning every dream in `dreams` (most-recent-
 * last in this array is pushed last, but js/store.js's own createDream
 * path unshifts new dreams to the front -- so we replicate that ordering
 * directly here by unshifting, same "most-recent-first" contract
 * DreamStore.getMyDreams() documents) and lands on result.html for
 * `openId`.
 */
async function seedAndOpen(page, dreams, openId) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var dreams = args.dreams;
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    state.dreams = dreams.slice().reverse().concat(state.dreams || []); // unshift-equivalent, most-recent-first
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { dreams: dreams });
  await page.goto(baseUrl + '/result.html?id=' + openId, { waitUntil: 'domcontentloaded' });
}

function baseDream(id, extra) {
  return Object.assign({
    id: id,
    ownerHandle: '@tester',
    caption: 'Dream ' + id,
    storyText: 'A story for dream ' + id + '.',
    style: 'Cinematic',
    isPublished: false,
    createdAt: Date.now()
  }, extra || {});
}

/** Reads every posthog.capture(...) call recorded so far, same convention as interp-analytics-behavioral.test.js. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function captures(phCalls, eventName) {
  return phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === eventName; });
}

/** Stubs netlify/functions/interpret-dream, same shape as test/interp-analytics-behavioral.test.js's own mockInterpretDream. */
function mockInterpretDream(page, opts) {
  opts = opts || {};
  return page.route('**/.netlify/functions/interpret-dream', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    if (body.mode === 'questions') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: opts.questions || [{ id: 'q1', text: 'What has been on your mind?', chips: ['Work', 'Family'] }] }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: opts.reading || 'A reading.' }) });
  });
}

test('Chamber: the strip lists only completed dreams (video or image), the opened dream is ringed as selected, and a pending (no video/image) dream is excluded', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreams = [
      baseDream('d-video-1', { videoUrl: 'https://example.com/v1.mp4' }),
      baseDream('d-image-1', { imageUrl: 'https://example.com/i1.png' }),
      baseDream('d-pending-1', {}) // no videoUrl/imageUrl -- not completed
    ];
    await seedAndOpen(page, dreams, 'd-video-1');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#itp-dream-strip .dream-row-tile', { timeout: 5000 });

    var ids = await page.locator('#itp-dream-strip .dream-row-tile').evaluateAll(function (els) {
      return els.map(function (e) { return e.getAttribute('data-dream-id'); });
    });
    assert.deepEqual(ids.sort(), ['d-image-1', 'd-video-1'], 'the pending dream (no video/image) must not appear in the strip');

    var selectedIds = await page.locator('#itp-dream-strip .dream-row-tile.is-selected').evaluateAll(function (els) {
      return els.map(function (e) { return e.getAttribute('data-dream-id'); });
    });
    assert.deepEqual(selectedIds, ['d-video-1'], 'the dream the Chamber was opened for must be the one ringed as selected');

    // Reuses the shared button-mode tile (not the <a> variant home.html's own row uses).
    var tag = await page.locator('#itp-dream-strip .dream-row-tile[data-dream-id="d-video-1"]').evaluate(function (e) { return e.tagName; });
    assert.equal(tag, 'BUTTON');
  } finally {
    await context.close();
  }
});

test('Chamber: tapping a different tile switches the active dream -- the ring moves, the switched-to dream\'s own picker/reading loads, and interp_dream_switched fires', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreams = [
      baseDream('d-a', { videoUrl: 'https://example.com/a.mp4', caption: 'Dream A' }),
      baseDream('d-b', { videoUrl: 'https://example.com/b.mp4', caption: 'Dream B' })
    ];
    await seedAndOpen(page, dreams, 'd-a');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { timeout: 5000 });

    // Sanity: opened on d-a's picker, d-a ringed.
    var selectedBefore = await page.locator('#itp-dream-strip .dream-row-tile.is-selected').getAttribute('data-dream-id');
    assert.equal(selectedBefore, 'd-a');

    await page.click('#itp-dream-strip .dream-row-tile[data-dream-id="d-b"]');
    await page.waitForFunction(function () {
      var sel = document.querySelector('#itp-dream-strip .dream-row-tile.is-selected');
      return sel && sel.getAttribute('data-dream-id') === 'd-b';
    }, null, { timeout: 5000 });

    // The switch re-ran open() for d-b -- a fresh dream with no saved
    // interpretations opens on the picker phase again, same as any other
    // open() call for a never-interpreted dream.
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    var switched = captures(phCalls, 'interp_dream_switched');
    assert.equal(switched.length, 1);
    assert.deepEqual(switched[0][2], { from_dream_id: 'd-a', to_dream_id: 'd-b' });

    // Switching fires a fresh interp_surface_opened too (open() runs in full).
    assert.equal(captures(phCalls, 'interp_surface_opened').length, 2);
  } finally {
    await context.close();
  }
});

test('Chamber: tapping the already-selected tile is a no-op (never restarts the current dream\'s in-progress flow, never fires interp_dream_switched)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    var dreams = [
      baseDream('d-solo', { videoUrl: 'https://example.com/solo.mp4' })
    ];
    await seedAndOpen(page, dreams, 'd-solo');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { timeout: 5000 });
    await page.click('.itp-persona-card[data-key="jung"]');
    await page.waitForSelector('#itp-composer-field', { timeout: 5000 });
    await page.fill('#itp-composer-field', 'partial answer, not yet submitted');

    await page.click('#itp-dream-strip .dream-row-tile[data-dream-id="d-solo"]');
    await page.waitForTimeout(200);

    // Still mid-questions, the typed (unsubmitted) text untouched -- the
    // no-op tap on the already-selected tile must not have reset anything.
    var fieldValue = await page.locator('#itp-composer-field').inputValue();
    assert.equal(fieldValue, 'partial answer, not yet submitted');

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'interp_dream_switched').length, 0);
  } finally {
    await context.close();
  }
});

test('Chamber: a single completed dream still renders the strip with its own tile ringed (no hide-when-only-one)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreams = [ baseDream('d-only', { videoUrl: 'https://example.com/only.mp4' }) ];
    await seedAndOpen(page, dreams, 'd-only');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#itp-dream-strip .dream-row-tile', { timeout: 5000 });
    var count = await page.locator('#itp-dream-strip .dream-row-tile').count();
    assert.equal(count, 1);
    var selected = await page.locator('#itp-dream-strip .dream-row-tile.is-selected').count();
    assert.equal(selected, 1);
  } finally {
    await context.close();
  }
});

test('Chamber: opening for a dream with no video/image yet (defensive fallback) still shows and rings that dream\'s own tile, stitched in alongside the real completed dreams', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var dreams = [
      baseDream('d-pending-open', {}), // no videoUrl/imageUrl -- the one we open for
      baseDream('d-complete-1', { videoUrl: 'https://example.com/c1.mp4' })
    ];
    await seedAndOpen(page, dreams, 'd-pending-open');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#itp-dream-strip .dream-row-tile', { timeout: 5000 });

    var ids = await page.locator('#itp-dream-strip .dream-row-tile').evaluateAll(function (els) {
      return els.map(function (e) { return e.getAttribute('data-dream-id'); });
    });
    assert.ok(ids.indexOf('d-pending-open') !== -1, 'the dream the Chamber was opened for must appear even without a finished video/image');
    assert.ok(ids.indexOf('d-complete-1') !== -1);

    var selected = await page.locator('#itp-dream-strip .dream-row-tile.is-selected').getAttribute('data-dream-id');
    assert.equal(selected, 'd-pending-open');
  } finally {
    await context.close();
  }
});
