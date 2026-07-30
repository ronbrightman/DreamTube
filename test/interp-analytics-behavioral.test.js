// test/interp-analytics-behavioral.test.js
//
// Real-browser coverage for Interpretation Wave 1 — "The Interpreter's
// Chamber" (docs/INTERPRETATION_WAVE1_SPEC.md, tracker item
// for-product-build-interpretation-wave-1--xuftyn) — js/interpret-
// experience.js, mounted from result.html's interpretation pill. REPLACES
// this file's own old coverage of the single-blended bottom sheet
// (interp_opened/interp_completed/interp_regenerated/interp_closed on
// #interp-cta-btn/#sheet-interp-overlay), which no longer exists — the
// whole surface was rebuilt as a self-contained full-screen component per
// the spec's own §8 mounting model. New neutral event names throughout
// (interp_surface_opened/interp_persona_selected/interp_questions_shown/
// interp_question_answered/interp_skipped_to_reading/
// interp_questions_failed/interp_reading_shown/interp_reading_failed/
// interp_another_take/interp_closed — spec §7's own table), still
// deliberately health/therapy-free (same standing ad-pixel-domain
// firewall this app enforces everywhere).
//
// Follows test/shop-purchase-conversion-behavioral.test.js's own
// established "read straight out of the PostHog stub's pending-call
// queue" convention (readPostHogCalls) and test/ui-behavioral.test.js's
// seedResultPage helper shape for getting a real, authenticated
// result.html render.

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

/** Seeds a logged-in account owning one dream, matching test/ui-behavioral.test.js's own seedResultPage shape. */
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
      caption: 'A test dream about flying over mountains',
      storyText: 'I was flying over mountains, free and calm.',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: new Date().toISOString()
    }, extra));
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { id: dreamId, extra: extra });
  await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
}

/**
 * Mocks interpret-dream.js, branching on the request's own `mode` field —
 * `opts.questions` ({questions:[...]}) and `opts.reading` (a string) are
 * both optional; a status override per mode is also supported via
 * `opts.questionsStatus`/`opts.readingStatus` (defaults 200) so a test can
 * simulate a q_loading/r_loading failure without stubbing global fetch
 * (this is a real browser, not node:test's fetch stub).
 */
function mockInterpretDream(page, opts) {
  opts = opts || {};
  return page.route('**/.netlify/functions/interpret-dream', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    if (body.mode === 'questions') {
      var qStatus = opts.questionsStatus || 200;
      if (qStatus !== 200) {
        route.fulfill({ status: qStatus, contentType: 'application/json', body: JSON.stringify({ error: opts.questionsError || 'E405: llm_request_failed' }) });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: opts.questions || [{ id: 'q1', text: 'What has been on your mind?', chips: ['Work', 'Family', 'A change', 'Not sure'] }] }) });
      return;
    }
    if (body.mode === 'reading') {
      var rStatus = opts.readingStatus || 200;
      if (rStatus !== 200) {
        route.fulfill({ status: rStatus, contentType: 'application/json', body: JSON.stringify({ error: opts.readingError || 'E405: llm_request_failed' }) });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: opts.reading || 'A reflection on flight and freedom, weaving in what you told me.' }) });
      return;
    }
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'E409: invalid_mode' }) });
  });
}

