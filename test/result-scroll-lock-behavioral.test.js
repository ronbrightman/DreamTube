// test/result-scroll-lock-behavioral.test.js
//
// Regression coverage for tracker item
// for-product-bug-founder-video-08-07-resu-f4u8zy (founder screen
// recording, dreamtube.life result.html on iPhone Safari): the page went
// mid-content-but-entirely-unscrollable — swiping down only rubber-banded
// into Safari's pull-to-refresh bubble instead of scrolling.
//
// Root cause: js/interpret-experience.js's open()/close() is the ONLY
// place in this whole page that locks document.body.style.overflow (every
// other overlay/sheet on result.html — .player-overlay, .sheet-overlay,
// .modal-overlay — is pointer-events:none when closed, so a stuck `.open`
// class there is at worst a visibly-stuck overlay, never an invisible
// scroll block; confirmed by reading every such overlay's CSS/JS). close()
// already released the lock correctly on its three explicit triggers
// (topbar X, the post-reading Close link, the error-state Close link) —
// the gap was every OTHER way the page can go away while the lock is
// held, most notably iOS Safari's native edge-swipe back gesture, which
// does not run this page's click handlers and can freeze the page into
// the back/forward cache (bfcache) with the lock still on, to be restored
// verbatim later with no fresh page load to ever reset it.
//
// This suite can't force a real iOS bfcache freeze/restore inside
// Chromium+CDP (bfcache is well known to be unreliable under DevTools
// Protocol automation, and this sandbox has no WebKit engine at all — see
// AGENT_POLICY.md's REAL-MODE gate discussion of engine-specific gaps).
// Instead it verifies the actual FIX MECHANISM directly: the fix is a
// `pagehide`/`pageshow` listener pair in js/interpret-experience.js, and
// `pagehide`/`pageshow` are the exact, portable events every browser
// (including iOS Safari) fires immediately before hiding/freezing a page
// and immediately after restoring one from bfcache — dispatching them
// synthetically exercises precisely the code path a real bfcache
// freeze/restore would invoke, which is the standard, portable way to
// test pagehide-driven cleanup (there is no cross-engine way to force a
// *real* bfcache store/restore from an automated test).
//
// Follows test/interp-analytics-behavioral.test.js's own seedResultPage/
// mockInterpretDream/blockThirdParty conventions.

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

/** Same shape as test/interp-analytics-behavioral.test.js's own helper. */
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

function mockInterpretDream(page, opts) {
  opts = opts || {};
  return page.route('**/.netlify/functions/interpret-dream', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    if (body.mode === 'questions') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: opts.questions || [{ id: 'q1', text: 'What has been on your mind?', chips: ['Work', 'Family'] }] }) });
      return;
    }
    if (body.mode === 'reading') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: opts.reading || 'A reflection on flight and freedom.' }) });
      return;
    }
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'E409: invalid_mode' }) });
  });
}

function readLockState(page) {
  return page.evaluate(function () {
    var root = document.getElementById('itp-root');
    return {
      bodyOverflow: document.body.style.overflow,
      itpOpen: root ? root.classList.contains('open') : false
    };
  });
}

test('result.html: opening the interpretation overlay locks body scroll, and the topbar Close button releases it (sanity baseline for the explicit-close paths)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await seedResultPage(page, 'd-scrolllock-baseline');

    var before = await readLockState(page);
    assert.equal(before.bodyOverflow, '', 'no lock before the overlay is ever opened');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });

    var whileOpen = await readLockState(page);
    assert.equal(whileOpen.bodyOverflow, 'hidden', 'body scroll is locked while the overlay is open');
    assert.equal(whileOpen.itpOpen, true);

    await page.click('#itp-close-btn');
    await page.waitForTimeout(50);

    var afterClose = await readLockState(page);
    assert.equal(afterClose.bodyOverflow, '', 'the topbar Close button releases the lock');
    assert.equal(afterClose.itpOpen, false);
  } finally {
    await context.close();
  }
});

test('result.html: abandoning the interpretation overlay open (no explicit close) then a pagehide/pageshow cycle — the exact sequence a bfcache-eligible navigation-away-and-back produces, including iOS Safari\'s edge-swipe back gesture — still releases the scroll lock', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await seedResultPage(page, 'd-scrolllock-pagehide');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });

    var whileOpen = await readLockState(page);
    assert.equal(whileOpen.bodyOverflow, 'hidden', 'precondition: overlay open, lock held, exactly as it would be mid-gesture');

    // Never tap Close — simulate the page being hidden/frozen for bfcache
    // storage (what a real edge-swipe-back or any other navigation-away
    // does) by dispatching the same event the browser itself would fire
    // right before that freeze.
    await page.evaluate(function () {
      window.dispatchEvent(new Event('pagehide'));
    });

    var afterPagehide = await readLockState(page);
    assert.equal(afterPagehide.bodyOverflow, '', 'pagehide must release the lock even though no close button was tapped — this is the actual regression: without the fix this stays "hidden" forever, because close() is never called on any path other than its three explicit buttons');
    assert.equal(afterPagehide.itpOpen, false, 'the session is torn down (not just the CSS lock) so a subsequent bfcache restore does not also show a stuck-open overlay');

    // Belt-and-suspenders: simulate the restore side too (pageshow with
    // persisted:true is exactly what fires when a bfcache-frozen page
    // comes back via back/forward navigation).
    await page.evaluate(function () {
      document.body.style.overflow = 'hidden'; // pretend an already-frozen pre-fix bfcache entry still had it stuck
      window.dispatchEvent(new Event('pageshow', { bubbles: false, cancelable: false }));
      // Event() alone can't set `persisted` (a read-only getter on real
      // PageTransitionEvent) — call the listener's effect directly is not
      // possible from here without reaching into the module, so instead
      // verify via a real PageTransitionEvent when the browser supports
      // constructing one; Chromium does.
    });
    var pte = await page.evaluate(function () {
      var supported = typeof PageTransitionEvent === 'function';
      if (supported) {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      }
      return supported;
    });
    assert.equal(pte, true, 'this Chromium build must support constructing PageTransitionEvent for this assertion to mean anything');

    var afterPageshow = await readLockState(page);
    assert.equal(afterPageshow.bodyOverflow, '', 'pageshow{persisted:true} unconditionally releases a still-set lock as defense-in-depth, independent of session state');
  } finally {
    await context.close();
  }
});

test('result.html: the interpretation overlay never manipulates document.body.style.overflow outside a session it owns — a pagehide with no session active is a no-op, not an accidental unlock of some OTHER page feature', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'd-scrolllock-noop');

    // Nothing else on this page ever sets body.style.overflow itself, so
    // set an arbitrary non-'' value here to prove pagehide with no
    // interpretation session active leaves it alone rather than blindly
    // clearing it (which would be the wrong fix — it must go through
    // close(), which no-ops when `session` is null, not force-clear).
    await page.evaluate(function () { document.body.style.overflow = 'scroll'; });
    await page.evaluate(function () { window.dispatchEvent(new Event('pagehide')); });

    var state = await readLockState(page);
    assert.equal(state.bodyOverflow, 'scroll', 'no active interpretation session -> pagehide must not touch body.style.overflow at all');
  } finally {
    await context.close();
  }
});