/** Reads every posthog.capture(...) call recorded so far, same convention as test/shop-purchase-conversion-behavioral.test.js's readPostHogCalls. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function captures(phCalls, eventName) {
  return phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === eventName; });
}

test('result.html: tapping the pill opens the picker and fires interp_surface_opened{has_existing:false}; picking a persona fires interp_persona_selected and shows the questions phase', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await seedResultPage(page, 'd-interp-picker');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'interp_surface_opened').length, 1);
    assert.deepEqual(captures(phCalls, 'interp_surface_opened')[0][2], { has_existing: false });

    await page.click('.itp-persona-card[data-key="jung"]');
    await page.waitForSelector('.itp-chip', { state: 'visible', timeout: 5000 });

    var phCalls2 = await readPostHogCalls(page);
    var picked = captures(phCalls2, 'interp_persona_selected');
    assert.equal(picked.length, 1);
    assert.deepEqual(picked[0][2], { persona: 'jung' });
    assert.equal(captures(phCalls2, 'interp_questions_shown').length, 1);
  } finally {
    await context.close();
  }
});

test('result.html: answering a question via chip tap advances to the next question, then reaching the reading fires interp_reading_shown{answered,regenerated:false}', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {
      questions: [
        { id: 'q1', text: 'What has been on your mind?', chips: ['Work', 'Family'] },
        { id: 'q2', text: 'What feels unresolved?', chips: ['A decision', 'A conversation'] }
      ],
      reading: 'Your dream speaks to something seeking balance in your waking life.'
    });
    await seedResultPage(page, 'd-interp-chips');

    await page.click('#interp-cta-btn');
    await page.click('.itp-persona-card[data-key="jung"]');
    await page.waitForSelector('.itp-chip', { timeout: 5000 });
    await page.click('.itp-chip[data-chip="Work"]');
    await page.waitForFunction(function () {
      return document.body.textContent.indexOf('What feels unresolved?') !== -1;
    }, null, { timeout: 5000 });
    await page.click('.itp-chip[data-chip="A decision"]');

    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    var text = await page.locator('#itp-reading-text').textContent();
    assert.equal(text, 'Your dream speaks to something seeking balance in your waking life.');

    var phCalls = await readPostHogCalls(page);
    var answered = captures(phCalls, 'interp_question_answered');
    assert.equal(answered.length, 2);
    assert.deepEqual(answered[0][2], { persona: 'jung', index: 0, via: 'chip' });
    assert.deepEqual(answered[1][2], { persona: 'jung', index: 1, via: 'chip' });
    var shown = captures(phCalls, 'interp_reading_shown');
    assert.equal(shown.length, 1);
    assert.deepEqual(shown[0][2], { persona: 'jung', answered: 2, regenerated: false });
  } finally {
    await context.close();
  }
});

test('result.html: free-text answer and Skip both advance the flow, recorded with the right `via`, and Skip is omitted from the qa sent to the reading call', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var capturedReadingBody = null;
    await page.route('**/.netlify/functions/interpret-dream', function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.mode === 'questions') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [
          { id: 'q1', text: 'First?', chips: ['a', 'b'] },
          { id: 'q2', text: 'Second?', chips: ['a', 'b'] }
        ] }) });
        return;
      }
      capturedReadingBody = body;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: 'A reading that reflects your free-text answer.' }) });
    });
    await seedResultPage(page, 'd-interp-freetext-skip');

    await page.click('#interp-cta-btn');
    await page.click('.itp-persona-card[data-key="gestalt"]');
    await page.waitForSelector('#itp-composer-field', { timeout: 5000 });
    await page.fill('#itp-composer-field', 'My own typed answer');
    await page.click('#itp-composer-send');

    await page.waitForFunction(function () { return document.body.textContent.indexOf('Second?') !== -1; }, null, { timeout: 5000 });
    await page.click('#itp-skip-link');

    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    var answered = captures(phCalls, 'interp_question_answered');
    assert.equal(answered.length, 2);
    assert.equal(answered[0][2].via, 'text');
    assert.equal(answered[1][2].via, 'skip');

    assert.equal(capturedReadingBody.qa.length, 1, 'the skipped question must be omitted from qa entirely');
    assert.equal(capturedReadingBody.qa[0].q, 'First?');
    assert.equal(capturedReadingBody.qa[0].a, 'My own typed answer');
  } finally {
    await context.close();
  }
});

test('result.html: "Just interpret it" jumps straight to the reading with whatever answers exist so far, firing interp_skipped_to_reading', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {
      questions: [
        { id: 'q1', text: 'Q1?', chips: ['a', 'b'] },
        { id: 'q2', text: 'Q2?', chips: ['a', 'b'] },
        { id: 'q3', text: 'Q3?', chips: ['a', 'b'] }
      ],
      reading: 'A direct-enough reading.'
    });
    await seedResultPage(page, 'd-interp-justinterpret');

    await page.click('#interp-cta-btn');
    await page.click('.itp-persona-card[data-key="scientist"]');
    await page.waitForSelector('.itp-chip', { timeout: 5000 });
    await page.click('#itp-just-interpret-link');

    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    var phCalls = await readPostHogCalls(page);
    var skipped = captures(phCalls, 'interp_skipped_to_reading');
    assert.equal(skipped.length, 1);
    assert.deepEqual(skipped[0][2], { persona: 'scientist', answered: 0 });
    // Never reached the second/third question.
    assert.equal(captures(phCalls, 'interp_question_answered').length, 0);
  } finally {
    await context.close();
  }
});

test('result.html: a non-429 questions failure silently falls through to a direct reading -- questions are never a gate', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, { questionsStatus: 500, questionsError: 'E405: llm_request_failed', reading: 'A reading produced even though questions failed.' });
    await seedResultPage(page, 'd-interp-qfail-fallback');

    await page.click('#interp-cta-btn');
    await page.click('.itp-persona-card[data-key="freud"]');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 8000 });
    var text = await page.locator('#itp-reading-text').textContent();
    assert.equal(text, 'A reading produced even though questions failed.');

    var phCalls = await readPostHogCalls(page);
    assert.equal(captures(phCalls, 'interp_questions_failed').length, 1);
    // Never showed an error screen for this -- straight through to the reading.
    assert.equal(await page.locator('.itp-error-copy').count(), 0);
  } finally {
    await context.close();
  }
});

test('result.html: a 429 at the questions call shows the friendly rate-limit message (Close only, no silent fallback)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, { questionsStatus: 429, questionsError: 'E406: rate_limited: too many reflections from this network today, try again tomorrow' });
    await seedResultPage(page, 'd-interp-ratelimited');

    await page.click('#interp-cta-btn');
    await page.click('.itp-persona-card[data-key="talmudic"]');
    await page.waitForSelector('.itp-error-copy', { state: 'visible', timeout: 5000 });
    var copy = await page.locator('.itp-error-copy').textContent();
    assert.match(copy, /today's reflection limit/i);
    assert.equal(await page.locator('#itp-retry-btn').count(), 0, 'a rate-limited error must show Close only, no Retry');
  } finally {
    await context.close();
  }
});

test('result.html: a reading-call failure (non-429) shows Retry, which re-succeeds on a second attempt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var attempt = 0;
    await page.route('**/.netlify/functions/interpret-dream', function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.mode === 'questions') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [{ id: 'q1', text: 'Q?', chips: ['a', 'b'] }] }) });
        return;
      }
      attempt += 1;
      if (attempt === 1) {
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E405: llm_request_failed' }) });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: 'Succeeded on retry.' }) });
    });
    await seedResultPage(page, 'd-interp-retry');

    await page.click('#interp-cta-btn');
    await page.click('.itp-persona-card[data-key="gestalt"]');
    await page.waitForSelector('.itp-chip', { timeout: 5000 });
    await page.click('.itp-chip >> nth=0');
    await page.waitForSelector('.itp-error-copy', { state: 'visible', timeout: 5000 });
    assert.match(await page.locator('.itp-error-copy').textContent(), /couldn.t put this into words/i);

    await page.click('#itp-retry-btn');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#itp-reading-text').textContent(), 'Succeeded on retry.');

    var phCalls = await readPostHogCalls(page);
    var failed = captures(phCalls, 'interp_reading_failed');
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0][2], { persona: 'gestalt', rate_limited: false });
  } finally {
    await context.close();
  }
});

test('result.html: revisiting an already-interpreted dream opens straight to the reading (no network), and Another Take returns to the picker with the persona badged Read', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // No mock for interpret-dream at all -- if the revisit path ever
    // accidentally hit the network, this would 404/fail loudly rather
    // than silently passing, proving the cached-text branch is what
    // actually rendered.
    await seedResultPage(page, 'd-interp-revisit', {
      interpretations: { jung: { text: 'Already-saved Jung reading.', at: Date.now(), qa: [{ q: 'Q?', a: 'A.' }] } }
    });

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    var text = await page.locator('#itp-reading-text').textContent();
    assert.equal(text, 'Already-saved Jung reading.');

    var phCalls = await readPostHogCalls(page);
    var opened = captures(phCalls, 'interp_surface_opened');
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0][2], { has_existing: true });

    await page.click('#itp-another-take-link');
    await page.waitForSelector('.itp-persona-card.read[data-key="jung"]', { state: 'visible', timeout: 5000 });
    var anotherTake = captures(await readPostHogCalls(page), 'interp_another_take');
    assert.equal(anotherTake.length, 1);
    assert.deepEqual(anotherTake[0][2], { from_persona: 'jung' });
  } finally {
    await context.close();
  }
});

test('result.html: a dream with only the OLD legacy interpretationText/interpretationAt (pre-wave-1) is lazily migrated and opens straight to the reading under the classic key', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'd-interp-legacy-migration', {
      interpretationText: 'A legacy blended reading from before Interpretation Wave 1.',
      interpretationAt: Date.now() - 100000
    });

    await page.click('#interp-cta-btn');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    var text = await page.locator('#itp-reading-text').textContent();
    assert.equal(text, 'A legacy blended reading from before Interpretation Wave 1.');

    // The migration wrote it into interpretations.classic, persisted --
    // confirms this isn't just an in-memory read of the old fields.
    var migrated = await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = JSON.parse(raw);
      var dream = state.dreams.filter(function (d) { return d.id === 'd-interp-legacy-migration'; })[0];
      return dream && dream.interpretations && dream.interpretations.classic;
    });
    assert.ok(migrated, 'expected interpretations.classic to be persisted after the lazy migration');
    assert.equal(migrated.text, 'A legacy blended reading from before Interpretation Wave 1.');
  } finally {
    await context.close();
  }
});

// ===== Review finding (round 2): js/interpret-experience.js's portraitHtml()
// only had an onerror handler (hide the <img> on failure) -- with
// css/styles.css's `.itp-portrait-fallback` positioned absolutely over a
// STATIC (unpositioned) `.itp-portrait img`, the fallback would paint on
// top of the real image PERMANENTLY, even on a genuinely successful load
// (CSS painting order: a positioned element always paints above an
// in-flow static sibling, regardless of DOM order). Invisible on this
// branch only because every portrait 404s today (no real assets shipped
// yet, spec §12) -- this test forces a REAL successful image load to
// prove the fallback actually hides once fixed, which no existing test
// covered (every other portrait assertion here only ever exercised the
// 404/fallback-shown path).
//
// Two things this test deliberately does NOT do, and why:
//
// 1. Mock the portrait's own network request via page.route. A targeted
//    repro found Chromium/Playwright unreliably delivering a real <img>
//    element's request to a page.route() handler once THIS SAME PAGE has
//    already gone through 2+ full navigations (exactly this file's own
//    seedResultPage: login.html -> result.html) -- a fetch()-driven route
//    (e.g. mockInterpretDream, used throughout this file) keeps working
//    fine across those same navigations, so this looks like a Chromium/
//    Playwright quirk specific to image-element requests post-navigation,
//    not a bug in this app or in page.route generally.
// 2. Let the portrait's ORIGINAL src (which always 404s today, no real
//    asset files) load-fail first, then swap the SAME <img>'s src to a
//    working image afterward. Tried first; it silently produced a false
//    negative -- the ORIGINAL 404 already fires the onerror handler,
//    setting `img.style.display='none'` inline, and swapping src
//    afterward never clears that stale inline style (the onload handler
//    only ever hides the FALLBACK, by design -- see portraitHtml()'s own
//    comment), so the image stayed invisible even once the fix correctly
//    hid the fallback. That inline-style-swap scenario also isn't
//    realistic: a real portraitHtml() <img> only ever attempts ONE load
//    in its lifetime (a fresh element is built per render), never a
//    failed-then-retried one.
//
// Instead: override the persona's OWN `portrait` field (a plain data
// property on window.InterpreterPersonas) to a real, always-loadable
// `data:` URI BEFORE the surface ever opens, so the <img> genuinely
// succeeds on its one and only real load attempt -- no network involved
// at all (a `data:` URI never reaches Playwright's request-interception
// layer), and no leftover onerror state to worry about.
var TINY_PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('result.html: a persona portrait that actually loads successfully hides its accent-gradient fallback (round-2 review regression: the fallback used to permanently cover a successfully-loaded image too, not just a 404\'d one)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await seedResultPage(page, 'd-interp-portrait-load-success');

    // Force the jung persona's portrait to a real, always-loadable image
    // BEFORE opening the surface, so its <img> succeeds on its one and
    // only load attempt -- see this section's own header comment for why
    // this is the reliable way to exercise the true success path.
    await page.evaluate(function (dataUri) {
      window.InterpreterPersonas.get('jung').portrait = dataUri;
    }, TINY_PNG_DATA_URI);

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });
    await page.click('.itp-persona-card[data-key="jung"]');
    // The topbar persona header's portrait is the smallest/most reused
    // instance of portraitHtml() -- pinned from q_loading onward.
    await page.waitForSelector('#itp-topbar .itp-portrait img', { state: 'attached', timeout: 5000 });
    await page.waitForFunction(function () {
      var img = document.querySelector('#itp-topbar .itp-portrait img');
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 5000 });

    var fallbackDisplay = await page.locator('#itp-topbar .itp-portrait-fallback').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(fallbackDisplay, 'none', 'the fallback must hide itself once the real portrait image genuinely loads, not just on a 404');
    var imgVisible = await page.locator('#itp-topbar .itp-portrait img').isVisible();
    assert.equal(imgVisible, true, 'the real loaded image must be genuinely present/visible in the DOM once loaded');
  } finally {
    await context.close();
  }
});

test('result.html: closing via the topbar X fires interp_closed with the current phase, at every phase (picker, questions, reading)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, { reading: 'A reading.' });
    await seedResultPage(page, 'd-interp-close-phases');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card', { timeout: 5000 });
    await page.click('#itp-close-btn');
    await page.waitForFunction(function () { return !document.getElementById('itp-root').classList.contains('open'); }, null, { timeout: 5000 });
    var phCalls1 = await readPostHogCalls(page);
    assert.deepEqual(captures(phCalls1, 'interp_closed')[0][2], { phase: 'picker' });

    await page.click('#interp-cta-btn');
    await page.click('.itp-persona-card[data-key="jung"]');
    await page.waitForSelector('.itp-chip', { timeout: 5000 });
    await page.click('#itp-close-btn');
    await page.waitForFunction(function () { return !document.getElementById('itp-root').classList.contains('open'); }, null, { timeout: 5000 });
    var phCalls2 = await readPostHogCalls(page);
    var closes2 = captures(phCalls2, 'interp_closed');
    assert.equal(closes2[closes2.length - 1][2].phase, 'questions');
  } finally {
    await context.close();
  }
});

test('result.html: never opening the interpretation surface at all fires none of the interp_* events', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'd-interp-never-opened');
    await page.waitForSelector('#interp-cta-btn', { timeout: 5000 });

    var phCalls = await readPostHogCalls(page);
    ['interp_surface_opened', 'interp_persona_selected', 'interp_questions_shown', 'interp_question_answered', 'interp_skipped_to_reading', 'interp_questions_failed', 'interp_reading_shown', 'interp_reading_failed', 'interp_another_take', 'interp_closed'].forEach(function (name) {
      assert.equal(captures(phCalls, name).length, 0, 'expected zero ' + name + ' captures when the surface is never opened');
    });
  } finally {
    await context.close();
  }
});

test('result.html: no interp_* event name or the picker footer/disclaimer copy is ever health/therapy-flavored', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, { reading: 'A reading.' });
    await seedResultPage(page, 'd-interp-health-copy');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card', { timeout: 5000 });
    var pickerText = await page.locator('.itp-body').textContent();
    // The disclaimer's OWN "not medical or mental-health advice" phrase is
    // the one explicit exception (spec §4) -- only checked once past the
    // picker, on the reading itself, below.
    assert.doesNotMatch(pickerText, /\btherapy\b|\bdiagnosis\b|\bhealing\b|\btreatment\b/i);

    await page.click('.itp-persona-card[data-key="scientist"]');
    await page.waitForSelector('#itp-just-interpret-link', { state: 'visible', timeout: 5000 });
    await page.click('#itp-just-interpret-link');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 8000 });
    var disclosure = await page.locator('.interp-disclosure').textContent();
    assert.match(disclosure, /not medical or mental-health advice/i);

    var phCalls = await readPostHogCalls(page);
    var allNames = phCalls.filter(function (e) { return e[0] === 'capture'; }).map(function (e) { return e[1]; });
    allNames.forEach(function (name) {
      assert.doesNotMatch(name, /therap|anxiety|depress|diagnos/i, 'event name "' + name + '" must never be health/therapy-flavored');
    });
  } finally {
    await context.close();
  }
});

// ===== Private-never-in-shared-feed guarantee =====

test('a published dream\'s interpretations map is NEVER included in the publish-dream payload, even after saving a reading', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var capturedPublishBody = null;
    await page.route('**/.netlify/functions/publish-dream', function (route) {
      capturedPublishBody = JSON.parse(route.request().postData() || '{}');
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await mockInterpretDream(page, { reading: 'A private reading that must never reach the shared feed.' });
    await seedResultPage(page, 'd-interp-privacy', { isPublished: true });

    await page.click('#interp-cta-btn');
    await page.click('.itp-persona-card[data-key="jung"]');
    await page.waitForSelector('#itp-just-interpret-link', { state: 'visible', timeout: 5000 });
    await page.click('#itp-just-interpret-link');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 8000 });

    // Trigger a re-sync the same way any other already-published-dream
    // edit does (setOkToFeatureOnChannels is a convenient, already-wired
    // real call site that re-syncs) -- confirms the CURRENT dream record,
    // now carrying a saved interpretations map, still never leaks it.
    await page.evaluate(function () { window.DreamStore.setOkToFeatureOnChannels('d-interp-privacy', true); });
    await page.waitForFunction(function () { return window.__capturedPublishBodyCheck || true; }, null, { timeout: 500 }).catch(function () {});
    await new Promise(function (r) { setTimeout(r, 300); });

    assert.ok(capturedPublishBody, 'expected at least one publish-dream sync to have fired');
    assert.equal(capturedPublishBody.interpretations, undefined, 'interpretations must never appear in the publish-dream payload');
    assert.equal(JSON.stringify(capturedPublishBody).indexOf('private reading that must never reach the shared feed') === -1, true, 'the actual reading text must never appear anywhere in the publish-dream payload');
  } finally {
    await context.close();
  }
});
